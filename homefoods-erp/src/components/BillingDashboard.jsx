import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import {
  MEAL_LABELS,
  calculateBaseWeeklyCost,
  calculateNetPayable,
  formatCurrency,
  formatPreference,
  normalizeMealPlan,
  toNumber,
} from '../erpHelpers';

export default function BillingDashboard() {
  const [customers, setCustomers] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [paymentData, setPaymentData] = useState({});
  const [savingCustomerId, setSavingCustomerId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setMessage('');

      const [settingsResult, customersResult] = await Promise.all([
        supabase.from('global_settings').select('*').single(),
        supabase.from('customers').select('id, name, meal_plan, preference, credit_balance').order('name', { ascending: true }),
      ]);

      if (cancelled) return;

      if (settingsResult.error || customersResult.error) {
        setMessage(settingsResult.error?.message ?? customersResult.error?.message ?? 'Unable to load billing data.');
      }

      setSettings(settingsResult.data ?? null);
      setCustomers(customersResult.data ?? []);
      setLoading(false);
    }

    fetchData();

    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(
    () =>
      customers.map((customer) => {
        const baseCost = calculateBaseWeeklyCost(customer, settings);
        const rawNetPayable = calculateNetPayable(customer, settings);

        return {
          ...customer,
          mealPlan: normalizeMealPlan(customer.meal_plan),
          baseCost,
          rawNetPayable,
          settlementDue: Math.max(rawNetPayable, 0),
        };
      }),
    [customers, settings],
  );

  function handleInputChange(customerId, field, value) {
    setPaymentData((previous) => ({
      ...previous,
      [customerId]: {
        ...previous[customerId],
        [field]: value,
      },
    }));
  }

  async function submitPayment(customer) {
    const payment = paymentData[customer.id] ?? {};
    const amountPaid = Number(payment.amount);
    const upiId = payment.upi?.trim() || 'CASH';

    if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
      setMessage('Enter a valid payment amount before settling the bill.');
      return;
    }

    setSavingCustomerId(customer.id);
    setMessage('');

    const transactionResult = await supabase.from('transactions').insert([
      {
        customer_id: customer.id,
        amount: amountPaid,
        upi_id: upiId,
      },
    ]);

    if (transactionResult.error) {
      setMessage(transactionResult.error.message ?? 'Error saving transaction.');
      setSavingCustomerId(null);
      return;
    }

    const nextCreditBalance = toNumber(customer.credit_balance) + amountPaid - customer.settlementDue;
    const updateResult = await supabase.from('customers').update({ credit_balance: nextCreditBalance }).eq('id', customer.id);

    setSavingCustomerId(null);

    if (updateResult.error) {
      setMessage(updateResult.error.message ?? 'Error updating credit balance.');
      return;
    }

    setMessage(`Logged ${formatCurrency(amountPaid)} for ${customer.name}.`);
    setPaymentData((previous) => ({
      ...previous,
      [customer.id]: {},
    }));

    const { data } = await supabase.from('customers').select('id, name, meal_plan, preference, credit_balance').order('name', { ascending: true });
    setCustomers(data ?? []);
  }

  return (
    <section className="panel">
      <div className="panel__header">
        <div>
          <span className="eyebrow">Weekly Billing</span>
          <h2>Base plan, carry-forward, and settlement</h2>
          <p>Base cost is derived from each customer’s meal plan and global settings, then the current credit is deducted.</p>
        </div>
      </div>

      <div className="summary-strip">
        <div className="summary-card">
          <span>Customers</span>
          <strong>{customers.length}</strong>
        </div>
        <div className="summary-card">
          <span>Status</span>
          <strong>{loading ? 'Loading' : 'Ready'}</strong>
        </div>
        <div className="summary-card">
          <span>NV premium</span>
          <strong>{settings ? formatCurrency(settings.nv_premium) : '—'}</strong>
        </div>
      </div>

      {message ? <div className="message-banner">{message}</div> : null}

      {loading ? (
        <div className="empty-state">Loading the weekly billing engine...</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">No customers were returned for billing.</div>
      ) : (
        <div className="table-shell">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Meal plan</th>
                <th>Preference</th>
                <th>Base plan cost</th>
                <th>Carry-forward</th>
                <th>Net payable</th>
                <th>Amount paid</th>
                <th>UPI reference</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <strong>{customer.name}</strong>
                  </td>
                  <td>
                    <div className="chip-list">
                      {customer.mealPlan.length ? (
                          customer.mealPlan.map((meal) => <span className="chip" key={meal}>{MEAL_LABELS[meal] ?? meal}</span>)
                      ) : (
                        <span className="chip chip--muted">No plan</span>
                      )}
                    </div>
                  </td>
                  <td>{formatPreference(customer.preference)}</td>
                  <td>{formatCurrency(customer.baseCost)}</td>
                  <td>
                    <span className={`status-chip ${toNumber(customer.credit_balance) >= 0 ? 'status-chip--success' : 'status-chip--warning'}`}>
                      {formatCurrency(customer.credit_balance)}
                    </span>
                  </td>
                  <td>
                    <strong>{formatCurrency(customer.rawNetPayable)}</strong>
                    <div className="table-note">
                      {customer.rawNetPayable < 0 ? `Advance credit ${formatCurrency(Math.abs(customer.rawNetPayable))}` : `Due ${formatCurrency(customer.settlementDue)}`}
                    </div>
                  </td>
                  <td>
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      step="1"
                      placeholder={String(customer.settlementDue || 0)}
                      value={paymentData[customer.id]?.amount ?? ''}
                      onChange={(event) => handleInputChange(customer.id, 'amount', event.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className="form-input"
                      type="text"
                      placeholder="UPI ID or CASH"
                      value={paymentData[customer.id]?.upi ?? ''}
                      onChange={(event) => handleInputChange(customer.id, 'upi', event.target.value)}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="action-button"
                      onClick={() => submitPayment(customer)}
                      disabled={savingCustomerId === customer.id}
                    >
                      {savingCustomerId === customer.id ? 'Saving...' : 'Settle'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}