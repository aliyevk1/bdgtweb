# BudgetWise

BudgetWise is a minimalist budgeting application that helps users balance their income using the 50/30/20 methodology. The app supports per-user categories, recurring templates, and template export/import so that configurations can be backed up or shared across environments.

## Running a Local Copy

### Prerequisites

* **Node.js ≥ 18**
* **npm ≥ 9**
* Any terminal (macOS/Linux shell or PowerShell on Windows)

### 1. Clone the repository

```bash
git clone https://github.com/<your-username>/budgetwise.git
cd budgetwise
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the development server

```bash
npm start
```

* Launches the Express backend on **[http://localhost:3000](http://localhost:3000)**
* Serves static frontend files from `/public`
* Automatically creates a local **SQLite** database file `budget.db` in the project root

Stop the server anytime with **Ctrl + C**.

### 4. Folder overview

```
/public        → Frontend (HTML, Tailwind, JS)
/api           → Express route handlers
/database.js   → SQLite initialization and migrations
/index.js      → Server entry point
/package.json  → Scripts and dependencies
```

### 5. Environment configuration (optional)

You can add a `.env` file to override defaults:

```bash
PORT=4000
DATABASE_PATH=./budget.db
JWT_SECRET=your_secret_here
```

If `.env` is missing, the app uses:

* Port 3000
* Database `budget.db` in the project root
* Random fallback secret for JWT

### 6. First-run behavior

* The app creates all required tables automatically.
* Open **[http://localhost:3000/register.html](http://localhost:3000/register.html)** to create your first user.
* JWT sessions are stored in `localStorage`; log out clears them.

### 7. Common issues

| Symptom                            | Cause / Fix                                             |
| ---------------------------------- | ------------------------------------------------------- |
| **Port in use**                    | Change `PORT` in `.env` or stop another process on 3000 |
| **Database locked**                | Restart Node; SQLite file was in use                    |
| **Unauthorized** after code change | Clear browser `localStorage` and log in again           |

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

- `version`: Schema version. Must be `"1.0"`.
- `generatedAt`: ISO-8601 timestamp (UTC) indicating when the file was produced.
- `categories`: Array of category definitions. Each entry must contain a `name` (1-40 characters, case-insensitive unique per user) and a `budget_type` (`Necessities`, `Leisure`, or `Savings`).
- `recurring`: Array of recurring payment templates. Each entry must include a `description` (1-255 characters), a positive `default_amount` with at most two decimal places, and a `category_name` that references one of the categories defined in the same file.

### Import Rules

- Categories are upserted using a case-insensitive match on the trimmed name. New categories will only be added up to the per-user limit (50).
- Recurring templates reference categories by name; duplicates (existing or repeated in the file) are skipped automatically. Users may store at most 50 recurring templates.
- Payload limits: at most 100 categories, 200 recurring templates, and a maximum file size of 1 MB.
- The import endpoint returns counts of inserted and skipped records for both categories and recurring templates.

These rules ensure imports are idempotent: importing the same file multiple times will not create duplicate records.
