import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { BadgeCheck, Info, PiggyBank, Trash2 } from "lucide-react";
import { parseMajor, toMajorString } from "@emi/core";
import { applyRecordedPrepayments, type LoanDetail, type RecordPrepaymentInput } from "@emi/shared";
import { errorMessage } from "../lib/api";
import { useFormat } from "../lib/format";
import { useDeletePrepayment, useRecordPrepayment } from "../lib/queries";
import { baseTermsForLoan } from "./LoanExtras";
import { Section, SelectField, TextField, cx } from "./ui";

type Kind = RecordPrepaymentInput["kind"];
type ChargeKind = "none" | "flat" | "percent";

/**
 * Prepayments and foreclosures the user actually made. Recording one rebuilds the schedule, so
 * every total (payable this/next month, outstanding, budget, reminders) reflects it.
 */
export function Prepayments({ loan }: { loan: LoanDetail }) {
  const { t } = useTranslation();
  const f = useFormat();
  const record = useRecordPrepayment();
  const del = useDeletePrepayment();
  const m = (v: number) => f.money(v, loan.currency);
  const saved = loan.prepaymentCharge;
  const [kind, setKind] = useState<Kind>("part");
  const [date, setDate] = useState(f.today());
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<RecordPrepaymentInput["mode"]>("reduce_tenure");
  const [chargeKind, setChargeKind] = useState<ChargeKind>(saved.kind);
  const [chargeValue, setChargeValue] = useState(saved.kind === "flat" ? toMajorString(saved.amount, loan.currency) : saved.kind === "percent" ? String(saved.percent) : "");
  const [chargeTax, setChargeTax] = useState(String(saved.kind === "none" ? 0 : loan.prepaymentChargeTaxRate));
  const [error, setError] = useState<string | null>(null);

  const canEdit = loan.access !== "view";
  const closed = loan.progress.principalOutstanding <= 0 || loan.prepayments.some((p) => p.kind === "foreclosure");

  /** Form → API input; throws RangeError on a bad amount. */
  const input = (): RecordPrepaymentInput => ({
    date,
    kind,
    amount: kind === "part" ? parseMajor(amount, loan.currency) : null,
    mode,
    charge:
      chargeKind === "flat"
        ? { kind: "flat", amount: parseMajor(chargeValue || "0", loan.currency) }
        : chargeKind === "percent"
          ? { kind: "percent", percent: Number(chargeValue) || 0 }
          : { kind: "none" },
    chargeTaxRate: chargeKind === "none" ? 0 : Number(chargeTax) || 0,
  });

  // Live preview with the same rules the server uses.
  const preview = useMemo(() => {
    if (kind === "part" && !amount) return null;
    try {
      const draft = { ...input(), id: "draft", amount: kind === "part" ? parseMajor(amount, loan.currency) : null } as const;
      const { applied, schedule } = applyRecordedPrepayments(baseTermsForLoan(loan), [...loan.prepayments, { ...draft, note: null, appliedAmount: 0, charges: 0, afterN: 0 }]);
      const a = applied.find((x) => x.id === "draft");
      if (!a || a.amount <= 0) return { error: t("errors.prepayment_after_loan_end") };
      const next = schedule.rows[a.afterN];
      return { ...a, nextEmi: next?.totalPayable ?? null, nextDate: next?.billedDate ?? null, instalments: schedule.rows.length };
    } catch (ex) {
      return { error: errorMessage(t, ex) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, date, amount, mode, chargeKind, chargeValue, chargeTax, loan]);

  if (loan.repaymentType !== "reducing") {
    return (
      <Section title={t("prepayments.title")}>
        <p className="flex gap-2 text-sm text-muted">
          <Info size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
          {t("prepayments.reducingOnly")}
        </p>
      </Section>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (kind === "foreclosure" && !confirm(t("prepayments.confirmForeclose"))) return;
    try {
      await record.mutateAsync({ loanId: loan.id, input: input() });
      setAmount("");
    } catch (ex) {
      setError(errorMessage(t, ex));
    }
  };

  return (
    <Section title={t("prepayments.title")}>
      <p className="mb-3 text-sm text-muted">{t("prepayments.intro")}</p>
      {loan.prepayments.length > 0 && (
        <ul className="mb-4 divide-y divide-line">
          {loan.prepayments.map((p) => (
            <li key={p.id} className="flex items-start gap-3 py-2 text-sm">
              {p.kind === "foreclosure" ? <BadgeCheck size={18} className="mt-0.5 text-success" aria-hidden /> : <PiggyBank size={18} className="mt-0.5 text-primary" aria-hidden />}
              <div className="min-w-0 flex-1">
                <p>
                  <strong>{f.date(p.date)}</strong> · {p.kind === "foreclosure" ? t("prepayments.foreclosure") : t("prepayments.part")}{" "}
                  <span className="num font-semibold">{m(p.appliedAmount)}</span>
                  {p.charges > 0 && <span className="text-muted"> + {t("prepayments.chargesAmount", { amount: m(p.charges) })}</span>}
                </p>
                <p className="text-xs text-muted">
                  {p.afterN > 0 && t("prepayments.afterEmi", { n: p.afterN })}
                  {p.kind === "part" && ` · ${p.mode === "reduce_emi" ? t("prepay.reduceEmi") : t("prepay.reduceTenure")}`}
                </p>
              </div>
              {canEdit && (
                <button
                  className="btn-ghost px-2 text-danger"
                  onClick={() => {
                    if (confirm(t("prepayments.confirmRemove"))) del.mutate({ loanId: loan.id, id: p.id });
                  }}
                  aria-label={t("prepayments.remove", { date: f.date(p.date) })}
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && !closed && (
        <form onSubmit={(e) => void submit(e)} className="space-y-3" noValidate>
          <div role="group" aria-label={t("prepayments.kind")} className="inline-flex rounded-xl border border-line bg-surface p-1">
            {(["part", "foreclosure"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cx("min-h-[36px] rounded-lg px-3 text-sm font-medium", kind === k ? "bg-primary text-primary-on" : "text-muted")}
              >
                {k === "part" ? t("prepayments.part") : t("prepayments.foreclose")}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField label={t("prepayments.date")} hint={t("prepayments.dateHint")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            {kind === "part" && (
              <>
                <TextField label={`${t("prepay.amount")} (${loan.currency})`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
                <SelectField label={t("prepay.mode")} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                  <option value="reduce_tenure">{t("prepay.reduceTenure")}</option>
                  <option value="reduce_emi">{t("prepay.reduceEmi")}</option>
                </SelectField>
              </>
            )}
            <SelectField
              label={t("form.prepaymentCharge")}
              value={chargeKind}
              onChange={(e) => {
                setChargeKind(e.target.value as ChargeKind);
                setChargeValue("");
              }}
            >
              <option value="none">{t("form.feeNone")}</option>
              <option value="flat">{t("form.feeFlat")}</option>
              <option value="percent">{t("form.prepaymentChargePercent")}</option>
            </SelectField>
            {chargeKind !== "none" && (
              <>
                <TextField
                  label={chargeKind === "flat" ? `${t("form.prepaymentChargeAmount")} (${loan.currency})` : t("form.prepaymentChargePercentValue")}
                  inputMode="decimal"
                  value={chargeValue}
                  onChange={(e) => setChargeValue(e.target.value)}
                />
                <TextField label={t("form.prepaymentChargeTax")} inputMode="decimal" value={chargeTax} onChange={(e) => setChargeTax(e.target.value)} />
              </>
            )}
          </div>

          {preview && (
            <div aria-live="polite" className={cx("rounded-xl p-3 text-sm", "error" in preview ? "bg-accent-soft text-accent-text" : "bg-primary-soft/50")}>
              {"error" in preview ? (
                preview.error
              ) : (
                <>
                  <p className="font-semibold">
                    {kind === "foreclosure"
                      ? t("prepayments.previewForeclose", { amount: m(preview.amount + preview.charges), n: preview.afterN })
                      : t("prepayments.previewPart", { amount: m(preview.amount + preview.charges), n: preview.afterN })}
                  </p>
                  {preview.charges > 0 && <p className="text-muted">{t("prepayments.previewCharges", { principal: m(preview.amount), charges: m(preview.charges) })}</p>}
                  {kind === "part" && preview.nextEmi !== null && preview.nextDate && (
                    <p className="text-muted">{t("prepayments.previewNext", { date: f.date(preview.nextDate), amount: m(preview.nextEmi), count: preview.instalments })}</p>
                  )}
                </>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <button className="btn-primary" disabled={record.isPending || (kind === "part" && !amount) || (!!preview && "error" in preview)}>
            {kind === "foreclosure" ? t("prepayments.recordForeclosure") : t("prepayments.record")}
          </button>
        </form>
      )}
    </Section>
  );
}
