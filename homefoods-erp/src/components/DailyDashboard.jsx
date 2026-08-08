import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import {
  MEAL_LABELS,
  STATUS_LABELS,
  calculateBaseWeeklyCost,
  defaultRosterRow,
  formatCurrency,
  formatPreference,
  formatDateInput,
  getDefaultRosterDate,
  getMonday,
  addDays,
  parseDate,
  normalizeMealPlan,
  isArchivedCustomer,
  isSameCalendarDate,
  isWithinCustomerWindow,
  statusTone,
} from '../erpHelpers';

const mealColumns = [
  { key: 'b_status', label: MEAL_LABELS.breakfast },
  { key: 'l_status', label: MEAL_LABELS.lunch },
  { key: 'd_status', label: MEAL_LABELS.dinner },
];

const mealKeyLookup = {
  b_status: 'breakfast',
  l_status: 'lunch',
  d_status: 'dinner',
};

function buildMealState(customer, rosterRow, mealColumn, selectedDate) {
  const mealPlan = normalizeMealPlan(customer.meal_plan);
  const fallbackRow = defaultRosterRow(customer.id, selectedDate, mealPlan);
  const status = rosterRow?.[mealColumn] ?? fallbackRow[mealColumn];
  const subscribed = mealPlan.includes(mealKeyLookup[mealColumn]);

  return {
    status,
    subscribed,
    label: STATUS_LABELS[String(status).toLowerCase()] ?? String(status ?? 'Inactive'),
  };
}

function buildWeekDates(referenceDate) {
  const weekStart = getMonday(parseDate(referenceDate) ?? new Date());
  return Array.from({ length: 7 }, (_, index) => formatDateInput(addDays(weekStart, index)));
}

function getDayLabel(dateString) {
  const date = parseDate(dateString);
  if (!date) return dateString;
  return date.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function emptyMealCounts() {
  return { breakfast: 0, lunch: 0, dinner: 0 };
}

function getMealName(mealColumn) {
  return mealColumn[0] === 'b' ? 'breakfast' : mealColumn[0] === 'l' ? 'lunch' : 'dinner';
}

// --- NEW: Pre-built Draggable Row Component ---
function SortableRosterRow({ row, date, savingKey, handleStatusChange, removeCustomerFromRoster, isReorderMode }) {
  const { customer, rosterRow, mealPlan, baseCost } = row;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: customer.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    position: 'relative',
    zIndex: isDragging ? 99 : 1,
    display: 'grid',
    gridTemplateColumns: '40px 1.5fr 1fr 1.5fr 135px 135px 135px 1fr 100px', // Matches Grid Header
    gap: '12px',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid #334155',
    backgroundColor: isDragging ? '#1e293b' : 'transparent',
    boxShadow: isDragging ? '0 10px 15px -3px rgba(0, 0, 0, 0.5)' : 'none',
  };

  return (
    <div ref={setNodeRef} style={style}>
      {/* Drag Handle ONLY appears if Reorder Mode is active */}
      {isReorderMode ? (
        <div {...attributes} {...listeners} style={{ cursor: 'grab', color: '#f97316', fontSize: '18px', textAlign: 'center', userSelect: 'none' }}>
          &#x2630;
        </div>
      ) : (
        <div></div>
      )}
      <div>
        <strong>{customer.name}</strong>
      </div>
      <div>{formatPreference(customer.preference)}</div>
      <div>
        <div className="chip-list">
          {mealPlan.length ? mealPlan.map((meal) => <span className="chip" key={meal}>{MEAL_LABELS[meal]}</span>) : <span className="chip chip--muted">No plan</span>}
        </div>
      </div>
      {mealColumns.map((mealColumn) => {
        const mealState = buildMealState(customer, rosterRow, mealColumn.key, date);
        const disabled = !mealState.subscribed;

        return (
          <div key={mealColumn.key}>
            <select
              className={`form-input status-toggle--${statusTone(mealState.status)}`}
              style={{ cursor: disabled ? 'not-allowed' : 'pointer', width: '100%' }}
              value={mealState.status}
              onChange={(event) => handleStatusChange(customer, mealColumn.key, event.target.value)}
              disabled={disabled || savingKey === `${customer.id}-${mealColumn.key}`}
              title={disabled ? 'This meal is not in the subscribed plan' : 'Select meal state'}
            >
              {disabled ? (
                <option value={mealState.status}>Not in plan</option>
              ) : (
                <>
                  <option value="active">Active (Veg)</option>
                  <option value="skipped">Skipped</option>
                  {mealColumn.key !== 'b_status' && (
                    <option value="active_nv">Active (Non-Veg)</option>
                  )}
                </>
              )}
            </select>
          </div>
        );
      })}
      <div>{formatCurrency(baseCost)}</div>
      <div>
        <button type="button" className="text-button text-button--danger" onClick={() => removeCustomerFromRoster(customer)} disabled={savingKey === `remove-${customer.id}`}>
          Remove
        </button>
      </div>
    </div>
  );
}


