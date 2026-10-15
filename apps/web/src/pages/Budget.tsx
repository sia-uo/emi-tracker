import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Info, Pencil, Plus, Trash2 } from "lucide-react";
import { addMonthsClamped, daysInMonth, parseISODate, parseMajor, toMajorString } from "@emi/core";
import {
  COMMON_CURRENCIES,
  EXPENSE_CATEGORIES,
  EXPENSE_FREQUENCIES,
  expenseInputSchema,
  monthlyEquivalent,
  prepaymentTotal,
  splitAmount,
  summarizeBudget,
  type BudgetRow,
  type Expense,
  type ExpenseCategory,
  type ExpenseFrequency,
} from "@emi/shared";
import { errorMessage } from "../lib/api";
import { useFormat } from "../lib/format";
import { useDeleteExpense, useExpenses, useInstalments, useLoans, useMe, useSaveExpense } from "../lib/queries";
import { BreathingRoom } from "../components/BreathingRoom";
import { Dialog, ErrorState, PageHeader, Section, SelectField, Spinner, StatusBadge, TextField, Toggle, cx } from "../components/ui";

const PRESETS: { key: string; category: ExpenseCategory; frequency?: ExpenseFrequency }[] = [
  { key: "rent", category: "housing" },
  { key: "food", category: "food" },
  { key: "gym", category: "fitness" },
  { key: "protein", category: "health" },
  { key: "claude", category: "subscriptions" },
  { key: "youtube", category: "subscriptions" },
  { key: "phone", category: "utilities" },
  { key: "electricity", category: "utilities" },
  { key: "fuel", category: "transport" },
  { key: "insurance", category: "insurance", frequency: "yearly" },
];

const NO_EXPENSES: Expense[] = [];

type Draft = { expense?: Expense; name?: string; category?: ExpenseCategory; frequency?: ExpenseFrequency };

function ExpenseDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const save = useSaveExpense();
  const e = draft.expense;
  const [name, setName] = useState(e?.name ?? draft.name ?? "");
  const [category, setCategory] = useState<ExpenseCategory>(e?.category ?? draft.category ?? "other");
  const [currency, setCurrency] = useState(e?.currency ?? f.defaultCurrency);
  const [amount, setAmount] = useState(e ? toMajorString(e.amount, e.currency) : "");
  const [frequency, setFrequency] = useState<ExpenseFrequency>(e?.frequency ?? draft.frequency ?? "monthly");
  const [active, setActive] = useState(e?.active ?? true);
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    let minor: number;
    try {
      minor = parseMajor(amount, currency);
    } catch {
      setError(t("form.errors.required"));
      return;
    }
    const parsed = expenseInputSchema.safeParse({ name, category, amount: minor, currency, frequency, active });
    if (!parsed.success) {
      setError(t("form.errors.required"));
      return;
    }
    try {
      await save.mutateAsync({ id: e?.id, input: parsed.data });
      onClose();
    } catch (ex) {
      setError(errorMessage(t, ex));
    }
  };

  return (
    <Dialog open onClose={onClose} title={e ? t("budget.editExpense") : t("budget.addExpense")}>
      <form onSubmit={(ev) => void submit(ev)} className="space-y-4" noValidate>
        <TextField label={t("budget.name")} value={name} onChange={(ev) => setName(ev.target.value)} required maxLength={60} />
        <SelectField label={t("budget.category")} value={category} onChange={(ev) => setCategory(ev.target.value as ExpenseCategory)}>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`budget.categories.${c}`)}
            </option>
          ))}
        </SelectField>
        <div className="grid grid-cols-[7rem_1fr] gap-3">
          <SelectField label={t("form.currency")} value={currency} onChange={(ev) => setCurrency(ev.target.value)}>
            {[...new Set([currency, ...COMMON_CURRENCIES])].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </SelectField>
          <TextField label={t("budget.amount")} inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} required />
        </div>
        <SelectField label={t("budget.frequency")} hint={frequency === "monthly" ? undefined : t("budget.spreadHint")} value={frequency} onChange={(ev) => setFrequency(ev.target.value as ExpenseFrequency)}>
          {EXPENSE_FREQUENCIES.map((v) => (
            <option key={v} value={v}>
              {t(`budget.frequencies.${v}`)}
            </option>
          ))}
        </SelectField>
        <Toggle label={t("budget.active")} checked={active} onChange={setActive} />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <button className="btn-primary w-full" disabled={save.isPending}>
          {save.isPending ? t("common.saving") : t("common.save")}
        </button>
      </form>
    </Dialog>
  );
}

