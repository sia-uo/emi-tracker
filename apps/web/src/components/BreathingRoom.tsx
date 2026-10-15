import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CalendarCheck, Info, PartyPopper, TrendingUp } from "lucide-react";
import { addMonthsClamped, daysInMonth, parseISODate, parseMajor, roundMinor, toMajorString } from "@emi/core";
import { breathingRoomFrom, projectCashflow, type Expense, type LoanSplit, type PrepaidItem } from "@emi/shared";
import { useFormat } from "../lib/format";
import { useInstalments } from "../lib/queries";
import { CashflowChart } from "./charts";
import { Section, Spinner, TextField } from "./ui";

const HORIZON_MONTHS = 60;
/** Default breathing room: this share of income left over after EMIs and fixed costs. */
const DEFAULT_TARGET_SHARE = 0.2;
const storageKey = (currency: string) => `emi-breathing-target-${currency}`;

function readTarget(currency: string): string | null {
  try {
    return localStorage.getItem(storageKey(currency));
  } catch {
    return null;
  }
}

function saveTarget(currency: string, value: string) {
  try {
    if (value) localStorage.setItem(storageKey(currency), value);
    else localStorage.removeItem(storageKey(currency));
  } catch {
    /* storage unavailable */
  }
}

/** "At this pace, when will I have money left over?" — a projection of income − (EMIs + fixed costs). */
export function BreathingRoom({
  income,
  expenses,
  splits,
  prepaid,
}: {
  income: { amount: number; currency: string } | null;
  expenses: readonly Expense[];
  splits: Readonly<Record<string, readonly LoanSplit[]>>;
  /** Recorded prepayments (principal + charges), counted in the month they were paid. */
  prepaid: readonly PrepaidItem[];
}) {
  const { t } = useTranslation();
  const f = useFormat();
  const start = f.today().slice(0, 8) + "01";
  const endMonth = addMonthsClamped(start, HORIZON_MONTHS - 1, 1);
  const { y, m } = parseISODate(endMonth);
  const dues = useInstalments(start, `${endMonth.slice(0, 8)}${String(daysInMonth(y, m)).padStart(2, "0")}`);
  const currency = income?.currency ?? f.defaultCurrency;
  const defaultTarget = income ? roundMinor(income.amount * DEFAULT_TARGET_SHARE) : 0;
  const [targetInput, setTargetInput] = useState(() => readTarget(currency) ?? "");
  const target = useMemo(() => {
    try {
      return targetInput ? Math.max(0, parseMajor(targetInput, currency)) : defaultTarget;
    } catch {
      return defaultTarget;
    }
  }, [targetInput, currency, defaultTarget]);

  const projection = useMemo(
    () =>
      income && dues.data
        ? projectCashflow({ currency, income: income.amount, startMonth: start.slice(0, 7), months: HORIZON_MONTHS, dues: dues.data, expenses, splits, prepaid })
        : null,
    [income, dues.data, currency, start, expenses, splits, prepaid],
  );

  if (!income) {
    return (
      <Section title={t("budget.breathing.title")}>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <Info size={16} className="shrink-0 text-primary" aria-hidden />
          {t("budget.breathing.needIncome")}
          <Link to="/settings" className="font-semibold text-primary-strong underline">
            {t("budget.openSettings")}
          </Link>
        </p>
      </Section>
    );
  }
  if (dues.isLoading || !projection) return <Spinner />;

  const money = (v: number) => f.money(v, currency);
  const { months, endings } = projection;
  const from = breathingRoomFrom(months, target);
  // Show until the last EMI (or the breathing-room month) plus a few months, at least a year.
  const lastEmi = months.reduce((last, mo, i) => (mo.emis > 0 ? i : last), -1);
  const shown = months.slice(0, Math.min(HORIZON_MONTHS, Math.max(12, lastEmi + 4, (from ?? 0) + 4)));
  const label = (ym: string) => f.monthLabel(`${ym}-01`);
  const now = months[0]!;
  const reached = from !== null ? months[from]! : null;
  const visibleEndings = endings.filter((e) => e.month <= shown[shown.length - 1]!.month);

  return (
    <Section title={t("budget.breathing.title")}>
      <div className="mb-4 grid gap-4 md:grid-cols-[1fr_16rem]">
        <div className="flex gap-3">
          {from === 0 ? (
            <PartyPopper size={28} className="shrink-0 text-success" aria-hidden />
          ) : from !== null ? (
            <CalendarCheck size={28} className="shrink-0 text-success" aria-hidden />
          ) : (
            <TrendingUp size={28} className="shrink-0 text-accent-text" aria-hidden />
          )}
          <div>
            <p className="text-lg font-semibold">
              {from === 0
                ? t("budget.breathing.already")
                : reached
                  ? t("budget.breathing.from", { month: label(reached.month) })
                  : t("budget.breathing.never", { years: HORIZON_MONTHS / 12 })}
            </p>
            <p className="text-sm text-muted">
              {reached && from! > 0 && t("budget.breathing.inMonths", { count: from! }) + " "}
              {reached
                ? t("budget.breathing.leftThen", { amount: money(reached.left), now: money(now.left) })
                : t("budget.breathing.leftNow", { amount: money(now.left) })}
            </p>
            {now.left < 0 && (
              <p role="alert" className="mt-1 text-sm font-semibold text-danger">
                {t("budget.breathing.overNow", { amount: money(-now.left) })}
              </p>
            )}
          </div>
        </div>
        <TextField
          label={`${t("budget.breathing.target")} (${currency})`}
          hint={t("budget.breathing.targetHint", { amount: money(defaultTarget) })}
          inputMode="decimal"
          placeholder={toMajorString(defaultTarget, currency)}
          value={targetInput}
          onChange={(e) => {
            setTargetInput(e.target.value);
            saveTarget(currency, e.target.value);
          }}
        />
      </div>

      <CashflowChart months={shown} income={income.amount} target={target} currency={currency} from={from} />

      {visibleEndings.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold text-primary-strong">{t("budget.breathing.milestones")}</h3>
          <ol className="space-y-1 text-sm">
            {visibleEndings.slice(0, 8).map((e) => (
              <li key={e.loanId} className="flex flex-wrap gap-x-2">
                <span className="num w-36 shrink-0 text-muted">{label(e.month)}</span>
                <Link to={`/loans/${e.loanId}`} className="font-medium hover:underline">
                  {t("budget.breathing.ends", { loan: e.name })}
                </Link>
                <span className="text-success">{t("budget.breathing.frees", { amount: money(e.frees) })}</span>
              </li>
            ))}
          </ol>
          {visibleEndings.length > 8 && <p className="mt-1 text-xs text-muted">{t("budget.breathing.more", { count: visibleEndings.length - 8 })}</p>}
        </div>
      )}
      <p className="mt-4 text-xs text-muted">{t("budget.breathing.assumptions", { currency })}</p>
    </Section>
  );
}
