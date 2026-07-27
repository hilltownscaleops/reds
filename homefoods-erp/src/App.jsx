import { useState } from 'react';
import './App.css';
import DailyDashboard from './components/DailyDashboard';
import BillingDashboard from './components/BillingDashboard';
import CustomerList from './components/CustomerList';
import { hasSupabaseConfig } from './supabaseClient';

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

  return (
    <div className="app-shell">
      <div className="app-shell__glow app-shell__glow--one" aria-hidden="true" />
      <div className="app-shell__glow app-shell__glow--two" aria-hidden="true" />

      <header className="hero-panel">
        <div className="hero-panel__copy">
          <span className="eyebrow">Homefoods ERP</span>
          <h1>Operational control for meals, credits, and weekly billing.</h1>
          <p>
            Built around the weekly prepaid cycle, with daily roster toggles, carry-forward math, and
            settlement logging against Supabase.
          </p>

          <div className="hero-panel__chips">
            <span className={`status-chip ${hasSupabaseConfig ? 'status-chip--success' : 'status-chip--warning'}`}>
              {hasSupabaseConfig ? 'Supabase connected' : 'Supabase env missing'}
            </span>
            <span className="status-chip status-chip--neutral">Database-driven math</span>
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