
const path = require('path');
const express = require('express');
const cors = require('cors');

const { initializeDatabase, run, get, all } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

initializeDatabase();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

app.post('/api/income', async (req, res) => {
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
      'INSERT INTO Income (amount, source, date) VALUES (?, ?, ?)',
      [numericAmount, trimmedSource, timestamp],
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

app.post('/api/expense', async (req, res) => {
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
      'INSERT INTO Expenditure (amount, description, budget_type, date) VALUES (?, ?, ?, ?)',
      [numericAmount, trimmedDescription, budgetType, timestamp],
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

app.get('/api/budget/dashboard', async (req, res) => {
  try {
    const { startIso, endIso } = getCurrentMonthRange();

    const totalIncomeRow = await get(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM Income WHERE date >= ? AND date < ?',
      [startIso, endIso],
    );
    const totalIncome = Number(totalIncomeRow?.total || 0);

    const categories = ['Necessities', 'Leisure', 'Savings'];
    const spentByCategory = {};

    await Promise.all(
      categories.map(async (category) => {
        const row = await get(
          'SELECT COALESCE(SUM(amount), 0) AS total FROM Expenditure WHERE budget_type = ? AND date >= ? AND date < ?',
          [category, startIso, endIso],
        );
        spentByCategory[category] = Number(row?.total || 0);
      }),
    );

    const incomes = await all(
      'SELECT id, amount, source, date FROM Income WHERE date >= ? AND date < ?',
      [startIso, endIso],
    );
    const expenses = await all(
      'SELECT id, amount, description, budget_type, date FROM Expenditure WHERE date >= ? AND date < ?',
      [startIso, endIso],
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
