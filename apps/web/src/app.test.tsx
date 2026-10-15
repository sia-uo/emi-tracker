import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { en, type Dashboard, type Me } from "@emi/shared";
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

const item = (id: string, loan: string, amount: number, currency = "INR", cardId: string | null = null) => ({
  instalmentId: id, loanId: loan, loanNickname: loan, lenderId: "l1", cardId, currency, n: 1,
  billedDate: "2025-06-12", payableDate: "2025-07-02", amount, status: "due" as const,
});

const dashboard: Dashboard = {
  today: "2025-06-28",
  payableThisMonth: { INR: 1_23_456_78, USD: 100_00 },
  stillToPayThisMonth: { INR: 1_00_000_00, USD: 100_00 },
  paidThisMonth: { INR: 23_456_78 },
  payableNextMonth: { INR: 61_000_00 },
  next7Days: { INR: 50_000_00 },
  next30Days: { INR: 75_000_00, USD: 100_00 },
  overdue: {},
  outstanding: { INR: 45_00_000_00, USD: 1_499_00 },
  byLender: { l1: { INR: 45_00_000_00 } },
  byType: { home: { INR: 45_00_000_00 }, bnpl: { USD: 1_499_00 } },
  upcoming: [
    { key: "card:c1:2025-07-02:INR", cardId: "c1", payableDate: "2025-07-02", currency: "INR", total: 30_000_00, items: [item("a", "iPhone", 10_000_00, "INR", "c1"), item("b", "Laptop", 20_000_00, "INR", "c1")] },
  ],
  activeLoans: 3,
  dti: { currency: "INR", income: 2_00_000_00, obligations: 55_000_00, ratio: 0.275, band: "healthy", excludedLoans: 1 },
  balanceTrend: {
    INR: [
      { date: "2025-06-01", outstanding: 45_00_000_00 },
      { date: "2025-07-01", outstanding: 44_80_000_00 },
      { date: "2025-08-01", outstanding: 44_60_000_00 },
    ],
  },
};

function mockApi(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).replace(/^.*\/api/, "").split("?")[0]!;
      if (!(path in routes)) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      return new Response(JSON.stringify(routes[path]), { status: 200 });
    }),
  );
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

afterEach(() => vi.unstubAllGlobals());