function Summary({ row }: { row: BudgetRow }) {
  const { t } = useTranslation();
  const f = useFormat();
  const m = (v: number) => f.money(v, row.currency);
  const pct = (v: number) => (row.income ? Math.round((v / row.income) * 100) : 0);
  const over = row.left !== null && row.left < 0;
  // Stacked bar of where the income goes (only meaningful with income).
  const base = row.income ? Math.max(row.income, row.outgo) : 0;
  const share = (v: number) => (base ? `${(v / base) * 100}%` : "0%");
  return (
    <Section>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {row.income !== null && (
          <div>
            <dt className="text-xs text-muted">{t("budget.income")}</dt>
            <dd className="num text-lg font-bold">{m(row.income)}</dd>
          </div>
        )}
        <div>
          <dt className="flex items-center gap-1.5 text-xs text-muted">
            <span className="h-2.5 w-2.5 rounded-sm bg-primary" aria-hidden /> {t("budget.emis")}
          </dt>
          <dd className="num text-lg font-bold">{m(row.emis)}</dd>
          {row.emisPaid > 0 && <dd className="text-xs text-success">{t("budget.emisPaid", { amount: m(row.emisPaid) })}</dd>}
          {row.emisOthers > 0 && <dd className="text-xs text-muted">{t("budget.emisOthers", { amount: m(row.emisOthers) })}</dd>}
          {row.prepaid > 0 && <dd className="text-xs text-muted">{t("budget.includesPrepaid", { amount: m(row.prepaid) })}</dd>}
        </div>
        <div>
          <dt className="flex items-center gap-1.5 text-xs text-muted">
            <span className="h-2.5 w-2.5 rounded-sm bg-accent" aria-hidden /> {t("budget.expenses")}
          </dt>
          <dd className="num text-lg font-bold">{m(row.expenses)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{row.left === null ? t("budget.outgo") : over ? t("budget.over") : t("budget.left")}</dt>
          <dd className={cx("num text-lg font-bold", row.left === null ? "" : over ? "text-danger" : "text-success")}>
            {m(row.left === null ? row.outgo : Math.abs(row.left))}
          </dd>
          {row.income !== null && <dd className="text-xs text-muted">{t("budget.outgo")}: {m(row.outgo)} · {t("budget.ofIncome", { percent: pct(row.outgo) })}</dd>}
        </div>
      </dl>
      {row.income !== null && row.income > 0 && (
        <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-surface-2 ring-1 ring-inset ring-line" aria-hidden>
          <div className="h-full bg-primary transition-[width] duration-700" style={{ width: share(row.emis) }} />
          <div className="h-full bg-accent transition-[width] duration-700" style={{ width: share(row.expenses) }} />
          {!over && <div className="h-full bg-success/70 transition-[width] duration-700" style={{ width: share(row.left ?? 0) }} />}
        </div>
      )}
    </Section>
  );
}

export function Budget() {
  const { t } = useTranslation();
  const f = useFormat();
  const me = useMe();
  const expenses = useExpenses();
  const loans = useLoans();
  const del = useDeleteExpense();
  const [month, setMonth] = useState(() => f.today().slice(0, 8) + "01");
  const { y, m } = parseISODate(month);
  const dues = useInstalments(month, `${month.slice(0, 8)}${String(daysInMonth(y, m)).padStart(2, "0")}`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settings = me.data?.settings;
  const incomeAmount = settings?.monthlyIncome ?? null;
  const incomeCurrency = settings?.incomeCurrency ?? null;
  const income = useMemo(
    () => (incomeAmount !== null && incomeCurrency ? { amount: incomeAmount, currency: incomeCurrency } : null),
    [incomeAmount, incomeCurrency],
  );
  // Only the user's share of split loans counts towards their budget.
  const splits = useMemo(() => Object.fromEntries((loans.data ?? []).filter((l) => l.splits.length).map((l) => [l.id, l.splits])), [loans.data]);
  // Prepayments count as payments in the month they were made.
  const prepaidAll = useMemo(
    () =>
      (loans.data ?? []).flatMap((l) =>
        l.prepayments.filter((p) => p.appliedAmount + p.charges > 0).map((p) => ({ loanId: l.id, loanNickname: l.nickname, kind: p.kind, date: p.date, currency: l.currency, amount: prepaymentTotal(p) })),
      ),
    [loans.data],
  );
  const monthEnd = `${month.slice(0, 8)}${String(daysInMonth(y, m)).padStart(2, "0")}`;
  const prepaidThisMonth = useMemo(() => prepaidAll.filter((p) => p.date >= month && p.date <= monthEnd), [prepaidAll, month, monthEnd]);
  const rows = useMemo(
    () => summarizeBudget({ expenses: expenses.data ?? [], dues: dues.data ?? [], income, splits, prepaid: prepaidThisMonth }),
    [expenses.data, dues.data, income, splits, prepaidThisMonth],
  );
  const byCategory = useMemo(() => {
    const groups = new Map<ExpenseCategory, Expense[]>();
    for (const e of expenses.data ?? []) {
      if (!groups.has(e.category)) groups.set(e.category, []);
      groups.get(e.category)!.push(e);
    }
    return EXPENSE_CATEGORIES.filter((c) => groups.has(c)).map((c) => ({ category: c, items: groups.get(c)! }));
  }, [expenses.data]);
  const taken = new Set((expenses.data ?? []).map((e) => e.name.toLowerCase()));
  const presets = PRESETS.filter((p) => !taken.has(t(`budget.presets.${p.key}`).toLowerCase()));

  const onDelete = async (e: Expense) => {
    if (!confirm(t("budget.deleteConfirm"))) return;
    try {
      setError(null);
      await del.mutateAsync(e.id);
    } catch (ex) {
      setError(errorMessage(t, ex));
    }
  };

  if (expenses.isLoading || dues.isLoading || loans.isLoading) return <Spinner />;
  if (expenses.error) return <ErrorState error={expenses.error} onRetry={() => void expenses.refetch()} />;
  if (dues.error) return <ErrorState error={dues.error} onRetry={() => void dues.refetch()} />;

  const dueList = (dues.data ?? []).filter((d) => d.status !== "skipped");

  return (
    <>
      <PageHeader
        title={t("budget.title")}
        actions={
          <button className="btn-primary" onClick={() => setDraft({})}>
            <Plus size={18} aria-hidden /> {t("budget.addExpense")}
          </button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{t("budget.intro")}</p>
        <div className="flex items-center gap-1">
          <button className="btn-ghost px-2" onClick={() => setMonth(addMonthsClamped(month, -1, 1))} aria-label={t("budget.prevMonth")}>
            <ChevronLeft aria-hidden />
          </button>
          <h2 className="min-w-[9rem] text-center font-display text-lg font-semibold text-primary-strong" aria-live="polite">
            {f.monthLabel(month)}
          </h2>
          <button className="btn-ghost px-2" onClick={() => setMonth(addMonthsClamped(month, 1, 1))} aria-label={t("budget.nextMonth")}>
            <ChevronRight aria-hidden />
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="space-y-4">
        {rows.map((r) => (
          <Summary key={r.currency} row={r} />
        ))}
        {!income && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <Info size={16} className="shrink-0 text-primary" aria-hidden />
            {t("budget.setIncome")}
            <Link to="/settings" className="font-semibold text-primary-strong underline">
              {t("budget.openSettings")}
            </Link>
          </p>
        )}
        {rows.length > 1 && <p className="text-xs text-muted">{t("dashboard.perCurrencyNote")}</p>}
      </div>

      <div className="mt-6">
        <BreathingRoom income={income} expenses={expenses.data ?? NO_EXPENSES} splits={splits} prepaid={prepaidAll} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section title={t("budget.expenseList")}>
          {presets.length > 0 && (
            <div className="mb-4">
              <p className="label">{t("budget.quickAdd")}</p>
              <div className="flex flex-wrap gap-2">
                {presets.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className="min-h-[36px] rounded-full border border-line bg-surface px-3 text-sm hover:border-accent hover:text-accent-text"
                    onClick={() => setDraft({ name: t(`budget.presets.${p.key}`), category: p.category, frequency: p.frequency })}
                  >
                    <Plus size={14} className="-ml-0.5 mr-1 inline" aria-hidden />
                    {t(`budget.presets.${p.key}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {byCategory.length === 0 ? (
            <p className="text-sm text-muted">{t("budget.noExpenses")}</p>
          ) : (
            <div className="space-y-4">
              {byCategory.map(({ category, items }) => (
                <div key={category}>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-accent-text">{t(`budget.categories.${category}`)}</h3>
                  <ul className="divide-y divide-line">
                    {items.map((e) => (
                      <li key={e.id} className={cx("flex items-center gap-2 py-2", !e.active && "opacity-60")}>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">
                            {e.name}
                            {!e.active && <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{t("budget.paused")}</span>}
                          </p>
                          <p className="text-xs text-muted">
                            {f.money(e.amount, e.currency)} · {t(`budget.frequencies.${e.frequency}`)}
                          </p>
                        </div>
                        <p className="num text-right text-sm font-semibold">
                          {t("budget.perMonth", { amount: f.money(monthlyEquivalent(e.amount, e.frequency), e.currency) })}
                        </p>
                        <button className="btn-ghost px-2" onClick={() => setDraft({ expense: e })} aria-label={`${t("common.edit")} ${e.name}`}>
                          <Pencil size={16} aria-hidden />
                        </button>
                        <button className="btn-ghost px-2 text-danger" onClick={() => void onDelete(e)} aria-label={`${t("common.delete")} ${e.name}`}>
                          <Trash2 size={16} aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title={t("budget.emiList")}>
          {dueList.length === 0 && prepaidThisMonth.length === 0 ? (
            <p className="text-sm text-muted">{t("budget.noEmis")}</p>
          ) : (
            <ul className="divide-y divide-line">
              {prepaidThisMonth.map((p) => (
                <li key={`pp-${p.loanId}-${p.date}`} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <Link to={`/loans/${p.loanId}`} className="block truncate font-medium hover:underline">
                      {p.loanNickname}
                    </Link>
                    <p className="text-xs text-muted">
                      {p.kind === "foreclosure" ? t("prepayments.foreclosure") : t("prepayments.part")} · {f.date(p.date)}
                    </p>
                  </div>
                  <StatusBadge status="paid" />
                  <p className="num w-32 text-right text-sm font-semibold">{f.money(p.amount, p.currency)}</p>
                </li>
              ))}
              {dueList.map((d) => (
                <li key={d.instalmentId} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <Link to={`/loans/${d.loanId}`} className="block truncate font-medium hover:underline">
                      {d.loanNickname}
                    </Link>
                    <p className="text-xs text-muted">{t("dashboard.payBy", { date: f.date(d.payableDate) })}</p>
                  </div>
                  <StatusBadge status={d.status} />
                  {splits[d.loanId]?.length ? (
                    <div className="w-32 text-right">
                      <p className="num text-sm font-semibold">{f.money(splitAmount(d.amount, splits[d.loanId]).mine, d.currency)}</p>
                      <p className="text-xs text-muted">{t("budget.shareOf", { amount: f.money(d.amount, d.currency) })}</p>
                    </div>
                  ) : (
                    <p className="num w-32 text-right text-sm font-semibold">{f.money(d.amount, d.currency)}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {draft && <ExpenseDialog draft={draft} onClose={() => setDraft(null)} />}
    </>
  );
}
