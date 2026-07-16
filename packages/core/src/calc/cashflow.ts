import { assertMinor } from "../money/money";

/**
 * Monthly cash-flow series (Phase 2): actual months from recorded payments and
 * expenses, forecast months from unpaid billable certificates (bucketed by due
 * date) plus the recurring-expense list. All amounts in EGP piasters.
 */

export interface DatedAmount {
  /** ISO date YYYY-MM-DD */
  date: string;
  egpMinor: number;
}

export interface OpenReceivable {
  /** Due date (submission + terms, or override); null = not yet scheduled. */
  dueDate: string | null;
  unpaidEgp: number;
}

export interface RecurringItem {
  egpMinor: number;
  /** 1–31; clamped to the month's length implicitly by bucketing per month. */
  dayOfMonth: number;
}

export interface CashflowMonth {
  /** "YYYY-MM" */
  month: string;
  inActual: number;
  outActual: number;
  inForecast: number;
  outForecast: number;
  net: number;
  cumulative: number;
  isForecast: boolean;
}

export interface CashflowInput {
  actualIn: DatedAmount[];
  actualOut: DatedAmount[];
  openReceivables: OpenReceivable[];
  recurring: RecurringItem[];
  todayIso: string;
  monthsBack: number;
  monthsForward: number;
}

function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = (y ?? 0) * 12 + ((m ?? 1) - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

export function buildCashflow(input: CashflowInput): CashflowMonth[] {
  const currentMonth = monthOf(input.todayIso);
  const start = addMonths(currentMonth, -Math.max(0, input.monthsBack));
  const months: string[] = [];
  for (let i = 0; i <= input.monthsBack + input.monthsForward; i++) {
    months.push(addMonths(start, i));
  }
  const index = new Map(months.map((m, i) => [m, i]));
  const rows: CashflowMonth[] = months.map((month) => ({
    month,
    inActual: 0,
    outActual: 0,
    inForecast: 0,
    outForecast: 0,
    net: 0,
    cumulative: 0,
    isForecast: month > currentMonth,
  }));

  for (const item of input.actualIn) {
    assertMinor(item.egpMinor);
    const i = index.get(monthOf(item.date));
    if (i !== undefined) rows[i]!.inActual += item.egpMinor;
  }
  for (const item of input.actualOut) {
    assertMinor(item.egpMinor);
    const i = index.get(monthOf(item.date));
    if (i !== undefined) rows[i]!.outActual += item.egpMinor;
  }

  // Unpaid receivables: expected in their due month; overdue or unscheduled
  // ones are expected in the CURRENT month (they are collectible now).
  for (const receivable of input.openReceivables) {
    assertMinor(receivable.unpaidEgp);
    if (receivable.unpaidEgp <= 0) continue;
    let month = receivable.dueDate ? monthOf(receivable.dueDate) : currentMonth;
    if (month < currentMonth) month = currentMonth;
    const i = index.get(month);
    if (i !== undefined) rows[i]!.inForecast += receivable.unpaidEgp;
  }

  // Recurring expenses hit every FUTURE month (the current month's actuals
  // already include whatever was really spent).
  for (const item of input.recurring) {
    assertMinor(item.egpMinor);
    for (const row of rows) {
      if (row.month > currentMonth) row.outForecast += item.egpMinor;
    }
  }

  let cumulative = 0;
  for (const row of rows) {
    row.net = row.inActual + row.inForecast - row.outActual - row.outForecast;
    cumulative += row.net;
    row.cumulative = cumulative;
  }
  return rows;
}
