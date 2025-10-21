
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
app.use(express.json({ limit: '1mb' }));
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

function parseLimit(rawLimit, defaultValue = 20, maxValue = 50) {
  const parsed = Number.parseInt(rawLimit, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.min(parsed, maxValue);
}

function normalizeSort(value) {
  if (!value) {
    return 'newest';
  }
  return value.toLowerCase() === 'oldest' ? 'oldest' : 'newest';
}

function normalizeType(value) {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  if (normalized === 'income') {
    return 'Income';
  }
  if (normalized === 'expense') {
    return 'Expense';
  }
  return null;
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

function decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
  } catch (error) {
    return null;
  }
}

async function fetchTransactions({
  userId,
  limit = 20,
  sort = 'newest',
  cursor = null,
  typeFilter = null,
  categoryFilter = null,
  dateFrom = null,
  dateTo = null,
}) {
  const normalizedSort = normalizeSort(sort);
  const clampedLimit = Math.min(Math.max(limit, 1), 50);
  const fetchLimit = clampedLimit + 1;

  let cursorCondition = '';
  const cursorParams = [];

  if (cursor) {
    if (
      typeof cursor !== 'object'
      || !cursor.date
      || typeof cursor.typeOrder !== 'number'
      || typeof cursor.id !== 'number'
      || cursor.sort !== normalizedSort
    ) {
      const error = new Error('Invalid cursor.');
      error.statusCode = 400;
      throw error;
    }

    if (normalizedSort === 'newest') {
      cursorCondition = `
        (sort_date < ?
          OR (
            sort_date = ?
            AND (
              type_order > ?
              OR (type_order = ? AND sort_id < ?)
            )
          )
        )`;
      cursorParams.push(
        cursor.date,
        cursor.date,
        cursor.typeOrder,
        cursor.typeOrder,
        cursor.id,
      );
    } else {
      cursorCondition = `
        (sort_date > ?
          OR (
            sort_date = ?
            AND (
              type_order > ?
              OR (type_order = ? AND sort_id > ?)
            )
          )
        )`;
      cursorParams.push(
        cursor.date,
        cursor.date,
        cursor.typeOrder,
        cursor.typeOrder,
        cursor.id,
      );
    }
  }

  const params = [userId, userId];
  const conditions = [];

  if (typeFilter) {
    conditions.push('type = ?');
    params.push(typeFilter);
  }

  if (categoryFilter) {
    if (categoryFilter.kind === 'uncategorized') {
      conditions.push("type = 'Expense' AND user_category_id IS NULL");
    } else if (categoryFilter.kind === 'id') {
      conditions.push("type = 'Expense' AND user_category_id = ?");
      params.push(categoryFilter.value);
    }
  }

  if (dateFrom) {
    conditions.push('sort_date >= ?');
    params.push(dateFrom);
  }

  if (dateTo) {
    conditions.push('sort_date <= ?');
    params.push(dateTo);
  }

  if (cursorCondition) {
    conditions.push(cursorCondition);
    params.push(...cursorParams);
  }

  let baseQuery = `
    SELECT
      sort_date,
      sort_id,
      type_order,
      type,
      amount,
      source,
      description,
      user_category_id,
      category_name,
      category_budget_type
    FROM (
      SELECT
        date AS sort_date,
        id AS sort_id,
        0 AS type_order,
        'Income' AS type,
        amount,
        source,
        NULL AS description,
        NULL AS user_category_id,
        NULL AS category_name,
        NULL AS category_budget_type
      FROM Income
      WHERE user_id = ?
      UNION ALL
      SELECT
        e.date AS sort_date,
        e.id AS sort_id,
        1 AS type_order,
        'Expense' AS type,
        e.amount,
        NULL AS source,
        e.description,
        e.user_category_id,
        uc.name AS category_name,
        uc.budget_type AS category_budget_type
      FROM Expenditure e
      LEFT JOIN UserCategory uc ON uc.id = e.user_category_id
      WHERE e.user_id = ?
    )
  `;

  if (conditions.length) {
    baseQuery += ` WHERE ${conditions.join(' AND ')}`;
  }

  const orderClause =
    normalizedSort === 'oldest'
      ? ' ORDER BY sort_date ASC, type_order ASC, sort_id ASC '
      : ' ORDER BY sort_date DESC, type_order ASC, sort_id DESC ';

  params.push(fetchLimit);

  const rows = await all(`${baseQuery}${orderClause}LIMIT ?`, params);

  let nextCursor = null;
  let items = rows;

  if (rows.length > clampedLimit) {
    const lastRow = rows[clampedLimit];
    nextCursor = encodeCursor({
      sort: normalizedSort,
      date: lastRow.sort_date,
      typeOrder: lastRow.type_order,
      id: lastRow.sort_id,
    });
    items = rows.slice(0, clampedLimit);
  }

  return {
    items: items.map((row) => ({
      id: row.sort_id,
      type: row.type,
      amount: Number(row.amount),
      date: row.sort_date,
      source: row.source,
      description: row.description,
      category_id: row.user_category_id,
      category_name: row.category_name,
      category_budget_type: row.category_budget_type,
      budgetType: row.category_budget_type,
    })),
    nextCursor,
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

    if (trimmedName.length < 1 || trimmedName.length > 40) {
      res.status(400).json({ message: 'Category name must be between 1 and 40 characters.' });
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

    const existingCountRow = await get(
      'SELECT COUNT(*) AS count FROM UserCategory WHERE user_id = ?',
      [req.userId],
    );

    const existingCount = Number(existingCountRow?.count || 0);
    if (existingCount >= 50) {
      res.status(400).json({ message: 'Category limit reached (50).' });
      return;
    }

    const result = await run(
      'INSERT INTO UserCategory (user_id, name, budget_type) VALUES (?, ?, ?)',
      [req.userId, trimmedName, budgetType],
    );

    res.status(201).json({
      id: result.lastID,
      name: trimmedName,
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

app.get('/api/transactions', authenticate, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 20, 50);
    const sort = normalizeSort(req.query.sort);
    const cursorString = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const typeParamRaw = typeof req.query.type === 'string' ? req.query.type : null;
    const categoryParamRaw = typeof req.query.category_id === 'string' ? req.query.category_id : null;
    const fromParam = typeof req.query.from === 'string' ? req.query.from : null;
    const toParam = typeof req.query.to === 'string' ? req.query.to : null;
    const typeParam = typeParamRaw ? typeParamRaw.trim() : null;
    const categoryParam = categoryParamRaw ? categoryParamRaw.trim() : null;

    let decodedCursor = null;
    if (cursorString) {
      decodedCursor = decodeCursor(cursorString);
      if (!decodedCursor || decodedCursor.sort !== sort) {
        res.status(400).json({ message: 'Invalid cursor.' });
        return;
      }
    }

    let typeFilter = null;
    if (typeParam) {
      typeFilter = normalizeType(typeParam);
      if (!typeFilter) {
        res.status(400).json({ message: 'Invalid type parameter.' });
        return;
      }
    }

    let categoryFilter = null;
    if (categoryParam) {
      if (categoryParam.toLowerCase() === 'uncategorized') {
        categoryFilter = { kind: 'uncategorized' };
      } else {
        const parsedCategory = Number.parseInt(categoryParam, 10);
        if (Number.isNaN(parsedCategory) || parsedCategory <= 0) {
          res.status(400).json({ message: 'Invalid category identifier.' });
          return;
        }
        categoryFilter = { kind: 'id', value: parsedCategory };
      }
    }

    if (typeFilter === 'Income' && categoryFilter) {
      res.status(400).json({ message: 'Category filter only applies to expenses.' });
      return;
    }

    let dateFrom = null;
    if (fromParam) {
      const fromValue = new Date(fromParam);
      if (Number.isNaN(fromValue.getTime())) {
        res.status(400).json({ message: 'Invalid from date.' });
        return;
      }
      dateFrom = fromValue.toISOString();
    }

    let dateTo = null;
    if (toParam) {
      const toValue = new Date(toParam);
      if (Number.isNaN(toValue.getTime())) {
        res.status(400).json({ message: 'Invalid to date.' });
        return;
      }
      dateTo = toValue.toISOString();
    }

    if (dateFrom && dateTo && dateFrom > dateTo) {
      res.status(400).json({ message: 'from must be earlier than to.' });
      return;
    }

    const result = await fetchTransactions({
      userId: req.userId,
      limit,
      sort,
      cursor: decodedCursor,
      typeFilter,
      categoryFilter,
      dateFrom,
      dateTo,
    });

    res.json({
      items: result.items,
      nextCursor: result.nextCursor,
    });
  } catch (error) {
    const status = error?.statusCode || 500;
    if (status >= 500) {
      console.error('Failed to load transactions:', error);
    }
    res.status(status).json({ message: error?.message || 'Failed to load transactions.' });
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

    let categoryId = null;
    let category = null;

    if (userCategoryId !== undefined && userCategoryId !== null && userCategoryId !== '') {
      const parsedId = Number.parseInt(userCategoryId, 10);
      if (!Number.isInteger(parsedId) || parsedId <= 0) {
        res.status(400).json({ message: 'Invalid category selection.' });
        return;
      }

      const existingCategory = await get(
        'SELECT id, name, budget_type FROM UserCategory WHERE id = ? AND user_id = ?',
        [parsedId, req.userId],
      );

      if (!existingCategory?.id) {
        res.status(400).json({ message: 'Invalid category selection.' });
        return;
      }

      categoryId = parsedId;
      category = existingCategory;
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
    const trimmedDescription = typeof description === 'string' ? description.trim() : '';
    const numericAmount = Number(defaultAmount);
    const categoryId = Number.parseInt(userCategoryId, 10);

    if (!trimmedDescription) {
      res.status(400).json({ message: 'Description is required.' });
      return;
    }

    if (trimmedDescription.length > 255) {
      res.status(400).json({ message: 'Description must be 255 characters or fewer.' });
      return;
    }

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      res.status(400).json({ message: 'Amount must be a positive number.' });
      return;
    }

    const normalizedAmount = Math.round(numericAmount * 100) / 100;
    if (Math.abs(normalizedAmount - numericAmount) > 1e-8) {
      res.status(400).json({ message: 'Amount must have at most two decimal places.' });
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

    const recurringCountRow = await get(
      'SELECT COUNT(*) AS count FROM RecurringExpenditure WHERE user_id = ?',
      [req.userId],
    );
    const recurringCount = Number(recurringCountRow?.count || 0);
    if (recurringCount >= 50) {
      res.status(400).json({ message: 'Recurring template limit reached (50).' });
      return;
    }

    const result = await run(
      'INSERT INTO RecurringExpenditure (user_id, user_category_id, description, default_amount) VALUES (?, ?, ?, ?)',
      [req.userId, categoryId, trimmedDescription, normalizedAmount],
    );

    res.status(201).json({
      id: result.lastID,
      description: trimmedDescription,
      default_amount: normalizedAmount,
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

app.get('/api/reports/spending-by-category', authenticate, async (req, res) => {
  try {
    const { startIso, endIso } = getCurrentMonthRange();

    const rows = await all(
      `
        SELECT
          COALESCE(uc.name, 'Uncategorized') AS name,
          COALESCE(SUM(e.amount), 0) AS total
        FROM Expenditure e
        LEFT JOIN UserCategory uc ON uc.id = e.user_category_id
        WHERE e.user_id = ? AND e.date >= ? AND e.date < ?
        GROUP BY uc.name
        ORDER BY total DESC
      `,
      [req.userId, startIso, endIso],
    );

    res.json(
      rows.map((row) => ({
        name: row.name,
        total: Number(row.total || 0),
      })),
    );
  } catch (error) {
    console.error('Failed to load spending by category:', error);
    res.status(500).json({ message: 'Failed to load spending by category.' });
  }
});

app.get('/api/templates/export', authenticate, async (req, res) => {
  try {
    const categories = await all(
      `
        SELECT name, budget_type
        FROM UserCategory
        WHERE user_id = ?
        ORDER BY name COLLATE NOCASE
      `,
      [req.userId],
    );

    const recurring = await all(
      `
        SELECT r.description, r.default_amount, uc.name AS category_name
        FROM RecurringExpenditure r
        LEFT JOIN UserCategory uc ON uc.id = r.user_category_id
        WHERE r.user_id = ?
        ORDER BY r.description COLLATE NOCASE
      `,
      [req.userId],
    );

    const payload = {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      categories: categories.map((category) => ({
        name: category.name,
        budget_type: category.budget_type,
      })),
      recurring: recurring
        .filter((item) => item.category_name)
        .map((item) => ({
          description: item.description,
          default_amount: Number(item.default_amount),
          category_name: item.category_name,
        })),
    };

    const fileName = `budgetwise-template-${new Date().toISOString().slice(0, 10)}.json`;
    res.set({
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });
    res.send(`${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    console.error('Failed to export template:', error);
    res.status(500).json({ message: 'Failed to export template.' });
  }
});

app.post('/api/templates/import', authenticate, async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      res.status(400).json({ message: 'Invalid template payload.' });
      return;
    }

    const { version, categories = [], recurring = [] } = payload;

    if (version !== '1.0') {
      res.status(400).json({ message: 'Unsupported template version.' });
      return;
    }

    if (!Array.isArray(categories) || categories.length > 100) {
      res.status(400).json({ message: 'Invalid categories list (max 100).' });
      return;
    }

    if (!Array.isArray(recurring) || recurring.length > 200) {
      res.status(400).json({ message: 'Invalid recurring list (max 200).' });
      return;
    }

    const payloadCategoryMap = new Map();
    let skippedCategoryDuplicates = 0;
    categories.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        throw Object.assign(new Error('Invalid category entry.'), { statusCode: 400 });
      }
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const budgetType = item.budget_type;

      if (!name || name.length > 40) {
        throw Object.assign(new Error(`Category name at index ${index} must be 1-40 characters.`), { statusCode: 400 });
      }

      if (!BUDGET_TYPES.has(budgetType)) {
        throw Object.assign(new Error(`Invalid budget type for category "${name}".`), { statusCode: 400 });
      }

      const key = name.toLowerCase();
      if (payloadCategoryMap.has(key)) {
        skippedCategoryDuplicates += 1;
        return;
      }

      payloadCategoryMap.set(key, { name, budget_type: budgetType });
    });

    const normalizedRecurring = [];
    const recurringPayloadKeys = new Set();
    let recurringDuplicateCount = 0;

    recurring.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        throw Object.assign(new Error('Invalid recurring entry.'), { statusCode: 400 });
      }

      const description =
        typeof item.description === 'string' ? item.description.trim() : '';
      const amountValue = Number(item.default_amount);
      const categoryName =
        typeof item.category_name === 'string' ? item.category_name.trim() : '';

      if (!description) {
        throw Object.assign(new Error(`Recurring description at index ${index} is required.`), { statusCode: 400 });
      }

      if (description.length > 255) {
        throw Object.assign(new Error(`Recurring description "${description}" is too long (max 255).`), {
          statusCode: 400,
        });
      }

      if (!Number.isFinite(amountValue) || amountValue <= 0) {
        throw Object.assign(new Error(`Recurring amount for "${description}" must be positive.`), { statusCode: 400 });
      }

      const normalizedAmount = Math.round(amountValue * 100) / 100;
      if (Math.abs(normalizedAmount - amountValue) > 1e-8) {
        throw Object.assign(new Error(`Recurring amount for "${description}" must have at most two decimals.`), {
          statusCode: 400,
        });
      }

      if (!categoryName) {
        throw Object.assign(new Error(`Recurring entry "${description}" must reference a category name.`), {
          statusCode: 400,
        });
      }

      const categoryKey = categoryName.toLowerCase();
      if (!payloadCategoryMap.has(categoryKey)) {
        throw Object.assign(
          new Error(`Recurring entry "${description}" references unknown category "${categoryName}".`),
          { statusCode: 400 },
        );
      }

      const dedupeKey = `${description.toLowerCase()}|${normalizedAmount.toFixed(2)}|${categoryKey}`;
      if (recurringPayloadKeys.has(dedupeKey)) {
        recurringDuplicateCount += 1;
        return;
      }
      recurringPayloadKeys.add(dedupeKey);
      normalizedRecurring.push({
        description,
        amount: normalizedAmount,
        categoryKey,
      });
    });

    const existingCategories = await all(
      'SELECT id, name FROM UserCategory WHERE user_id = ?',
      [req.userId],
    );

    const categoryMap = new Map();
    existingCategories.forEach((category) => {
      categoryMap.set(category.name.toLowerCase(), { id: category.id, name: category.name });
    });

    const existingCategoryCount = existingCategories.length;
    const potentialNewCategories = Array.from(payloadCategoryMap.entries()).filter(
      ([key]) => !categoryMap.has(key),
    );

    if (existingCategoryCount + potentialNewCategories.length > 50) {
      res.status(400).json({ message: 'Import would exceed the category limit (50).' });
      return;
    }

    const existingRecurringRows = await all(
      'SELECT description, default_amount, user_category_id FROM RecurringExpenditure WHERE user_id = ?',
      [req.userId],
    );

    const existingRecurringSet = new Set(
      existingRecurringRows.map((row) => `${row.description.toLowerCase()}|${Number(row.default_amount).toFixed(2)}|${row.user_category_id}`),
    );

    let insertedCategories = 0;
    let skippedCategories = skippedCategoryDuplicates;
    let insertedRecurring = 0;
    let skippedRecurring = recurringDuplicateCount;

    try {
      await run('BEGIN TRANSACTION');

      for (const [key, cat] of potentialNewCategories) {
        const result = await run(
          'INSERT INTO UserCategory (user_id, name, budget_type) VALUES (?, ?, ?)',
          [req.userId, cat.name, cat.budget_type],
        );
        categoryMap.set(key, { id: result.lastID, name: cat.name });
        insertedCategories += 1;
      }

      // Existing categories from payload that already existed should be counted as skipped
      skippedCategories += payloadCategoryMap.size - potentialNewCategories.length;

      let currentRecurringCount = existingRecurringRows.length;

      for (const recurringItem of normalizedRecurring) {
        const categoryRecord = categoryMap.get(recurringItem.categoryKey);
        if (!categoryRecord) {
          throw Object.assign(
            new Error(`Category mapping failed for "${recurringItem.categoryKey}".`),
            { statusCode: 500 },
          );
        }

        const key = `${recurringItem.description.toLowerCase()}|${recurringItem.amount.toFixed(2)}|${categoryRecord.id}`;
        if (existingRecurringSet.has(key)) {
          skippedRecurring += 1;
          continue;
        }

        if (currentRecurringCount >= 50) {
          throw Object.assign(new Error('Import would exceed the recurring template limit (50).'), {
            statusCode: 400,
          });
        }

        await run(
          'INSERT INTO RecurringExpenditure (user_id, user_category_id, description, default_amount) VALUES (?, ?, ?, ?)',
          [req.userId, categoryRecord.id, recurringItem.description, recurringItem.amount],
        );
        existingRecurringSet.add(key);
        insertedRecurring += 1;
        currentRecurringCount += 1;
      }

      await run('COMMIT');
    } catch (transactionError) {
      await run('ROLLBACK');
      if (transactionError?.statusCode === 500) {
        throw transactionError;
      }
      throw transactionError;
    }

    res.json({
      inserted: {
        categories: insertedCategories,
        recurring: insertedRecurring,
      },
      skipped: {
        categories: skippedCategories,
        recurring: skippedRecurring,
      },
    });
  } catch (error) {
    if (error?.statusCode) {
      res.status(error.statusCode).json({ message: error.message });
      return;
    }
    if (error?.type === 'entity.too.large' || error?.message?.includes('payload too large')) {
      res.status(413).json({ message: 'Template exceeds 1MB limit.' });
      return;
    }
    console.error('Failed to import template:', error);
    res.status(500).json({ message: 'Failed to import template.' });
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
        LEFT JOIN UserCategory uc ON uc.id = e.user_category_id
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
        LEFT JOIN UserCategory uc ON uc.id = e.user_category_id
        WHERE e.user_id = ? AND e.date >= ? AND e.date < ?
      `,
      [req.userId, startIso, endIso],
    );

    // Merge and sort transactions to highlight the most recent activity.
    const { items: recentTransactions, nextCursor } = await fetchTransactions({
      userId: req.userId,
      limit: 10,
      sort: 'newest',
    });

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
      transactions: recentTransactions,
      hasMore: Boolean(nextCursor),
      nextCursor,
    });
  } catch (error) {
    console.error('Failed to load dashboard:', error);
    res.status(500).json({ message: 'Failed to load dashboard.' });
  }
});

app.listen(PORT, () => {
  console.log(`BudgetWise MVP server listening on http://localhost:${PORT}`);
});
