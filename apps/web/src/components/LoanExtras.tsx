import { useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { CalendarPlus, Download, FileDown, FileSpreadsheet, FileText, Info, Paperclip, Send, Trash2, TrendingUp, UserRound, Wallet } from "lucide-react";
import { parseMajor, simulatePrepayment, toMajorString, type PrepaymentResult } from "@emi/core";
import { DOCUMENT_TYPES, duesToIcs, placeRecordedPrepayments, scheduleToCsv, toLoanTerms, type LoanDetail, type UpcomingItem } from "@emi/shared";
import { HttpError, errorMessage } from "../lib/api";
import { downloadBlob, slug } from "../lib/download";
import { useFormat } from "../lib/format";
import { exportSchedulePdf } from "../lib/pdf";
import { useAddRateChange, useChangeShare, useDeleteDocument, useDeleteRateChange, useInvite, useMe, useRevokeShare, useUploadDocument } from "../lib/queries";
import { Section, SelectField, TextField, cx } from "./ui";

/** Engine terms for a saved loan as stored: manual overrides and rate changes, without recorded prepayments. */
export function baseTermsForLoan(loan: LoanDetail) {
  const overrides: Record<number, number> = {};
  for (const i of loan.instalments) if (i.overridden) overrides[i.n] = i.emi;
  return toLoanTerms(loan, { overrides, rateChanges: loan.rateChanges });
}

/** Engine terms for a saved loan including the prepayments the user recorded (what the schedule shows). */
export function termsForLoan(loan: LoanDetail) {
  const base = baseTermsForLoan(loan);
  try {
    return { ...base, prepayments: placeRecordedPrepayments(base, loan.prepayments).map((x) => x.p) };
  } catch {
    return base;
  }
}

export function toUpcomingItems(loan: LoanDetail): UpcomingItem[] {
  return loan.instalments.map((i) => ({
    instalmentId: i.id,
    loanId: loan.id,
    loanNickname: loan.nickname,
    lenderId: loan.lenderId,
    cardId: loan.cardId ?? null,
    currency: loan.currency,
    n: i.n,
    billedDate: i.billedDate,
    payableDate: i.payableDate,
    amount: i.totalPayable,
    status: i.status,
  }));
}

export function ExportMenu({ loan, lenderName }: { loan: LoanDetail; lenderName: string }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const f = useFormat();
  const [busy, setBusy] = useState(false);
  const name = slug(loan.nickname);
  return (
    <Section title={t("exporting.title")}>
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={() => downloadBlob(`${name}-schedule.csv`, scheduleToCsv(loan, loan.instalments, i18n.language), "text/csv;charset=utf-8")}>
          <FileSpreadsheet size={16} aria-hidden /> {t("exporting.csv")}
        </button>
        <button
          className="btn-secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await exportSchedulePdf(loan, me.data?.settings ?? { locale: f.locale, dateFormat: "DD MMM YYYY" }, lenderName);
            } finally {
              setBusy(false);
            }
          }}
        >
          <FileText size={16} aria-hidden /> {t("exporting.pdf")}
        </button>
        <button
          className="btn-secondary"
          onClick={() => downloadBlob(`${name}-due-dates.ics`, duesToIcs(toUpcomingItems(loan), { locale: f.locale, language: i18n.language, alarmDaysBefore: 1 }), "text/calendar;charset=utf-8")}
        >
          <CalendarPlus size={16} aria-hidden /> {t("exporting.ics")}
        </button>
      </div>
    </Section>
  );
}

