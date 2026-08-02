import { useEffect, useState, useMemo } from 'react';
import { supabase } from './supabaseClient';
import { formatDateInput, addDays, getMonday, parseDate, toNumber } from './erpHelpers';

// --- Helper Functions ---
function getCutoffTime(rosterDateStr) {
  // Cutoff is 9:00 PM on the day BEFORE the roster date
  const rosterDate = new Date(`${rosterDateStr}T00:00:00`);
  const cutoff = new Date(rosterDate);
  cutoff.setDate(cutoff.getDate() - 1);
  cutoff.setHours(21, 0, 0, 0);
  return cutoff;
}

function isPastCutoff(rosterDateStr) {
  return new Date() > getCutoffTime(rosterDateStr);
}

// Re-using the exact ERP ledger logic to ensure the customer sees the exact same math as the admin
function calculateLifetimeEaten(rosterRows, settings) {
  let eatenTotal = 0;
  rosterRows.forEach((row) => {
    if (row.b_status === 'active') eatenTotal += toNumber(settings.base_breakfast);
    else if (row.b_status === 'late_skipped') eatenTotal += toNumber(settings.base_breakfast) * 0.3;
    
    if (row.l_status === 'active' || row.l_status === 'nv_downgraded') eatenTotal += toNumber(settings.base_lunch);
    else if (row.l_status === 'active_nv') eatenTotal += (toNumber(settings.base_lunch) + toNumber(settings.nv_premium));
    else if (row.l_status === 'late_skipped') eatenTotal += toNumber(settings.base_lunch) * 0.3;
    
    if (row.d_status === 'active' || row.d_status === 'nv_downgraded') eatenTotal += toNumber(settings.base_dinner);
    else if (row.d_status === 'active_nv') eatenTotal += (toNumber(settings.base_dinner) + toNumber(settings.nv_premium));
    else if (row.d_status === 'late_skipped') eatenTotal += toNumber(settings.base_dinner) * 0.3;
  });
  return eatenTotal;
}

