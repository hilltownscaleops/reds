export const MEAL_ORDER = ['breakfast', 'lunch', 'dinner'];

export const MEAL_LABELS = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

export const STATUS_LABELS = {
  active: 'Active',
  skipped: 'Skipped',
  nv_downgraded: 'NV downgraded',
  inactive: 'Inactive',
};

export function toNumber(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseDate(value) {
  if (!value) return null;

  const datePart = String(value).slice(0, 10);
  const [year, month, day] = datePart.split('-').map(Number);

  if (!year || !month || !day) return null;

  return new Date(year, month - 1, day);
}

export function formatDateInput(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function addDays(date, count) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + count);
  return nextDate;
}

export function isWeekend(date) {
  const day = date.getDay();

  return day === 0 || day === 6;
}

export function getMonday(date) {
  const current = new Date(date);
  const day = current.getDay();
  const offset = day === 0 ? -6 : 1 - day;

  current.setDate(current.getDate() + offset);
  return current;
}

export function getFriday(date) {
  return addDays(getMonday(date), 4);
}

export function getAutoFillWindow(referenceDate) {
  const baseDate = referenceDate instanceof Date ? referenceDate : parseDate(referenceDate) ?? new Date();

  if (isWeekend(baseDate)) {
    const nextMonday = addDays(getMonday(baseDate), 7);

    return {
      start: nextMonday,
      end: addDays(nextMonday, 4),
    };
  }

  return {
    start: getMonday(baseDate),
    end: getFriday(baseDate),
  };
}

export function getDefaultRosterDate(referenceDate) {
  const baseDate = referenceDate instanceof Date ? referenceDate : parseDate(referenceDate) ?? new Date();

  if (isWeekend(baseDate)) {
    return formatDateInput(addDays(getMonday(baseDate), 7));
  }

  return formatDateInput(baseDate);
}

export function eachDateInRange(startDate, endDate) {
  const dates = [];

  if (!(startDate instanceof Date) || !(endDate instanceof Date) || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return dates;
  }

  const current = new Date(startDate);

  while (current <= endDate) {
    dates.push(formatDateInput(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

export function isSameCalendarDate(leftValue, rightValue) {
  const leftDate = parseDate(leftValue);
  const rightDate = parseDate(rightValue);

  if (!(leftDate instanceof Date) || Number.isNaN(leftDate.getTime())) return false;
  if (!(rightDate instanceof Date) || Number.isNaN(rightDate.getTime())) return false;

  return formatDateInput(leftDate) === formatDateInput(rightDate);
}

export function isWithinCustomerWindow(customer, dateString) {
  const rosterDate = parseDate(dateString);
  const startDate = parseDate(customer?.start_date) ?? rosterDate;
  const endDate = parseDate(customer?.end_date);

  if (!(rosterDate instanceof Date) || Number.isNaN(rosterDate.getTime())) return false;

  if (startDate && rosterDate < startDate) return false;
  if (endDate && rosterDate > endDate) return false;

  return true;
}

export function isArchivedCustomer(customer) {
  if (!customer) return false;

  if (typeof customer.is_archived === 'boolean') {
    return customer.is_archived;
  }

  if (typeof customer.active === 'boolean') {
    return !customer.active;
  }

  return Boolean(customer.archived_at);
}

export function formatCurrency(value) {
  return `₹${toNumber(value).toLocaleString('en-IN', {
    maximumFractionDigits: 0,
  })}`;
}

export function normalizeMealPlan(mealPlan) {
  if (Array.isArray(mealPlan)) {
    return mealPlan.map((meal) => String(meal).trim().toLowerCase()).filter(Boolean);
  }

  if (typeof mealPlan === 'string') {
    return mealPlan
      .split(',')
      .map((meal) => meal.trim().toLowerCase())
      .filter(Boolean);
  }

  return [];
}

export function formatPreference(preference) {
  const normalized = String(preference ?? '').trim().toLowerCase();

  if (normalized.includes('non')) return 'Non-Veg';
  if (normalized.includes('premium')) return 'NV Premium';
  return 'Veg';
}

export function getMealPrice(settings, mealType) {
  const priceMap = {
    breakfast: settings?.base_breakfast ?? settings?.breakfast_price ?? settings?.base_meal ?? 0,
    lunch: settings?.base_lunch ?? settings?.base_meal ?? settings?.base_breakfast ?? 0,
    dinner: settings?.base_dinner ?? settings?.base_lunch ?? settings?.base_meal ?? 0,
  };

  return toNumber(priceMap[mealType]);
}

export function calculateBaseWeeklyCost(customer, settings) {
  const plan = normalizeMealPlan(customer?.meal_plan);
  const premium = toNumber(settings?.nv_premium);

  const mealTotal = MEAL_ORDER.reduce((total, mealType) => {
    if (!plan.includes(mealType)) return total;

    return total + getMealPrice(settings, mealType) * 5;
  }, 0);

  const isNonVeg = String(customer?.preference ?? '').toLowerCase().includes('non');

  return mealTotal + (isNonVeg ? premium * 2 : 0);
}

export function calculateNetPayable(customer, settings) {
  return calculateBaseWeeklyCost(customer, settings) - toNumber(customer?.credit_balance);
}

export function defaultRosterRow(customerId, rosterDate, mealPlan) {
  const plan = normalizeMealPlan(mealPlan);

  return {
    customer_id: customerId,
    roster_date: rosterDate,
    b_status: plan.includes('breakfast') ? 'active' : 'skipped',
    l_status: plan.includes('lunch') ? 'active' : 'skipped',
    d_status: plan.includes('dinner') ? 'active' : 'skipped',
  };
}

export function buildRosterSeedRows(customer, referenceDate) {
  const window = getAutoFillWindow(referenceDate);
  const startDate = parseDate(customer?.start_date) ?? window.start;
  const endDate = parseDate(customer?.end_date) ?? window.end;
  const dateStart = startDate > window.start ? startDate : window.start;
  const dateEnd = endDate < window.end ? endDate : window.end;

  return eachDateInRange(dateStart, dateEnd)
    .filter((rosterDate) => isWithinCustomerWindow(customer, rosterDate))
    .map((rosterDate) => defaultRosterRow(customer.id, rosterDate, customer.meal_plan));
}

export function cycleMealStatus(currentStatus, mealColumn) {
  const normalized = String(currentStatus ?? 'active').toLowerCase();

  if (mealColumn === 'b_status') {
    return normalized === 'active' ? 'skipped' : 'active';
  }

  const cycle = ['active', 'skipped', 'nv_downgraded'];
  const currentIndex = cycle.indexOf(normalized);

  return cycle[(currentIndex + 1) % cycle.length] ?? 'active';
}

export function statusTone(status) {
  const normalized = String(status ?? '').toLowerCase();

  if (normalized === 'active') return 'success';
  if (normalized === 'skipped') return 'warning';
  if (normalized === 'nv_downgraded') return 'accent';
  return 'muted';
}