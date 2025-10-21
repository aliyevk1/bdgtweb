
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { initializeDatabase, run, get, all } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'my-super-secret-key';
const TOKEN_EXPIRY = '7d';
const BUDGET_TYPES = new Set(['Necessities', 'Leisure', 'Savings']);

initializeDatabase();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(password, 10, (err, hash) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(hash);
    });
  });
}

function comparePassword(password, hash) {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, hash, (err, matches) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(matches);
    });
  });
}

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!tokenMatch) {
    res.status(401).json({ message: 'Authorization token required.' });
    return;
  }

  try {
    const decoded = jwt.verify(tokenMatch[1], JWT_SECRET);
    if (!decoded?.id) {
      res.status(401).json({ message: 'Invalid token payload.' });
      return;
    }

    req.userId = decoded.id;
    next();
  } catch (error) {
    console.error('Token verification failed:', error);
    res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

app.post('/api/users/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const trimmedUsername = typeof username === 'string' ? username.trim() : '';
    const passwordValue = typeof password === 'string' ? password : '';

    if (!trimmedUsername || passwordValue.length < 8) {
      res
        .status(400)
        .json({ message: 'Username is required and password must be at least 8 characters.' });
      return;
    }

    const existingUser = await get('SELECT id FROM User WHERE username = ?', [trimmedUsername]);
    if (existingUser?.id) {
      res.status(409).json({ message: 'Username is already taken.' });
      return;
    }

    const passwordHash = await hashPassword(passwordValue);
    const result = await run(
      'INSERT INTO User (username, password_hash) VALUES (?, ?)',
      [trimmedUsername, passwordHash],
    );

    const token = jwt.sign({ id: result.lastID }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });

    res.status(201).json({ token });
  } catch (error) {
    console.error('Failed to register user:', error);
    res.status(500).json({ message: 'Failed to register user.' });
  }
});

app.post('/api/categories', authenticate, async (req, res) => {
  try {
    const { name, budget_type: budgetType } = req.body;
    const trimmedName = typeof name === 'string' ? name.trim() : '';

    if (!trimmedName) {
      res.status(400).json({ message: 'Category name is required.' });
      return;
    }

    if (!BUDGET_TYPES.has(budgetType)) {
      res.status(400).json({ message: 'Invalid budget type.' });
      return;
    }

    const existing = await get(
      'SELECT id FROM UserCategory WHERE user_id = ? AND LOWER(name) = LOWER(?)',
      [req.userId, trimmedName],
    );

    if (existing?.id) {
      res.status(409).json({ message: 'Category name already exists.' });
      return;
    }

    const result = await run(
      'INSERT INTO UserCategory (user_id, name, budget_type) VALUES (?, ?, ?)',
      [req.userId, trimmedName.slice(0, 255), budgetType],
    );

    res.status(201).json({
      id: result.lastID,
      name: trimmedName.slice(0, 255),
      budget_type: budgetType,
    });
  } catch (error) {
    console.error('Failed to create category:', error);
    res.status(500).json({ message: 'Failed to create category.' });
  }
});

app.get('/api/categories', authenticate, async (req, res) => {
  try {
    const categories = await all(
      'SELECT id, name, budget_type FROM UserCategory WHERE user_id = ? ORDER BY name COLLATE NOCASE',
      [req.userId],
    );

    res.json(categories);
  } catch (error) {
    console.error('Failed to load categories:', error);
    res.status(500).json({ message: 'Failed to load categories.' });
  }
});

app.delete('/api/categories/:id', authenticate, async (req, res) => {
  try {
    const categoryId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      res.status(400).json({ message: 'Invalid category id.' });
      return;
    }

    const category = await get(
      'SELECT id FROM UserCategory WHERE id = ? AND user_id = ?',
      [categoryId, req.userId],
    );

    if (!category?.id) {
      res.status(404).json({ message: 'Category not found.' });
      return;
    }

    const usage = await get(
      'SELECT COUNT(*) AS total FROM Expenditure WHERE user_id = ? AND user_category_id = ?',
      [req.userId, categoryId],
    );

    if ((usage?.total || 0) > 0) {
      res.status(400).json({ message: 'Cannot delete a category that has expenses.' });
      return;
    }

    await run('DELETE FROM UserCategory WHERE id = ? AND user_id = ?', [categoryId, req.userId]);
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete category:', error);
    res.status(500).json({ message: 'Failed to delete category.' });
  }
});

