import { beforeEach, describe, expect, it } from "vitest";
import { addMonthsClamped, todayInZone } from "@emi/core";
import { resetRateLimits } from "../src/lib/security";
import { client, createUser, makeEnv } from "./helpers";

const loan = (over: Record<string, unknown> = {}) => ({
  lenderId: "seed-in-icici-bank",
  type: "personal",
  nickname: "Bike",
  currency: "INR",
  principal: 1_00_000_00,
  annualRate: 12,
  tenureMonths: 12,
  repaymentType: "reducing",
  bookingDate: "2025-01-05",
  firstEmiDate: "2025-02-05",
  emiDay: 5,
  ...over,
});

let env: ReturnType<typeof makeEnv>;
let c: ReturnType<typeof client>;
let bob: ReturnType<typeof client>;
beforeEach(async () => {
  resetRateLimits();
  env = makeEnv();
  c = client(env);
  c.setCookie(await createUser(env, "alice"));
  bob = client(env);
  bob.setCookie(await createUser(env, "bob"));
});

describe("recording a prepayment", () => {
  it("part-payment: applies from the next EMI, shortens the loan and lowers outstanding", async () => {
    const created = (await c.post("/loans", loan())).json;
    const res = await c.post(`/loans/${created.id}/prepayments`, { date: "2025-04-15", kind: "part", amount: 20_000_00 });
    expect(res.status).toBe(201);
    expect(res.json.prepayments).toEqual([
      expect.objectContaining({ date: "2025-04-15", kind: "part", amount: 20_000_00, appliedAmount: 20_000_00, charges: 0, afterN: 3, mode: "reduce_tenure" }),
    ]);
    expect(res.json.instalments.length).toBeLessThan(12);
    // #4 (May 5) already starts from the reduced balance.
    expect(res.json.instalments[3].opening).toBe(res.json.instalments[2].closing);
    expect(res.json.progress.principalOutstanding).toBe(1_00_000_00 - 20_000_00);
    expect(res.json.summary.totalPrepaid).toBe(20_000_00);

    // The loan list shows the same outstanding and the prepayment.
    const listed = (await c.get("/loans")).json[0];
    expect(listed.progress.principalOutstanding).toBe(80_000_00);
    expect(listed.prepayments).toHaveLength(1);
  });

  it("reduce EMI keeps the tenure with a lower EMI", async () => {
    const created = (await c.post("/loans", loan())).json;
    const res = await c.post(`/loans/${created.id}/prepayments`, { date: "2025-04-15", kind: "part", amount: 20_000_00, mode: "reduce_emi" });
    expect(res.json.instalments).toHaveLength(12);
    expect(res.json.instalments[3].emi).toBeLessThan(created.instalments[3].emi);
  });

  it("foreclosure: removes later EMIs, charges 3% + GST, and closes the loan once earlier EMIs are paid", async () => {
    const created = (await c.post("/loans", loan())).json;
    for (const i of created.instalments.slice(0, 3)) await c.post(`/instalments/${i.id}/payment`, { paidDate: i.payableDate, amountPaid: i.totalPayable });
    const res = await c.post(`/loans/${created.id}/prepayments`, {
      date: "2025-04-20",
      kind: "foreclosure",
      charge: { kind: "percent", percent: 3 },
      chargeTaxRate: 18,
    });
    expect(res.status).toBe(201);
    expect(res.json.instalments).toHaveLength(3);
    const outstanding = created.instalments[2].closing;
    const charge = Math.round(outstanding * 0.03);
    expect(res.json.prepayments[0]).toMatchObject({ kind: "foreclosure", amount: null, appliedAmount: outstanding, charges: charge + Math.round(charge * 0.18) });
    expect(res.json.progress.principalOutstanding).toBe(0);
    expect(res.json.nextInstalment).toBeNull();

    // Nothing left to prepay after a foreclosure.
    const late = await c.post(`/loans/${created.id}/prepayments`, { date: "2025-06-10", kind: "part", amount: 1_000_00 });
    expect(late.status).toBe(422);
    expect(late.json.error).toBe("prepayment_after_loan_end");
    expect((await c.get(`/loans/${created.id}`)).json.prepayments).toHaveLength(1);
  });

  it("deleting a prepayment restores the schedule", async () => {
    const created = (await c.post("/loans", loan())).json;
    const pp = (await c.post(`/loans/${created.id}/prepayments`, { date: "2025-04-15", kind: "foreclosure" })).json.prepayments[0];
    const res = await c.del(`/loans/${created.id}/prepayments/${pp.id}`);
    expect(res.status).toBe(200);
    expect(res.json.instalments).toEqual(created.instalments);
    expect(res.json.prepayments).toEqual([]);
    expect(res.json.progress.principalOutstanding).toBe(1_00_000_00);
  });

  it("validates", async () => {
    const created = (await c.post("/loans", loan())).json;
    const bad = async (body: unknown) => c.post(`/loans/${created.id}/prepayments`, body);
    expect((await bad({ date: "2025-04-15", kind: "part" })).status).toBe(400); // amount required
    const early = await bad({ date: "2025-02-01", kind: "part", amount: 1_000_00 });
    expect([early.status, early.json.error]).toEqual([422, "prepayment_before_first_emi"]);
    const flat = (await c.post("/loans", loan({ repaymentType: "flat" }))).json;
    const r = await c.post(`/loans/${flat.id}/prepayments`, { date: "2025-04-15", kind: "part", amount: 1_000_00 });
    expect([r.status, r.json.error]).toEqual([422, "prepayment_reducing_only"]);
    expect((await c.get(`/loans/${created.id}`)).json.prepayments).toEqual([]);
  });

  it("only the owner or an editor can record, and data is removed with the loan", async () => {
    const created = (await c.post("/loans", loan())).json;
    expect((await bob.post(`/loans/${created.id}/prepayments`, { date: "2025-04-15", kind: "foreclosure" })).status).toBe(404);
    await c.post(`/loans/${created.id}/shares`, { email: "bob@example.com", access: "view" });
    expect((await bob.post(`/loans/${created.id}/prepayments`, { date: "2025-04-15", kind: "foreclosure" })).status).toBe(403);
    await c.post(`/loans/${created.id}/prepayments`, { date: "2025-04-15", kind: "part", amount: 1_000_00 });
    expect((await bob.get("/loans/shared")).json[0].prepayments).toHaveLength(1);
    await c.del(`/loans/${created.id}`);
    expect(env.DB.db.prepare("SELECT COUNT(*) AS n FROM prepayments").get()).toEqual({ n: 0 });
  });
});

