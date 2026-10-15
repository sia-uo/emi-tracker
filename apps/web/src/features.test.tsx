import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { addDays, addMonthsClamped, todayInZone } from "@emi/core";
import { en, type Me } from "@emi/shared";
import { AppRoutes } from "./App";

const me: Me = {
  user: { id: "u", email: "a@b.c", name: "Asha Rao", picture: null },
  settings: {
    country: "IN", currency: "INR", locale: "en-IN", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY", taxLabel: "GST", taxRate: 18,
    theme: "light", reminderHour: 9, dueWindowDays: 7, reminderDaysBefore: [3, 1], remindOnDay: true, remindOverdue: true, pushEnabled: true,
    emailReminders: true, weeklySummary: false, monthlyIncome: 2_00_000_00, incomeCurrency: "INR",
  },
  features: { email: false, push: true },
};

/** Just the list-item fields these screens read. */
const loan = (id: string, nickname: string, balance: number, rate: number, emi: number, extra: Record<string, unknown> = {}) => ({
  id, nickname, lenderId: "l1", cardId: null, type: "personal", currency: "INR", annualRate: rate, repaymentType: "reducing",
  interestTaxEnabled: false, interestTaxRate: 0, muted: false, createdAt: "2025-01-01", access: "owner", ownerName: null,
  lender: { name: "HDFC Bank", color: "#004C8F", initial: "H" }, card: null, nextInstalment: null,
  summary: { emi }, progress: { principalOutstanding: balance, progress: 0.2, instalmentsLeft: 6 },
  splits: [], prepaymentCharge: { kind: "none" }, prepaymentChargeTaxRate: 0,
  ...extra,
});
const cardEmi = loan("L2", "Phone EMI", 30_000_00, 16, 5_000_00, {
  type: "credit_card_emi", cardId: "c1", interestTaxEnabled: true, interestTaxRate: 18,
  card: { nickname: "Regalia", last4: "4321", holderName: "Ravi Rao" },
});
const personal = loan("L3", "Personal", 2_00_000_00, 12, 10_000_00);

const due = (id: string, amount: number, status: string) => ({
  instalmentId: id, loanId: "L2", loanNickname: "Phone EMI", lenderId: "l1", cardId: "c1", currency: "INR", n: 1,
  billedDate: "2025-06-12", payableDate: "2025-07-02", amount, status,
});
const expense = (id: string, name: string, amount: number, frequency: string, category = "fitness") => ({
  id, name, category, amount, currency: "INR", frequency, active: true, createdAt: "", updatedAt: "",
});

/** Serves `routes` for any method; returns the recorded calls (method, path, parsed body). */
function mockApi(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, "").split("?")[0]!;
      calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (!(path in routes)) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      return new Response(JSON.stringify(routes[path]), { status: 200 });
    }),
  );
  return calls;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const base = { "/me": me, "/lenders": [], "/cards": [], "/notifications": [], "/loans/shared": [] };
afterEach(() => vi.unstubAllGlobals());

describe("loans tab", () => {
  it("shows the card and whose name is on it", async () => {
    mockApi({ ...base, "/loans": [cardEmi, personal] });
    renderAt("/loans");
    expect(await screen.findByText(/Regalia ••4321/)).toBeInTheDocument();
    expect(screen.getByText("Name on card: Ravi Rao")).toBeInTheDocument();
    expect(screen.getAllByText(/Regalia/)).toHaveLength(1); // only the card EMI has a card line
  });

  it("shows your share of a split loan and who it's split with", async () => {
    const split = { ...personal, splits: [{ name: "Rahul", kind: "flat", amount: 3_000_00 }, { name: "Priya", kind: "percent", percent: 20 }] };
    mockApi({ ...base, "/loans": [split] });
    renderAt("/loans");
    expect(await screen.findByText("Split with Rahul, Priya")).toBeInTheDocument();
    expect(screen.getByText(en.loans.yourShare)).toBeInTheDocument();
    expect(screen.getByText("₹5,000.00")).toBeInTheDocument(); // 10,000 − 3,000 − 20%
  });
});