describe("app shell", () => {
  it("shows the sign-in screen when not authenticated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 })));
    renderAt("/");
    expect(await screen.findByText(en.auth.tagline)).toBeInTheDocument();
  });

  it("dashboard shows per-currency totals (lakh grouping) and groups card EMIs into one pay-by", async () => {
    mockApi({
      "/me": me,
      "/dashboard": dashboard,
      "/lenders": [{ id: "l1", name: "HDFC Bank", country: "IN", color: "#004C8F", initial: "H", custom: false }],
      "/cards": [{ id: "c1", nickname: "Regalia", lenderId: "l1", last4: "4321", statementDay: 12, dueDay: 2, graceDays: null }],
      "/notifications": [],
    });
    renderAt("/");
    expect(await screen.findByText("Hi Asha")).toBeInTheDocument();
    const tile = screen.getByText(en.dashboard.payableThisMonth).closest("div.card") as HTMLElement;
    expect(within(tile).getByText("₹1,23,456.78")).toBeInTheDocument();
    expect(within(tile).getByText("$100.00")).toBeInTheDocument();
    const next = screen.getByText(en.dashboard.payableNextMonth).closest("div.card") as HTMLElement;
    expect(within(next).getByText("₹61,000.00")).toBeInTheDocument();
    expect(screen.queryByText(en.dashboard.next30)).not.toBeInTheDocument();
    const still = screen.getByText(en.dashboard.stillToPay).closest("div.card") as HTMLElement;
    expect(within(still).getByText("₹1,00,000.00")).toBeInTheDocument();
    expect(within(still).getByText("₹23,456.78 of ₹1,23,456.78 paid")).toBeInTheDocument();
    expect(within(still).getByText("$0.00 of $100.00 paid")).toBeInTheDocument();
    expect(screen.getByText("2 EMIs on Regalia")).toBeInTheDocument();
    expect(screen.getByText("₹30,000.00")).toBeInTheDocument();
    // Two navigation landmarks (sidebar + bottom bar) with accessible names
    expect(screen.getAllByRole("navigation", { name: en.nav.mainNavigation }).length).toBe(2);
    // Debt-to-income tile + outstanding balance chart (with a data table)
    expect(screen.getByText("27.5%")).toBeInTheDocument();
    expect(screen.getByText(en.dashboard.dtiBands.healthy)).toBeInTheDocument();
    expect(screen.getByText("1 loan in another currency not counted.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Outstanding balance/ })).toBeInTheDocument();
  });
});

const sharedLoan = (access: "view" | "edit" | "owner") => {
  const inst = (n: number, closing: number) => ({
    id: `L1:${n}`, loanId: "L1", n, billedDate: `2025-0${n + 1}-05`, payableDate: `2025-0${n + 1}-05`, opening: closing + 50_000_00,
    interest: 1_000_00, principal: 50_000_00, emi: 51_000_00, interestTax: 0, fees: 0, shiftCost: 0, totalPayable: 51_000_00,
    closing, overridden: false, skipped: false, annualRate: 12, status: "upcoming" as const, payment: null,
  });
  return {
    id: "L1", lenderId: "seed-x", cardId: null, type: "personal", nickname: "Family car", currency: "INR", principal: 1_00_000_00,
    annualRate: 12, tenureMonths: 2, repaymentType: "reducing", bookingDate: "2025-01-05", firstEmiDate: "2025-02-05", emiDay: 5,
    processingFee: { kind: "none" }, processingFeeTaxRate: 0, feeCollection: "upfront", taxLabel: "None", interestTaxEnabled: false,
    interestTaxRate: 0, emiShift: { enabled: false, dayCount: 365, collection: "first_instalment" }, noCostEmi: false, holidayRule: "none",
    muted: false, createdAt: "", updatedAt: "",
    summary: { currency: "INR", emi: 51_000_00, financedPrincipal: 1_00_000_00, totalPrincipal: 1_00_000_00, totalInterest: 2_000_00, totalInterestTax: 0,
      noCostDiscount: 0, processingFee: 0, processingFeeTax: 0, totalFees: 0, shiftDays: 0, shiftInterest: 0, shiftTax: 0, shiftCost: 0, upfrontCharges: 0,
      totalPrepaid: 0, prepaymentCharges: 0, prepaymentChargeTax: 0, instalments: 2, totalCostOfBorrowing: 2_000_00, totalPayable: 1_02_000_00,
      equivalentReducingRate: 12, effectiveAnnualRate: 12.6, nominalApr: 12 },
    progress: { instalmentsTotal: 2, instalmentsPaid: 0, instalmentsLeft: 2, principalPaid: 0, interestPaid: 0, principalOutstanding: 1_00_000_00, progress: 0 },
    nextInstalment: inst(1, 50_000_00), instalments: [inst(1, 50_000_00), inst(2, 0)], rateChanges: [], documents: [], shares: [],
    access, lender: { name: "HDFC Bank", color: "#004C8F", initial: "H" }, ownerName: access === "owner" ? null : "Ravi",
  };
};

describe("shared loans in the UI", () => {
  const routes = (access: "view" | "edit" | "owner") => ({
    "/me": me, "/lenders": [], "/cards": [], "/notifications": [], "/loans/L1": sharedLoan(access),
  });

  it("view access is read-only: no pay/edit/delete/share/document controls", async () => {
    mockApi(routes("view"));
    renderAt("/loans/L1");
    expect(await screen.findByText(/shared this loan with you as view only/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: en.schedule.markPaid })).toHaveLength(0);
    expect(screen.queryByRole("button", { name: en.common.delete })).toBeNull();
    expect(screen.queryByRole("link", { name: en.common.edit })).toBeNull();
    expect(screen.queryByText(en.sharing.title)).toBeNull();
    expect(screen.queryByText(en.documents.title)).toBeNull();
    expect(screen.queryByRole("button", { name: en.rateChanges.add })).toBeNull();
    // Charts still render for viewers
    expect(screen.getByRole("img", { name: /Principal vs interest/ })).toBeInTheDocument();
  });

  it("edit access can record payments and edit, but cannot delete, share or see documents", async () => {
    mockApi(routes("edit"));
    renderAt("/loans/L1");
    expect((await screen.findAllByRole("button", { name: new RegExp(en.schedule.markPaid) })).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: en.common.edit })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.common.delete })).toBeNull();
    expect(screen.queryByText(en.sharing.title)).toBeNull();
    expect(screen.queryByText(en.documents.title)).toBeNull();
  });

  it("the owner sees sharing and documents", async () => {
    mockApi(routes("owner"));
    renderAt("/loans/L1");
    expect(await screen.findByText(en.sharing.title)).toBeInTheDocument();
    expect(screen.getByText(en.documents.title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.common.delete })).toBeInTheDocument();
  });
});

describe("i18n coverage", () => {
  it("every t('key') used in the web app and API exists in the English strings", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !f.includes(".test.")) files.push(p);
      }
    };
    walk(join(__dirname));
    walk(join(__dirname, "..", "..", "api", "src")); // server-side strings (emails, push)
    const missing: string[] = [];
    const has = (key: string) => {
      const v = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);
      return v !== undefined;
    };
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) {
        if (!has(m[1]!) && !has(m[1]! + "_one")) missing.push(`${f}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
