import { buildSchedule, percentOf, roundMinor, type LoanTerms, type Minor, type Prepayment, type Schedule } from "@emi/core";
import type { RecordedPrepayment } from "./api-types";

/** Foreclosure prepays "everything": the engine caps a prepayment at the outstanding balance. */
const FORECLOSE_AMOUNT = 1e15;

export type PrepaymentDateIssue = "prepayment_before_first_emi" | "prepayment_after_loan_end";

export class PrepaymentDateError extends Error {
  constructor(
    readonly code: PrepaymentDateIssue,
    readonly prepaymentId: string,
  ) {
    super(code);
  }
}

export interface AppliedPrepayment {
  id: string;
  /** The instalment after which it was applied (the last one billed on or before its date). */
  afterN: number;
  /** Principal it actually paid off (a foreclosure: whatever was outstanding). */
  amount: Minor;
  /** Charge plus tax on it. */
  charges: Minor;
}

type Rec = Pick<RecordedPrepayment, "id" | "date" | "kind" | "amount" | "mode" | "charge" | "chargeTaxRate">;

/**
 * Apply prepayments the user actually made to a loan's terms. A prepayment counts from the
 * next EMI: it is applied right after the last instalment billed on or before its date, so the
 * following EMI (or, for a foreclosure, the end of the loan) reflects it. Interest for the days
 * between that instalment and the prepayment is not charged — a small simplification.
 */
export function applyRecordedPrepayments(terms: LoanTerms, recorded: readonly Rec[]): { schedule: Schedule; applied: AppliedPrepayment[] } {
  if (!recorded.length) return { schedule: buildSchedule(terms), applied: [] };
  const placed = placeRecordedPrepayments(terms, recorded);
  const schedule = buildSchedule({ ...terms, prepayments: [...(terms.prepayments ?? []), ...placed.map((x) => x.p)] });
  return { schedule, applied: splitApplied(schedule, placed) };
}

/** Recorded prepayments as engine prepayments, each dated at the instalment it follows. */
export function placeRecordedPrepayments(terms: LoanTerms, recorded: readonly Rec[]): { rec: Rec; p: Prepayment }[] {
  if (!recorded.length) return [];
  // Billed dates don't depend on prepayments, so the plain schedule tells us where each one lands.
  const base = buildSchedule({ ...terms, prepayments: [] });
  const recs = [...recorded].sort((a, b) => a.date.localeCompare(b.date));
  return recs.map((r) => {
    let idx = -1;
    for (let i = 0; i < base.rows.length && base.rows[i]!.billedDate <= r.date; i++) idx = i;
    if (idx < 0) throw new PrepaymentDateError("prepayment_before_first_emi", r.id);
    if (idx >= base.rows.length - 1) throw new PrepaymentDateError("prepayment_after_loan_end", r.id);
    const c = r.charge;
    const p: Prepayment = {
      date: base.rows[idx]!.billedDate,
      amount: r.kind === "foreclosure" ? FORECLOSE_AMOUNT : (r.amount ?? 0),
      mode: r.mode,
      chargePercent: c.kind === "percent" ? c.percent : 0,
      chargeFlat: c.kind === "flat" ? c.amount : 0,
      chargeTaxRate: c.kind === "none" ? 0 : r.chargeTaxRate,
    };
    return { rec: r, p };
  });
}

/** Split each row's prepayment back into the recorded ones, the way the engine applied them. */
function splitApplied(schedule: Schedule, placed: readonly { rec: Rec; p: Prepayment }[]): AppliedPrepayment[] {
  const applied: AppliedPrepayment[] = [];
  const used = new Map<number, number>();
  for (const { rec, p } of placed) {
    const row = schedule.rows.find((r) => r.billedDate === p.date);
    if (!row) {
      // An earlier foreclosure already ended the loan.
      applied.push({ id: rec.id, afterN: 0, amount: 0, charges: 0 });
      continue;
    }
    const before = row.closing + row.prepayment;
    const sofar = used.get(row.n) ?? 0;
    const amount = Math.max(0, Math.min(p.amount, before - sofar));
    used.set(row.n, sofar + amount);
    const charge = amount > 0 ? percentOf(amount, p.chargePercent ?? 0) + (p.chargeFlat ?? 0) : 0;
    applied.push({ id: rec.id, afterN: row.n, amount, charges: charge + percentOf(charge, p.chargeTaxRate ?? 0) });
  }
  return applied;
}

/** Principal + charges: what a recorded prepayment cost in the month it was paid. */
export const prepaymentTotal = (p: Pick<RecordedPrepayment, "appliedAmount" | "charges">): Minor => roundMinor(p.appliedAmount + p.charges);