describe("budget", () => {
  it("adds this month's EMIs and fixed expenses and shows what's left", async () => {
    mockApi({
      ...base,
      "/loans": [cardEmi],
      "/instalments": [due("a", 10_000_00, "due"), due("b", 20_000_00, "paid"), due("c", 99_000_00, "skipped")],
      "/expenses": [expense("e1", "Gym", 2_000_00, "monthly"), expense("e2", "YouTube Premium", 1_490_00, "yearly", "subscriptions")],
    });
    renderAt("/budget");
    expect(await screen.findByText("₹2,00,000.00")).toBeInTheDocument(); // income
    expect(screen.getByText("₹30,000.00")).toBeInTheDocument(); // EMIs (skipped excluded)
    expect(screen.getByText("₹20,000.00 already paid")).toBeInTheDocument();
    expect(screen.getByText("₹2,124.17")).toBeInTheDocument(); // 2,000 + 1,490 ÷ 12
    expect(screen.getByText("₹1,67,875.83")).toBeInTheDocument(); // left over
    expect(screen.getByText("₹124.17 / month")).toBeInTheDocument();
    // Presets already added are hidden from quick add.
    expect(screen.queryByRole("button", { name: "YouTube Premium" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claude subscription" })).toBeInTheDocument();
  });

  it("counts only your share of a split loan", async () => {
    mockApi({
      ...base,
      "/loans": [{ ...cardEmi, splits: [{ name: "Rahul", kind: "flat", amount: 1_000_00 }] }],
      "/instalments": [due("a", 3_000_00, "due")],
      "/expenses": [],
    });
    renderAt("/budget");
    expect(await screen.findByText("+ ₹1,000.00 paid by others")).toBeInTheDocument();
    expect(screen.getByText("your share of ₹3,000.00")).toBeInTheDocument();
    expect(screen.getAllByText("₹2,000.00").length).toBeGreaterThanOrEqual(2); // summary + EMI list
    expect(screen.getByText("₹1,98,000.00")).toBeInTheDocument(); // 2,00,000 − 2,000 left over
  });
});

describe("extra cash planner", () => {
  it("recommends closing the costliest loan first", async () => {
    mockApi({ ...base, "/loans": [personal, cardEmi] });
    renderAt("/tools");
    fireEvent.click(await screen.findByRole("tab", { name: en.tools.extraCash }));
    fireEvent.change(await screen.findByLabelText(/Amount to use/), { target: { value: "50000" } });
    const steps = await screen.findAllByRole("listitem");
    const plan = steps.map((s) => s.textContent).filter((t) => /^\d(Close|Prepay)/.test(t ?? ""));
    expect(plan[0]).toMatch(/^1Close Phone EMI\s*— Pay ₹30,000\.00/);
    expect(plan[1]).toMatch(/^2Prepay Personal\s*— Pay ₹20,000\.00/);
  });

  it("uses each loan's saved pre-closure charge, flat or %", async () => {
    const charged = { ...cardEmi, prepaymentCharge: { kind: "flat", amount: 500_00 }, prepaymentChargeTaxRate: 18 };
    mockApi({ ...base, "/loans": [personal, charged] });
    renderAt("/tools");
    fireEvent.click(await screen.findByRole("tab", { name: en.tools.extraCash }));
    fireEvent.change(await screen.findByLabelText(/Amount to use/), { target: { value: "50000" } });
    expect(await screen.findByText(/Pay ₹30,590\.00/)).toBeInTheDocument(); // 30,000 + 500 + 18% GST
    expect(screen.getByText(/includes ₹590\.00 charges/)).toBeInTheDocument();
    // The saved charge is pre-filled and can be changed for a what-if.
    const value = screen.getByLabelText(/Charge \(INR\) — Phone EMI/) as HTMLInputElement;
    expect(value.value).toBe("500.00");
    fireEvent.change(value, { target: { value: "0" } });
    expect(await screen.findByText(/Pay ₹30,000\.00/)).toBeInTheDocument();
  });
});

describe("mobile navigation", () => {
  it("has Budget in the bottom bar and Settings in the top bar", async () => {
    mockApi({ ...base, "/loans": [], "/expenses": [], "/instalments": [] });
    renderAt("/budget");
    await screen.findByText(en.budget.intro);
    const [, bottom] = screen.getAllByRole("navigation", { name: en.nav.mainNavigation });
    expect(bottom!.textContent).toContain(en.nav.budget);
    expect(bottom!.textContent).not.toContain(en.nav.settings);
    expect(screen.getAllByRole("link", { name: en.nav.settings }).length).toBeGreaterThanOrEqual(2); // sidebar + top-bar gear
  });
});

/** A loan detail complete enough for the edit form and the detail page. */
function fullLoan(over: Record<string, unknown> = {}) {
  const inst = (n: number, closing: number) => ({
    id: `L9:${n}`, loanId: "L9", n, billedDate: `2025-0${n + 1}-05`, payableDate: `2025-0${n + 1}-05`, opening: closing + 50_000_00,
    interest: 1_000_00, principal: 50_000_00, emi: 51_000_00, interestTax: 0, fees: 0, shiftCost: 0, totalPayable: 51_000_00,
    closing, overridden: false, skipped: false, annualRate: 12, status: "upcoming" as const, payment: null,
  });
  return {
    id: "L9", lenderId: "l1", cardId: null, type: "personal", nickname: "Goa trip", currency: "INR", principal: 1_00_000_00,
    annualRate: 12, tenureMonths: 2, repaymentType: "reducing", bookingDate: "2025-01-05", firstEmiDate: "2025-02-05", emiDay: 5,
    processingFee: { kind: "none" }, processingFeeTaxRate: 0, feeCollection: "upfront", taxLabel: "GST", interestTaxEnabled: false,
    interestTaxRate: 0, emiShift: { enabled: false, dayCount: 365, collection: "first_instalment" }, noCostEmi: false, holidayRule: "none",
    muted: false, createdAt: "", updatedAt: "",
    prepaymentCharge: { kind: "percent", percent: 3 }, prepaymentChargeTaxRate: 18,
    splits: [{ name: "Rahul", kind: "flat", amount: 17_000_00 }],
    summary: { currency: "INR", emi: 51_000_00, financedPrincipal: 1_00_000_00, totalPrincipal: 1_00_000_00, totalInterest: 2_000_00, totalInterestTax: 0,
      noCostDiscount: 0, processingFee: 0, processingFeeTax: 0, totalFees: 0, shiftDays: 0, shiftInterest: 0, shiftTax: 0, shiftCost: 0, upfrontCharges: 0,
      totalPrepaid: 0, prepaymentCharges: 0, prepaymentChargeTax: 0, instalments: 2, totalCostOfBorrowing: 2_000_00, totalPayable: 1_02_000_00,
      equivalentReducingRate: 12, effectiveAnnualRate: 12.6, nominalApr: 12 },
    progress: { instalmentsTotal: 2, instalmentsPaid: 0, instalmentsLeft: 2, principalPaid: 0, interestPaid: 0, principalOutstanding: 1_00_000_00, progress: 0 },
    nextInstalment: inst(1, 50_000_00), instalments: [inst(1, 50_000_00), inst(2, 0)], rateChanges: [], documents: [], shares: [],
    access: "owner", lender: { name: "HDFC Bank", color: "#004C8F", initial: "H" }, card: null, ownerName: null,
    ...over,
  };
}

describe("loan splits and pre-closure charge", () => {
  it("the loan page shows each person's part of the next instalment", async () => {
    mockApi({ ...base, "/loans/L9": fullLoan() });
    renderAt("/loans/L9");
    expect(await screen.findByText(en.loans.splitTitle)).toBeInTheDocument();
    expect(screen.getByText("Rahul")).toBeInTheDocument();
    expect(screen.getByText("₹17,000.00")).toBeInTheDocument();
    expect(screen.getByText("₹34,000.00")).toBeInTheDocument(); // 51,000 − 17,000
    expect(screen.getByText("3% + 18% GST")).toBeInTheDocument(); // saved pre-closure charge
  });

  it("editing a loan keeps its people and charge, and previews your share", async () => {
    const lenders = [{ id: "l1", name: "HDFC Bank", country: "IN", color: "#004C8F", initial: "H", custom: false }];
    const calls = mockApi({ ...base, "/lenders": lenders, "/loans/L9": fullLoan() });
    renderAt("/loans/L9/edit");
    expect(await screen.findByDisplayValue("Rahul")).toBeInTheDocument();
    expect(screen.getByDisplayValue("17000.00")).toBeInTheDocument();
    expect(await screen.findByText(en.form.splitYourShare)).toBeInTheDocument();

    // Add a second person paying 10%, then save.
    fireEvent.click(screen.getByRole("button", { name: en.form.splitAdd }));
    const names = screen.getAllByLabelText(en.form.splitName);
    fireEvent.change(names[1]!, { target: { value: "Priya" } });
    fireEvent.click(screen.getAllByRole("combobox", { name: en.form.splitKind })[1]!);
    fireEvent.click(screen.getByRole("option", { name: en.form.splitPercent }));
    fireEvent.change(screen.getByLabelText(en.form.splitPercentValue), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: en.common.save }));

    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const body = calls.find((c) => c.method === "PUT")!.body;
    expect(body.splits).toEqual([
      { name: "Rahul", kind: "flat", amount: 17_000_00 },
      { name: "Priya", kind: "percent", percent: 10 },
    ]);
    expect(body.prepaymentCharge).toEqual({ kind: "percent", percent: 3 });
    expect(body.prepaymentChargeTaxRate).toBe(18);
  });
});

describe("pre-closure charge default", () => {
  it("new loans start at 3% plus the tax rate from settings", async () => {
    mockApi(base);
    renderAt("/loans/new");
    expect(await screen.findByLabelText(en.form.prepaymentChargePercentValue)).toHaveValue("3");
    expect(screen.getByLabelText(en.form.prepaymentChargeTax)).toHaveValue("18");
  });
});

describe("card line", () => {
  it("puts the name on card on its own line", async () => {
    mockApi({ ...base, "/loans": [cardEmi] });
    renderAt("/loans");
    const holder = await screen.findByText("Name on card: Ravi Rao");
    const cardName = screen.getByText(/Regalia ••4321/);
    expect(holder.closest("p")).not.toBe(cardName.closest("p"));
    expect(holder.closest("p")).toHaveAttribute("title", "Name on card: Ravi Rao");
  });
});

describe("loan filters", () => {
  it("filters by a specific card, shows chips and clears", async () => {
    mockApi({ ...base, "/loans": [cardEmi, personal] });
    renderAt("/loans");
    fireEvent.click(await screen.findByRole("button", { name: en.loans.filters.button }));
    fireEvent.click(screen.getByRole("combobox", { name: en.loans.filters.card }));
    fireEvent.click(screen.getByRole("option", { name: "Regalia ••4321" }));
    expect(await screen.findByText("Showing 1 of 2 loans")).toBeInTheDocument();
    expect(screen.queryByText("Personal")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: Card: Regalia ••4321" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.loans.filters.clear }));
    expect(await screen.findByText("Personal")).toBeInTheDocument();
  });

  it("reads filters from the URL and explains when nothing matches", async () => {
    mockApi({ ...base, "/loans": [cardEmi, personal] });
    renderAt("/loans?due=overdue");
    expect(await screen.findByText(en.loans.filters.noMatch)).toBeInTheDocument();
  });

  it("searches by name on card", async () => {
    mockApi({ ...base, "/loans": [cardEmi, personal] });
    renderAt("/loans");
    fireEvent.change(await screen.findByLabelText(en.loans.filters.search), { target: { value: "ravi" } });
    expect(await screen.findByText("Showing 1 of 2 loans")).toBeInTheDocument();
    expect(screen.getByText("Phone EMI")).toBeInTheDocument();
  });
});

describe("breathing room", () => {
  it("says from which month money is left over and which loans end", async () => {
    const start = todayInZone("Asia/Kolkata").slice(0, 8) + "01";
    const month = (n: number) => addMonthsClamped(start, n, 1);
    // ₹1,70,000 of EMIs for 3 months, then nothing. Income ₹2,00,000, gym ₹2,000 → ₹28,000 left, then ₹1,98,000.
    const dues = [0, 1, 2].map((n) => ({ ...due(`p${n}`, 1_70_000_00, "upcoming"), payableDate: addDays(month(n), 4), loanNickname: "Phone EMI" }));
    mockApi({ ...base, "/loans": [cardEmi], "/instalments": dues, "/expenses": [expense("e1", "Gym", 2_000_00, "monthly")] });
    renderAt("/budget");
    const long = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
    const label = (iso: string) => long.format(new Date(`${iso}T00:00:00Z`));
    expect(await screen.findByText(`Breathing room from ${label(month(3))}`)).toBeInTheDocument();
    expect(screen.getByText(/That's 3 months away\./)).toBeInTheDocument();
    expect(screen.getByText("Phone EMI ends")).toBeInTheDocument();
    expect(screen.getByText("frees ₹1,70,000.00 / month")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Monthly cash flow/ })).toBeInTheDocument();

    // A lower target means there is already enough left over.
    fireEvent.change(screen.getByLabelText(/Breathing room means at least/), { target: { value: "20000" } });
    expect(await screen.findByText(en.budget.breathing.already)).toBeInTheDocument();
  });
});

describe("recording a prepayment", () => {
  it("previews a foreclosure with the loan's saved charge and sends it", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = mockApi({ ...base, "/loans/L9": fullLoan(), "/loans/L9/prepayments": fullLoan() });
    renderAt("/loans/L9");
    fireEvent.click(await screen.findByRole("button", { name: en.prepayments.foreclose }));
    fireEvent.change(screen.getByLabelText(en.prepayments.date), { target: { value: "2025-02-20" } });
    expect(await screen.findByText(/^Pay ₹[\d,.]+ to close the loan after EMI #1\.$/)).toBeInTheDocument();
    expect(screen.getByText(/principal \+ ₹[\d,.]+ charges\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.prepayments.recordForeclosure }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      date: "2025-02-20", kind: "foreclosure", amount: null, mode: "reduce_tenure",
      charge: { kind: "percent", percent: 3 }, chargeTaxRate: 18,
    });
  });

  it("explains when a date is outside the loan", async () => {
    mockApi({ ...base, "/loans/L9": fullLoan() });
    renderAt("/loans/L9");
    const section = (await screen.findByRole("heading", { name: en.prepayments.title })).closest("section") as HTMLElement;
    fireEvent.change(within(section).getByLabelText(new RegExp(en.prepay.amount)), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText(en.prepayments.date), { target: { value: "2025-01-20" } });
    expect(await screen.findByText(en.errors.prepayment_before_first_emi)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.prepayments.record })).toBeDisabled();
  });

  it("lists recorded prepayments and marks them on the schedule", async () => {
    const pp = { id: "pp1", date: "2025-02-20", kind: "part", amount: 10_000_00, mode: "reduce_tenure", charge: { kind: "none" }, chargeTaxRate: 0, note: null, appliedAmount: 10_000_00, charges: 0, afterN: 1 };
    mockApi({ ...base, "/loans/L9": fullLoan({ prepayments: [pp] }) });
    renderAt("/loans/L9");
    expect(await screen.findByText("After EMI #1 · Reduce tenure (keep EMI)")).toBeInTheDocument();
    expect(screen.getAllByText("−₹10,000.00 prepaid").length).toBeGreaterThanOrEqual(1);
  });
});

describe("budget with prepayments", () => {
  it("counts a prepayment made this month as a payment", async () => {
    const today = todayInZone("Asia/Kolkata");
    const pp = { id: "pp1", date: today, kind: "foreclosure", amount: null, mode: "reduce_tenure", charge: { kind: "none" }, chargeTaxRate: 0, note: null, appliedAmount: 25_000_00, charges: 1_000_00, afterN: 2 };
    mockApi({ ...base, "/loans": [{ ...cardEmi, prepayments: [pp] }], "/instalments": [], "/expenses": [] });
    renderAt("/budget");
    expect(await screen.findByText("includes ₹26,000.00 prepaid")).toBeInTheDocument();
    expect(screen.getByText("₹26,000.00 already paid")).toBeInTheDocument();
    expect(screen.getByText(en.prepayments.foreclosure, { exact: false })).toBeInTheDocument();
  });
});
