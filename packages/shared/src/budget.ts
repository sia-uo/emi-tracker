import { roundMinor, type Minor } from "@emi/core";
import type { ExpenseFrequency } from "./constants";
import type { Expense, UpcomingItem } from "./api-types";
import type { LoanSplit } from "./schemas";
import { splitAmount } from "./split";

/** What a recurring expense costs per month (quarterly ÷ 3, yearly ÷ 12, rounded to minor units). */
export function monthlyEquivalent(amount: Minor, frequency: ExpenseFrequency): Minor {
  return frequency === "monthly" ? amount : roundMinor(amount / (frequency === "quarterly" ? 3 : 12));
}

/** A prepayment as a dated amount (principal + charges). */
export interface PrepaidItem {
  date: string;
  currency: string;
  amount: Minor;
}

export interface BudgetRow {
  currency: string;
  /** Monthly income, when it is set in this currency. */
  income: Minor | null;
  /** The user's share of EMIs payable this month (skipped instalments excluded). */
  emis: Minor;
  /** Part of `emis` already paid. */
  emisPaid: Minor;
  /** Paid by the other people on split loans (not counted in `emis`). */
  emisOthers: Minor;
  /** Prepayments / foreclosures made this month (principal + charges), included in `emis` and `emisPaid`. */
  prepaid: Minor;
  /** Active fixed expenses, monthly equivalent. */
  expenses: Minor;
  outgo: Minor;
  /** income − outgo; null without income in this currency. */
  left: Minor | null;
}

/**
 * Month budget per currency — amounts in different currencies are never added together.
 * The income currency comes first, then the rest alphabetically.
 */
export function summarizeBudget(opts: {
  expenses: readonly Expense[];
  dues: readonly UpcomingItem[];
  income: { amount: Minor; currency: string } | null;
  /** Splits per loan id; only the user's share of a split loan counts towards the budget. */
  splits?: Readonly<Record<string, readonly LoanSplit[]>>;
  /** Prepayments made in the month (counted as payments, entirely the user's). */
  prepaid?: readonly PrepaidItem[];
}): BudgetRow[] {
  const rows = new Map<string, BudgetRow>();
  const row = (currency: string) => {
    let r = rows.get(currency);
    if (!r) rows.set(currency, (r = { currency, income: null, emis: 0, emisPaid: 0, emisOthers: 0, prepaid: 0, expenses: 0, outgo: 0, left: null }));
    return r;
  };
  if (opts.income) row(opts.income.currency).income = opts.income.amount;
  for (const d of opts.dues) {
    if (d.status === "skipped") continue;
    const r = row(d.currency);
    const { mine, othersTotal } = splitAmount(d.amount, opts.splits?.[d.loanId]);
    r.emis += mine;
    r.emisOthers += othersTotal;
    if (d.status === "paid") r.emisPaid += mine;
  }
  for (const p of opts.prepaid ?? []) {
    const r = row(p.currency);
    r.emis += p.amount;
    r.emisPaid += p.amount;
    r.prepaid += p.amount;
  }
  for (const e of opts.expenses) if (e.active) row(e.currency).expenses += monthlyEquivalent(e.amount, e.frequency);
  for (const r of rows.values()) {
    r.outgo = r.emis + r.expenses;
    r.left = r.income === null ? null : r.income - r.outgo;
  }
  const first = opts.income?.currency;
  return [...rows.values()].sort((a, b) => Number(b.currency === first) - Number(a.currency === first) || a.currency.localeCompare(b.currency));
}

export interface CashflowMonth {
  /** YYYY-MM */
  month: string;
  /** The user's share of EMIs payable that month. */
  emis: Minor;
  expenses: Minor;
  outgo: Minor;
  /** income − outgo */
  left: Minor;
}

export interface LoanEnding {
  loanId: string;
  name: string;
  /** YYYY-MM of the loan's last instalment. */
  month: string;
  /** The user's share of the loan's regular EMI, no longer payable after `month`. */
  frees: Minor;
}

const nextMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/**
 * Month-by-month cash flow in one currency, assuming income and fixed expenses stay as they
 * are and EMIs are paid as scheduled. `dues` should cover `months` months from `startMonth`.
 */
export function projectCashflow(opts: {
  currency: string;
  income: Minor;
  startMonth: string;
  months: number;
  dues: readonly UpcomingItem[];
  expenses: readonly Expense[];
  splits?: Readonly<Record<string, readonly LoanSplit[]>>;
  /** Prepayments count in the month they are paid. */
  prepaid?: readonly PrepaidItem[];
}): { months: CashflowMonth[]; endings: LoanEnding[] } {
  const expenses = opts.expenses
    .filter((e) => e.active && e.currency === opts.currency)
    .reduce((s, e) => s + monthlyEquivalent(e.amount, e.frequency), 0);
  const list: string[] = [];
  for (let m = opts.startMonth, i = 0; i < opts.months; i++, m = nextMonth(m)) list.push(m);
  const last = list[list.length - 1] ?? opts.startMonth;

  const emis = new Map<string, Minor>();
  const loans = new Map<string, { name: string; last: string; first: Minor }>();
  for (const d of opts.dues) {
    if (d.currency !== opts.currency || d.status === "skipped") continue;
    const month = d.payableDate.slice(0, 7);
    if (month < opts.startMonth || month > last) continue;
    const mine = splitAmount(d.amount, opts.splits?.[d.loanId]).mine;
    emis.set(month, (emis.get(month) ?? 0) + mine);
    const l = loans.get(d.loanId);
    if (!l) loans.set(d.loanId, { name: d.loanNickname, last: month, first: mine });
    else if (month > l.last) l.last = month;
  }

  for (const p of opts.prepaid ?? []) {
    const month = p.date.slice(0, 7);
    if (p.currency !== opts.currency || month < opts.startMonth || month > last) continue;
    emis.set(month, (emis.get(month) ?? 0) + p.amount);
  }

  const months = list.map((month) => {
    const e = emis.get(month) ?? 0;
    return { month, emis: e, expenses, outgo: e + expenses, left: opts.income - e - expenses };
  });
  // A loan whose dues run to the end of the window may well continue past it: not an ending.
  const endings = [...loans]
    .filter(([, l]) => l.last < last)
    .map(([loanId, l]) => ({ loanId, name: l.name, month: l.last, frees: l.first }))
    .sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name));
  return { months, endings };
}

/** Index of the first month from which `left` stays at or above `target` for good; null if never. */
export function breathingRoomFrom(months: readonly CashflowMonth[], target: Minor): number | null {
  let from: number | null = null;
  months.forEach((m, i) => {
    if (m.left < target) from = null;
    else if (from === null) from = i;
  });
  return from;
}
