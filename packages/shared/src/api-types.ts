import type { InstalmentStatus, LoanProgress, ScheduleSummary } from "@emi/core";
import type { ExpenseInput, LoanInput, Settings } from "./schemas";

export interface User {
  id: string;
  email: string;
  name: string;
  picture: string | null;
}

export interface Me {
  user: User;
  settings: Settings;
  /** Which optional channels the server has configured (email needs Resend; push needs VAPID keys). */
  features: { email: boolean; push: boolean };
}

export interface Lender {
  id: string;
  name: string;
  country: string;
  color: string;
  initial: string;
  custom: boolean;
}

export interface Card {
  id: string;
  nickname: string;
  lenderId: string | null;
  last4: string | null;
  /** Name on the card when it belongs to someone else; null = the user's own card. */
  holderName: string | null;
  statementDay: number;
  dueDay: number | null;
  graceDays: number | null;
}

export interface Payment {
  id: string;
  paidDate: string;
  amountPaid: number;
  lateFee: number;
  note: string | null;
}

export interface Instalment {
  id: string;
  loanId: string;
  n: number;
  billedDate: string;
  payableDate: string;
  opening: number;
  interest: number;
  principal: number;
  emi: number;
  interestTax: number;
  fees: number;
  shiftCost: number;
  totalPayable: number;
  closing: number;
  overridden: boolean;
  skipped: boolean;
  /** Annual rate applied to this instalment (changes with floating-rate changes). */
  annualRate: number;
  status: InstalmentStatus;
  payment: Payment | null;
}

export interface Loan extends LoanInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** The viewer's role on a loan: owner, or a shared user with edit/view access. */
export type LoanAccess = "owner" | "edit" | "view";

export interface LenderSnapshot {
  name: string;
  color: string;
  initial: string;
}

/** The card a card EMI is billed to. Only ever sent to the loan's owner. */
export interface CardSnapshot {
  nickname: string;
  last4: string | null;
  holderName: string | null;
}

export interface Expense extends ExpenseInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoanListItem extends Loan {
  summary: ScheduleSummary;
  progress: LoanProgress;
  nextInstalment: Instalment | null;
  access: LoanAccess;
  /** Lender name/colour so shared users can see it without access to the owner's custom lenders. */
  lender: LenderSnapshot | null;
  /** Owner only: the card a credit card EMI is billed to (null for other loans and for shared users). */
  card: CardSnapshot | null;
  /** Prepayments and foreclosures recorded on the loan, oldest first. */
  prepayments: RecordedPrepayment[];
  /** Owner's display name; set only for loans shared with the viewer. */
  ownerName: string | null;
}

export interface LoanShare {
  id: string;
  email: string;
  access: "view" | "edit";
  /** pending = invited email has not signed in yet. */
  status: "pending" | "active";
  name: string | null;
  createdAt: string;
}

export interface RateChangeRecord {
  id: string;
  effectiveDate: string;
  annualRate: number;
  mode: "keep_emi" | "keep_tenure";
}

export interface LoanDocument {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

/** A prepayment or foreclosure the user recorded on a loan. */
export interface RecordedPrepayment {
  id: string;
  date: string;
  kind: "part" | "foreclosure";
  /** What the user asked to prepay; null for a foreclosure. */
  amount: number | null;
  mode: "reduce_tenure" | "reduce_emi";
  charge: { kind: "none" } | { kind: "flat"; amount: number } | { kind: "percent"; percent: number };
  chargeTaxRate: number;
  note: string | null;
  /** Principal it actually paid off (from the schedule). */
  appliedAmount: number;
  /** Charge + tax on it. */
  charges: number;
  /** Applied right after this instalment. */
  afterN: number;
}

export interface LoanDetail extends LoanListItem {
  instalments: Instalment[];
  rateChanges: RateChangeRecord[];
  /** Owner only; empty for shared users. */
  documents: LoanDocument[];
  /** Owner only; empty for shared users. */
  shares: LoanShare[];
}

export type MoneyByCurrency = Record<string, number>;

export interface UpcomingItem {
  instalmentId: string;
  loanId: string;
  loanNickname: string;
  lenderId: string;
  cardId: string | null;
  currency: string;
  n: number;
  billedDate: string;
  payableDate: string;
  amount: number;
  status: InstalmentStatus;
}

export interface PayByGroup {
  key: string;
  cardId: string | null;
  payableDate: string;
  currency: string;
  total: number;
  items: UpcomingItem[];
}

export interface Dashboard {
  today: string;
  payableThisMonth: MoneyByCurrency;
  /**
   * This month's instalments not paid yet (skipped excluded). payableThisMonth and paidThisMonth
   * also include prepayments made this month, so payable = paid + still to pay.
   */
  stillToPayThisMonth: MoneyByCurrency;
  paidThisMonth: MoneyByCurrency;
  /** Unpaid instalments payable next month, plus prepayments dated next month. */
  payableNextMonth: MoneyByCurrency;
  next7Days: MoneyByCurrency;
  next30Days: MoneyByCurrency;
  overdue: MoneyByCurrency;
  outstanding: MoneyByCurrency;
  byLender: Record<string, MoneyByCurrency>;
  byType: Record<string, MoneyByCurrency>;
  upcoming: PayByGroup[];
  activeLoans: number;
  /** Debt-to-income in the income currency; null when no income is set. */
  dti: {
    currency: string;
    income: number;
    obligations: number;
    ratio: number;
    band: "healthy" | "caution" | "high";
    /** Active loans in other currencies, not counted. */
    excludedLoans: number;
  } | null;
  /** Projected outstanding principal at each month end, per currency (own loans, schedule assumed paid). */
  balanceTrend: Record<string, { date: string; outstanding: number }[]>;
}

export interface DeletionImpact {
  ownedLoans: number;
  /** Owned loans that are shared with someone (their access will be revoked). */
  ownedSharedLoans: number;
  shareRecipients: number;
  /** Loans other people shared with this user (the user is removed from them). */
  sharedWithMe: number;
}

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  loanId: string | null;
  instalmentId: string | null;
  createdAt: string;
  readAt: string | null;
}

/** GET /api/version — what is deployed. */
export interface ApiVersion {
  environment: string;
  /** Git commit (full SHA) the Worker was deployed from, when deployed by CI. */
  commit: string | null;
  /** Cloudflare Worker version id. */
  versionId: string | null;
  /** When this Worker version was deployed (ISO 8601). */
  deployedAt: string | null;
}

export interface ApiError {
  error: string;
  message?: string;
  issues?: { path: (string | number)[]; message: string }[];
}
