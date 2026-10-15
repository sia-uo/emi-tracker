import {
  addDays,
  addMonthsClamped,
  buildSchedule,
  compareISO,
  derivePayableDate,
  dtiBand,
  groupPayables,
  instalmentStatus,
  loanProgress,
  todayInZone,
  totalsByCurrency,
  totalsByKeyAndCurrency,
  type LoanProgress,
  type PayableRule,
  type RateChangeMode,
  type ScheduleSummary,
} from "@emi/core";
import { applyRecordedPrepayments, PrepaymentDateError, type RecordedPrepayment } from "@emi/shared";
import { toLoanTerms, type Card, type CardSnapshot, type Dashboard, type LenderSnapshot, type LoanAccess, type LoanShare, type Instalment, type LoanDetail, type LoanInput, type LoanListItem, type UpcomingItem } from "@emi/shared";
import { ApiError, notFound } from "../lib/errors";
import { chunk } from "../lib/util";
import { cardFromRow, loanFromRow, sqlLiteral } from "./repo";

type Row = Record<string, unknown>;

/** What status derivation needs: the user's local date and their "due" window. */
export interface StatusCtx {
  today: string;
  dueWindowDays: number;
}

const STATUS_CTX_SQL = "SELECT time_zone, due_window_days FROM settings WHERE user_id = ?";

function statusCtxFromRow(r: Row | undefined): StatusCtx {
  return {
    today: todayInZone(String(r?.time_zone ?? "UTC")),
    dueWindowDays: r?.due_window_days === undefined || r?.due_window_days === null ? 7 : Number(r.due_window_days),
  };
}

export async function userStatusCtx(db: D1Database, userId: string): Promise<StatusCtx> {
  return statusCtxFromRow((await db.prepare(STATUS_CTX_SQL).bind(userId).first<Row>()) ?? undefined);
}

export async function loadCard(db: D1Database, userId: string, cardId: string | null | undefined): Promise<Card | null> {
  if (!cardId) return null;
  const r = await db.prepare("SELECT * FROM cards WHERE id = ? AND user_id = ?").bind(cardId, userId).first<Row>();
  if (!r) throw new ApiError(422, "card_not_found");
  return cardFromRow(r);
}

/**
 * Rebuild a loan's instalments from its terms, preserving manual overrides,
 * skip flags and payments (instalment ids are stable: '<loanId>:<n>').
 * Returns the summary which is cached on the loan row.
 */