app.post('/api/users/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const trimmedUsername = typeof username === 'string' ? username.trim() : '';
    const passwordValue = typeof password === 'string' ? password : '';

    if (!trimmedUsername || !passwordValue) {
      res.status(400).json({ message: 'Username and password are required.' });
      return;
    }

    const user = await get('SELECT id, password_hash FROM User WHERE username = ?', [trimmedUsername]);

    if (!user?.id) {
      res.status(401).json({ message: 'Invalid username or password.' });
      return;
    }

    const matches = await comparePassword(passwordValue, user.password_hash);

    if (!matches) {
      res.status(401).json({ message: 'Invalid username or password.' });
      return;
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    res.json({ token });
  } catch (error) {
    console.error('Failed to log in user:', error);
    res.status(500).json({ message: 'Failed to log in user.' });
  }
});

app.post('/api/income', authenticate, async (req, res) => {
  try {
    const { amount, source } = req.body;
    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      res.status(400).json({ message: 'Amount must be a positive number.' });
      return;
    }

    const trimmedSource = typeof source === 'string' ? source.trim().slice(0, 255) : '';
    const timestamp = new Date().toISOString();

    const result = await run(
      'INSERT INTO Income (user_id, amount, source, date) VALUES (?, ?, ?, ?)',
      [req.userId, numericAmount, trimmedSource, timestamp],
    );

    res.status(201).json({
      id: result.lastID,
      amount: numericAmount,
      source: trimmedSource,
      date: timestamp,
    });
  } catch (error) {
    console.error('Failed to record income:', error);
    res.status(500).json({ message: 'Failed to record income.' });
  }
});

app.post('/api/expense', authenticate, async (req, res) => {
  try {
    const { amount, description, user_category_id: userCategoryId } = req.body;
    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      res.status(400).json({ message: 'Amount must be a positive number.' });
      return;
    }

    const categoryId = Number.parseInt(userCategoryId, 10);

    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      res.status(400).json({ message: 'A valid category is required.' });
      return;
    }

    const category = await get(
      'SELECT id, name, budget_type FROM UserCategory WHERE id = ? AND user_id = ?',
      [categoryId, req.userId],
    );

    if (!category?.id) {
      res.status(400).json({ message: 'Invalid category selection.' });
      return;
    }

    const trimmedDescription = typeof description === 'string' ? description.trim().slice(0, 255) : '';
    const timestamp = new Date().toISOString();

    const result = await run(
      'INSERT INTO Expenditure (user_id, user_category_id, amount, description, date) VALUES (?, ?, ?, ?, ?)',
      [req.userId, categoryId, numericAmount, trimmedDescription, timestamp],
    );

    res.status(201).json({
      id: result.lastID,
      amount: numericAmount,
      description: trimmedDescription,
      user_category_id: categoryId,
      category,
      date: timestamp,
    });
  } catch (error) {
    console.error('Failed to record expense:', error);
    res.status(500).json({ message: 'Failed to record expense.' });
  }
});

app.post('/api/recurring', authenticate, async (req, res) => {
  try {
    const { description, default_amount: defaultAmount, user_category_id: userCategoryId } = req.body;
    const trimmedDescription = typeof description === 'string' ? description.trim().slice(0, 255) : '';
    const numericAmount = Number(defaultAmount);
    const categoryId = Number.parseInt(userCategoryId, 10);

    if (!trimmedDescription) {
      res.status(400).json({ message: 'Description is required.' });
      return;
    }

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      res.status(400).json({ message: 'Amount must be a positive number.' });
      return;
    }

    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      res.status(400).json({ message: 'A valid category is required.' });
      return;
    }

    const category = await get(
      'SELECT id, name, budget_type FROM UserCategory WHERE id = ? AND user_id = ?',
      [categoryId, req.userId],
    );

    if (!category?.id) {
      res.status(400).json({ message: 'Invalid category selection.' });
      return;
    }

    const result = await run(
      'INSERT INTO RecurringExpenditure (user_id, user_category_id, description, default_amount) VALUES (?, ?, ?, ?)',
      [req.userId, categoryId, trimmedDescription, numericAmount],
    );

    res.status(201).json({
      id: result.lastID,
      description: trimmedDescription,
      default_amount: numericAmount,
      user_category_id: categoryId,
      category,
    });
  } catch (error) {
    console.error('Failed to create recurring template:', error);
    res.status(500).json({ message: 'Failed to create recurring template.' });
  }
});

