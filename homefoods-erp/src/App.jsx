import { useState, useEffect } from 'react';
import './App.css';
import DailyDashboard from './components/DailyDashboard';
import BillingDashboard from './components/BillingDashboard';
import CustomerList from './components/CustomerList';
import { supabase, hasSupabaseConfig } from './supabaseClient';

const tabs = [
  {
    id: 'daily',
    label: 'Daily Operations',
    description: 'Roster controls and live carry-forward updates.',
  },
  {
    id: 'billing',
    label: 'Weekly Billing',
    description: 'Weekly dues, UPI settlement, and ledger entries.',
  },
  {
    id: 'customers',
    label: 'Customers',
    description: 'Read-only profiles, meal plans, and credit state.',
  },
];

const highlights = [
  { label: 'Service window', value: 'Mon - Fri' },
  { label: 'Meal slots', value: 'Breakfast, Lunch, Dinner' },
  { label: 'NV surcharge', value: '₹25 per meal' },
  { label: 'Ledger model', value: 'Supabase Postgres' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('daily');
  
  // Auth State
  const [session, setSession] = useState(null);
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');

  // Check session on load
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function handleAdminLogin(e) {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError('');

    // 1. Try to log in as the admin
    let { error: signInError } = await supabase.auth.signInWithPassword({
      email: 'admin@homefoods.app',
      password: password,
    });

    // 2. If the admin account doesn't exist yet, create it automatically
    if (signInError && signInError.message.includes('Invalid login credentials')) {
      const { error: signUpError } = await supabase.auth.signUp({
        email: 'admin@homefoods.app',
        password: password,
      });
      
      if (signUpError) {
        setAuthError(signUpError.message);
      }
    } else if (signInError) {
      setAuthError(signInError.message);
    }
    
    setAuthLoading(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  if (authLoading) {
    return (
      <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="app-shell__glow app-shell__glow--one" aria-hidden="true" />
        <p style={{ color: 'white', zIndex: 1 }}>Loading ERP Vault...</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '20px' }}>
        <div className="app-shell__glow app-shell__glow--one" aria-hidden="true" />
        <div className="app-shell__glow app-shell__glow--two" aria-hidden="true" />

        <section className="panel" style={{ maxWidth: '400px', width: '100%', zIndex: 1 }}>
          <div className="panel__header">
            <div>
              <span className="eyebrow">Restricted Access</span>
              <h2>Homefoods Admin ERP</h2>
              <p>Enter the master password to unlock the database.</p>
            </div>
          </div>

          <form onSubmit={handleAdminLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '24px' }}>
            <label className="field">
              <span>Master Password</span>
              <input
                className="form-input"
                type="password"
                placeholder="Minimum 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            {authError && <div className="message-banner">{authError}</div>}

            <button
              className="action-button"
              type="submit"
              disabled={authLoading || password.length < 6}
            >
              {authLoading ? 'Authenticating...' : 'Unlock ERP'}
            </button>
          </form>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-shell__glow app-shell__glow--one" aria-hidden="true" />
      <div className="app-shell__glow app-shell__glow--two" aria-hidden="true" />

      <header className="hero-panel">
        <div className="hero-panel__copy">
          <span className="eyebrow">Homefoods ERP</span>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <h1>Operational control for meals, credits, and weekly billing.</h1>
          </div>
          <p>
            Built around the weekly prepaid cycle, with daily roster toggles, carry-forward math, and
            settlement logging against Supabase.
          </p>

          <div className="hero-panel__chips">
            <span className={`status-chip ${hasSupabaseConfig ? 'status-chip--success' : 'status-chip--warning'}`}>
              {hasSupabaseConfig ? 'Supabase connected' : 'Supabase env missing'}
            </span>
            <span className="status-chip status-chip--neutral">Database-driven math</span>
            
            {/* Added Logout Button Here */}
            <button 
              onClick={handleLogout} 
              className="text-button text-button--danger" 
              style={{ marginLeft: 'auto', border: '1px solid currentColor', padding: '4px 12px', borderRadius: '4px' }}
            >
              Lock ERP (Logout)
            </button>
          </div>
        </div>

        <div className="hero-panel__highlights">
          {highlights.map((highlight) => (
            <article className="metric-card" key={highlight.label}>
              <span className="metric-card__label">{highlight.label}</span>
              <strong>{highlight.value}</strong>
            </article>
          ))}
        </div>
      </header>

      <nav className="tab-strip" aria-label="Homefoods ERP sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab-button ${activeTab === tab.id ? 'tab-button--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            aria-selected={activeTab === tab.id}
          >
            <span>{tab.label}</span>
            <small>{tab.description}</small>
          </button>
        ))}
      </nav>

      <main className="workspace-shell">
        {activeTab === 'daily' && <DailyDashboard />}
        {activeTab === 'billing' && <BillingDashboard />}
        {activeTab === 'customers' && <CustomerList />}
      </main>
    </div>
  );
}