export default function CustomerApp() {
  const [mobileInput, setMobileInput] = useState('');
  const [customer, setCustomer] = useState(null);
  const [settings, setSettings] = useState(null);
  const [roster, setRoster] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  
  // Custom Dialog State to replace alert()/confirm()
  const [dialog, setDialog] = useState(null);
  const [topupAmount, setTopupAmount] = useState(500);
  const upiId = 'your_upi_id@bank'; // CHANGE THIS TO YOUR ACTUAL UPI ID

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true);
    setLoginError('');

    // Fetch user by mobile number
    const { data: userData, error } = await supabase
      .from('customers')
      .select('*')
      .eq('mobile', mobileInput)
      .single();

    if (error || !userData) {
      setLoginError('No active customer found with this mobile number.');
      setLoading(false);
      return;
    }

    setCustomer(userData);
    await loadCustomerData(userData.id);
  }

  async function loadCustomerData(customerId) {
    const [settingsRes, rosterRes, txRes] = await Promise.all([
      supabase.from('global_settings').select('*').single(),
      supabase.from('daily_roster').select('*').eq('customer_id', customerId),
      supabase.from('transactions').select('*').eq('customer_id', customerId),
    ]);

    setSettings(settingsRes.data);
    setRoster(rosterRes.data || []);
    setTransactions(txRes.data || []);
    setLoading(false);
  }

  const wallet = useMemo(() => {
    if (!settings) return { totalEaten: 0, totalTopup: 0, carryover: 0 };
    
    const totalEaten = calculateLifetimeEaten(roster, settings);
    const totalTopup = transactions.reduce((sum, tx) => sum + toNumber(tx.amount), 0);
    const carryover = totalTopup - totalEaten;

    return { totalEaten, totalTopup, carryover };
  }, [roster, transactions, settings]);

  const currentWeek = useMemo(() => {
    const start = getMonday(new Date());
    return Array.from({ length: 7 }, (_, i) => {
      const dateStr = formatDateInput(addDays(start, i));
      const row = roster.find(r => r.roster_date === dateStr) || {
        customer_id: customer?.id,
        roster_date: dateStr,
        b_status: 'skipped',
        l_status: 'skipped',
        d_status: 'skipped'
      };
      return row;
    });
  }, [roster, customer]);

  function initiateToggle(row, mealKey) {
    const currentStatus = row[mealKey];
    const isCurrentlyEaten = ['active', 'active_nv', 'nv_downgraded'].includes(currentStatus);
    
    // Determine the base price of the requested meal
    const mealPrice = mealKey === 'b_status' ? toNumber(settings.base_breakfast) :
                      mealKey === 'l_status' ? toNumber(settings.base_lunch) : 
                      toNumber(settings.base_dinner);

    if (isCurrentlyEaten) {
      // User is trying to UNTICK (Skip)
      if (isPastCutoff(row.roster_date)) {
        setDialog({
          title: "Late Cancellation Penalty",
          message: "It is past 9 PM for this meal. Canceling now will incur a 30% no-show deduction from your credits.",
          confirmText: "Accept & Cancel",
          onConfirm: () => executeToggle(row, mealKey, 'late_skipped')
        });
      } else {
        // Free skip
        executeToggle(row, mealKey, 'skipped');
      }
    } else {
      // User is trying to TICK (Roster)
      if (wallet.carryover < mealPrice) {
        setDialog({
          title: "Insufficient Credits",
          message: `You need at least ₹${mealPrice} to roster this meal. Your current balance is ₹${wallet.carryover}. Please top up your wallet.`,
          confirmText: "Okay",
          onConfirm: () => setDialog(null)
        });
      } else {
        executeToggle(row, mealKey, 'active');
      }
    }
  }

  async function executeToggle(row, mealKey, nextStatus) {
    setDialog(null);
    const payload = {
      customer_id: row.customer_id,
      roster_date: row.roster_date,
      b_status: row.b_status,
      l_status: row.l_status,
      d_status: row.d_status,
      [mealKey]: nextStatus,
    };

    // The customer app only has RLS permission to upsert their own roster
    const { error } = await supabase.from('daily_roster').upsert(payload, { onConflict: 'customer_id,roster_date' });
    if (!error) {
      await loadCustomerData(customer.id);
    }
  }

  function handleTopup() {
    const amount = Math.max(500, toNumber(topupAmount));
    const upiLink = `upi://pay?pa=${upiId}&pn=Homefoods&am=${amount}&cu=INR`;
    
    // Attempt to open the UPI app on the user's phone
    window.location.href = upiLink;

    setDialog({
      title: "Top-up Initiated",
      message: "If your UPI app did not open automatically, please complete the payment manually. Once done, share the screenshot with Homefoods Admin to unlock your credits.",
      confirmText: "Done",
      onConfirm: () => setDialog(null)
    });
  }

  if (!customer) {
    return (
      <div style={{ maxWidth: '400px', margin: '40px auto', padding: '20px', fontFamily: 'sans-serif' }}>
        <h2>Homefoods Customer Portal</h2>
        <p style={{ color: '#666', marginBottom: '20px' }}>Log in to manage your meals and wallet.</p>
        <form onSubmit={handleLogin}>
          <input 
            type="tel" 
            placeholder="Enter Mobile Number" 
            value={mobileInput}
            onChange={(e) => setMobileInput(e.target.value)}
            style={{ width: '100%', padding: '12px', boxSizing: 'border-box', marginBottom: '10px', borderRadius: '8px', border: '1px solid #ccc' }}
          />
          {loginError && <div style={{ color: 'red', marginBottom: '10px', fontSize: '14px' }}>{loginError}</div>}
          <button 
            type="submit" 
            disabled={loading || !mobileInput}
            style={{ width: '100%', padding: '12px', background: '#f97316', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold' }}
          >
            {loading ? 'Verifying...' : 'Login'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '500px', margin: '0 auto', padding: '20px', fontFamily: 'sans-serif', paddingBottom: '100px' }}>
      
      {/* Custom Dialog / Modal */}
      {dialog && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div style={{ background: '#1e293b', padding: '24px', borderRadius: '16px', width: '100%', maxWidth: '360px', color: 'white' }}>
            <h3 style={{ margin: '0 0 12px 0' }}>{dialog.title}</h3>
            <p style={{ margin: '0 0 24px 0', lineHeight: 1.5, color: '#cbd5e1' }}>{dialog.message}</p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              {dialog.title.includes("Penalty") && (
                <button onClick={() => setDialog(null)} style={{ padding: '10px 16px', background: 'transparent', color: '#cbd5e1', border: '1px solid #475569', borderRadius: '8px' }}>Cancel</button>
              )}
              <button onClick={dialog.onConfirm} style={{ padding: '10px 16px', background: '#f97316', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold' }}>{dialog.confirmText}</button>
            </div>
          </div>
        </div>
      )}

      <header style={{ marginBottom: '24px' }}>
        <h2 style={{ margin: 0, color: '#1e293b' }}>Welcome, {customer.name}</h2>
        <p style={{ margin: 0, color: '#64748b' }}>Manage your weekly schedule</p>
      </header>

      {/* Wallet Card */}
      <div style={{ background: '#1e293b', borderRadius: '16px', padding: '20px', color: 'white', marginBottom: '24px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <span style={{ color: '#94a3b8', fontSize: '14px', textTransform: 'uppercase' }}>Available Credits</span>
          <strong style={{ fontSize: '24px', color: wallet.carryover < 0 ? '#f87171' : '#86efac' }}>
            ₹{wallet.carryover}
          </strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #334155', paddingTop: '16px', fontSize: '14px' }}>
          <span>Total Top-up: <strong>₹{wallet.totalTopup}</strong></span>
          <span>Total Eaten: <strong>₹{wallet.totalEaten}</strong></span>
        </div>
      </div>

      {/* Top-up Form */}
      <div style={{ background: '#f1f5f9', borderRadius: '16px', padding: '20px', marginBottom: '24px' }}>
        <h4 style={{ margin: '0 0 12px 0', color: '#1e293b' }}>Add Credits</h4>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input 
            type="number" 
            min="500" 
            value={topupAmount} 
            onChange={(e) => setTopupAmount(e.target.value)}
            style={{ flex: 1, padding: '12px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '16px' }}
          />
          <button 
            onClick={handleTopup}
            style={{ padding: '12px 20px', background: '#10b981', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
          >
            Pay UPI
          </button>
        </div>
        <p style={{ fontSize: '12px', color: '#64748b', marginTop: '8px' }}>Min top-up ₹500. Share screenshot on WhatsApp to confirm.</p>
      </div>

      {/* Roster Calendar */}
      <div>
        <h3 style={{ margin: '0 0 16px 0', color: '#1e293b' }}>This Week's Roster</h3>
        <div style={{ display: 'grid', gap: '12px' }}>
          {currentWeek.map((row) => {
            const dateObj = new Date(row.roster_date);
            const isToday = new Date().toDateString() === dateObj.toDateString();
            
            return (
              <div key={row.roster_date} style={{ background: 'white', border: isToday ? '2px solid #f97316' : '1px solid #e2e8f0', borderRadius: '12px', padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ display: 'block', color: '#0f172a' }}>
                    {dateObj.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
                  </strong>
                  {isToday && <span style={{ fontSize: '12px', color: '#f97316', fontWeight: 'bold' }}>Today</span>}
                </div>
                
                <div style={{ display: 'flex', gap: '8px' }}>
                  {['b_status', 'l_status', 'd_status'].map((mealKey) => {
                    const status = row[mealKey] || 'skipped';
                    const isEaten = ['active', 'active_nv', 'nv_downgraded'].includes(status);
                    const isLateSkipped = status === 'late_skipped';
                    
                    return (
                      <button
                        key={mealKey}
                        onClick={() => initiateToggle(row, mealKey)}
                        style={{
                          width: '40px', height: '40px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer',
                          background: isEaten ? '#f97316' : isLateSkipped ? '#fecaca' : '#f1f5f9',
                          color: isEaten ? 'white' : isLateSkipped ? '#ef4444' : '#94a3b8',
                          border: isLateSkipped ? '1px solid #ef4444' : 'none'
                        }}
                        title={isLateSkipped ? "Late skipped (30% charge)" : ""}
                      >
                        {mealKey[0].toUpperCase()}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  );
}