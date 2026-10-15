import { z } from "zod";
import { isValidISODate } from "@emi/core";
import { DATE_FORMATS, EXPENSE_CATEGORIES, EXPENSE_FREQUENCIES, LOAN_TYPES, TAX_LABELS } from "./constants";

/** All money crossing the wire is an integer in the currency's minor unit. */
export const minor = z.number().int().safe();
export const nonNegMinor = minor.nonnegative();
export const isoDate = z.string().refine(isValidISODate, { message: "invalid_date" });
export const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, "invalid_currency")
  .refine((c) => {
    try {
      new Intl.NumberFormat("en", { style: "currency", currency: c });
      return true;
    } catch {
      return false;
    }
  }, "invalid_currency");
export const percent = z.number().min(0).max(100);
export const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "invalid_time_zone");
export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "invalid_color");
const id = z.string().min(1).max(64);
const shortText = (max: number) => z.string().trim().max(max);

// ---- Settings ---------------------------------------------------------------------------
export const settingsSchema = z.object({
  country: z.string().min(2).max(5),
  currency: currencyCode,
  locale: z.string().min(2).max(20),
  timeZone,
  dateFormat: z.enum(DATE_FORMATS),
  taxLabel: z.enum(TAX_LABELS),
  taxRate: percent,
  theme: z.enum(["system", "light", "dark"]),
  reminderHour: z.number().int().min(0).max(23),
  /** An unpaid instalment shows as "due" from this many days before its payable date. */
  dueWindowDays: z.number().int().min(0).max(30),
  reminderDaysBefore: z.array(z.number().int().min(1).max(30)).max(5),
  remindOnDay: z.boolean(),
  remindOverdue: z.boolean(),
  pushEnabled: z.boolean(),
  emailReminders: z.boolean(),
  weeklySummary: z.boolean(),
  /** Private: never exposed to users a loan is shared with. Minor units of incomeCurrency. */
  monthlyIncome: nonNegMinor.max(1e14).nullable(),
  incomeCurrency: currencyCode.nullable(),
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial();

// ---- Lenders ----------------------------------------------------------------------------
export const lenderInputSchema = z.object({
  name: shortText(80).min(1),
  country: z.string().min(2).max(5),
  color: hexColor,
  initial: shortText(2).optional(),
});
export type LenderInput = z.infer<typeof lenderInputSchema>;

// ---- Cards ------------------------------------------------------------------------------
export const cardInputSchema = z
  .object({
    nickname: shortText(60).min(1),
    lenderId: id.nullable().optional(),
    last4: z.string().regex(/^\d{4}$/).nullable().optional(),
    /** Name printed on the card when it isn't the user's own (blank = own card). */
    holderName: shortText(60)
      .nullable()
      .optional()
      .transform((v) => v || null),
    statementDay: z.number().int().min(1).max(31),
    dueDay: z.number().int().min(1).max(31).nullable().optional(),
    graceDays: z.number().int().min(1).max(60).nullable().optional(),
  })
  .refine((c) => !!c.dueDay !== !!c.graceDays, { message: "due_day_or_grace_days", path: ["dueDay"] });
export type CardInput = z.infer<typeof cardInputSchema>;
export type CardInputRaw = z.input<typeof cardInputSchema>;

// ---- Fixed expenses -----------------------------------------------------------------------
export const expenseInputSchema = z.object({
  name: shortText(60).min(1),
  category: z.enum(EXPENSE_CATEGORIES),
  /** Minor units, charged once per `frequency`. */
  amount: minor.positive().max(1e14),
  currency: currencyCode,
  frequency: z.enum(EXPENSE_FREQUENCIES).default("monthly"),
  active: z.boolean().default(true),
});
export type ExpenseInput = z.infer<typeof expenseInputSchema>;
export type ExpenseInputRaw = z.input<typeof expenseInputSchema>;

// ---- Loans ------------------------------------------------------------------------------
export const feeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("flat"), amount: nonNegMinor }),
  z.object({ kind: z.literal("percent"), percent }),
]);

/** Someone else paying part of each instalment: a % of it, or a fixed amount (minor units). */
export const loanSplitSchema = z.discriminatedUnion("kind", [
  z.object({ name: shortText(60).min(1), kind: z.literal("percent"), percent: z.number().gt(0).max(100) }),
  z.object({ name: shortText(60).min(1), kind: z.literal("flat"), amount: minor.positive().max(1e14) }),
]);
export type LoanSplit = z.infer<typeof loanSplitSchema>;

