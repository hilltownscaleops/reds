import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import {
  MEAL_LABELS,
  calculateBaseWeeklyCost,
  formatCurrency,
  formatPreference,
  normalizeMealPlan,
  toNumber,
} from '../erpHelpers';

// Helper: Calculates eaten amount for a specific batch of days
function calculateWeeklyEaten(customer, rosterRows, settings) {
  if (!rosterRows || rosterRows.length === 0) return 0;

  let eatenTotal = 0;

  rosterRows.forEach((row) => {
    // Breakfast
    if (row.b_status === 'active') eatenTotal += toNumber(settings.base_breakfast);
    else if (row.b_status === 'late_skipped') eatenTotal += toNumber(settings.base_breakfast) * 0.3;
    
    // Lunch
    if (row.l_status === 'active' || row.l_status === 'nv_downgraded') {
      eatenTotal += toNumber(settings.base_lunch);
    } else if (row.l_status === 'active_nv') {
      eatenTotal += toNumber(settings.base_lunch) + toNumber(settings.nv_premium);
    } else if (row.l_status === 'late_skipped') {
      eatenTotal += toNumber(settings.base_lunch) * 0.3;
    }
    
    // Dinner
    if (row.d_status === 'active' || row.d_status === 'nv_downgraded') {
      eatenTotal += toNumber(settings.base_dinner);
    } else if (row.d_status === 'active_nv') {
      eatenTotal += toNumber(settings.base_dinner) + toNumber(settings.nv_premium);
    } else if (row.d_status === 'late_skipped') {
      eatenTotal += toNumber(settings.base_dinner) * 0.3;
    }
  });

  return eatenTotal;
}

// Helper: Calculates lifetime eaten across all rosters
function calculateLifetimeEaten(customer, allRosters, settings) {
  const customerRosters = allRosters.filter((r) => String(r.customer_id) === String(customer.id));
  
  // The math is now strictly literal based on the roster status (Active vs Active NV). 
  // We no longer need to group by weeks to restrict NV premiums in the background.
  return calculateWeeklyEaten(customer, customerRosters, settings);
}

export default function BillingDashboard() {
  const [customers, setCustomers] = useState([]);
  const [settings, setSettings] = useState(null);
  const [roster, setRoster] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [paymentData, setPaymentData] = useState({});
  const [savingCustomerId, setSavingCustomerId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setMessage('');

      // Fetch absolute truth from all tables (limit elevated to handle lifetime history)
      const [settingsResult, customersResult, rosterResult, txResult] = await Promise.all([
        supabase.from('global_settings').select('*').single(),
        supabase.from('customers').select('*').order('name', { ascending: true }),
        supabase.from('daily_roster').select('*').limit(10000),
        supabase.from('transactions').select('*').limit(10000),
      ]);

      if (cancelled) return;

      if (settingsResult.error || customersResult.error) {
        setMessage('Unable to load ledger data.');
      }

      setSettings(settingsResult.data ?? null);
      setCustomers(customersResult.data ?? []);
      setRoster(rosterResult.data ?? []);
      setTransactions(txResult.data ?? []);
      setLoading(false);
    }

    fetchData();

    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    if (!settings) return [];
    
    return customers.map((customer) => {
      // 1. Calculate Total Eaten (Lifetime)
      const lifetimeEaten = calculateLifetimeEaten(customer, roster, settings);
      
      // 2. Calculate Total Top-ups (Lifetime)
      const customerTx = transactions.filter((tx) => String(tx.customer_id) === String(customer.id));
      const lifetimeTopup = customerTx.reduce((sum, tx) => sum + toNumber(tx.amount), 0);
      
      // 3. Runtime Carry-over
      const carryover = lifetimeTopup - lifetimeEaten;
      
      // 4. Base Plan for Next Week
      const baseWeekPlan = calculateBaseWeeklyCost(customer, settings);
      
      // 5. Suggested Top-up
      const suggestedTopup = Math.max(0, baseWeekPlan - carryover);

      return {
        ...customer,
        mealPlan: normalizeMealPlan(customer.meal_plan),
        lifetimeEaten,
        lifetimeTopup,
        carryover,
        baseWeekPlan,
        suggestedTopup,
      };
    });
  }, [customers, settings, roster, transactions]);

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
      setMessage('Enter a valid payment amount.');
      return;
    }

    setSavingCustomerId(customer.id);
    setMessage('');

    // Log the transaction. (We NO LONGER update the customer's credit_balance table!)
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

    setMessage(`Logged ${formatCurrency(amountPaid)} for ${customer.name}.`);
    
    // Clear the input and instantly refresh the transaction state to update the UI Math
    setPaymentData((previous) => ({ ...previous, [customer.id]: {} }));
    
    const { data: updatedTx } = await supabase.from('transactions').select('*').limit(10000);
    setTransactions(updatedTx ?? []);
    setSavingCustomerId(null);
  }

  return (
    <section className="panel">
      <div className="panel__header">
        <div>
          <span className="eyebrow">Lifetime Ledger</span>
          <h2>Runtime Carry-over & Top-ups</h2>
          <p>Calculates absolute truth: (Total Money Received) - (Total Food Eaten) = Current Carry-over.</p>
        </div>
      </div>

      {message ? <div className="message-banner">{message}</div> : null}

      {loading ? (
        <div className="empty-state">Calculating runtime ledger...</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">No customers found.</div>
      ) : (
        <div className="table-shell">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Total Top-ups</th>
                <th>Total Eaten</th>
                <th>Carry-over</th>
                <th>Next Wk Base</th>
                <th>Suggested Top-up</th>
                <th>New Payment</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <strong>{customer.name}</strong><br/>
                    <small style={{ color: 'rgba(226, 232, 240, 0.6)' }}>
                      {formatPreference(customer.preference)}
                    </small>
                  </td>
                  <td>{formatCurrency(customer.lifetimeTopup)}</td>
                  <td>{formatCurrency(customer.lifetimeEaten)}</td>
                  <td>
                    <span className={`status-chip ${customer.carryover >= 0 ? 'status-chip--success' : 'status-chip--warning'}`}>
                      {formatCurrency(customer.carryover)}
                    </span>
                  </td>
                  <td>{formatCurrency(customer.baseWeekPlan)}</td>
                  <td>
                    <strong>{formatCurrency(customer.suggestedTopup)}</strong>
                  </td>
                  <td style={{ display: 'flex', gap: '8px', minWidth: '220px' }}>
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      step="1"
                      style={{ width: '100px' }}
                      placeholder={String(customer.suggestedTopup || 0)}
                      value={paymentData[customer.id]?.amount ?? ''}
                      onChange={(event) => handleInputChange(customer.id, 'amount', event.target.value)}
                    />
                    <input
                      className="form-input"
                      type="text"
                      placeholder="UPI ID"
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