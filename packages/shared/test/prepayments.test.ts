import { describe, expect, it } from "vitest";
import { buildSchedule, type LoanTerms } from "@emi/core";
import { applyRecordedPrepayments, PrepaymentDateError, type RecordedPrepayment } from "../src";

// ₹1,00,000 at 12% for 12 months, EMIs on the 5th from Feb 2025 (EMI ₹8,884.88).
const terms: LoanTerms = {
  currency: "INR", principal: 1_00_000_00, annualRate: 12, tenureMonths: 12, repaymentType: "reducing",
  bookingDate: "2025-01-05", firstEmiDate: "2025-02-05",
};
const rec = (over: Partial<RecordedPrepayment>) =>
  ({ id: "p1", date: "2025-04-15", kind: "part", amount: 20_000_00, mode: "reduce_tenure", charge: { kind: "none" }, chargeTaxRate: 0, ...over }) as RecordedPrepayment;

describe("applyRecordedPrepayments", () => {
  it("applies a prepayment from the next EMI after the day it was paid", () => {
    const { schedule, applied } = applyRecordedPrepayments(terms, [rec({})]);
    // Paid Apr 15 → after the Apr 5 instalment (#3), so May 5 (#4) already reflects it.
    expect(applied).toEqual([{ id: "p1", afterN: 3, amount: 20_000_00, charges: 0 }]);
    expect(schedule).toEqual(buildSchedule({ ...terms, prepayments: [{ date: "2025-04-05", amount: 20_000_00, mode: "reduce_tenure", chargePercent: 0, chargeFlat: 0, chargeTaxRate: 0 }] }));
    expect(schedule.rows[3]!.opening).toBe(schedule.rows[2]!.closing);
    expect(schedule.rows.length).toBeLessThan(12);
    expect(schedule.summary.totalPrepaid).toBe(20_000_00);
  });

  it("paying on an EMI's own date applies after that EMI", () => {
    expect(applyRecordedPrepayments(terms, [rec({ date: "2025-04-05" })]).applied[0]!.afterN).toBe(3);
  });

  it("reduce EMI keeps the tenure and lowers the next EMI", () => {
    const { schedule } = applyRecordedPrepayments(terms, [rec({ mode: "reduce_emi" })]);
    expect(schedule.rows).toHaveLength(12);
    expect(schedule.rows[3]!.emi).toBeLessThan(schedule.rows[2]!.emi);
  });

  it("a foreclosure ends the loan and pays the whole outstanding plus charges", () => {
    const { schedule, applied } = applyRecordedPrepayments(terms, [
      rec({ kind: "foreclosure", amount: null, charge: { kind: "percent", percent: 3 }, chargeTaxRate: 18 }),
    ]);
    expect(schedule.rows).toHaveLength(3);
    const outstanding = buildSchedule(terms).rows[2]!.closing;
    expect(applied[0]!.amount).toBe(outstanding);
    const charge = Math.round(outstanding * 0.03);
    expect(applied[0]!.charges).toBe(charge + Math.round(charge * 0.18));
    expect(schedule.rows.at(-1)!.closing).toBe(0);
  });

  it("a flat charge is added once", () => {
    const { applied } = applyRecordedPrepayments(terms, [rec({ charge: { kind: "flat", amount: 500_00 }, chargeTaxRate: 18 })]);
    expect(applied[0]!.charges).toBe(590_00);
  });

  it("a later prepayment after a foreclosure applies nothing", () => {
    const { applied } = applyRecordedPrepayments(terms, [rec({ kind: "foreclosure", amount: null }), rec({ id: "p2", date: "2025-06-10" })]);
    expect(applied[1]).toEqual({ id: "p2", afterN: 0, amount: 0, charges: 0 });
  });

  it("rejects dates before the first EMI or after the last one", () => {
    expect(() => applyRecordedPrepayments(terms, [rec({ date: "2025-02-01" })])).toThrow(PrepaymentDateError);
    try {
      applyRecordedPrepayments(terms, [rec({ date: "2026-01-05" })]);
    } catch (e) {
      expect((e as PrepaymentDateError).code).toBe("prepayment_after_loan_end");
    }
    expect.assertions(2);
  });
});