export const loanInputSchema = z
  .object({
    lenderId: id,
    cardId: id.nullable().optional(),
    type: z.enum(LOAN_TYPES),
    customTypeLabel: shortText(40).optional(),
    nickname: shortText(80).min(1),
    currency: currencyCode,
    principal: minor.positive().max(1e14),
    annualRate: percent,
    tenureMonths: z.number().int().min(1).max(600),
    repaymentType: z.enum(["reducing", "flat"]),
    bookingDate: isoDate,
    firstEmiDate: isoDate,
    emiDay: z.number().int().min(1).max(31),
    processingFee: feeSchema.default({ kind: "none" }),
    processingFeeTaxRate: percent.default(0),
    feeCollection: z.enum(["upfront", "first_instalment"]).default("upfront"),
    taxLabel: z.enum(TAX_LABELS).default("None"),
    interestTaxEnabled: z.boolean().default(false),
    interestTaxRate: percent.default(0),
    emiShift: z
      .object({
        enabled: z.boolean(),
        originalFirstEmiDate: isoDate.nullable().optional(),
        dayCount: z.union([z.literal(365), z.literal(360)]).default(365),
        collection: z.enum(["upfront", "first_instalment"]).default("first_instalment"),
      })
      .default({ enabled: false, dayCount: 365, collection: "first_instalment" }),
    noCostEmi: z.boolean().default(false),
    holidayRule: z.enum(["none", "previous_working_day", "next_working_day"]).default("none"),
    /** Pre-closure / part-payment charge the lender takes, plus tax on it. Only used by the prepayment tools. */
    prepaymentCharge: feeSchema.default({ kind: "none" }),
    prepaymentChargeTaxRate: percent.default(0),
    /** Other people who pay part of each instalment. */
    splits: z.array(loanSplitSchema).max(10).default([]),
    notes: shortText(2000).optional(),
    muted: z.boolean().default(false),
  })
  .superRefine((l, ctx) => {
    if (l.firstEmiDate < l.bookingDate) ctx.addIssue({ code: "custom", path: ["firstEmiDate"], message: "first_emi_before_booking" });
    if (l.type === "credit_card_emi" && !l.cardId) ctx.addIssue({ code: "custom", path: ["cardId"], message: "card_required" });
    const splitPercent = l.splits.reduce((s, x) => s + (x.kind === "percent" ? x.percent : 0), 0);
    if (splitPercent > 100) ctx.addIssue({ code: "custom", path: ["splits"], message: "splits_over_100" });
    if (l.type === "other" && !l.customTypeLabel) ctx.addIssue({ code: "custom", path: ["customTypeLabel"], message: "required" });
    if (l.emiShift.enabled && l.emiShift.originalFirstEmiDate && l.emiShift.originalFirstEmiDate > l.firstEmiDate)
      ctx.addIssue({ code: "custom", path: ["emiShift", "originalFirstEmiDate"], message: "shift_must_be_later" });
  });
export type LoanInput = z.infer<typeof loanInputSchema>;
export type LoanInputRaw = z.input<typeof loanInputSchema>;

export const overrideSchema = z.object({ amount: nonNegMinor.nullable() });

export const rateChangeInputSchema = z.object({
  effectiveDate: isoDate,
  annualRate: percent,
  mode: z.enum(["keep_emi", "keep_tenure"]).default("keep_emi"),
});
export type RateChangeInput = z.infer<typeof rateChangeInputSchema>;

export const prepaymentInputSchema = z.object({
  date: isoDate,
  amount: minor.positive(),
  mode: z.enum(["reduce_tenure", "reduce_emi"]),
  chargePercent: percent.default(0),
  chargeTaxRate: percent.default(0),
});
export type PrepaymentInput = z.infer<typeof prepaymentInputSchema>;

/** A prepayment or foreclosure the user actually made (changes the stored schedule). */
export const recordPrepaymentSchema = z
  .object({
    date: isoDate,
    kind: z.enum(["part", "foreclosure"]),
    /** Principal prepaid (part-payments only; a foreclosure pays whatever is outstanding). */
    amount: minor.positive().max(1e14).nullable().optional(),
    mode: z.enum(["reduce_tenure", "reduce_emi"]).default("reduce_tenure"),
    charge: feeSchema.default({ kind: "none" }),
    chargeTaxRate: percent.default(0),
    note: shortText(200).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.kind === "part" && !p.amount) ctx.addIssue({ code: "custom", path: ["amount"], message: "required" });
  });
export type RecordPrepaymentInput = z.infer<typeof recordPrepaymentSchema>;

export const shareInputSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  access: z.enum(["view", "edit"]),
});
export type ShareInput = z.infer<typeof shareInputSchema>;
export const shareAccessSchema = z.object({ access: z.enum(["view", "edit"]) });

export const deleteAccountSchema = z.object({ confirmEmail: z.string().email().max(320) });

// ---- Payments ---------------------------------------------------------------------------
export const paymentInputSchema = z.object({
  paidDate: isoDate,
  amountPaid: nonNegMinor,
  lateFee: nonNegMinor.default(0),
  note: shortText(500).optional(),
});
export type PaymentInput = z.infer<typeof paymentInputSchema>;

export const instalmentStatusPatchSchema = z.object({ skipped: z.boolean() });

// ---- Auth / push ------------------------------------------------------------------------
export const googleLoginSchema = z.object({ credential: z.string().min(20).max(4096) });

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1024),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;
