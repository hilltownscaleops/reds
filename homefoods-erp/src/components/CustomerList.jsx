import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { MEAL_LABELS, MEAL_ORDER, formatCurrency, formatPreference, normalizeMealPlan, toNumber } from '../erpHelpers';

const emptyCustomerDraft = {
  id: '',
  name: '',
  mobile: '',
  geo_point: '',
  preference: 'veg',
  meal_plan: [],
  start_date: '',
  end_date: '',
};

const emptySettingsDraft = {
  id: '',
  base_breakfast: '0',
  base_lunch: '0',
  base_dinner: '0',
  nv_premium: '0',
};

function createCustomerDraft(customer) {
  if (!customer) return emptyCustomerDraft;

  return {
    id: customer.id,
    name: customer.name ?? '',
    mobile: customer.mobile ?? '',
    geo_point: customer.geo_point ?? '',
    preference: String(customer.preference ?? 'veg').toLowerCase(),
    meal_plan: normalizeMealPlan(customer.meal_plan),
    start_date: customer.start_date ?? '',
    end_date: customer.end_date ?? '',
  };
}

function createSettingsDraft(settings) {
  return {
    id: settings?.id ?? '',
    base_breakfast: String(settings?.base_breakfast ?? 0),
    base_lunch: String(settings?.base_lunch ?? 0),
    base_dinner: String(settings?.base_dinner ?? settings?.base_lunch ?? 0),
    nv_premium: String(settings?.nv_premium ?? 0),
  };
}

function isArchivedCustomer(customer) {
  if (!customer) return false;

  if (typeof customer.is_archived === 'boolean') {
    return customer.is_archived;
  }

  if (typeof customer.active === 'boolean') {
    return !customer.active;
  }

  return Boolean(customer.archived_at);
}

async function persistArchiveState(customerId, archived) {
  const attempts = [
    archived ? { archived_at: new Date().toISOString() } : { archived_at: null },
    { is_archived: archived },
    { active: !archived },
  ];

  let lastError = null;

  for (const payload of attempts) {
    const { error } = await supabase.from('customers').update(payload).eq('id', customerId);
    if (!error) return { error: null };
    lastError = error;
  }

  return { error: lastError };
}