export async function regenerateSchedule(
  db: D1Database,
  userId: string,
  loanId: string,
  input: LoanInput,
  card: Card | null,
): Promise<ScheduleSummary> {
  const [ov, rc, pp] = await db.batch([
    db.prepare("SELECT n, override_amount FROM instalments WHERE loan_id = ? AND user_id = ? AND override_amount IS NOT NULL").bind(loanId, userId),
    db.prepare("SELECT effective_date, annual_rate, mode FROM rate_changes WHERE loan_id = ? AND user_id = ?").bind(loanId, userId),
    db.prepare(`${PREPAYMENT_SELECT} WHERE loan_id = ? AND user_id = ? ORDER BY paid_date, created_at`).bind(loanId, userId),
  ]);
  const overrides: Record<number, number> = {};
  for (const r of (ov!.results as Row[]) ?? []) {
    const n = Number(r.n);
    if (n < input.tenureMonths) overrides[n] = Number(r.override_amount);
  }
  const rateChanges = ((rc!.results as Row[]) ?? []).map((r) => ({
    effectiveDate: String(r.effective_date),
    annualRate: Number(r.annual_rate),
    mode: String(r.mode) as RateChangeMode,
  }));

  const recorded = ((pp!.results as Row[]) ?? []).map(prepaymentFromRow);
  let schedule: ReturnType<typeof buildSchedule>;
  let applied: ReturnType<typeof applyRecordedPrepayments>["applied"];
  try {
    ({ schedule, applied } = applyRecordedPrepayments(toLoanTerms(input, { overrides, rateChanges }), recorded));
  } catch (e) {
    if (e instanceof PrepaymentDateError) throw new ApiError(422, e.code);
    throw e;
  }
  const rule: PayableRule = {
    card: card ? { statementDay: card.statementDay, dueDay: card.dueDay, graceDays: card.graceDays } : null,
    holidayRule: input.holidayRule,
  };

  // Multi-row upserts with literal values (all generated numbers/ids/dates) keep us well
  // under D1's 100 bound-parameter and 50 queries-per-invocation limits.
  const statements: D1PreparedStatement[] = [];
  for (const part of chunk(schedule.rows, 150)) {
    const values = part
      .map((r) =>
        `(${[
          sqlLiteral(`${loanId}:${r.n}`),
          sqlLiteral(userId),
          sqlLiteral(loanId),
          r.n,
          sqlLiteral(r.billedDate),
          sqlLiteral(derivePayableDate(r.billedDate, rule)),
          r.annualRate,
          r.opening,
          r.interest,
          r.principal,
          r.emi,
          r.interestTax,
          r.processingFee + r.processingFeeTax,
          r.shiftInterest + r.shiftTax,
          r.totalPayable,
          r.closing,
        ].join(",")})`,
      )
      .join(",\n");
    statements.push(
      db.prepare(
        `INSERT INTO instalments (id, user_id, loan_id, n, billed_date, payable_date, annual_rate, opening, interest, principal, emi, interest_tax, fees, shift_cost, total_payable, closing)
         VALUES ${values}
         ON CONFLICT(id) DO UPDATE SET billed_date=excluded.billed_date, payable_date=excluded.payable_date,
           annual_rate=excluded.annual_rate, opening=excluded.opening, interest=excluded.interest,
           principal=excluded.principal, emi=excluded.emi, interest_tax=excluded.interest_tax, fees=excluded.fees,
           shift_cost=excluded.shift_cost, total_payable=excluded.total_payable, closing=excluded.closing`,
      ),
    );
  }
  statements.push(
    // Schedule length can differ from the contract tenure (keep-EMI rate changes), so trim by actual rows.
    db.prepare("DELETE FROM payments WHERE loan_id = ? AND user_id = ? AND instalment_id IN (SELECT id FROM instalments WHERE loan_id = ? AND n > ?)").bind(loanId, userId, loanId, schedule.rows.length),
    db.prepare("DELETE FROM instalments WHERE loan_id = ? AND user_id = ? AND n > ?").bind(loanId, userId, schedule.rows.length),
    db.prepare("UPDATE loans SET summary = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?").bind(JSON.stringify(schedule.summary), loanId, userId),
    ...applied.map((a) =>
      db.prepare("UPDATE prepayments SET applied_amount = ?, charges = ?, after_n = ? WHERE id = ? AND user_id = ?").bind(a.amount, a.charges, a.afterN, a.id, userId),
    ),
  );
  await db.batch(statements);
  return schedule.summary;
}

const PREPAYMENT_SELECT = "SELECT * FROM prepayments";

export function prepaymentFromRow(r: Row): RecordedPrepayment {
  return {
    id: String(r.id),
    date: String(r.paid_date),
    kind: String(r.kind) as RecordedPrepayment["kind"],
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    mode: String(r.mode) as RecordedPrepayment["mode"],
    charge: JSON.parse(String(r.charge ?? '{"kind":"none"}')),
    chargeTaxRate: Number(r.charge_tax_rate ?? 0),
    note: r.note === null || r.note === undefined ? null : String(r.note),
    appliedAmount: Number(r.applied_amount ?? 0),
    charges: Number(r.charges ?? 0),
    afterN: Number(r.after_n ?? 0),
  };
}