export function RateChanges({ loan }: { loan: LoanDetail }) {
  const { t } = useTranslation();
  const f = useFormat();
  const add = useAddRateChange();
  const del = useDeleteRateChange();
  const [date, setDate] = useState("");
  const [rate, setRate] = useState("");
  const [mode, setMode] = useState<"keep_emi" | "keep_tenure">("keep_emi");
  const [error, setError] = useState<string | null>(null);

  if (loan.repaymentType !== "reducing") {
    return (
      <Section title={t("rateChanges.title")}>
        <p className="flex gap-2 text-sm text-muted">
          <Info size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
          {t("flatRate.rateChangeUnavailable")}
        </p>
      </Section>
    );
  }
  const canEdit = loan.access !== "view";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await add.mutateAsync({ loanId: loan.id, input: { effectiveDate: date, annualRate: Number(rate), mode } });
      setDate("");
      setRate("");
    } catch (ex) {
      setError(errorMessage(t, ex));
    }
  };
  return (
    <Section title={t("rateChanges.title")}>
      <p className="mb-3 text-sm text-muted">{t("rateChanges.intro")}</p>
      {loan.rateChanges.length === 0 ? (
        <p className="mb-3 text-sm text-muted">{t("rateChanges.empty")}</p>
      ) : (
        <ul className="mb-4 divide-y divide-line">
          {loan.rateChanges.map((rc) => (
            <li key={rc.id} className="flex items-center gap-3 py-2 text-sm">
              <TrendingUp size={16} className="text-primary" aria-hidden />
              <span className="flex-1">
                <strong>{f.date(rc.effectiveDate)}</strong> → {f.percent(rc.annualRate)} ·{" "}
                <span className="text-muted">{rc.mode === "keep_emi" ? t("rateChanges.keepEmi") : t("rateChanges.keepTenure")}</span>
              </span>
              {canEdit && (
                <button className="btn-ghost px-2 text-danger" onClick={() => del.mutate({ loanId: loan.id, id: rc.id })} aria-label={t("rateChanges.remove")}>
                  <Trash2 size={16} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
      <form onSubmit={(e) => void submit(e)} className="grid gap-3 sm:grid-cols-4 sm:items-end">
        <TextField label={t("rateChanges.effectiveDate")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required min={loan.bookingDate} />
        <TextField label={t("rateChanges.newRate")} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required />
        <SelectField label={t("rateChanges.mode")} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="keep_emi">{t("rateChanges.keepEmi")}</option>
          <option value="keep_tenure">{t("rateChanges.keepTenure")}</option>
        </SelectField>
        <button className="btn-primary" disabled={add.isPending || !date || !rate}>
          {t("rateChanges.add")}
        </button>
      </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Section>
  );
}

export function PrepaySimulator({ loan }: { loan: LoanDetail }) {
  const { t } = useTranslation();
  const f = useFormat();
  const m = (v: number) => f.money(v, loan.currency);
  const next = loan.nextInstalment?.billedDate ?? loan.firstEmiDate;
  const [date, setDate] = useState(next);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"reduce_tenure" | "reduce_emi">("reduce_tenure");
  // Start from the loan's saved pre-closure charge; the user can try other numbers here.
  const saved = loan.prepaymentCharge;
  const [chargeKind, setChargeKind] = useState<"percent" | "flat">(saved.kind === "flat" ? "flat" : "percent");
  const [charge, setCharge] = useState(saved.kind === "flat" ? toMajorString(saved.amount, loan.currency) : saved.kind === "percent" ? String(saved.percent) : "0");
  const [chargeTax, setChargeTax] = useState(
    String(saved.kind !== "none" ? loan.prepaymentChargeTaxRate : loan.interestTaxEnabled ? loan.interestTaxRate : loan.processingFeeTaxRate || 0),
  );
  const [result, setResult] = useState<PrepaymentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const terms = useMemo(() => termsForLoan(loan), [loan]);

  if (loan.repaymentType !== "reducing") {
    return (
      <Section title={t("prepay.title")}>
        <p className="flex gap-2 text-sm text-muted">
          <Info size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
          {t("flatRate.prepayUnavailable")}
        </p>
      </Section>
    );
  }

  const run = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setResult(
        simulatePrepayment(terms, {
          date,
          amount: parseMajor(amount, loan.currency),
          mode,
          chargePercent: chargeKind === "percent" ? Number(charge) || 0 : 0,
          chargeFlat: chargeKind === "flat" && charge ? parseMajor(charge, loan.currency) : 0,
          chargeTaxRate: Number(chargeTax) || 0,
        }),
      );
    } catch (ex) {
      setResult(null);
      setError(errorMessage(t, ex));
    }
  };

  return (
    <Section title={t("prepay.title")}>
      <p className="mb-3 text-sm text-muted">{t("prepay.intro")}</p>
      <form onSubmit={run} className="grid gap-3 sm:grid-cols-3">
        <TextField label={t("prepay.date")} hint={t("prepay.dateHint")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        <TextField label={`${t("prepay.amount")} (${loan.currency})`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <SelectField label={t("prepay.mode")} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="reduce_tenure">{t("prepay.reduceTenure")}</option>
          <option value="reduce_emi">{t("prepay.reduceEmi")}</option>
        </SelectField>
        <SelectField
          label={t("extraCash.chargeKind")}
          value={chargeKind}
          onChange={(e) => {
            setChargeKind(e.target.value as typeof chargeKind);
            setCharge("0");
          }}
        >
          <option value="percent">{t("form.prepaymentChargePercent")}</option>
          <option value="flat">{t("form.feeFlat")}</option>
        </SelectField>
        <TextField
          label={chargeKind === "flat" ? `${t("prepay.chargeFlat")} (${loan.currency})` : t("prepay.chargePercent")}
          hint={saved.kind !== "none" ? t("prepay.chargeFromLoan") : undefined}
          inputMode="decimal"
          value={charge}
          onChange={(e) => setCharge(e.target.value)}
        />
        <TextField label={t("prepay.chargeTax")} inputMode="decimal" value={chargeTax} onChange={(e) => setChargeTax(e.target.value)} />
        <div className="flex items-end sm:col-span-3">
          <button className="btn-primary w-full" disabled={!amount}>
            <Wallet size={16} aria-hidden /> {t("prepay.simulate")}
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {result && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2" aria-live="polite">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">{t("prepay.interestSaved")}</dt>
              <dd className="num font-semibold text-success">{m(result.interestSaved)}</dd>
            </div>
            {result.interestTaxSaved > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">{t("prepay.taxSaved")}</dt>
                <dd className="num text-success">{m(result.interestTaxSaved)}</dd>
              </div>
            )}
            {result.charges > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">{t("prepay.charges")}</dt>
                <dd className="num text-accent-text">−{m(result.charges)}</dd>
              </div>
            )}
            <div className="flex justify-between border-t border-line pt-2 font-semibold">
              <dt>{t("prepay.netSaving")}</dt>
              <dd className={cx("num text-lg", result.netSaving >= 0 ? "text-success" : "text-danger")}>{m(result.netSaving)}</dd>
            </div>
            {result.netSaving < 0 && <p className="text-xs text-danger">{t("prepay.negative")}</p>}
          </dl>
          <table className="text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th />
                <th scope="col" className="text-right font-medium">
                  {t("prepay.before")}
                </th>
                <th scope="col" className="text-right font-medium">
                  {t("prepay.after")}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="py-1 text-left font-normal text-muted">
                  {t("prepay.instalments")}
                </th>
                <td className="num text-right">{result.instalmentsBefore}</td>
                <td className="num text-right font-semibold">{result.instalmentsAfter}</td>
              </tr>
              {!result.foreclosed && (
                <tr>
                  <th scope="row" className="py-1 text-left font-normal text-muted">
                    {t("prepay.emi")}
                  </th>
                  <td className="num text-right">{m(result.emiBefore)}</td>
                  <td className="num text-right font-semibold">{m(result.emiAfter)}</td>
                </tr>
              )}
              <tr>
                <th scope="row" className="py-1 text-left font-normal text-muted">
                  {t("schedule.totalCost")}
                </th>
                <td className="num text-right">{m(result.before.summary.totalCostOfBorrowing)}</td>
                <td className="num text-right font-semibold">{m(result.after.summary.totalCostOfBorrowing)}</td>
              </tr>
            </tbody>
          </table>
          {result.foreclosed && <p className="text-sm font-medium text-primary-strong sm:col-span-2">{t("prepay.foreclosed")}</p>}
        </div>
      )}
    </Section>
  );
}

export function Documents({ loan }: { loan: LoanDetail }) {
  const { t } = useTranslation();
  const f = useFormat();
  const upload = useUploadDocument();
  const del = useDeleteDocument();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
  const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      await upload.mutateAsync({ loanId: loan.id, file });
    } catch (ex) {
      const code = ex instanceof HttpError ? (ex.body?.error ?? "") : "";
      setError(t(`documents.errors.${code}`, { defaultValue: t("common.errorGeneric") }));
    } finally {
      if (input.current) input.current.value = "";
    }
  };

  return (
    <Section title={t("documents.title")}>
      <p className="mb-3 text-sm text-muted">{t("documents.intro")}</p>
      {loan.documents.length === 0 ? (
        <p className="mb-3 text-sm text-muted">{t("documents.empty")}</p>
      ) : (
        <ul className="mb-3 divide-y divide-line">
          {loan.documents.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
              <Paperclip size={16} className="text-primary" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {d.filename} <span className="text-muted">· {size(d.size)} · {f.date(d.createdAt.slice(0, 10))}</span>
              </span>
              <a className="btn-ghost px-2" href={`${base}/api/documents/${d.id}`} aria-label={`${t("documents.download")} ${d.filename}`}>
                <Download size={16} aria-hidden />
              </a>
              <button className="btn-ghost px-2 text-danger" onClick={() => del.mutate(d.id)} aria-label={`${t("documents.remove")} ${d.filename}`}>
                <Trash2 size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input ref={input} type="file" accept={DOCUMENT_TYPES.join(",")} className="sr-only" id={`doc-${loan.id}`} onChange={(e) => void onFile(e.target.files?.[0])} />
      <label htmlFor={`doc-${loan.id}`} className={cx("btn-secondary cursor-pointer", upload.isPending && "pointer-events-none opacity-50")}>
        <FileDown size={16} aria-hidden /> {upload.isPending ? t("documents.uploading") : t("documents.upload")}
      </label>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Section>
  );
}

export function SharingPanel({ loan }: { loan: LoanDetail }) {
  const { t } = useTranslation();
  const invite = useInvite();
  const change = useChangeShare();
  const revoke = useRevokeShare();
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<"view" | "edit">("view");
  const [error, setError] = useState<string | null>(null);
  if (loan.access !== "owner") return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await invite.mutateAsync({ loanId: loan.id, email, access });
      setEmail("");
    } catch (ex) {
      setError(errorMessage(t, ex));
    }
  };

  return (
    <Section title={t("sharing.title")}>
      <p className="mb-1 text-sm text-muted">{t("sharing.intro")}</p>
      <p className="mb-3 text-xs text-muted">{t("sharing.privacyNote")}</p>
      {loan.shares.length === 0 ? (
        <p className="mb-3 text-sm text-muted">{t("sharing.empty")}</p>
      ) : (
        <ul className="mb-4 divide-y divide-line">
          {loan.shares.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <UserRound size={16} className="text-primary" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{s.name ?? s.email}</span>
                <span className="block truncate text-xs text-muted">
                  {s.name ? `${s.email} · ` : ""}
                  {s.status === "active" ? t("sharing.active") : t("sharing.pending")}
                </span>
              </span>
              <SelectField
                label={`${t("sharing.access")} — ${s.email}`}
                hideLabel
                className="w-40"
                value={s.access}
                onChange={(e) => change.mutate({ loanId: loan.id, shareId: s.id, access: e.target.value as "view" | "edit" })}
              >
                <option value="view">{t("sharing.view")}</option>
                <option value="edit">{t("sharing.edit")}</option>
              </SelectField>
              <button
                className="btn-ghost px-2 text-danger"
                onClick={() => confirm(t("sharing.revokeConfirm", { email: s.email })) && revoke.mutate({ loanId: loan.id, shareId: s.id })}
                aria-label={`${t("sharing.revoke")} — ${s.email}`}
              >
                <Trash2 size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => void submit(e)} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <TextField label={t("sharing.email")} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={320} />
        <SelectField label={t("sharing.access")} value={access} onChange={(e) => setAccess(e.target.value as "view" | "edit")}>
          <option value="view">{t("sharing.view")}</option>
          <option value="edit">{t("sharing.edit")}</option>
        </SelectField>
        <button className="btn-primary" disabled={invite.isPending || !email}>
          <Send size={16} aria-hidden /> {invite.isPending ? t("sharing.inviting") : t("sharing.invite")}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Section>
  );
}