app.get('/api/recurring', authenticate, async (req, res) => {
  try {
    const templates = await all(
      `
        SELECT r.id,
               r.description,
               r.default_amount,
               r.user_category_id,
               uc.name AS category_name,
               uc.budget_type AS category_budget_type
        FROM RecurringExpenditure r
        INNER JOIN UserCategory uc ON uc.id = r.user_category_id
        WHERE r.user_id = ?
        ORDER BY r.description COLLATE NOCASE
      `,
      [req.userId],
    );

    res.json(templates);
  } catch (error) {
    console.error('Failed to load recurring templates:', error);
    res.status(500).json({ message: 'Failed to load recurring templates.' });
  }
});

app.delete('/api/recurring/:id', authenticate, async (req, res) => {
  try {
    const templateId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(templateId) || templateId <= 0) {
      res.status(400).json({ message: 'Invalid template id.' });
      return;
    }

    const existing = await get(
      'SELECT id FROM RecurringExpenditure WHERE id = ? AND user_id = ?',
      [templateId, req.userId],
    );

    if (!existing?.id) {
      res.status(404).json({ message: 'Template not found.' });
      return;
    }

    await run('DELETE FROM RecurringExpenditure WHERE id = ? AND user_id = ?', [templateId, req.userId]);
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete recurring template:', error);
    res.status(500).json({ message: 'Failed to delete recurring template.' });
  }
});

app.get('/api/budget/dashboard', authenticate, async (req, res) => {
  try {
    const { startIso, endIso } = getCurrentMonthRange();

    const totalIncomeRow = await get(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM Income WHERE user_id = ? AND date >= ? AND date < ?',
      [req.userId, startIso, endIso],
    );
    const totalIncome = Number(totalIncomeRow?.total || 0);

    const spentByCategory = {
      Necessities: 0,
      Leisure: 0,
      Savings: 0,
    };

    const spendingRows = await all(
      `
        SELECT uc.budget_type AS budget_type, COALESCE(SUM(e.amount), 0) AS total
        FROM Expenditure e
        INNER JOIN UserCategory uc ON uc.id = e.user_category_id
        WHERE e.user_id = ? AND e.date >= ? AND e.date < ?
        GROUP BY uc.budget_type
      `,
      [req.userId, startIso, endIso],
    );

    spendingRows.forEach((row) => {
      if (row?.budget_type && spentByCategory[row.budget_type] !== undefined) {
        spentByCategory[row.budget_type] = Number(row.total || 0);
      }
    });

    const incomes = await all(
      'SELECT id, amount, source, date FROM Income WHERE user_id = ? AND date >= ? AND date < ?',
      [req.userId, startIso, endIso],
    );
    const expenses = await all(
      `
        SELECT e.id,
               e.amount,
               e.description,
               e.date,
               uc.name AS category_name,
               uc.budget_type AS category_budget_type
        FROM Expenditure e
        INNER JOIN UserCategory uc ON uc.id = e.user_category_id
        WHERE e.user_id = ? AND e.date >= ? AND e.date < ?
      `,
      [req.userId, startIso, endIso],
    );

    // Merge and sort transactions to highlight the most recent activity.
    const transactions = incomes
      .map((income) => ({
        id: `income-${income.id}`,
        type: 'Income',
        amount: Number(income.amount),
        label: income.source || 'Income',
        detail: 'Income',
        date: income.date,
      }))
      .concat(
        expenses.map((expense) => ({
          id: `expense-${expense.id}`,
          type: 'Expense',
          amount: Number(expense.amount),
          label: expense.category_name || expense.description || 'Expense',
          budgetType: expense.category_budget_type,
          detail: expense.description || '',
          date: expense.date,
        })),
      )
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 20);

    const budgets = {
      Necessities: {
        budget: totalIncome * 0.5,
        spent: spentByCategory.Necessities || 0,
      },
      Leisure: {
        budget: totalIncome * 0.3,
        spent: spentByCategory.Leisure || 0,
      },
      Savings: {
        budget: totalIncome * 0.2,
        spent: spentByCategory.Savings || 0,
      },
    };

    Object.values(budgets).forEach((bucket) => {
      bucket.remaining = bucket.budget - bucket.spent;
    });

    res.json({
      totalIncome,
      budgets,
      transactions,
    });
  } catch (error) {
    console.error('Failed to load dashboard:', error);
    res.status(500).json({ message: 'Failed to load dashboard.' });
  }
});

app.listen(PORT, () => {
  console.log(`BudgetWise MVP server listening on http://localhost:${PORT}`);
});
