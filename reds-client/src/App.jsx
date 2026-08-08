import { useMemo, useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { formatDateInput, addDays, getMonday, toNumber, calculateBaseWeeklyCost } from './erpHelpers';
import './App.css';

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

const MEAL_CONFIG = {
  b_status: { shortLabel: 'B', label: 'Breakfast' },
  l_status: { shortLabel: 'L', label: 'Lunch' },
  d_status: { shortLabel: 'D', label: 'Dinner' },
};

function getMealButtonClass(status) {
  if (['active', 'active_nv', 'nv_downgraded'].includes(status)) {
    return 'meal-toggle meal-toggle--active';
  }

  if (status === 'late_skipped') {
    return 'meal-toggle meal-toggle--late';
  }

  return 'meal-toggle meal-toggle--inactive';
}

const mobno = import.meta.env.VITE_MOBNO || '9876543210'; // CHANGE THIS TO YOUR ACTUAL MOBILE NUMBER IN .env
 
export default function App() {
  const [mobileInput, setMobileInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [customer, setCustomer] = useState(null);
  const [settings, setSettings] = useState(null);
  const [roster, setRoster] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  
  // Week Navigation
  const [baseDate, setBaseDate] = useState(new Date());

  // Custom Dialog State
  const [dialog, setDialog] = useState(null);

  // 1. Calculate Wallet FIRST so it's ready for the next calculations
  const wallet = useMemo(() => {
    if (!settings) return { totalEaten: 0, totalTopup: 0, carryover: 0 };
    
    const totalEaten = calculateLifetimeEaten(roster, settings);
    const totalTopup = transactions.reduce((sum, tx) => sum + toNumber(tx.amount), 0);
    const carryover = totalTopup - totalEaten;

    return { totalEaten, totalTopup, carryover };
  }, [roster, transactions, settings]);

  // 2. Calculate their week base plan
  const baseWeekPlan = useMemo(() => {
    if (!customer || !settings) return 0;
    return calculateBaseWeeklyCost(customer, settings);
  }, [customer, settings]);

  // 3. Calculate suggested top-up (Base Week - Current Balance)
  const suggestedTopup = useMemo(() => {
    return Math.max(0, baseWeekPlan - wallet.carryover);
  }, [baseWeekPlan, wallet.carryover]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true);
    setLoginError('');

    // 1. Fetch user by mobile number to verify they exist in your ERP
    const { data: userData, error: dbError } = await supabase
      .from('customers')
      .select('*')
      .eq('mobile', mobileInput)
      .single();

    if (dbError || !userData) {
      setLoginError('No active customer found with this mobile number.');
      setLoading(false);
      return;
    }

    // 2. Check the provided PIN against the database pin
    if (userData.pin !== pinInput) {
      setLoginError('Incorrect PIN. Please try again.');
      setLoading(false);
      return;
    }

    // 3. Secretly authenticate with Supabase Auth to get a Secure JWT Token
    const fakeEmail = `${mobileInput}@homefoods.app`;
    const securePaddedPassword = `${pinInput}-HomeFoodsAuth`; 

    let authRes = await supabase.auth.signInWithPassword({
      email: fakeEmail,
      password: securePaddedPassword
    });

    // 4. If they don't have an Auth account yet, create one invisibly
    if (authRes.error && (authRes.error.message.includes('Invalid login credentials') || authRes.error.status === 400)) {
      authRes = await supabase.auth.signUp({
        email: fakeEmail,
        password: securePaddedPassword
      });
      
      if (authRes.error) {
        setLoginError(authRes.error.message);
        setLoading(false);
        return;
      }
    } else if (authRes.error) {
      setLoginError(authRes.error.message);
      setLoading(false);
      return;
    }

    if (!authRes.data?.session) {
      setLoginError('SECURITY LOCK: You must turn off "Confirm Email" in Supabase Auth settings to enable login.');
      setLoading(false);
      return;
    }

    // 5. Force-sync the secure Auth ID to the customer profile every time
    if (userData.auth_id !== authRes.data.user.id) {
      await supabase.from('customers')
        .update({ auth_id: authRes.data.user.id })
        .eq('id', userData.id);
      userData.auth_id = authRes.data.user.id;
    }

    // 6. Fully authenticated! Load their protected RLS data.
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

  const currentWeek = useMemo(() => {
    const start = getMonday(baseDate);
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
  }, [roster, customer, baseDate]);

  const todayDateKey = formatDateInput(new Date());

  function initiateToggle(row, mealKey) {
    // Prevent modifying past dates entirely
    const rosterDateObj = new Date(`${row.roster_date}T00:00:00`);
    const todayObj = new Date();
    todayObj.setHours(0, 0, 0, 0); // Lock to midnight of current day

    if (rosterDateObj < todayObj) {
      setDialog({
        title: "Action Not Allowed",
        message: "You cannot modify meals for past dates.",
        confirmText: "Okay",
        onConfirm: () => setDialog(null)
      });
      return;
    }

    const dayOfWeek = rosterDateObj.getDay();

    // STRICT WEEKEND LOCK: Block clicks if admin has disabled the day in Global Settings
    if (dayOfWeek === 6 && !settings?.enable_saturday) {
      setDialog({ title: "Service Unavailable", message: "We do not operate on Saturdays.", confirmText: "Okay", onConfirm: () => setDialog(null) });
      return;
    }
    if (dayOfWeek === 0 && !settings?.enable_sunday) {
      setDialog({ title: "Service Unavailable", message: "We do not operate on Sundays.", confirmText: "Okay", onConfirm: () => setDialog(null) });
      return;
    }

    const currentStatus = row[mealKey];
    const isCurrentlyEaten = ['active', 'active_nv', 'nv_downgraded'].includes(currentStatus);
    
    // Check if it is a Non-Veg special day
    const isNonVeg = customer.preference && customer.preference.toLowerCase().includes('non');
    
    let nextActiveStatus = 'active';
    if (isNonVeg) {
      // Auto-assign Non-Veg based on your specific weekly schedule
      if (dayOfWeek === 3 && mealKey === 'l_status') nextActiveStatus = 'active_nv';
      if (dayOfWeek === 4 && mealKey === 'd_status') nextActiveStatus = 'active_nv';
    }

    // Determine the exact price of the requested meal
    let mealPrice = mealKey === 'b_status' ? toNumber(settings.base_breakfast) :
                    mealKey === 'l_status' ? toNumber(settings.base_lunch) : 
                    toNumber(settings.base_dinner);

    if (nextActiveStatus === 'active_nv') {
      mealPrice += toNumber(settings.nv_premium);
    }

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
        executeToggle(row, mealKey, nextActiveStatus);
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

  if (!customer) {
    return (
      <div className="customer-app">
        <div className="customer-app__glow customer-app__glow--one" aria-hidden="true" />
        <div className="customer-app__glow customer-app__glow--two" aria-hidden="true" />

        <main className="customer-app__auth">
          <section className="auth-card panel">
            <p className="eyebrow">Homefoods Customer Portal</p>
            <h1>Manage meals and wallet balance from one place.</h1>
            <p className="auth-card__copy">Log in to view your weekly roster, credits, and top-up history.</p>

            <form className="auth-form" onSubmit={handleLogin}>
              <label className="field">
                <span>Mobile Number</span>
                <input
                  className="form-input"
                  type="tel"
                  placeholder="Enter your mobile number"
                  value={mobileInput}
                  onChange={(e) => setMobileInput(e.target.value)}
                />
              </label>

              <label className="field" style={{ marginTop: '12px' }}>
                <span>4-Digit PIN</span>
                <input
                  className="form-input"
                  type="password"
                  placeholder="Enter your PIN"
                  maxLength="4"
                  pattern="\d{4}"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                />
              </label>

              {loginError && <div className="message-banner" style={{ marginTop: '12px' }}>{loginError}</div>}

              <button 
                className="action-button" 
                style={{ marginTop: '16px' }}
                type="submit" 
                disabled={loading || !mobileInput || pinInput.length < 4}
              >
                {loading ? 'Verifying...' : 'Secure Login'}
              </button>
            </form>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="customer-app">
      <div className="customer-app__glow customer-app__glow--one" aria-hidden="true" />
      <div className="customer-app__glow customer-app__glow--two" aria-hidden="true" />

      {dialog && (
        <div className="dialog-overlay">
          <div className="dialog-card panel">
            <p className="eyebrow">Action required</p>
            <h3>{dialog.title}</h3>
            <p>{dialog.message}</p>
            <div className={`dialog-actions ${dialog.title.includes('Penalty') ? 'dialog-actions--split' : ''}`}>
              {dialog.title.includes('Penalty') && (
                <button className="dialog-cancel" onClick={() => setDialog(null)}>Cancel</button>
              )}
              <button className="action-button" onClick={dialog.onConfirm}>{dialog.confirmText}</button>
            </div>
          </div>
        </div>
      )}

      <main className="customer-app__content">
        <header className="page-header panel">
          <div>
            <p className="eyebrow">Customer Portal</p>
            <h1>Welcome, {customer.name}</h1>
            <p className="page-header__copy">Manage your weekly schedule and keep your credits in view.</p>
          </div>
        </header>

        <section className="panel wallet-panel">
          <div className="panel__header panel__header--split">
            <div>
              <p className="eyebrow">Wallet</p>
              <h2>Available Credits</h2>
              <p className="panel__description">This is your current carryover after all meals and top-ups.</p>
            </div>
            <strong className={`wallet-balance ${wallet.carryover < 0 ? 'wallet-balance--negative' : ''}`}>
              ₹{wallet.carryover}
            </strong>
          </div>

          <div className="wallet-stats">
            <article className="summary-card">
              <span>Total Top-up</span>
              <strong>₹{wallet.totalTopup}</strong>
            </article>
            <article className="summary-card">
              <span>Total Eaten</span>
              <strong>₹{wallet.totalEaten}</strong>
            </article>
          </div>
        </section>

        <section className="panel">
          <div className="panel__header panel__header--split">
            <div>
              <p className="eyebrow">Top-up</p>
              <h2>Add Credits</h2>
              <p className="panel__description">
                Weekly base: <strong>₹{baseWeekPlan}</strong>. Suggested top-up: <strong>₹{suggestedTopup}</strong>.
              </p>
            </div>
          </div>
          
          <div style={{ marginTop: '16px', padding: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '12px', border: '1px solid #334155' }}>
            <p style={{ margin: '0 0 12px 0', color: '#cbd5e1', lineHeight: '1.5' }}>
              Please GPay to this mobile number and share the screenshot with Homefoods Admin to update your credits:
            </p>
            <h3 style={{ margin: 0, color: '#f97316', fontSize: '24px', letterSpacing: '1px' }}>
              {mobno}
            </h3>
          </div>
        </section>

        <section className="panel">
          <div className="panel__header panel__header--split">
            <div>
              <p className="eyebrow">Weekly roster</p>
              <h2>This Week's Schedule</h2>
            </div>
          </div>

          <div className="status-legend" aria-label="Meal status legend">
            <span className="legend-chip legend-chip--active">Selected</span>
            <span className="legend-chip legend-chip--muted">Skipped</span>
            <span className="legend-chip legend-chip--late">Late skip</span>
          </div>

          <div className="roster-list">
            {currentWeek.map((row) => {
              const dateObj = new Date(`${row.roster_date}T00:00:00`);
              const isToday = row.roster_date === todayDateKey;
              
              const dayOfWeek = dateObj.getDay();
              const isWeekendDisabled = (dayOfWeek === 6 && !settings?.enable_saturday) || (dayOfWeek === 0 && !settings?.enable_sunday);

              console.log(`Rendering ${row.roster_date}: isToday=${isToday}, isWeekendDisabled=${isWeekendDisabled}`);

              return (
                <article 
                  key={row.roster_date} 
                  className={`day-card ${isToday ? 'day-card--today' : ''}`}
                  style={isWeekendDisabled ? { opacity: 0.4, filter: 'grayscale(100%)', pointerEvents: 'none' } : {}}
                >
                  <div className="day-card__meals">
                    {['b_status', 'l_status', 'd_status'].map((mealKey) => {
                      const status = row[mealKey] || 'skipped';
                      const meal = MEAL_CONFIG[mealKey];

                      return (
                        <button
                          key={mealKey}
                          className={getMealButtonClass(status)}
                          onClick={() => initiateToggle(row, mealKey)}
                          title={status === 'late_skipped' ? 'Late skipped (30% charge)' : meal.label}
                          aria-label={`${meal.label}: ${status}`}
                        >
                          <span>{meal.shortLabel}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="day-card__date">
                    <span>{dateObj.toLocaleDateString('en-IN', { weekday: 'short' })}</span>
                    <strong>{dateObj.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</strong>
                    {isToday && <span className="day-card__badge">Today</span>}
                  </div>
                </article>
              );
            })}
          </div>

          <div className="schedule-nav">
            <button className="tab-button schedule-nav__button" onClick={() => setBaseDate((current) => addDays(current, -7))}>Prev week</button>
            <button className="tab-button schedule-nav__button" onClick={() => setBaseDate(new Date())}>Today</button>
            <button className="tab-button schedule-nav__button" onClick={() => setBaseDate((current) => addDays(current, 7))}>Next week</button>
          </div>
        </section>
      </main>
    </div>
  );
}