# BudgetWise

BudgetWise is a minimalist budgeting application that helps users balance their income using the 50/30/20 methodology. The app supports per-user categories, recurring templates, and template export/import so that configurations can be backed up or shared across environments.

---

## Running with Docker

This method runs both the backend (Node.js/Express) and frontend (static `/public` files) in a single container with SQLite built-in.

### Prerequisites

* **Docker ≥ 24**

### 1. Clone the repository

```bash
git clone https://github.com/aliyevk1/bdgtweb.git
cd bdgtweb
```

### 2. Build the Docker image

```bash
docker build -t budgetwise:latest .
```

### 3. Run the container

#### Option A — Ephemeral (database inside the container; data lost on removal)

```bash
docker run -d --name budgetwise -p 3000:3000 budgetwise:latest
```

* Runs the app on **[http://localhost:3000](http://localhost:3000)**
* Database file `/data/budget.db` is stored inside the container layer (deleted when container is removed)

#### Option B — Persistent (database stored outside the container)

```bash
docker volume create budgetwise_data

docker run -d --name budgetwise -p 3000:3000 -e NODE_ENV=production -e PORT=3000 -e DATABASE_PATH=/data/budget.db -v budgetwise_data:/data budgetwise:latest
```

* Runs the app on **[http://localhost:3000](http://localhost:3000)**
* SQLite database is stored in a persistent Docker volume `budgetwise_data`
* Data survives container rebuilds and restarts

#### Option C — Custom environment variables

```bash
docker run -d --name budgetwise -p 8080:3000 -e NODE_ENV=production -e PORT=3000 -e JWT_SECRET=mystrongsecret -e DATABASE_PATH=/data/budget.db -v budgetwise_data:/data budgetwise:latest
```

* Example with a custom port and JWT secret.

### 4. Verify container status

```bash
docker ps
```

You should see `budgetwise` running. Access **[http://localhost:3000](http://localhost:3000)** to use the app.

### 5. Stop and remove the container

```bash
docker stop budgetwise && docker rm budgetwise
```

---

## Running a Local Copy (Without Docker)

### Prerequisites

* **Node.js ≥ 18**
* **npm ≥ 9**

### 1. Clone and install

```bash
git clone https://github.com/aliyevk1/bdgtweb.git
cd bdgtweb
npm install
```

### 2. Start the development server

```bash
npm start
```

* Backend: **[http://localhost:3000](http://localhost:3000)**
* Frontend served from `/public`
* SQLite database `budget.db` auto-created in project root

Stop anytime with **Ctrl + C**.

### 3. Optional environment variables

```bash
PORT=4000
DATABASE_PATH=./budget.db
JWT_SECRET=your_secret_here
```

Defaults (if `.env` missing):

* Port 3000
* Database in project root (`budget.db`)
* Random JWT secret generated at runtime

---

## Template Export/Import Schema

The template system uses a versioned JSON schema. The current schema version is **1.0** and is returned by `GET /api/templates/export` and accepted by `POST /api/templates/import`.

```json
{
  "version": "1.0",
  "generatedAt": "2025-10-21T00:00:00.000Z",
  "categories": [
    { "name": "Groceries", "budget_type": "Necessities" },
    { "name": "Dining", "budget_type": "Leisure" }
  ],
  "recurring": [
    { "description": "Rent", "default_amount": 1200.0, "category_name": "Rent" },
    { "description": "Gym Membership", "default_amount": 45.0, "category_name": "Fitness" }
  ]
}
```

### Field meanings

* `version`: Schema version, must be `"1.0"`.
* `generatedAt`: ISO-8601 timestamp when exported.
* `categories`: Array of category definitions with `name` (1–40 chars, unique per user) and `budget_type` (`Necessities`, `Leisure`, `Savings`).
* `recurring`: Array of recurring templates, each with a `description`, `default_amount`, and `category_name` referencing a defined category.

### Import Rules

* Categories are upserted case-insensitively (max 50 per user).
* Recurring templates reference categories by name; duplicates are skipped.
* Limits: ≤100 categories, ≤200 recurring templates, ≤1 MB file size.
* Import endpoint returns counts of inserted/skipped records.

Repeated imports of the same file will not create duplicates (idempotent behavior).