describe("dashboard KPIs with prepayments", () => {
  it("counts a foreclosure as paid this month and drops next month's EMI", async () => {
    const today = todayInZone("Asia/Kolkata");
    const first = addMonthsClamped(today, -2);
    const created = (
      await c.post("/loans", loan({ bookingDate: addMonthsClamped(today, -3), firstEmiDate: first, emiDay: Number(first.slice(8)) }))
    ).json;
    const before = (await c.get("/dashboard")).json;
    expect(before.payableNextMonth.INR).toBe(created.summary.emi);

    // Paid the EMIs so far, then foreclosed today.
    const due = created.instalments.filter((i: { billedDate: string }) => i.billedDate <= today);
    for (const i of due) await c.post(`/instalments/${i.id}/payment`, { paidDate: today, amountPaid: i.totalPayable });
    const res = await c.post(`/loans/${created.id}/prepayments`, { date: today, kind: "foreclosure" });
    expect(res.status).toBe(201);
    const pp = res.json.prepayments[0];

    const after = (await c.get("/dashboard")).json;
    expect(after.payableNextMonth).toEqual({});
    expect(after.outstanding).toEqual({});
    expect(after.activeLoans).toBe(0);
    expect(after.stillToPayThisMonth).toEqual({});
    const emisThisMonth = due.filter((i: { payableDate: string }) => i.payableDate >= today.slice(0, 8) + "01").reduce((s: number, i: { totalPayable: number }) => s + i.totalPayable, 0);
    expect(after.paidThisMonth.INR).toBe(emisThisMonth + pp.appliedAmount + pp.charges);
    expect(after.payableThisMonth.INR).toBe(after.paidThisMonth.INR);
  });

  it("a part-payment with reduce EMI lowers what is payable next month", async () => {
    const today = todayInZone("Asia/Kolkata");
    const first = addMonthsClamped(today, -2);
    const created = (
      await c.post("/loans", loan({ bookingDate: addMonthsClamped(today, -3), firstEmiDate: first, emiDay: Number(first.slice(8)) }))
    ).json;
    await c.post(`/loans/${created.id}/prepayments`, { date: today, kind: "part", amount: 30_000_00, mode: "reduce_emi" });
    const d = (await c.get("/dashboard")).json;
    expect(d.payableNextMonth.INR).toBeLessThan(created.summary.emi);
    expect(d.outstanding.INR).toBe(1_00_000_00 - 30_000_00);
  });
});
