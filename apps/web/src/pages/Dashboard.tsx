import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertOctagon, AlertTriangle, CalendarClock, CheckCircle2, Plus, Wallet } from "lucide-react";
import type { Dashboard as DashboardData, Lender, PayByGroup } from "@emi/shared";
import { currencyEntries, useFormat } from "../lib/format";
import { useCards, useDashboard, useLenders, useMe } from "../lib/queries";
import { BalanceChart } from "../components/charts";
import { ErrorState, LenderAvatar, MoneyLines, PageHeader, ProgressBar, Section, Spinner, StatusBadge, cx } from "../components/ui";

/** What is left to pay this month, with how much of the month is already paid (per currency). */
function StillToPayTile({ still, paid, total, index }: { still: Record<string, number>; paid: Record<string, number>; total: Record<string, number>; index: number }) {
  const { t } = useTranslation();
  const f = useFormat();
  const currencies = currencyEntries(total).map(([c]) => c);
  return (
    <div style={{ "--i": index } as React.CSSProperties} className="card animate-rise p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-muted">
        <Wallet size={16} aria-hidden /> {t("dashboard.stillToPay")}
      </div>
      {currencies.length === 0 ? (
        <p className="mt-2 text-xl font-bold">—</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {currencies.map((c) => {
            const left = still[c] ?? 0;
            const done = paid[c] ?? 0;
            return (
              <li key={c}>
                <p className={cx("num text-xl font-bold", left === 0 && "text-success")}>{left === 0 ? t("dashboard.allPaid") : f.money(left, c)}</p>
                <ProgressBar value={total[c] ? done / total[c]! : 0} label={t("dashboard.paidOf", { paid: f.money(done, c), total: f.money(total[c] ?? 0, c) })} />
                <p className="mt-1 text-xs text-muted">{t("dashboard.paidOf", { paid: f.money(done, c), total: f.money(total[c] ?? 0, c) })}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Tile({ label, totals, tone = "default", icon, index = 0 }: { label: string; totals: Record<string, number>; tone?: "default" | "accent" | "warn"; icon?: React.ReactNode; index?: number }) {
  const f = useFormat();
  return (
    <div
      style={{ "--i": index } as React.CSSProperties}
      className={cx(
        "card animate-rise p-4",
        tone === "accent" && "lacquer border-transparent",
        tone === "warn" && currencyEntries(totals).length > 0 && "border-accent/50 bg-accent-soft",
      )}
    >
      <div className={cx("flex items-center gap-2 text-sm font-medium", tone === "accent" ? "text-frame-muted" : "text-muted")}>
        {icon}
        {label}
      </div>
      <MoneyLines
        entries={currencyEntries(totals)}
        money={f.money}
        className={cx("mt-2 text-xl font-bold", tone === "warn" && currencyEntries(totals).length > 0 && "text-accent-text")}
      />
    </div>
  );
}

function Breakdown({ title, data, label }: { title: string; data: Record<string, Record<string, number>>; label: (k: string) => React.ReactNode }) {
  const f = useFormat();
  // One bar list per currency so magnitudes are only compared within a currency.
  const byCurrency = new Map<string, [string, number][]>();
  for (const [k, totals] of Object.entries(data)) {
    for (const [c, v] of Object.entries(totals)) {
      if (!byCurrency.has(c)) byCurrency.set(c, []);
      byCurrency.get(c)!.push([k, v]);
    }
  }
  if (!byCurrency.size) return null;
  return (
    <Section title={title}>
      <div className="space-y-5">
        {[...byCurrency].map(([c, rows]) => {
          rows.sort((a, b) => b[1] - a[1]);
          const max = rows[0]?.[1] ?? 1;
          return (
            <div key={c}>
              {byCurrency.size > 1 && <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{c}</p>}
              <ul className="space-y-3">
                {rows.map(([k, v]) => (
                  <li key={k}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2 truncate">{label(k)}</span>
                      <span className="num shrink-0 font-semibold">{f.money(v, c)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-2" aria-hidden>
                      <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(3, (v / max) * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

const DTI_STYLE = {
  healthy: { bar: "bg-success", text: "text-success", Icon: CheckCircle2 },
  caution: { bar: "bg-accent", text: "text-accent-text", Icon: AlertTriangle },
  high: { bar: "bg-danger", text: "text-danger", Icon: AlertOctagon },
} as const;

function DtiCard({ dti }: { dti: DashboardData["dti"] }) {
  const { t } = useTranslation();
  const f = useFormat();
  if (!dti) {
    return (
      <Section title={t("dashboard.dti")}>
        <p className="text-sm text-muted">{t("dashboard.dtiSetIncome")}</p>
        <Link to="/settings" className="btn-ghost mt-2">
          {t("nav.settings")}
        </Link>
      </Section>
    );
  }
  const pct = Math.round(dti.ratio * 1000) / 10;
  const style = DTI_STYLE[dti.band];
  return (
    <Section title={t("dashboard.dti")}>
      <p className={cx("num text-3xl font-bold", style.text)}>{f.percent(pct, 1)}</p>
      <p className={cx("mt-1 flex items-center gap-1 text-sm font-semibold", style.text)}>
        <style.Icon size={16} aria-hidden /> {t(`dashboard.dtiBands.${dti.band}`)}
      </p>
      <div
        className="relative mt-3 h-2 rounded-full bg-surface-2"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t("dashboard.dti")}
      >
        <div className={cx("h-2 rounded-full", style.bar)} style={{ width: `${Math.min(100, pct)}%` }} />
        {[30, 40].map((m) => (
          <span key={m} aria-hidden className="absolute top-[-3px] h-3.5 w-0.5 bg-muted/60" style={{ left: `${m}%` }} />
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">
        {t("dashboard.dtiDetail", { obligations: f.money(dti.obligations, dti.currency), income: f.money(dti.income, dti.currency) })}
      </p>
      {dti.excludedLoans > 0 && <p className="mt-1 text-xs text-muted">{t("dashboard.dtiExcluded", { count: dti.excludedLoans })}</p>}
    </Section>
  );
}

function PayByRow({ g, cardName }: { g: PayByGroup; cardName: (id: string) => string }) {
  const { t } = useTranslation();
  const f = useFormat();
  const first = g.items[0]!;
  const overdue = g.items.some((i) => i.status === "overdue");
  return (
    <li className={cx("flex items-center gap-3 rounded-xl border p-3", overdue ? "border-accent/60 bg-accent-soft" : "border-line")}>
      <div className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-primary-soft py-1 text-primary-strong">
        <span className="text-lg font-bold leading-tight">{g.payableDate.slice(8)}</span>
        <span className="text-[11px] uppercase">{f.monthShort(g.payableDate)}</span>
      </div>
      <div className="min-w-0 flex-1">
        {g.cardId && g.items.length > 1 ? (
          <p className="truncate font-medium">{t("dashboard.cardGroup", { count: g.items.length, card: cardName(g.cardId) })}</p>
        ) : (
          <Link to={`/loans/${first.loanId}`} className="block truncate font-medium hover:underline">
            {first.loanNickname} <span className="text-muted">#{first.n}</span>
          </Link>
        )}
        <p className="text-xs text-muted">
          {t("dashboard.payBy", { date: f.date(g.payableDate) })}
          {first.billedDate !== g.payableDate && <> · {t("dashboard.billedOn", { date: f.date(first.billedDate) })}</>}
        </p>
        {g.cardId && g.items.length > 1 && (
          <ul className="mt-1 text-xs text-muted">
            {g.items.map((i) => (
              <li key={i.instalmentId}>
                <Link to={`/loans/${i.loanId}`} className="hover:underline">
                  {i.loanNickname}
                </Link>{" "}
                · {f.money(i.amount, i.currency)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="num font-bold">{f.money(g.total, g.currency)}</span>
        <StatusBadge status={overdue ? "overdue" : first.status} />
      </div>
    </li>
  );
}

export function Dashboard() {
  const { t } = useTranslation();
  const me = useMe();
  const dash = useDashboard();
  const lenders = useLenders();
  const cards = useCards();

  if (dash.isLoading) return <Spinner />;
  if (dash.error) return <ErrorState error={dash.error} onRetry={() => void dash.refetch()} />;
  const d = dash.data as DashboardData;
  const lenderById = new Map((lenders.data ?? []).map((l) => [l.id, l] as [string, Lender]));
  const cardName = (id: string) => cards.data?.find((c) => c.id === id)?.nickname ?? "";

  const firstName = me.data?.user.name.split(" ")[0] ?? "";
  const addBtn = (
    <Link to="/loans/new" className="btn-primary">
      <Plus size={18} aria-hidden /> {t("dashboard.addLoan")}
    </Link>
  );

  if (d.activeLoans === 0 && d.upcoming.length === 0) {
    return (
      <>
        <PageHeader title={t("dashboard.greeting", { name: firstName })} />
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <Wallet size={40} className="text-primary" aria-hidden />
          <h2 className="text-lg font-semibold">{t("dashboard.emptyTitle")}</h2>
          <p className="max-w-sm text-muted">{t("dashboard.emptyBody")}</p>
          {addBtn}
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t("dashboard.greeting", { name: firstName })} actions={addBtn} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile label={t("dashboard.payableThisMonth")} totals={d.payableThisMonth} tone="accent" icon={<CalendarClock size={16} aria-hidden />} />
        {/* Older cached dashboards (offline) don't have the paid / still-to-pay split. */}
        <StillToPayTile still={d.stillToPayThisMonth ?? d.payableThisMonth} paid={d.paidThisMonth ?? {}} total={d.payableThisMonth} index={1} />
        <Tile label={t("dashboard.next7")} totals={d.next7Days} index={2} />
        {/* Older cached dashboards (offline) have no next-month figure. */}
        <Tile label={t("dashboard.payableNextMonth")} totals={d.payableNextMonth ?? {}} index={3} />
        <Tile label={t("dashboard.overdue")} totals={d.overdue} tone="warn" icon={<AlertTriangle size={16} aria-hidden />} index={4} />
        <Tile label={t("dashboard.outstanding")} totals={d.outstanding} index={5} />
      </div>
      <p className="mt-2 text-xs text-muted">{t("dashboard.perCurrencyNote")}</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:self-start">
          <DtiCard dti={d.dti} />
        </div>
        {Object.keys(d.balanceTrend).length > 0 && (
          <Section title={t("charts.balanceTrend")} className="lg:col-span-2">
            <p className="mb-2 text-xs text-muted">{t("charts.balanceTrendDesc")}</p>
            <div className="space-y-6">
              {Object.entries(d.balanceTrend)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([c, pts]) => (
                  <div key={c}>
                    {Object.keys(d.balanceTrend).length > 1 && <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{c}</p>}
                    <BalanceChart currency={c} label={`${t("charts.balanceTrend")} (${c})`} points={pts.map((p) => ({ date: p.date, value: p.outstanding }))} />
                  </div>
                ))}
            </div>
          </Section>
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Section title={t("dashboard.upcoming")} className="lg:col-span-2">
          {d.upcoming.length === 0 ? (
            <p className="text-muted">{t("dashboard.nothingDue")}</p>
          ) : (
            <ul className="space-y-2">
              {d.upcoming.map((g) => (
                <PayByRow key={g.key} g={g} cardName={cardName} />
              ))}
            </ul>
          )}
          <Link to="/calendar" className="btn-ghost mt-3">
            {t("common.viewAll")}
          </Link>
        </Section>
        <div className="space-y-6">
          <Breakdown
            title={t("dashboard.byLender")}
            data={d.byLender}
            label={(id) => {
              const l = lenderById.get(id);
              return (
                <>
                  <LenderAvatar lender={l} size={22} /> <span className="truncate">{l?.name ?? id}</span>
                </>
              );
            }}
          />
          <Breakdown title={t("dashboard.byType")} data={d.byType} label={(k) => t(`loans.types.${k}`)} />
        </div>
      </div>
    </>
  );
}