function prepaymentsByLoan(rows: Row[]): Map<string, RecordedPrepayment[]> {
  const out = new Map<string, RecordedPrepayment[]>();
  for (const r of rows) {
    const id = String(r.loan_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push(prepaymentFromRow(r));
  }
  return out;
}

const INSTALMENT_SELECT = `
  SELECT i.*, p.id AS payment_id, p.paid_date, p.amount_paid, p.late_fee, p.note AS payment_note
  FROM instalments i LEFT JOIN payments p ON p.instalment_id = i.id AND p.user_id = i.user_id`;

export function instalmentFromRow(r: Row, ctx: StatusCtx): Instalment {
  const payment = r.payment_id
    ? {
        id: String(r.payment_id),
        paidDate: String(r.paid_date),
        amountPaid: Number(r.amount_paid),
        lateFee: Number(r.late_fee),
        note: r.payment_note === null ? null : String(r.payment_note),
      }
    : null;
  const payableDate = String(r.payable_date);
  return {
    id: String(r.id),
    loanId: String(r.loan_id),
    n: Number(r.n),
    billedDate: String(r.billed_date),
    payableDate,
    opening: Number(r.opening),
    interest: Number(r.interest),
    principal: Number(r.principal),
    emi: Number(r.emi),
    interestTax: Number(r.interest_tax),
    fees: Number(r.fees),
    shiftCost: Number(r.shift_cost),
    totalPayable: Number(r.total_payable),
    closing: Number(r.closing),
    overridden: r.override_amount !== null && r.override_amount !== undefined,
    skipped: Number(r.skipped) === 1,
    annualRate: Number(r.annual_rate),
    status: instalmentStatus(
      { payableDate, paidAt: payment?.paidDate ?? null, skipped: Number(r.skipped) === 1 },
      ctx.today,
      ctx.dueWindowDays,
    ),
    payment,
  };
}

/** Outstanding = financed − principal of paid instalments − principal prepaid (part-payments, foreclosure). */
function progressFrom(instalments: Instalment[], summary: ScheduleSummary): LoanProgress {
  const p = loanProgress(instalments.map((i) => ({ ...i, paid: !!i.payment })));
  const repaid = p.principalPaid + (summary.totalPrepaid ?? 0);
  const financed = summary.financedPrincipal;
  return { ...p, principalOutstanding: financed - repaid, progress: financed > 0 ? Math.min(1, repaid / financed) : 0 };
}

/** Who is looking at a loan. Data always lives under the owner's user_id. */
export interface Viewer {
  userId: string;
  role: LoanAccess;
  ownerName?: string | null;
}

function lenderSnapshot(r: Row): LenderSnapshot | null {
  return r.lender_name ? { name: String(r.lender_name), color: String(r.lender_color), initial: String(r.lender_initial) } : null;
}

/** Callers must only pass rows of the viewer's own loans: the card is private to the owner. */
function cardSnapshot(r: Row): CardSnapshot | null {
  return r.card_nickname ? { nickname: String(r.card_nickname), last4: r.card_last4 ? String(r.card_last4) : null, holderName: r.card_holder ? String(r.card_holder) : null } : null;
}

const LOAN_WITH_LENDER = `SELECT l.*, ld.name AS lender_name, ld.color AS lender_color, ld.initial AS lender_initial,
    cd.nickname AS card_nickname, cd.last4 AS card_last4, cd.holder_name AS card_holder
  FROM loans l LEFT JOIN lenders ld ON ld.id = l.lender_id
  LEFT JOIN cards cd ON cd.id = l.card_id AND cd.user_id = l.user_id`;

function shareFromRow(r: Row): LoanShare {
  return {
    id: String(r.id),
    email: String(r.email),
    access: String(r.access) as LoanShare["access"],
    status: r.user_id ? "active" : "pending",
    name: r.user_name ? String(r.user_name) : null,
    createdAt: String(r.created_at),
  };
}

/**
 * Full loan view. `ownerId` scopes every query; `viewer` controls what is revealed:
 * documents, shares and the owner's card id are owner-only. Status uses the viewer's
 * own time zone and due window.
 */
export async function getLoanDetail(db: D1Database, ownerId: string, loanId: string, viewer?: Viewer): Promise<LoanDetail> {
  const v: Viewer = viewer ?? { userId: ownerId, role: "owner" };
  const isOwner = v.role === "owner";
  const [loanRes, instRes, tzRes, rcRes, docRes, shareRes, ppRes] = await db.batch([
    db.prepare(`${LOAN_WITH_LENDER} WHERE l.id = ? AND l.user_id = ?`).bind(loanId, ownerId),
    db.prepare(`${INSTALMENT_SELECT} WHERE i.loan_id = ? AND i.user_id = ? ORDER BY i.n`).bind(loanId, ownerId),
    db.prepare(STATUS_CTX_SQL).bind(v.userId),
    db.prepare("SELECT id, effective_date, annual_rate, mode FROM rate_changes WHERE loan_id = ? AND user_id = ? ORDER BY effective_date").bind(loanId, ownerId),
    // Owner-only data: the queries match nothing for shared viewers.
    db
      .prepare("SELECT id, filename, content_type, size, created_at FROM documents WHERE loan_id = ? AND user_id = ? AND ? = 1 ORDER BY created_at DESC")
      .bind(loanId, ownerId, isOwner ? 1 : 0),
    db
      .prepare(
        `SELECT s.*, u.name AS user_name FROM loan_shares s LEFT JOIN users u ON u.id = s.user_id
         WHERE s.loan_id = ? AND s.owner_id = ? AND ? = 1 ORDER BY s.created_at`,
      )
      .bind(loanId, ownerId, isOwner ? 1 : 0),
    db.prepare(`${PREPAYMENT_SELECT} WHERE loan_id = ? AND user_id = ? ORDER BY paid_date, created_at`).bind(loanId, ownerId),
  ]);
  const row = (loanRes!.results as Row[])[0];
  if (!row) throw notFound("loan_not_found");
  const ctx = statusCtxFromRow((tzRes!.results as Row[])[0]);
  const loan = loanFromRow(row);
  const instalments = (instRes!.results as Row[]).map((r) => instalmentFromRow(r, ctx));
  return {
    ...loan,
    // The owner's card is never exposed to shared users (payable dates already reflect it).
    cardId: isOwner ? loan.cardId : null,
    instalments,
    progress: progressFrom(instalments, loan.summary),
    nextInstalment: instalments.find((i) => !i.payment && !i.skipped) ?? null,
    access: v.role,
    lender: lenderSnapshot(row),
    card: isOwner ? cardSnapshot(row) : null,
    prepayments: (ppRes!.results as Row[]).map(prepaymentFromRow),
    ownerName: isOwner ? null : (v.ownerName ?? null),
    rateChanges: (rcRes!.results as Row[]).map((r) => ({
      id: String(r.id),
      effectiveDate: String(r.effective_date),
      annualRate: Number(r.annual_rate),
      mode: String(r.mode) as RateChangeMode,
    })),
    documents: (docRes!.results as Row[]).map((r) => ({
      id: String(r.id),
      filename: String(r.filename),
      contentType: String(r.content_type),
      size: Number(r.size),
      createdAt: String(r.created_at),
    })),
    shares: (shareRes!.results as Row[]).map(shareFromRow),
  };
}

function toListItems(
  loanRows: Row[],
  instRows: Row[],
  ppRows: Row[],
  ctx: StatusCtx,
  role: (r: Row) => LoanAccess,
  isOwner: (r: Row) => boolean,
): LoanListItem[] {
  const prepaid = prepaymentsByLoan(ppRows);
  const byLoan = new Map<string, Instalment[]>();
  for (const r of instRows) {
    const i = instalmentFromRow(r, ctx);
    let list = byLoan.get(i.loanId);
    if (!list) byLoan.set(i.loanId, (list = []));
    list.push(i);
  }
  return loanRows.map((r) => {
    const loan = loanFromRow(r);
    const inst = byLoan.get(loan.id) ?? [];
    return {
      ...loan,
      cardId: isOwner(r) ? loan.cardId : null,
      progress: progressFrom(inst, loan.summary),
      nextInstalment: inst.find((i) => !i.payment && !i.skipped) ?? null,
      access: role(r),
      lender: lenderSnapshot(r),
      card: isOwner(r) ? cardSnapshot(r) : null,
      prepayments: prepaid.get(loan.id) ?? [],
      ownerName: isOwner(r) ? null : r.owner_name ? String(r.owner_name) : null,
    };
  });
}

/** The user's own loans. */
export async function listLoans(db: D1Database, userId: string): Promise<LoanListItem[]> {
  const [loanRes, instRes, tzRes, ppRes] = await db.batch([
    db.prepare(`${LOAN_WITH_LENDER} WHERE l.user_id = ? ORDER BY l.created_at DESC`).bind(userId),
    db.prepare(`${INSTALMENT_SELECT} WHERE i.user_id = ? ORDER BY i.loan_id, i.n`).bind(userId),
    db.prepare(STATUS_CTX_SQL).bind(userId),
    db.prepare(`${PREPAYMENT_SELECT} WHERE user_id = ? ORDER BY paid_date, created_at`).bind(userId),
  ]);
  return toListItems(
    loanRes!.results as Row[],
    instRes!.results as Row[],
    ppRes!.results as Row[],
    statusCtxFromRow((tzRes!.results as Row[])[0]),
    () => "owner",
    () => true,
  );
}

/** Loans other people shared with the user — only those loans, nothing else of the owner's. */
export async function listSharedLoans(db: D1Database, userId: string): Promise<LoanListItem[]> {
  const [loanRes, instRes, tzRes, ppRes] = await db.batch([
    db
      .prepare(
        `SELECT l.*, ld.name AS lender_name, ld.color AS lender_color, ld.initial AS lender_initial, s.access AS share_access, u.name AS owner_name
         FROM loan_shares s
         JOIN loans l ON l.id = s.loan_id AND l.user_id = s.owner_id
         JOIN users u ON u.id = s.owner_id
         LEFT JOIN lenders ld ON ld.id = l.lender_id
         WHERE s.user_id = ? ORDER BY l.created_at DESC`,
      )
      .bind(userId),
    db
      .prepare(
        `${INSTALMENT_SELECT} JOIN loan_shares s ON s.loan_id = i.loan_id AND s.owner_id = i.user_id
         WHERE s.user_id = ? ORDER BY i.loan_id, i.n`,
      )
      .bind(userId),
    db.prepare(STATUS_CTX_SQL).bind(userId),
    db
      .prepare(
        `SELECT pp.* FROM prepayments pp JOIN loan_shares s ON s.loan_id = pp.loan_id AND s.owner_id = pp.user_id
         WHERE s.user_id = ? ORDER BY pp.paid_date, pp.created_at`,
      )
      .bind(userId),
  ]);
  return toListItems(
    loanRes!.results as Row[],
    instRes!.results as Row[],
    ppRes!.results as Row[],
    statusCtxFromRow((tzRes!.results as Row[])[0]),
    (r) => String(r.share_access) as LoanAccess,
    () => false,
  );
}

/** Instalments in a payable-date range (calendar / list view), across all loans. */
export async function listInstalmentsInRange(
  db: D1Database,
  userId: string,
  from: string,
  to: string,
): Promise<UpcomingItem[]> {
  const ctx = await userStatusCtx(db, userId);
  const res = await db
    .prepare(
      `${INSTALMENT_SELECT.replace("SELECT i.*", "SELECT i.*, l.nickname AS loan_nickname, l.lender_id, l.card_id, l.currency")}
       JOIN loans l ON l.id = i.loan_id AND l.user_id = i.user_id
       WHERE i.user_id = ? AND i.payable_date BETWEEN ? AND ? ORDER BY i.payable_date, l.nickname`,
    )
    .bind(userId, from, to)
    .all<Row>();
  return res.results.map((r) => toUpcoming(r, ctx));
}

function toUpcoming(r: Row, ctx: StatusCtx): UpcomingItem {
  const i = instalmentFromRow(r, ctx);
  return {
    instalmentId: i.id,
    loanId: i.loanId,
    loanNickname: String(r.loan_nickname),
    lenderId: String(r.lender_id),
    cardId: r.card_id === null ? null : String(r.card_id),
    currency: String(r.currency),
    n: i.n,
    billedDate: i.billedDate,
    payableDate: i.payableDate,
    amount: i.totalPayable,
    status: i.status,
  };
}

export async function getDashboard(db: D1Database, userId: string): Promise<Dashboard> {
  const ctx = await userStatusCtx(db, userId);
  const today = ctx.today;
  const monthStart = today.slice(0, 8) + "01";
  const monthEnd = addDays(addMonthsClamped(monthStart, 1), -1);
  const horizon = addDays(today, 30);
  const nextMonthStart = addMonthsClamped(monthStart, 1, 1);
  const nextMonthEnd = addDays(addMonthsClamped(monthStart, 2, 1), -1);
  const windowEnd = compareISO(horizon, nextMonthEnd) > 0 ? horizon : nextMonthEnd;

  const [dueRes, loanRes, paidRes, nextRes, trendRes, incomeRes, prepaidRes] = await db.batch([
    db
      .prepare(
        `${INSTALMENT_SELECT.replace("SELECT i.*", "SELECT i.*, l.nickname AS loan_nickname, l.lender_id, l.card_id, l.currency")}
         JOIN loans l ON l.id = i.loan_id AND l.user_id = i.user_id
         WHERE i.user_id = ? AND i.payable_date <= ? AND (i.payable_date >= ? OR (p.id IS NULL AND i.skipped = 0))
         ORDER BY i.payable_date`,
      )
      .bind(userId, windowEnd, monthStart),
    db.prepare("SELECT id, lender_id, type, currency, summary FROM loans WHERE user_id = ?").bind(userId),
    db
      .prepare(
        `SELECT i.loan_id, SUM(i.principal) AS principal_paid FROM instalments i
         JOIN payments p ON p.instalment_id = i.id AND p.user_id = i.user_id
         WHERE i.user_id = ? GROUP BY i.loan_id`,
      )
      .bind(userId),
    // Each loan's next unpaid instalment, excluding one-off fees / EMI-shift cost: the regular monthly obligation.
    db
      .prepare(
        `SELECT i.loan_id, MIN(i.n) AS n, i.total_payable - i.fees - i.shift_cost AS regular
         FROM instalments i LEFT JOIN payments p ON p.instalment_id = i.id AND p.user_id = i.user_id
         WHERE i.user_id = ? AND p.id IS NULL AND i.skipped = 0 GROUP BY i.loan_id`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT i.loan_id, i.billed_date, i.closing, l.currency FROM instalments i JOIN loans l ON l.id = i.loan_id AND l.user_id = i.user_id
         WHERE i.user_id = ? AND i.billed_date >= ? ORDER BY i.loan_id, i.n`,
      )
      .bind(userId, monthStart),
    db.prepare("SELECT monthly_income, income_currency FROM settings WHERE user_id = ?").bind(userId),
    // Prepayments count as payments in the month they are paid (principal + charges).
    db
      .prepare(
        `SELECT pp.paid_date, pp.applied_amount + pp.charges AS total, l.currency FROM prepayments pp
         JOIN loans l ON l.id = pp.loan_id AND l.user_id = pp.user_id
         WHERE pp.user_id = ? AND pp.paid_date BETWEEN ? AND ?`,
      )
      .bind(userId, monthStart, nextMonthEnd),
  ]);
  const prepaid = (prepaidRes!.results as Row[]).map((r) => ({ date: String(r.paid_date), currency: String(r.currency), amount: Number(r.total) }));
  const prepaidIn = (a: string, b: string) => prepaid.filter((p) => p.date >= a && p.date <= b && p.amount > 0);
  const prepaidTotals = (a: string, b: string) => totalsByCurrency(prepaidIn(a, b), (p) => p.currency, (p) => p.amount);
  const addTotals = (x: Record<string, number>, y: Record<string, number>) => {
    const out = { ...x };
    for (const [c, v] of Object.entries(y)) out[c] = (out[c] ?? 0) + v;
    return out;
  };

  const items = (dueRes!.results as Row[]).map((r) => toUpcoming(r, ctx));
  const unpaid = items.filter((i) => i.status !== "paid" && i.status !== "skipped");
  const inMonth = items.filter((i) => i.payableDate >= monthStart && i.payableDate <= monthEnd);
  const amount = (i: UpcomingItem) => i.amount;
  const cur = (i: UpcomingItem) => i.currency;

  const principalPaid = new Map<string, number>();
  for (const r of paidRes!.results as Row[]) principalPaid.set(String(r.loan_id), Number(r.principal_paid));
  const loans = (loanRes!.results as Row[]).map((r) => {
    const summary = JSON.parse(String(r.summary)) as ScheduleSummary;
    return {
      lenderId: String(r.lender_id),
      type: String(r.type),
      currency: String(r.currency),
      outstanding: summary.financedPrincipal - (principalPaid.get(String(r.id)) ?? 0) - (summary.totalPrepaid ?? 0),
    };
  });
  const active = loans.filter((l) => l.outstanding > 0);

  // ---- Debt-to-income (income currency only; never mixed with other currencies)
  const incomeRow = (incomeRes!.results as Row[])[0];
  let dti: Dashboard["dti"] = null;
  if (incomeRow && incomeRow.monthly_income !== null && incomeRow.income_currency && Number(incomeRow.monthly_income) > 0) {
    const income = Number(incomeRow.monthly_income);
    const currency = String(incomeRow.income_currency);
    const regular = new Map((nextRes!.results as Row[]).map((r) => [String(r.loan_id), Number(r.regular)]));
    const loanRows = loanRes!.results as Row[];
    let obligations = 0;
    let excludedLoans = 0;
    for (const r of loanRows) {
      const sum = JSON.parse(String(r.summary)) as ScheduleSummary;
      const out = sum.financedPrincipal - (principalPaid.get(String(r.id)) ?? 0) - (sum.totalPrepaid ?? 0);
      if (out <= 0) continue;
      if (String(r.currency) !== currency) excludedLoans++;
      else obligations += regular.get(String(r.id)) ?? 0;
    }
    const ratio = obligations / income;
    dti = { currency, income, obligations, ratio, band: dtiBand(ratio), excludedLoans };
  }

  // ---- Projected outstanding principal at each month end, per currency (schedule assumed paid)
  const balanceTrend: Dashboard["balanceTrend"] = {};
  {
    const startOutstanding = new Map<string, { currency: string; outstanding: number }>();
    loans.forEach((l, idx) => startOutstanding.set(String((loanRes!.results as Row[])[idx]!.id), { currency: l.currency, outstanding: Math.max(0, l.outstanding) }));
    // closing by loan & month (last instalment billed in that month)
    const closingByLoanMonth = new Map<string, Map<string, number>>();
    let lastMonth = monthStart.slice(0, 7);
    for (const r of trendRes!.results as Row[]) {
      const loanId = String(r.loan_id);
      const month = String(r.billed_date).slice(0, 7);
      if (month > lastMonth) lastMonth = month;
      let m = closingByLoanMonth.get(loanId);
      if (!m) closingByLoanMonth.set(loanId, (m = new Map()));
      m.set(month, Number(r.closing));
    }
    const months: string[] = [];
    for (let d = monthStart; d.slice(0, 7) <= lastMonth && months.length < 600; d = addMonthsClamped(d, 1, 1)) months.push(d.slice(0, 7));
    const current = new Map([...startOutstanding].map(([id, v]) => [id, v.outstanding]));
    const series: Record<string, number[]> = {};
    for (const month of months) {
      for (const [id] of startOutstanding) {
        const c = closingByLoanMonth.get(id)?.get(month);
        if (c !== undefined) current.set(id, c);
      }
      const totals: Record<string, number> = {};
      for (const [id, v] of startOutstanding) totals[v.currency] = (totals[v.currency] ?? 0) + Math.max(0, current.get(id) ?? 0);
      for (const [cur2, total] of Object.entries(totals)) (series[cur2] ??= []).push(total);
    }
    // Downsample long horizons to at most ~120 points (keep the first and last).
    for (const [cur2, values] of Object.entries(series)) {
      if (!values.some((v) => v > 0)) continue;
      // End each currency's series at its first zero (its own debt-free month).
      const firstZero = values.findIndex((v) => v <= 0);
      const end = firstZero === -1 ? values.length : firstZero + 1;
      const step = Math.max(1, Math.ceil(end / 120));
      balanceTrend[cur2] = months
        .slice(0, end)
        .map((m, i) => ({ date: `${m}-01`, outstanding: values[i]! }))
        .filter((_, i) => i % step === 0 || i === end - 1);
    }
  }

  return {
    today,
    payableThisMonth: addTotals(totalsByCurrency(inMonth.filter((i) => i.status !== "skipped"), cur, amount), prepaidTotals(monthStart, monthEnd)),
    stillToPayThisMonth: totalsByCurrency(inMonth.filter((i) => i.status !== "skipped" && i.status !== "paid"), cur, amount),
    paidThisMonth: addTotals(totalsByCurrency(inMonth.filter((i) => i.status === "paid"), cur, amount), prepaidTotals(monthStart, monthEnd)),
    payableNextMonth: addTotals(
      totalsByCurrency(unpaid.filter((i) => i.payableDate >= nextMonthStart && i.payableDate <= nextMonthEnd), cur, amount),
      prepaidTotals(nextMonthStart, nextMonthEnd),
    ),
    next7Days: totalsByCurrency(unpaid.filter((i) => i.payableDate >= today && i.payableDate <= addDays(today, 7)), cur, amount),
    next30Days: totalsByCurrency(unpaid.filter((i) => i.payableDate >= today && i.payableDate <= horizon), cur, amount),
    overdue: totalsByCurrency(unpaid.filter((i) => i.status === "overdue"), cur, amount),
    outstanding: totalsByCurrency(active, (l) => l.currency, (l) => l.outstanding),
    byLender: totalsByKeyAndCurrency(active, (l) => l.lenderId, (l) => l.currency, (l) => l.outstanding),
    byType: totalsByKeyAndCurrency(active, (l) => l.type, (l) => l.currency, (l) => l.outstanding),
    upcoming: groupPayables(
      unpaid
        .filter((i) => i.payableDate <= horizon)
        .map((i) => ({ ...i, id: i.instalmentId })),
    ).map((g) => ({ ...g, items: g.items as unknown as UpcomingItem[] })),
    activeLoans: active.length,
    dti,
    balanceTrend,
  };
}
