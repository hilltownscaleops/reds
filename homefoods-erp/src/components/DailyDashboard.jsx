import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import {
  MEAL_LABELS,
  STATUS_LABELS,
  calculateBaseWeeklyCost,
  calculateNetPayable,
  cycleMealStatus,
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
  toNumber,
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

export default function DailyDashboard() {
  const [date, setDate] = useState(() => getDefaultRosterDate(new Date()));
  const [customers, setCustomers] = useState([]);
  const [roster, setRoster] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [savingKey, setSavingKey] = useState('');
  const mountedRef = useRef(true);

  const weekDays = useMemo(() => buildWeekDates(date), [date]);
  const weekStart = weekDays[0];
  const weekEnd = weekDays[weekDays.length - 1];

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  async function loadRoster(selectedDate) {
    await Promise.resolve();
    setLoading(true);
    setMessage('');

    try {
      const selectedWeekDays = buildWeekDates(selectedDate);
      const selectedWeekStart = selectedWeekDays[0];
      const selectedWeekEnd = selectedWeekDays[selectedWeekDays.length - 1];

      const [customerResult, rosterResult, settingsResult] = await Promise.all([
        supabase.from('customers').select('id, name, meal_plan, preference, credit_balance, start_date, end_date').order('name', { ascending: true }),
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

      setCustomers(customerResult.data ?? []);
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
  const rosterLookup = useMemo(() => new Map(rosterRowsForSelectedDay.map((row) => [row.customer_id, row])), [rosterRowsForSelectedDay]);
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

  const selectedDayRows = useMemo(
    () =>
      rosterRowsForSelectedDay
        .map((row) => ({
          rosterRow: row,
          customer: customers.find((customer) => String(customer.id) === String(row.customer_id)),
        }))
        .filter((entry) => entry.customer),
    [customers, rosterRowsForSelectedDay],
  );

  const availableCustomers = useMemo(
    () => customers.filter((customer) => !rosterCustomerIds.has(String(customer.id)) && !isArchivedCustomer(customer) && isWithinCustomerWindow(customer, date)),
    [customers, rosterCustomerIds, date],
  );

  async function handleToggle(customer, mealColumn) {
    const existingRow = rosterLookup.get(customer.id);
    const baseRow = existingRow ?? defaultRosterRow(customer.id, date, customer.meal_plan);
    const nextStatus = cycleMealStatus(baseRow[mealColumn], mealColumn);
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

  async function fetchLatestCustomers() {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, meal_plan, preference, credit_balance, start_date, end_date, archived_at, is_archived, active')
      .order('name', { ascending: true });

    if (error) {
      throw error;
    }

    return data ?? [];
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
      const [latestCustomers, currentSettings] = await Promise.all([fetchLatestCustomers(), supabase.from('global_settings').select('*').single()]);

      if (currentSettings.error) {
        setMessage(currentSettings.error.message ?? 'Unable to load pricing settings for roster all.');
        return;
      }

      const eligibleCustomers = latestCustomers.filter((customer) => {
        if (isArchivedCustomer(customer)) return false;
        if (!isWithinCustomerWindow(customer, date)) return false;
        return true;
      });

      if (eligibleCustomers.length === 0) {
        setMessage('No eligible customers found for the selected roster date.');
        return;
      }

      const rows = eligibleCustomers.map((customer) => ({
        ...defaultRosterRow(customer.id, date, customer.meal_plan),
        customer_id: customer.id,
        roster_date: date,
      }));

      const rosterResult = await supabase.from('daily_roster').upsert(rows, {
        onConflict: 'customer_id,roster_date',
      });

      if (rosterResult.error) {
        setMessage(rosterResult.error.message ?? 'Unable to apply roster all.');
        return;
      }

      const baseTotal = eligibleCustomers.reduce((total, customer) => total + calculateBaseWeeklyCost(customer, currentSettings.data), 0);
      const netTotal = eligibleCustomers.reduce((total, customer) => total + calculateNetPayable(customer, currentSettings.data), 0);

      setMessage(
        `Roster all applied for ${eligibleCustomers.length} customers. Base total ${formatCurrency(baseTotal)}. Net payable ${formatCurrency(netTotal)}.`,
      );
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
        fetchLatestCustomers(),
        supabase
          .from('daily_roster')
          .select('customer_id, b_status, l_status, d_status')
          .eq('roster_date', yesterday),
        supabase.from('global_settings').select('*').single(),
      ]);

      if (currentSettings.error) {
        setMessage(currentSettings.error.message ?? 'Unable to load pricing settings for copy roster.');
        return;
      }

      if (yesterdayRosterResult.error) {
        setMessage(yesterdayRosterResult.error.message ?? 'Unable to copy yesterday roster.');
        return;
      }

      const yesterdayLookup = new Map((yesterdayRosterResult.data ?? []).map((row) => [String(row.customer_id), row]));
      const eligibleCustomers = latestCustomers.filter((customer) => !isArchivedCustomer(customer) && isWithinCustomerWindow(customer, date));

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

      const copyResult = await supabase.from('daily_roster').upsert(payload, {
        onConflict: 'customer_id,roster_date',
      });

      if (copyResult.error) {
        setMessage(copyResult.error.message ?? 'Unable to apply same as yesterday.');
        return;
      }

      const baseTotal = eligibleCustomers.reduce((total, customer) => total + calculateBaseWeeklyCost(customer, currentSettings.data), 0);
      const netTotal = eligibleCustomers.reduce((total, customer) => total + calculateNetPayable(customer, currentSettings.data), 0);

      setMessage(
        `Copied yesterday roster into ${eligibleCustomers.length} customers. Base total ${formatCurrency(baseTotal)}. Net payable ${formatCurrency(netTotal)}.`,
      );
      await loadRoster(date);
    } catch (error) {
      setMessage(error?.message ?? 'Unable to apply same as yesterday.');
    } finally {
      setSavingKey('');
    }
  }

  const rows = customers.map((customer) => {
    const rosterRow = rosterLookup.get(customer.id);

    return {
      customer,
      rosterRow,
      baseCost: calculateBaseWeeklyCost(customer, settings),
      mealPlan: normalizeMealPlan(customer.meal_plan),
    };
  });

  const mealTotals = rows.reduce(
    (totals, row) => {
      const rosterRow = row.rosterRow;

      if ((rosterRow?.b_status ?? 'skipped') === 'active') totals.breakfast += 1;
      if ((rosterRow?.l_status ?? 'skipped') === 'active') totals.lunch += 1;
      if ((rosterRow?.d_status ?? 'skipped') === 'active') totals.dinner += 1;

      return totals;
    },
    { breakfast: 0, lunch: 0, dinner: 0 },
  );

  const calendarDays = weekDays.map((day) => {
    const dayRows = dateLookup.get(day) ?? [];
    const mealCounts = dayRows.reduce(
      (totals, row) => {
        if ((row.b_status ?? 'skipped') === 'active') totals.breakfast += 1;
        if ((row.l_status ?? 'skipped') === 'active') totals.lunch += 1;
        if ((row.d_status ?? 'skipped') === 'active') totals.dinner += 1;

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
      <div className="panel__header">
        <div>
          <span className="eyebrow">Daily Operations</span>
          <h2>Roster control and carry-forward updates</h2>
          <p>Each toggle writes directly to the roster table so the trigger can update customer credit immediately.</p>
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
            <div className="day-roster-panel__meta">
              <span className="status-chip status-chip--neutral">Breakfast {mealTotals.breakfast}</span>
              <span className="status-chip status-chip--neutral">Lunch {mealTotals.lunch}</span>
              <span className="status-chip status-chip--neutral">Dinner {mealTotals.dinner}</span>
            </div>
          </div>

          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Preference</th>
                  <th>Meal plan</th>
                  <th>Credit balance</th>
                  <th>Breakfast</th>
                  <th>Lunch</th>
                  <th>Dinner</th>
                  <th>Week base</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {selectedDayRows.map(({ customer, rosterRow, mealPlan, baseCost }) => (
                  <tr key={customer.id}>
                    <td>
                      <strong>{customer.name}</strong>
                    </td>
                    <td>{formatPreference(customer.preference)}</td>
                    <td>
                      <div className="chip-list">
                        {mealPlan.length ? mealPlan.map((meal) => <span className="chip" key={meal}>{MEAL_LABELS[meal]}</span>) : <span className="chip chip--muted">No plan</span>}
                      </div>
                    </td>
                    <td>
                      <span className={`status-chip status-chip--${toNumber(customer.credit_balance) >= 0 ? 'success' : 'warning'}`}>
                        {formatCurrency(customer.credit_balance)}
                      </span>
                    </td>
                    {mealColumns.map((mealColumn) => {
                      const mealState = buildMealState(customer, rosterRow, mealColumn.key, date);
                      const disabled = !mealState.subscribed;

                      return (
                        <td key={mealColumn.key}>
                          <button
                            type="button"
                            className={`status-toggle status-toggle--${statusTone(mealState.status)}`}
                            onClick={() => handleToggle(customer, mealColumn.key)}
                            disabled={disabled || savingKey === `${customer.id}-${mealColumn.key}`}
                            title={disabled ? 'This meal is not in the subscribed plan' : 'Click to cycle the meal state'}
                          >
                            {disabled ? 'Not in plan' : mealState.label}
                          </button>
                        </td>
                      );
                    })}
                    <td>{formatCurrency(baseCost)}</td>
                    <td>
                      <button type="button" className="text-button text-button--danger" onClick={() => removeCustomerFromRoster(customer)} disabled={savingKey === `remove-${customer.id}`}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="roster-pool-panel">
        <div className="calendar-panel__header">
          <div>
            <span className="eyebrow">Roster pool</span>
            <h3>Add customers to today’s roster</h3>
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