export default function DailyDashboard() {
  const [date, setDate] = useState(() => getDefaultRosterDate(new Date()));
  const [customers, setCustomers] = useState([]);
  const [roster, setRoster] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [savingKey, setSavingKey] = useState('');
  
  // NEW: Bulk Reorder State
  const [isReorderMode, setIsReorderMode] = useState(false);
  const [orderChanged, setOrderChanged] = useState(false);
  const [backupCustomers, setBackupCustomers] = useState([]);
  const [dialog, setDialog] = useState(null);

  const mountedRef = useRef(true);

  const weekDays = useMemo(() => buildWeekDates(date), [date]);
  const weekStart = weekDays[0];
  const weekEnd = weekDays[weekDays.length - 1];

  // Configure drag sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  async function loadRoster(selectedDate) {
    mountedRef.current = true;
    setLoading(true);
    setMessage('');

    try {
      const selectedWeekDays = buildWeekDates(selectedDate);
      const selectedWeekStart = selectedWeekDays[0];
      const selectedWeekEnd = selectedWeekDays[selectedWeekDays.length - 1];

      const [customerResult, rosterResult, settingsResult] = await Promise.all([
        supabase.from('customers').select('*'),
        supabase
          .from('daily_roster')
          .select('id, customer_id, roster_date, b_status, l_status, d_status')
          .gte('roster_date', selectedWeekStart)
          .lte('roster_date', selectedWeekEnd),
        supabase.from('global_settings').select('*').single(),
      ]);

      if (!mountedRef.current) return;

      if (customerResult.error || rosterResult.error || settingsResult?.error) {
        setMessage(customerResult.error?.message ?? rosterResult.error?.message ?? settingsResult?.error?.message ?? 'Unable to load daily roster.');
      } else {
        setMessage('');
      }

      // Important: Pre-sort the master customer list immediately upon fetching
      const fetchedCustomers = customerResult.data ?? [];
      fetchedCustomers.sort((a, b) => {
        const orderA = a.sort_order ?? 9999;
        const orderB = b.sort_order ?? 9999;
        if (orderA !== orderB) return orderA - orderB;
        
        const isNonVegA = String(a.preference || '').toLowerCase().includes('non');
        const isNonVegB = String(b.preference || '').toLowerCase().includes('non');
        if (isNonVegA && !isNonVegB) return -1;
        if (!isNonVegA && isNonVegB) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });

      setCustomers(fetchedCustomers);
      setRoster(rosterResult.data ?? []);
      setSettings(settingsResult?.data ?? null);
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error?.message ?? 'Unable to load daily roster.');
        setCustomers([]);
        setRoster([]);
        setSettings(null);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void (async () => {
      await loadRoster(date);
    })();
  }, [date]);

  const rosterRowsForSelectedDay = useMemo(() => roster.filter((row) => isSameCalendarDate(row.roster_date, date)), [roster, date]);
  const rosterLookup = useMemo(() => new Map(rosterRowsForSelectedDay.map((row) => [String(row.customer_id), row])), [rosterRowsForSelectedDay]);
  const rosterCustomerIds = useMemo(() => new Set(rosterRowsForSelectedDay.map((row) => String(row.customer_id))), [rosterRowsForSelectedDay]);
  
  const dateLookup = useMemo(
    () =>
      new Map(
        weekDays.map((day) => [
          day,
          roster.filter((row) => isSameCalendarDate(row.roster_date, day)),
        ]),
      ),
    [roster, weekDays],
  );

  // Derives the table rows directly from the global, pre-sorted `customers` state
  const selectedDayRows = useMemo(
    () =>
      customers
        .filter((customer) => rosterCustomerIds.has(String(customer.id)))
        .map((customer) => {
          const rosterRow = rosterLookup.get(String(customer.id));
          return {
            customer,
            rosterRow,
            mealPlan: normalizeMealPlan(customer.meal_plan),
            baseCost: calculateBaseWeeklyCost(customer, settings),
          };
        }),
    [customers, rosterCustomerIds, rosterLookup, settings],
  );

  const availableCustomers = useMemo(
    () => customers.filter((customer) => !rosterCustomerIds.has(String(customer.id)) && !isArchivedCustomer(customer) && isWithinCustomerWindow(customer, date)),
    [customers, rosterCustomerIds, date],
  );

  // NEW: Toggle Reorder Mode & Handle Bulk Save
  function handleToggleReorder() {
    if (!isReorderMode) {
      // Turn ON Reorder Mode
      setBackupCustomers([...customers]);
      setOrderChanged(false);
      setIsReorderMode(true);
    } else {
      // Turn OFF Reorder Mode
      if (orderChanged) {
        setDialog({
          title: 'Save New Route Order?',
          message: 'You have modified the customer order. Do you want to save this to the database permanently?',
          onConfirm: async () => {
            // FIX: Instantly close dialog and turn off drag UI so it doesn't feel stuck!
            setDialog(null);
            setIsReorderMode(false);
            setOrderChanged(false);
            setMessage('Saving new order to database...');
            
            try {
              const { error } = await supabase.from('customers').upsert(customers, { onConflict: 'id' });
              if (error) setMessage(error.message || 'Failed to save order to database.');
              else setMessage('Route order saved successfully.');
            } catch (err) {
              setMessage('Failed to save order: ' + err.message);
            }
          },
          onCancel: () => {
            setDialog(null);
            setCustomers(backupCustomers); // Revert to old order
            setIsReorderMode(false);
            setOrderChanged(false);
            setMessage('Reordering canceled.');
          }
        });
      } else {
        setIsReorderMode(false); // No changes made, just close it silently
      }
    }
  }

  // NEW: Robust Drag-and-Drop handler for dnd-kit (Local state ONLY)
  function handleDragEnd(event) {
    const { active, over } = event;
    
    if (!over || active.id === over.id) return;

    setCustomers((items) => {
      const oldIndex = items.findIndex((item) => item.id === active.id);
      const newIndex = items.findIndex((item) => item.id === over.id);

      const newlySorted = arrayMove(items, oldIndex, newIndex);
      
      return newlySorted.map((c, index) => ({
        ...c,
        sort_order: index,
      }));
    });
    
    setOrderChanged(true); // Flag that a drag occurred
  }

  async function handleStatusChange(customer, mealColumn, nextStatus) {
    const existingRow = rosterLookup.get(String(customer.id));
    const baseRow = existingRow ?? defaultRosterRow(customer.id, date, customer.meal_plan);
    const payload = {
      customer_id: baseRow.customer_id,
      roster_date: baseRow.roster_date,
      b_status: baseRow.b_status,
      l_status: baseRow.l_status,
      d_status: baseRow.d_status,
      [mealColumn]: nextStatus,
    };

    setSavingKey(`${customer.id}-${mealColumn}`);
    const { error } = await supabase.from('daily_roster').upsert(payload, {
      onConflict: 'customer_id,roster_date',
    });
    setSavingKey('');

    if (error) {
      setMessage(error.message ?? 'Error updating meal status.');
      return;
    }

    setMessage(`Updated ${customer.name}'s ${MEAL_LABELS[getMealName(mealColumn)]} roster.`);
    await loadRoster(date);
  }

  async function addCustomerToRoster(customer) {
    setSavingKey(`add-${customer.id}`);
    const { error } = await supabase.from('daily_roster').upsert(defaultRosterRow(customer.id, date, customer.meal_plan), {
      onConflict: 'customer_id,roster_date',
    });
    setSavingKey('');

    if (error) {
      setMessage(error.message ?? 'Unable to add customer to roster.');
      return;
    }
    setMessage(`Added ${customer.name} to the roster.`);
    await loadRoster(date);
  }

  async function removeCustomerFromRoster(customer) {
    setSavingKey(`remove-${customer.id}`);
    const { error } = await supabase.from('daily_roster').delete().eq('customer_id', customer.id).eq('roster_date', date);
    setSavingKey('');

    if (error) {
      setMessage(error.message ?? 'Unable to remove customer from roster.');
      return;
    }
    setMessage(`Removed ${customer.name} from the roster.`);
    await loadRoster(date);
  }

  async function rosterAllCustomers() {
    setSavingKey('roster-all');
    try {
      const [latestCustomers, currentSettings] = await Promise.all([
        supabase.from('customers').select('*').order('name', { ascending: true }),
        supabase.from('global_settings').select('*').single()
      ]);

      if (currentSettings.error) {
        setMessage(currentSettings.error.message ?? 'Unable to load pricing settings for roster all.');
        return;
      }

      const eligibleCustomers = (latestCustomers.data ?? []).filter((customer) => {
        if (isArchivedCustomer(customer)) return false;
        if (!isWithinCustomerWindow(customer, date)) return false;
        if (rosterCustomerIds.has(String(customer.id))) return false;
        return true;
      });

      if (eligibleCustomers.length === 0) {
        setMessage('No eligible customers found or everyone is already rostered for this date.');
        return;
      }

      const rows = eligibleCustomers.map((customer) => ({
        ...defaultRosterRow(customer.id, date, customer.meal_plan),
        customer_id: customer.id,
        roster_date: date,
      }));

      const rosterResult = await supabase.from('daily_roster').upsert(rows, { onConflict: 'customer_id,roster_date' });

      if (rosterResult.error) {
        setMessage(rosterResult.error.message ?? 'Unable to apply roster all.');
        return;
      }

      setMessage(`Roster all applied for ${eligibleCustomers.length} missing customers.`);
      await loadRoster(date);
    } catch (error) {
      setMessage(error?.message ?? 'Unable to apply roster all.');
    } finally {
      setSavingKey('');
    }
  }

  async function rosterSameAsYesterday() {
    const yesterday = formatDateInput(addDays(parseDate(date) ?? new Date(), -1));
    setSavingKey('same-yesterday');

    try {
      const [latestCustomers, yesterdayRosterResult, currentSettings] = await Promise.all([
        supabase.from('customers').select('*').order('name', { ascending: true }),
        supabase.from('daily_roster').select('customer_id, b_status, l_status, d_status').eq('roster_date', yesterday),
        supabase.from('global_settings').select('*').single(),
      ]);

      if (currentSettings.error || yesterdayRosterResult.error) {
        setMessage('Unable to load data for copy roster.');
        return;
      }

      const yesterdayLookup = new Map((yesterdayRosterResult.data ?? []).map((row) => [String(row.customer_id), row]));
      
      const eligibleCustomers = (latestCustomers.data ?? []).filter((customer) => {
        if (isArchivedCustomer(customer)) return false;
        if (!isWithinCustomerWindow(customer, date)) return false;
        if (rosterCustomerIds.has(String(customer.id))) return false;
        return true;
      });

      if (eligibleCustomers.length === 0) {
        setMessage('No eligible customers found for the selected roster date.');
        return;
      }

      const payload = eligibleCustomers.map((customer) => {
        const yesterdayRow = yesterdayLookup.get(String(customer.id));
        const fallbackRow = defaultRosterRow(customer.id, date, customer.meal_plan);
        return {
          customer_id: customer.id,
          roster_date: date,
          b_status: yesterdayRow?.b_status ?? fallbackRow.b_status,
          l_status: yesterdayRow?.l_status ?? fallbackRow.l_status,
          d_status: yesterdayRow?.d_status ?? fallbackRow.d_status,
        };
      });

      const copyResult = await supabase.from('daily_roster').upsert(payload, { onConflict: 'customer_id,roster_date' });

      if (copyResult.error) {
        setMessage(copyResult.error.message ?? 'Unable to apply same as yesterday.');
        return;
      }

      setMessage(`Copied yesterday roster into ${eligibleCustomers.length} customers.`);
      await loadRoster(date);
    } catch (error) {
      setMessage(error?.message ?? 'Unable to apply same as yesterday.');
    } finally {
      setSavingKey('');
    }
  }

  const mealTotals = selectedDayRows.reduce(
    (totals, row) => {
      const rosterRow = row.rosterRow;
      const isEaten = (status) => ['active', 'active_nv', 'nv_downgraded'].includes(status);

      if (isEaten(rosterRow?.b_status)) totals.breakfast += 1;
      if (isEaten(rosterRow?.l_status)) totals.lunch += 1;
      if (isEaten(rosterRow?.d_status)) totals.dinner += 1;

      return totals;
    },
    { breakfast: 0, lunch: 0, dinner: 0 },
  );

  const calendarDays = weekDays.map((day) => {
    const dayRows = dateLookup.get(day) ?? [];
    const mealCounts = dayRows.reduce(
      (totals, row) => {
        const isEaten = (status) => ['active', 'active_nv', 'nv_downgraded'].includes(status);

        if (isEaten(row.b_status)) totals.breakfast += 1;
        if (isEaten(row.l_status)) totals.lunch += 1;
        if (isEaten(row.d_status)) totals.dinner += 1;

        return totals;
      },
      emptyMealCounts(),
    );

    return {
      day,
      label: getDayLabel(day),
      mealCounts,
      totalMeals: mealCounts.breakfast + mealCounts.lunch + mealCounts.dinner,
      isSelected: day === date,
    };
  });

  return (
    <section className="panel">
      {/* Custom Dialog Overlay for Reorder Confirmation */}
      {dialog && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div style={{ background: '#1e293b', padding: '24px', borderRadius: '16px', width: '100%', maxWidth: '400px', color: 'white', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)' }}>
            <p style={{ margin: '0 0 8px 0', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#f97316', fontWeight: 'bold' }}>Action required</p>
            <h3 style={{ margin: '0 0 12px 0', fontSize: '20px' }}>{dialog.title}</h3>
            <p style={{ margin: '0 0 24px 0', lineHeight: 1.5, color: '#cbd5e1' }}>{dialog.message}</p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button onClick={dialog.onCancel} style={{ padding: '10px 16px', background: 'transparent', color: '#cbd5e1', border: '1px solid #475569', borderRadius: '8px', cursor: 'pointer' }}>Discard Changes</button>
              <button onClick={dialog.onConfirm} style={{ padding: '10px 16px', background: '#f97316', color: 'white', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>Save Order</button>
            </div>
          </div>
        </div>
      )}

      <div className="panel__header">
        <div>
          <span className="eyebrow">Daily Operations</span>
          <h2>Roster control and carry-forward updates</h2>
          <p>Each dropdown selection writes directly to the roster table.</p>
        </div>

        <label className="field field--date">
          <span>Date</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
      </div>

      <div className="summary-strip">
        <div className="summary-card">
          <span>Breakfast</span>
          <strong>{mealTotals.breakfast}</strong>
        </div>
        <div className="summary-card">
          <span>Lunch</span>
          <strong>{mealTotals.lunch}</strong>
        </div>
        <div className="summary-card">
          <span>Dinner</span>
          <strong>{mealTotals.dinner}</strong>
        </div>
      </div>

      {message ? <div className="message-banner">{message}</div> : null}

      <div className="roster-actions">
        <button type="button" className="action-button roster-action" onClick={rosterSameAsYesterday} disabled={savingKey === 'same-yesterday'}>
          Same as yesterday
        </button>
        <button type="button" className="action-button roster-action" onClick={rosterAllCustomers} disabled={savingKey === 'roster-all'}>
          Roster all
        </button>
      </div>

      <section className="calendar-panel">
        <div className="calendar-panel__header">
          <div>
            <span className="eyebrow">Weekly calendar</span>
            <h3>{getDayLabel(weekStart)} - {getDayLabel(weekEnd)}</h3>
          </div>
          <p>Click a day to load its roster in the table below.</p>
        </div>

        <div className="calendar-grid">
          {calendarDays.map((day) => (
            <button
              key={day.day}
              type="button"
              className={`calendar-day ${day.isSelected ? 'calendar-day--selected' : ''}`}
              onClick={() => setDate(day.day)}
            >
              <span className="calendar-day__label">{day.label}</span>
              <strong>{day.totalMeals}</strong>
              <div className="calendar-day__counts">
                <span>B {day.mealCounts.breakfast}</span>
                <span>L {day.mealCounts.lunch}</span>
                <span>D {day.mealCounts.dinner}</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      {loading ? (
        <div className="empty-state">Loading the weekly roster for {date}...</div>
      ) : selectedDayRows.length === 0 ? (
        <div className="empty-state">No roster rows were returned for {getDayLabel(date)}.</div>
      ) : (
        <section className="day-roster-panel">
          <div className="day-roster-panel__header">
            <div>
              <span className="eyebrow">Selected day</span>
              <h3>{getDayLabel(date)}</h3>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <div className="day-roster-panel__meta">
                <span className="status-chip status-chip--neutral">Breakfast {mealTotals.breakfast}</span>
                <span className="status-chip status-chip--neutral">Lunch {mealTotals.lunch}</span>
                <span className="status-chip status-chip--neutral">Dinner {mealTotals.dinner}</span>
              </div>
              
              {/* NEW: Reorder Toggle Switch */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 'bold', color: isReorderMode ? '#f97316' : '#94a3b8', background: isReorderMode ? 'rgba(249, 115, 22, 0.1)' : 'transparent', padding: '8px 12px', borderRadius: '8px', border: `1px solid ${isReorderMode ? '#f97316' : '#334155'}`, transition: 'all 0.2s', userSelect: 'none' }}>
                <input 
                  type="checkbox" 
                  checked={isReorderMode} 
                  onChange={handleToggleReorder} 
                  style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: '#f97316' }}
                />
                {isReorderMode ? 'Done Reordering' : 'Enable Reorder'}
              </label>
            </div>
          </div>

          {/* NEW: Replaced Table with CSS Grid and dnd-kit context */}
          <div className="table-shell" style={{ overflowX: 'auto', padding: '10px 0' }}>
            <div style={{ minWidth: '1000px', display: 'flex', flexDirection: 'column' }}>
              
              {/* Header Row */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '40px 1.5fr 1fr 1.5fr 135px 135px 135px 1fr 100px',
                gap: '12px',
                padding: '12px 16px',
                borderBottom: '2px solid #334155',
                color: '#94a3b8',
                fontWeight: '600',
                fontSize: '12px',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                textAlign: 'left'
              }}>
                <div></div>
                <div>Customer</div>
                <div>Preference</div>
                <div>Meal plan</div>
                <div>Breakfast</div>
                <div>Lunch</div>
                <div>Dinner</div>
                <div>Week base</div>
                <div>Action</div>
              </div>

              {/* Draggable Rows */}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={selectedDayRows.map(r => r.customer.id)} strategy={verticalListSortingStrategy}>
                  {selectedDayRows.map((row) => (
                    <SortableRosterRow
                      key={row.customer.id}
                      row={row}
                      date={date}
                      savingKey={savingKey}
                      handleStatusChange={handleStatusChange}
                      removeCustomerFromRoster={removeCustomerFromRoster}
                      isReorderMode={isReorderMode}
                    />
                  ))}
                </SortableContext>
              </DndContext>

            </div>
          </div>
        </section>
      )}

      <section className="roster-pool-panel">
        <div className="calendar-panel__header">
          <div>
            <span className="eyebrow">Roster pool</span>
            <h3>Add customers to today's roster</h3>
          </div>
          <p>{availableCustomers.length} customers available</p>
        </div>

        {availableCustomers.length === 0 ? (
          <div className="empty-state">No additional customers are available to add for this day.</div>
        ) : (
          <div className="roster-pool-grid">
            {availableCustomers.map((customer) => (
              <article className="roster-pool-card" key={customer.id}>
                <div>
                  <strong>{customer.name}</strong>
                  <p>{formatPreference(customer.preference)}</p>
                </div>
                <button type="button" className="action-button" onClick={() => addCustomerToRoster(customer)} disabled={savingKey === `add-${customer.id}`}>
                  Add
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
