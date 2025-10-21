
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
    const { amount, description, budget_type: budgetType } = req.body;
    const numericAmount = Number(amount);
    const allowedTypes = new Set(['Necessities', 'Leisure', 'Savings']);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      res.status(400).json({ message: 'Amount must be a positive number.' });
      return;
    }

    if (!allowedTypes.has(budgetType)) {
      res.status(400).json({ message: 'Invalid budget type.' });
      return;
    }

    const trimmedDescription = typeof description === 'string' ? description.trim().slice(0, 255) : '';
    const timestamp = new Date().toISOString();

    const result = await run(
      'INSERT INTO Expenditure (user_id, amount, description, budget_type, date) VALUES (?, ?, ?, ?, ?)',
      [req.userId, numericAmount, trimmedDescription, budgetType, timestamp],
    );

    res.status(201).json({
      id: result.lastID,
      amount: numericAmount,
      description: trimmedDescription,
      budget_type: budgetType,
      date: timestamp,
    });
  } catch (error) {
    console.error('Failed to record expense:', error);
    res.status(500).json({ message: 'Failed to record expense.' });
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

    const categories = ['Necessities', 'Leisure', 'Savings'];
    const spentByCategory = {};

    await Promise.all(
      categories.map(async (category) => {
        const row = await get(
          'SELECT COALESCE(SUM(amount), 0) AS total FROM Expenditure WHERE user_id = ? AND budget_type = ? AND date >= ? AND date < ?',
          [req.userId, category, startIso, endIso],
        );
        spentByCategory[category] = Number(row?.total || 0);
      }),
    );

    const incomes = await all(
      'SELECT id, amount, source, date FROM Income WHERE user_id = ? AND date >= ? AND date < ?',
      [req.userId, startIso, endIso],
    );
    const expenses = await all(
      'SELECT id, amount, description, budget_type, date FROM Expenditure WHERE user_id = ? AND date >= ? AND date < ?',
      [req.userId, startIso, endIso],
    );

    // Merge and sort transactions to highlight the most recent activity.
    const transactions = incomes
      .map((income) => ({
        id: `income-${income.id}`,
        type: 'Income',
        amount: Number(income.amount),
        label: income.source || 'Income',
        date: income.date,
      }))
      .concat(
        expenses.map((expense) => ({
          id: `expense-${expense.id}`,
          type: expense.budget_type,
          amount: Number(expense.amount),
          label: expense.description || 'Expense',
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