export default function CustomerList() {
  const [customers, setCustomers] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [customerDraft, setCustomerDraft] = useState(emptyCustomerDraft);
  const [settingsDraft, setSettingsDraft] = useState(emptySettingsDraft);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setMessage('');

      const [customerResult, settingsResult] = await Promise.all([
        supabase.from('customers').select('*').order('name', { ascending: true }),
        supabase.from('global_settings').select('*').maybeSingle(),
      ]);

      if (cancelled) return;

      if (customerResult.error || settingsResult?.error) {
        setMessage(customerResult.error?.message ?? settingsResult?.error?.message ?? 'Unable to load customers.');
        setCustomers([]);
        setSettings(null);
      } else {
        const fetchedCustomers = customerResult.data ?? [];
        const fetchedSettings = settingsResult?.data ?? null;

        setCustomers(fetchedCustomers);
        setSettings(fetchedSettings);
        setSettingsDraft(createSettingsDraft(fetchedSettings));

        if (fetchedCustomers.length > 0) {
          const firstCustomer = fetchedCustomers[0];
          setSelectedCustomerId(String(firstCustomer.id));
          setCustomerDraft(createCustomerDraft(firstCustomer));
        } else {
          setSelectedCustomerId('');
          setCustomerDraft(emptyCustomerDraft);
        }
      }
      setLoading(false);
    }

    fetchData();

    return () => {
      cancelled = true;
    };
  }, []);

  function selectCustomer(customerId) {
    setSelectedCustomerId(customerId);

    if (customerId === 'new') {
      setCustomerDraft(emptyCustomerDraft);
      return;
    }

    const selectedCustomer = customers.find((customer) => String(customer.id) === String(customerId));
    if (selectedCustomer) {
      setCustomerDraft(createCustomerDraft(selectedCustomer));
    }
  }

  function toggleMeal(meal) {
    setCustomerDraft((previous) => ({
      ...previous,
      meal_plan: previous.meal_plan.includes(meal)
        ? previous.meal_plan.filter((entry) => entry !== meal)
        : [...previous.meal_plan, meal],
    }));
  }

  async function saveCustomer() {
    if (!customerDraft.name.trim()) {
      setMessage('A customer name is required.');
      return;
    }

    setSavingCustomer(true);
    setMessage('');

    const payload = {
      name: customerDraft.name.trim(),
      mobile: customerDraft.mobile.trim() || null,
      geo_point: customerDraft.geo_point.trim() || null,
      preference: customerDraft.preference,
      meal_plan: customerDraft.meal_plan,
      start_date: customerDraft.start_date || null,
      end_date: customerDraft.end_date || null,
    };

    let error, data;
    const isNew = selectedCustomerId === 'new';

    if (isNew) {
      const response = await supabase.from('customers').insert([payload]).select();
      error = response.error;
      data = response.data;
    } else {
      const response = await supabase.from('customers').update(payload).eq('id', selectedCustomerId).select();
      error = response.error;
      data = response.data;
    }

    if (error) {
      setMessage(error.message ?? 'Unable to save customer.');
    } else {
      setMessage(isNew ? 'New customer created successfully.' : 'Customer details saved.');
      
      const { data: updatedList } = await supabase.from('customers').select('*').order('name', { ascending: true });
      setCustomers(updatedList ?? []);

      if (isNew && data?.[0]) {
        setSelectedCustomerId(String(data[0].id));
        setCustomerDraft(createCustomerDraft(data[0]));
      }
    }

    setSavingCustomer(false);
  }

  async function savePricing() {
    setSavingSettings(true);
    setMessage('');

    const payload = {
      id: settingsDraft.id || settings?.id || 1,
      base_breakfast: toNumber(settingsDraft.base_breakfast),
      base_lunch: toNumber(settingsDraft.base_lunch),
      base_dinner: toNumber(settingsDraft.base_dinner),
      nv_premium: toNumber(settingsDraft.nv_premium),
    };

    const { error } = await supabase.from('global_settings').upsert(payload, { onConflict: 'id' });

    if (error) {
      setMessage(error.message ?? 'Unable to save pricing settings.');
    } else {
      setMessage('Pricing settings saved.');
      const { data } = await supabase.from('global_settings').select('*').maybeSingle();
      setSettings(data ?? null);
    }
    setSavingSettings(false);
  }

  async function toggleArchive(customer) {
    setMessage('');
    const { error } = await persistArchiveState(customer.id, !isArchivedCustomer(customer));

    if (error) {
      setMessage(error.message ?? 'Unable to update archive state.');
      return;
    }

    setMessage(isArchivedCustomer(customer) ? 'Customer restored.' : 'Customer archived.');
    const { data } = await supabase.from('customers').select('*').order('name', { ascending: true });
    setCustomers(data ?? []);
  }

  return (
    <section className="panel">
      <div className="panel__header">
        <div>
          <span className="eyebrow">Customers</span>
          <h2>Edit customer details and base pricing</h2>
          <p>Update subscription windows, meal plans, and base meal costs from the app.</p>
        </div>
      </div>

      <div className="summary-strip">
        <div className="summary-card">
          <span>Customer count</span>
          <strong>{customers.length}</strong>
        </div>
        <div className="summary-card">
          <span>Status</span>
          <strong>{loading ? 'Loading' : 'Ready'}</strong>
        </div>
        <div className="summary-card">
          <span>Breakfast cost</span>
          <strong>{settings ? formatCurrency(settings.base_breakfast) : '—'}</strong>
        </div>
      </div>

      {message ? <div className="message-banner">{message}</div> : null}

      <div className="editor-grid">
        <article className="editor-panel">
          <div className="editor-panel__header">
            <div>
              <span className="eyebrow">Customer editor</span>
              <h3>Customer details</h3>
            </div>

            {}
            <label className="field field--date">
              <span>Customer</span>
              <select value={selectedCustomerId} onChange={(event) => selectCustomer(event.target.value)}>
                <optgroup label="Actions">
                  <option value="new">+ Add New Customer</option>
                </optgroup>
                <optgroup label="Existing Customers">
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
          </div>

          <div className="form-grid form-grid--customer">
            <label className="field">
              <span>Name</span>
              <input
                value={customerDraft.name}
                onChange={(event) => setCustomerDraft((previous) => ({ ...previous, name: event.target.value }))}
                placeholder="Full Name"
              />
            </label>

            <label className="field">
              <span>Preference</span>
              <select
                value={customerDraft.preference}
                onChange={(event) => setCustomerDraft((previous) => ({ ...previous, preference: event.target.value }))}
              >
                <option value="veg">Veg</option>
                <option value="non-veg">Non-Veg</option>
              </select>
            </label>

            <label className="field">
              <span>Mobile No.</span>
              <input
                type="tel"
                value={customerDraft.mobile}
                onChange={(event) => setCustomerDraft((previous) => ({ ...previous, mobile: event.target.value }))}
                placeholder="Phone number"
              />
            </label>

            <label className="field">
              <span>Address / Geo Point</span>
              <input
                type="text"
                value={customerDraft.geo_point}
                onChange={(event) => setCustomerDraft((previous) => ({ ...previous, geo_point: event.target.value }))}
                placeholder="Address or Maps link"
              />
            </label>

            {}
            <label className="field">
              <span>Start date</span>
              <input
                type="date"
                value={customerDraft.start_date}
                onChange={(event) => setCustomerDraft((previous) => ({ ...previous, start_date: event.target.value }))}
              />
            </label>

            <label className="field">
              <span>End date</span>
              <input
                type="date"
                value={customerDraft.end_date}
                onChange={(event) => setCustomerDraft((previous) => ({ ...previous, end_date: event.target.value }))}
              />
            </label>

            <div className="field">
              <span>Meal plan</span>
              <div className="checkbox-grid">
                {MEAL_ORDER.map((meal) => (
                  <label className="checkbox-pill" key={meal}>
                    <input type="checkbox" checked={customerDraft.meal_plan.includes(meal)} onChange={() => toggleMeal(meal)} />
                    <span>{MEAL_LABELS[meal]}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="form-actions">
            <button type="button" className="action-button" onClick={saveCustomer} disabled={savingCustomer}>
              {savingCustomer ? 'Saving...' : selectedCustomerId === 'new' ? 'Create Customer' : 'Save Changes'}
            </button>
          </div>
        </article>

        {}
        <article className="editor-panel">
          <div className="editor-panel__header">
            <div>
              <span className="eyebrow">Pricing editor</span>
              <h3>Base rates</h3>
            </div>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>Breakfast cost</span>
              <input
                type="number"
                value={settingsDraft.base_breakfast}
                onChange={(event) => setSettingsDraft((previous) => ({ ...previous, base_breakfast: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Lunch cost</span>
              <input
                type="number"
                value={settingsDraft.base_lunch}
                onChange={(event) => setSettingsDraft((previous) => ({ ...previous, base_lunch: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Dinner cost</span>
              <input
                type="number"
                value={settingsDraft.base_dinner}
                onChange={(event) => setSettingsDraft((previous) => ({ ...previous, base_dinner: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>NV premium</span>
              <input
                type="number"
                value={settingsDraft.nv_premium}
                onChange={(event) => setSettingsDraft((previous) => ({ ...previous, nv_premium: event.target.value }))}
              />
            </label>
          </div>

          <div className="form-actions">
            <button type="button" className="action-button" onClick={savePricing} disabled={savingSettings}>
              {savingSettings ? 'Saving...' : 'Save pricing'}
            </button>
          </div>
        </article>
      </div>

      {}
      {loading ? (
        <div className="empty-state">Loading customer profiles...</div>
      ) : customers.length === 0 ? (
        <div className="empty-state">No customers were returned from Supabase.</div>
      ) : (
        <div className="customer-grid">
          {customers.map((customer) => {
            const mealPlan = normalizeMealPlan(customer.meal_plan);
            const archived = isArchivedCustomer(customer);

            return (
              <article className={`customer-card ${archived ? 'customer-card--archived' : ''}`} key={customer.id}>
                <div className="customer-card__top">
                  <div>
                    <h3>{customer.name}</h3>
                    <p>{formatPreference(customer.preference)}</p>
                  </div>
                  <div className="customer-card__stack">
                    <span className={`status-chip ${archived ? 'status-chip--neutral' : 'status-chip--success'}`}>
                      {archived ? 'Archived' : 'Active'}
                    </span>
                  </div>
                </div>

                <div className="chip-list">
                  {mealPlan.length ? (
                    mealPlan.map((meal) => <span className="chip" key={meal}>{MEAL_LABELS[meal] ?? meal}</span>)
                  ) : (
                    <span className="chip chip--muted">No meal plan</span>
                  )}
                </div>

                <dl className="customer-card__meta">
                  <div>
                    <dt>Start</dt>
                    <dd>{customer.start_date || 'Unset'}</dd>
                  </div>
                  <div>
                    <dt>End</dt>
                    <dd>{customer.end_date || 'Open ended'}</dd>
                  </div>
                  <div>
                    <dt>Meals</dt>
                    <dd>{mealPlan.length ? `${mealPlan.length} subscribed` : 'Not set'}</dd>
                  </div>
                </dl>

                <div className="customer-card__footer">
                  <span>{archived ? 'Hidden from active operations' : 'Managed in ledger'}</span>
                  <div className="customer-card__actions">
                    <button type="button" className="text-button" onClick={() => selectCustomer(String(customer.id))}>
                      Edit
                    </button>
                    <button type="button" className="text-button text-button--danger" onClick={() => toggleArchive(customer)}>
                      {archived ? 'Restore' : 'Archive'}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}