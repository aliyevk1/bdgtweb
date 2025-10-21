/* global document, window, localStorage */

(() => {
  'use strict';

  const existingToken = localStorage.getItem('token');
  if (!existingToken) {
    window.location.href = '/login.html';
    return;
  }

  const formatCurrency = (amount) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(Number.isFinite(amount) ? amount : 0);

  const statusMessage = document.getElementById('status-message');
  const exportTemplateButton = document.getElementById('export-template-button');
  const importTemplateInput = document.getElementById('import-template-input');
  const categoryListEl = document.getElementById('category-list');
  const categoryEmptyEl = document.getElementById('category-empty-state');
  const recurringListEl = document.getElementById('recurring-list');
  const recurringEmptyEl = document.getElementById('recurring-empty-state');
  const recurringCategorySelect = document.getElementById('recurring-category');
  const recurringCategoryEmptyHint = document.getElementById('recurring-category-empty');

  let categoriesCache = [];

  const setStatus = (message, isError = false) => {
    if (!statusMessage) {
      return;
    }

    if (!message) {
      statusMessage.textContent = '';
      statusMessage.className = 'hidden';
      return;
    }

    statusMessage.textContent = message;
    statusMessage.className = isError
      ? 'rounded bg-red-100 p-3 text-sm text-red-700'
      : 'rounded bg-emerald-100 p-3 text-sm text-emerald-700';
  };

  const handleUnauthorized = () => {
    localStorage.removeItem('token');
    window.location.href = '/login.html';
  };

  const requireAuthHeaders = (extraHeaders = {}) => {
    const token = localStorage.getItem('token');
    if (!token) {
      handleUnauthorized();
      return null;
    }

    return {
      ...extraHeaders,
      Authorization: `Bearer ${token}`,
    };
  };

  const renderCategoryList = (categories) => {
    if (!categoryListEl || !categoryEmptyEl) {
      return;
    }

    categoryListEl.innerHTML = '';

    if (!categories || categories.length === 0) {
      categoryEmptyEl.classList.remove('hidden');
      return;
    }

    categoryEmptyEl.classList.add('hidden');

    categories.forEach((category) => {
      const item = document.createElement('li');
      item.className = 'flex items-center justify-between gap-4 py-3';

      const meta = document.createElement('div');
      meta.className = 'flex flex-col';

      const name = document.createElement('span');
      name.className = 'font-medium';
      name.textContent = category.name;

      const badge = document.createElement('span');
      badge.className = 'text-xs uppercase tracking-wide text-slate-500';
      badge.textContent = category.budget_type;

      meta.appendChild(name);
      meta.appendChild(badge);

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'rounded border border-red-200 px-3 py-1 text-xs font-semibold text-red-600 hover:bg-red-50';
      deleteButton.textContent = 'Delete';
      deleteButton.addEventListener('click', async () => {
        const confirmed = window.confirm(
          `Delete "${category.name}"? Expenses linked to this category must be removed first.`,
        );
        if (!confirmed) {
          return;
        }

        try {
          const headers = requireAuthHeaders();
          if (!headers) {
            return;
          }

          const response = await fetch(`/api/categories/${category.id}`, {
            method: 'DELETE',
            headers,
          });

          if (response.status === 401) {
            handleUnauthorized();
            return;
          }

          if (response.status === 400) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.message || 'Cannot delete category with expenses.');
          }

          if (!response.ok && response.status !== 204) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.message || 'Failed to delete category.');
          }

          setStatus('Category deleted.');
          await loadCategories();
        } catch (error) {
          console.error('Delete category error:', error);
          setStatus(error.message, true);
        }
      });

      item.appendChild(meta);
      item.appendChild(deleteButton);
      categoryListEl.appendChild(item);
    });
  };

  const renderRecurringCategoryOptions = (categories) => {
    if (!recurringCategorySelect || !recurringCategoryEmptyHint) {
      return;
    }

    recurringCategorySelect.innerHTML = '';

    if (!categories || categories.length === 0) {
      recurringCategorySelect.disabled = true;
      recurringCategoryEmptyHint.classList.remove('hidden');
      return;
    }

    recurringCategorySelect.disabled = false;
    recurringCategoryEmptyHint.classList.add('hidden');

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select category';
    placeholder.disabled = true;
    placeholder.selected = true;
    recurringCategorySelect.appendChild(placeholder);

    categories.forEach((category) => {
      const option = document.createElement('option');
      option.value = category.id;
      option.textContent = `${category.name} (${category.budget_type})`;
      recurringCategorySelect.appendChild(option);
    });
  };

  const renderRecurringList = (templates) => {
    if (!recurringListEl || !recurringEmptyEl) {
      return;
    }

    recurringListEl.innerHTML = '';

    if (!templates || templates.length === 0) {
      recurringEmptyEl.classList.remove('hidden');
      return;
    }

    recurringEmptyEl.classList.add('hidden');

    templates.forEach((template) => {
      const item = document.createElement('li');
      item.className = 'flex items-center justify-between gap-4 py-3';

      const meta = document.createElement('div');
      meta.className = 'flex flex-col';

      const name = document.createElement('span');
      name.className = 'font-medium';
      name.textContent = template.description;

      const subtitle = document.createElement('span');
      subtitle.className = 'text-xs uppercase tracking-wide text-slate-500';
      subtitle.textContent = `${formatCurrency(template.default_amount)} • ${template.category_name} (${template.category_budget_type})`;

      meta.appendChild(name);
      meta.appendChild(subtitle);

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'rounded border border-red-200 px-3 py-1 text-xs font-semibold text-red-600 hover:bg-red-50';
      deleteButton.textContent = 'Delete';
      deleteButton.addEventListener('click', async () => {
        const confirmed = window.confirm(
          `Delete recurring template "${template.description}"?`,
        );
        if (!confirmed) {
          return;
        }

        try {
          const headers = requireAuthHeaders();
          if (!headers) {
            return;
          }

          const response = await fetch(`/api/recurring/${template.id}`, {
            method: 'DELETE',
            headers,
          });

          if (response.status === 401) {
            handleUnauthorized();
            return;
          }

          if (!response.ok && response.status !== 204) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.message || 'Failed to delete template.');
          }

          setStatus('Recurring template deleted.');
          await loadRecurring();
        } catch (error) {
          console.error('Delete recurring template error:', error);
          setStatus(error.message, true);
        }
      });

      item.appendChild(meta);
      item.appendChild(deleteButton);
      recurringListEl.appendChild(item);
    });
  };

  const loadCategories = async () => {
    try {
      const headers = requireAuthHeaders();
      if (!headers) {
        return [];
      }

      const response = await fetch('/api/categories', { headers });
      if (response.status === 401) {
        handleUnauthorized();
        return [];
      }

      if (!response.ok) {
        throw new Error('Unable to load categories.');
      }

      const data = await response.json();
      categoriesCache = Array.isArray(data) ? data : [];
      renderCategoryList(categoriesCache);
      renderRecurringCategoryOptions(categoriesCache);
      return categoriesCache;
    } catch (error) {
      console.error(error);
      setStatus(error.message, true);
      categoriesCache = [];
      renderCategoryList(categoriesCache);
      renderRecurringCategoryOptions(categoriesCache);
      return [];
    }
  };

  const loadRecurring = async () => {
    try {
      const headers = requireAuthHeaders();
      if (!headers) {
        return [];
      }

      const response = await fetch('/api/recurring', { headers });
      if (response.status === 401) {
        handleUnauthorized();
        return [];
      }

      if (!response.ok) {
        throw new Error('Unable to load recurring templates.');
      }

      const templates = await response.json();
      renderRecurringList(Array.isArray(templates) ? templates : []);
      return templates;
    } catch (error) {
      console.error(error);
      setStatus(error.message, true);
      renderRecurringList([]);
      return [];
    }
  };

  const exportTemplate = async () => {
    try {
      const headers = requireAuthHeaders();
      if (!headers) {
        return;
      }

      const response = await fetch('/api/templates/export', { headers });
      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Failed to export template.');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.href = url;
      link.download = `budgetwise-template-${timestamp}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      setStatus('Template exported successfully.');
    } catch (error) {
      console.error('Export template error:', error);
      setStatus(error.message, true);
    }
  };

  const importTemplateFromFile = async (file) => {
    try {
      if (!file) {
        return;
      }

      if (file.size > 1024 * 1024) {
        throw new Error('Template files must be 1 MB or smaller.');
      }

      const fileText = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(fileText);
      } catch (parseError) {
        throw new Error('Selected file is not valid JSON.');
      }

      const headers = requireAuthHeaders({
        'Content-Type': 'application/json',
      });
      if (!headers) {
        return;
      }

      const response = await fetch('/api/templates/import', {
        method: 'POST',
        headers,
        body: JSON.stringify(parsed),
      });

      const payload = await response.json().catch(() => ({}));

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      if (!response.ok) {
        throw new Error(payload.message || 'Failed to import template.');
      }

      const insertedCategories = payload?.inserted?.categories ?? 0;
      const insertedRecurring = payload?.inserted?.recurring ?? 0;
      const skippedCategories = payload?.skipped?.categories ?? 0;
      const skippedRecurring = payload?.skipped?.recurring ?? 0;

      setStatus(
        `Import complete. Categories added: ${insertedCategories} (skipped ${skippedCategories}), Recurring added: ${insertedRecurring} (skipped ${skippedRecurring}).`,
      );
      await loadCategories();
      await loadRecurring();
    } catch (error) {
      console.error('Import template error:', error);
      setStatus(error.message, true);
    } finally {
      if (importTemplateInput) {
        importTemplateInput.value = '';
      }
    }
  };

  document.addEventListener('DOMContentLoaded', async () => {
    const logoutButton = document.getElementById('logout-button');
    const categoryForm = document.getElementById('category-form');
    const recurringForm = document.getElementById('recurring-form');

    if (logoutButton) {
      logoutButton.addEventListener('click', () => {
        localStorage.removeItem('token');
        window.location.href = '/login.html';
      });
    }

    if (exportTemplateButton) {
      exportTemplateButton.addEventListener('click', () => {
        setStatus('');
        exportTemplate();
      });
    }

    if (importTemplateInput) {
      importTemplateInput.addEventListener('change', (event) => {
        setStatus('');
        const [file] = event.target.files || [];
        importTemplateFromFile(file);
      });
    }

    if (categoryForm) {
      categoryForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        setStatus('');

        const formData = new FormData(categoryForm);
        const name = (formData.get('name') || '').toString().trim();
        const budgetType = formData.get('budget_type');

        if (!name) {
          setStatus('Please provide a category name.', true);
          return;
        }

        if (name.length > 40) {
          setStatus('Category name must be 40 characters or fewer.', true);
          return;
        }

        try {
          const headers = requireAuthHeaders({
            'Content-Type': 'application/json',
          });
          if (!headers) {
            return;
          }

          const response = await fetch('/api/categories', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name, budget_type: budgetType }),
          });

          if (response.status === 401) {
            handleUnauthorized();
            return;
          }

          const payload = await response.json().catch(() => ({}));

          if (!response.ok) {
            const message = payload.message || 'Failed to create category.';
            throw new Error(message);
          }

          categoryForm.reset();
          setStatus(`"${payload.name}" added to ${payload.budget_type}.`);
          await loadCategories();
          await loadRecurring();
        } catch (error) {
          console.error('Create category error:', error);
          setStatus(error.message, true);
        }
      });
    }

    if (recurringForm) {
      recurringForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        setStatus('');

        const formData = new FormData(recurringForm);
        const description = (formData.get('description') || '').toString().trim();
        const defaultAmount = Number(formData.get('default_amount'));
        const categoryId = Number.parseInt(formData.get('user_category_id'), 10);

        if (!description) {
          setStatus('Please provide a description for the template.', true);
          return;
        }

        if (description.length > 255) {
          setStatus('Description must be 255 characters or fewer.', true);
          return;
        }

        if (!Number.isFinite(defaultAmount) || defaultAmount <= 0) {
          setStatus('Default amount must be greater than zero.', true);
          return;
        }

        const normalizedAmount = Math.round(defaultAmount * 100) / 100;
        if (Math.abs(normalizedAmount - defaultAmount) > 1e-8) {
          setStatus('Default amount must have at most two decimal places.', true);
          return;
        }

        if (!Number.isInteger(categoryId) || categoryId <= 0) {
          setStatus('Please select a category for the template.', true);
          return;
        }

        try {
          const headers = requireAuthHeaders({
            'Content-Type': 'application/json',
          });
          if (!headers) {
            return;
          }

          const response = await fetch('/api/recurring', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              description,
              default_amount: normalizedAmount,
              user_category_id: categoryId,
            }),
          });

          const payload = await response.json().catch(() => ({}));

          if (!response.ok) {
            const message = payload.message || 'Failed to create recurring template.';
            throw new Error(message);
          }

          recurringForm.reset();
          setStatus(`Recurring template "${payload.description}" created.`);
          await loadRecurring();
        } catch (error) {
          console.error('Create recurring template error:', error);
          setStatus(error.message, true);
        }
      });
    }

    await loadCategories();
    await loadRecurring();
  });
})();
