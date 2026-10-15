import { Hono, type Context } from "hono";
import { z } from "zod";
import { isValidISODate } from "@emi/core";
import {
  instalmentStatusPatchSchema,
  isoDate,
  loanInputSchema,
  overrideSchema,
  paymentInputSchema,
  rateChangeInputSchema,
  recordPrepaymentSchema,
  shareAccessSchema,
  shareInputSchema,
  type LoanInput,
} from "@emi/shared";
import type { AppEnv } from "../env";
import { accessFor, viewerOf, type LoanAccessCtx } from "../lib/access";
import { ApiError, notFound } from "../lib/errors";
import { rateLimit } from "../lib/security";
import { newId } from "../lib/util";
import { sendEmail, shareInviteEmail } from "../services/email";
import { getDashboard, getLoanDetail, listInstalmentsInRange, listLoans, listSharedLoans, loadCard, regenerateSchedule } from "../services/loans";
import { loanColumns, loanInputFromRow } from "../services/repo";

/**
 * Access rules (see docs/DECISIONS.md "Sharing"):
 * - owner: everything.
 * - edit:  view + record/undo payments, skip, overrides, edit terms (not lender/card/type), rate changes.
 * - view:  read-only.
 * - Only the owner can share, change access, revoke, mute, delete, or touch documents.
 * All loan data stays under the owner's user_id; every query is scoped by ctx.ownerId.
 */
export const loanRoutes = new Hono<AppEnv>();
export const instalmentRoutes = new Hono<AppEnv>();
export const dashboardRoutes = new Hono<AppEnv>();

type Row = Record<string, unknown>;

export const INVITES_PER_DAY = 20;

/** Emails already sent today (UTC), the same count the reminder job uses for Resend's daily quota. */
async function emailsSentToday(db: D1Database): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(DISTINCT send_id) AS c FROM notifications WHERE channel = 'email' AND status = 'sent' AND created_at >= ?")
    .bind(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z")
    .first<{ c: number }>();
  return Number(r?.c ?? 0);
}

async function assertLender(db: D1Database, userId: string, lenderId: string) {
  const ok = await db.prepare("SELECT 1 FROM lenders WHERE id = ? AND (user_id IS NULL OR user_id = ?)").bind(lenderId, userId).first();
  if (!ok) throw new ApiError(422, "lender_not_found");
}

const detail = (c: Context<AppEnv>, ctx: LoanAccessCtx, loanId: string) => getLoanDetail(c.env.DB, ctx.ownerId, loanId, viewerOf(c.get("userId"), ctx));

async function regenerateFromRow(db: D1Database, ownerId: string, row: Row) {
  const input = loanInputFromRow(row);
  await regenerateSchedule(db, ownerId, String(row.id), input, await loadCard(db, ownerId, input.cardId));
}

// ---- Loans --------------------------------------------------------------------------------

loanRoutes.get("/", async (c) => c.json(await listLoans(c.env.DB, c.get("userId"))));
loanRoutes.get("/shared", async (c) => c.json(await listSharedLoans(c.env.DB, c.get("userId"))));

loanRoutes.post("/", async (c) => {
  const userId = c.get("userId");
  const input: LoanInput = loanInputSchema.parse(await c.req.json());
  await assertLender(c.env.DB, userId, input.lenderId);
  const card = input.type === "credit_card_emi" ? await loadCard(c.env.DB, userId, input.cardId) : null;
  const id = newId();
  const cols = loanColumns(input);
  const names = Object.keys(cols);
  await c.env.DB.prepare(`INSERT INTO loans (id, user_id, ${names.join(", ")}) VALUES (?, ?, ${names.map(() => "?").join(", ")})`)
    .bind(id, userId, ...Object.values(cols))
    .run();
  try {
    await regenerateSchedule(c.env.DB, userId, id, input, card);
  } catch (err) {
    await c.env.DB.prepare("DELETE FROM loans WHERE id = ? AND user_id = ?").bind(id, userId).run();
    throw err;
  }
  return c.json(await getLoanDetail(c.env.DB, userId, id), 201);
});

loanRoutes.get("/:id", async (c) => {
  const ctx = await accessFor(c.env.DB, c.get("userId"), c.req.param("id"), "view");
  return c.json(await detail(c, ctx, c.req.param("id")));
});

loanRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  const ctx = await accessFor(c.env.DB, c.get("userId"), id, "edit");
  const previous = ctx.loan;
  let body = (await c.req.json()) as Record<string, unknown>;
  if (ctx.role !== "owner") {
    // Editors can't see the owner's lenders, cards or mute preference: keep them as they are
    // (merged before validation, since a card EMI requires the owner's card id).
    const prev = loanInputFromRow(previous);
    body = { ...body, lenderId: prev.lenderId, cardId: prev.cardId, type: prev.type, customTypeLabel: prev.customTypeLabel, muted: prev.muted };
  }
  const input: LoanInput = loanInputSchema.parse(body);
  if (ctx.role === "owner") {
    await assertLender(c.env.DB, ctx.ownerId, input.lenderId);
  }
  const card = input.type === "credit_card_emi" ? await loadCard(c.env.DB, ctx.ownerId, input.cardId) : null;
  const cols = loanColumns(input);
  const sets = Object.keys(cols).map((k) => `${k} = ?`).join(", ");
  await c.env.DB.prepare(`UPDATE loans SET ${sets} WHERE id = ? AND user_id = ?`).bind(...Object.values(cols), id, ctx.ownerId).run();
  try {
    await regenerateSchedule(c.env.DB, ctx.ownerId, id, input, card);
  } catch (err) {
    // Roll the terms back so the stored loan and schedule stay consistent.
    const old = loanColumns(loanInputFromRow(previous));
    await c.env.DB.prepare(`UPDATE loans SET ${Object.keys(old).map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND user_id = ?`)
      .bind(...Object.values(old), id, ctx.ownerId)
      .run();
    throw err;
  }
  return c.json(await detail(c, ctx, id));
});

/** Reminders go to the owner, so muting is the owner's choice. */
loanRoutes.patch("/:id/mute", async (c) => {
  const ctx = await accessFor(c.env.DB, c.get("userId"), c.req.param("id"), "owner");
  const { muted } = z.object({ muted: z.boolean() }).parse(await c.req.json());
  await c.env.DB.prepare("UPDATE loans SET muted = ? WHERE id = ? AND user_id = ?").bind(muted ? 1 : 0, c.req.param("id"), ctx.ownerId).run();
  return c.json({ muted });
});

loanRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const ctx = await accessFor(c.env.DB, c.get("userId"), id, "owner");
  const owner = ctx.ownerId;
  const docs = await c.env.DB.prepare("SELECT r2_key FROM documents WHERE loan_id = ? AND user_id = ?").bind(id, owner).all<Row>();
  if (docs.results.length) await c.env.DOCS.delete(docs.results.map((d) => String(d.r2_key)));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM loan_shares WHERE loan_id = ? AND owner_id = ?").bind(id, owner),
    ...["payments", "instalments", "rate_changes", "prepayments", "documents", "notifications"].map((t) =>
      c.env.DB.prepare(`DELETE FROM ${t} WHERE loan_id = ? AND user_id = ?`).bind(id, owner),
    ),
    c.env.DB.prepare("DELETE FROM loans WHERE id = ? AND user_id = ?").bind(id, owner),
  ]);
  return c.body(null, 204);
});

/** Manually set (or clear with null) an instalment's EMI so the schedule matches the bank statement. */
loanRoutes.put("/:id/instalments/:n/override", async (c) => {
  const id = c.req.param("id");
  const ctx = await accessFor(c.env.DB, c.get("userId"), id, "edit");
  const owner = ctx.ownerId;
  const n = Number(c.req.param("n"));
  const { amount } = overrideSchema.parse(await c.req.json());
  const input = loanInputFromRow(ctx.loan);
  if (!Number.isInteger(n) || n < 1 || n >= input.tenureMonths) throw new ApiError(422, "override_out_of_range");
  const prev = await c.env.DB.prepare("SELECT override_amount FROM instalments WHERE loan_id = ? AND n = ? AND user_id = ?")
    .bind(id, n, owner)
    .first<{ override_amount: number | null }>();
  await c.env.DB.prepare("UPDATE instalments SET override_amount = ? WHERE loan_id = ? AND n = ? AND user_id = ?").bind(amount, id, n, owner).run();
  try {
    await regenerateSchedule(c.env.DB, owner, id, input, await loadCard(c.env.DB, owner, input.cardId));
  } catch (err) {
    await c.env.DB.prepare("UPDATE instalments SET override_amount = ? WHERE loan_id = ? AND n = ? AND user_id = ?")
      .bind(prev?.override_amount ?? null, id, n, owner)
      .run();
    throw err;
  }
  return c.json(await detail(c, ctx, id));
});

// ---- Floating-rate changes ----------------------------------------------------------------

loanRoutes.post("/:id/rate-changes", async (c) => {
  const id = c.req.param("id");
  const ctx = await accessFor(c.env.DB, c.get("userId"), id, "edit");
  const row = ctx.loan;
  const rc = rateChangeInputSchema.parse(await c.req.json());
  if (String(row.repayment_type) !== "reducing") throw new ApiError(422, "rate_change_reducing_only");
  if (rc.effectiveDate <= String(row.booking_date)) throw new ApiError(422, "rate_change_before_booking");
  const rcId = newId();
  await c.env.DB.prepare("INSERT INTO rate_changes (id, user_id, loan_id, effective_date, annual_rate, mode) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(rcId, ctx.ownerId, id, rc.effectiveDate, rc.annualRate, rc.mode)
    .run();
  try {
    await regenerateFromRow(c.env.DB, ctx.ownerId, row);
  } catch (err) {
    await c.env.DB.prepare("DELETE FROM rate_changes WHERE id = ? AND user_id = ?").bind(rcId, ctx.ownerId).run();
    throw err;
  }
  return c.json(await detail(c, ctx, id), 201);
});

// ---- Recorded prepayments / foreclosures (change the stored schedule) -----------------------

loanRoutes.post("/:id/prepayments", async (c) => {
  const id = c.req.param("id");
  const ctx = await accessFor(c.env.DB, c.get("userId"), id, "edit");
  const row = ctx.loan;
  const p = recordPrepaymentSchema.parse(await c.req.json());
  if (String(row.repayment_type) !== "reducing") throw new ApiError(422, "prepayment_reducing_only");
  const ppId = newId();
  const db = c.env.DB;
  await db
    .prepare(
      "INSERT INTO prepayments (id, user_id, loan_id, paid_date, kind, amount, mode, charge, charge_tax_rate, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ppId, ctx.ownerId, id, p.date, p.kind, p.kind === "part" ? p.amount! : null, p.mode, JSON.stringify(p.charge), p.charge.kind === "none" ? 0 : p.chargeTaxRate, p.note ?? null)
    .run();
  const undo = async () => {
    await db.prepare("DELETE FROM prepayments WHERE id = ? AND user_id = ?").bind(ppId, ctx.ownerId).run();
    await regenerateFromRow(db, ctx.ownerId, row);
  };
  try {
    await regenerateFromRow(db, ctx.ownerId, row);
  } catch (err) {
    await db.prepare("DELETE FROM prepayments WHERE id = ? AND user_id = ?").bind(ppId, ctx.ownerId).run();
    throw err;
  }
  // Nothing left to prepay by then (e.g. an earlier foreclosure already closed the loan).
  const applied = await db.prepare("SELECT applied_amount FROM prepayments WHERE id = ?").bind(ppId).first<{ applied_amount: number }>();
  if (!applied || Number(applied.applied_amount) <= 0) {
    await undo();
    throw new ApiError(422, "prepayment_after_loan_end");
  }
  return c.json(await detail(c, ctx, id), 201);
});

loanRoutes.delete("/:id/prepayments/:ppId", async (c) => {
  const id = c.req.param("id");
  const ctx = await accessFor(c.env.DB, c.get("userId"), id, "edit");
  const res = await c.env.DB.prepare("DELETE FROM prepayments WHERE id = ? AND loan_id = ? AND user_id = ?").bind(c.req.param("ppId"), id, ctx.ownerId).run();
  if (!res.meta.changes) throw notFound("prepayment_not_found");
  await regenerateFromRow(c.env.DB, ctx.ownerId, ctx.loan);
  return c.json(await detail(c, ctx, id));
});

loanRoutes.delete("/:id/rate-changes/:rcId", async (c) => {
  const id = c.req.param("id");
  const ctx = await accessFor(c.env.DB, c.get("userId"), id, "edit");
  const res = await c.env.DB.prepare("DELETE FROM rate_changes WHERE id = ? AND loan_id = ? AND user_id = ?").bind(c.req.param("rcId"), id, ctx.ownerId).run();
  if (!res.meta.changes) throw notFound("rate_change_not_found");
  await regenerateFromRow(c.env.DB, ctx.ownerId, ctx.loan);
  return c.json(await detail(c, ctx, id));
});

// ---- Sharing (owner only) ----------------------------------------------------------------------

loanRoutes.get("/:id/shares", async (c) => {
  const id = c.req.param("id");
  const ctx = await accessFor(c.env.DB, c.get("userId"), id, "owner");
  return c.json((await detail(c, ctx, id)).shares);
});

loanRoutes.post("/:id/shares", rateLimit("share", 20), async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const ctx = await accessFor(c.env.DB, userId, id, "owner");
  const { email, access } = shareInputSchema.parse(await c.req.json());
  const owner = await c.env.DB.prepare("SELECT email, name FROM users WHERE id = ?").bind(userId).first<{ email: string; name: string }>();
  if (owner && owner.email.toLowerCase() === email) throw new ApiError(422, "cannot_share_with_self");
  // Link immediately if someone already signed in with that email; otherwise on their first sign-in.
  const existingUser = await c.env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?").bind(email).first<{ id: string }>();
  const prior = await c.env.DB.prepare("SELECT id FROM loan_shares WHERE loan_id = ? AND email = ?").bind(id, email).first<{ id: string }>();
  if (!prior) {
    // Invites send email to addresses the owner chooses: cap new invites per owner per day.
    const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM loan_shares WHERE owner_id = ? AND created_at >= ?")
      .bind(ctx.ownerId, new Date(Date.now() - 86_400_000).toISOString())
      .first<{ n: number }>();
    if (Number(recent?.n ?? 0) >= INVITES_PER_DAY) throw new ApiError(429, "invite_limit");
  }
  const shareId = prior?.id ?? newId();
  await c.env.DB.prepare(
    `INSERT INTO loan_shares (id, loan_id, owner_id, email, user_id, access, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(loan_id, email) DO UPDATE SET access = excluded.access`,
  )
    .bind(shareId, id, ctx.ownerId, email, existingUser?.id ?? null, access, existingUser ? new Date().toISOString() : null)
    .run();
  if (!prior) {
    const nickname = String(ctx.loan.nickname);
    const invite = shareInviteEmail({ to: email, ownerName: owner?.name || owner?.email || "", loanNickname: nickname, access, appUrl: c.env.APP_ORIGIN, locale: "en" });
    c.executionCtx.waitUntil(
      (async () => {
        // Respect the daily Resend budget; the share still works without the email.
        if ((await emailsSentToday(c.env.DB)) >= Number(c.env.EMAIL_DAILY_CAP ?? 95)) return { ok: false, error: "daily_email_cap" };
        return sendEmail(c.env, invite);
      })().then(async (r) => {
        // Logged so it counts toward the daily email cap; failures are visible in logs.
        await c.env.DB.prepare(
          `INSERT INTO notifications (id, user_id, channel, kind, dedupe_key, loan_id, title, body, status, error, send_id)
           VALUES (?, ?, 'email', 'share_invite', ?, ?, ?, '', ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
        )
          .bind(newId(), ctx.ownerId, `email:share:${shareId}`, id, invite.subject, r.ok ? "sent" : "failed", r.error ?? null, newId())
          .run();
        if (!r.ok && r.error !== "email_not_configured") console.error("share invite email failed", r.error);
      }),
    );
  }
  return c.json((await detail(c, ctx, id)).shares, prior ? 200 : 201);
});

loanRoutes.patch("/:id/shares/:shareId", async (c) => {
  const id = c.req.param("id");
  const ctx = await accessFor(c.env.DB, c.get("userId"), id, "owner");
  const { access } = shareAccessSchema.parse(await c.req.json());
  const res = await c.env.DB.prepare("UPDATE loan_shares SET access = ? WHERE id = ? AND loan_id = ? AND owner_id = ?")
    .bind(access, c.req.param("shareId"), id, ctx.ownerId)
    .run();
  if (!res.meta.changes) throw notFound("share_not_found");
  return c.json((await detail(c, ctx, id)).shares);
});

loanRoutes.delete("/:id/shares/:shareId", async (c) => {
  const id = c.req.param("id");
  const ctx = await accessFor(c.env.DB, c.get("userId"), id, "owner");
  const res = await c.env.DB.prepare("DELETE FROM loan_shares WHERE id = ? AND loan_id = ? AND owner_id = ?").bind(c.req.param("shareId"), id, ctx.ownerId).run();
  if (!res.meta.changes) throw notFound("share_not_found");
  return c.json((await detail(c, ctx, id)).shares);
});

// ---- Instalments --------------------------------------------------------------------------

/** Calendar / list view: the user's own loans only. */
instalmentRoutes.get("/", async (c) => {
  const q = z.object({ from: isoDate, to: isoDate }).parse({ from: c.req.query("from"), to: c.req.query("to") });
  if (q.from > q.to) throw new ApiError(400, "bad_range");
  return c.json(await listInstalmentsInRange(c.env.DB, c.get("userId"), q.from, q.to));
});

/** Find an instalment and require at least `min` access to its loan (404 if none at all). */
async function instalmentWithAccess(c: Context<AppEnv>, id: string) {
  const inst = await c.env.DB.prepare("SELECT id, loan_id, user_id FROM instalments WHERE id = ?").bind(id).first<Row>();
  if (!inst) throw notFound("instalment_not_found");
  const ctx = await accessFor(c.env.DB, c.get("userId"), String(inst.loan_id), "edit");
  if (String(inst.user_id) !== ctx.ownerId) throw notFound("instalment_not_found");
  return { inst, ctx };
}

instalmentRoutes.post("/:id/payment", async (c) => {
  const { inst, ctx } = await instalmentWithAccess(c, c.req.param("id"));
  const p = paymentInputSchema.parse(await c.req.json());
  if (!isValidISODate(p.paidDate)) throw new ApiError(400, "invalid_date");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO payments (id, user_id, loan_id, instalment_id, paid_date, amount_paid, late_fee, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instalment_id) DO UPDATE SET paid_date = excluded.paid_date, amount_paid = excluded.amount_paid,
         late_fee = excluded.late_fee, note = excluded.note`,
    ).bind(newId(), ctx.ownerId, String(inst.loan_id), String(inst.id), p.paidDate, p.amountPaid, p.lateFee, p.note ?? null),
    c.env.DB.prepare("UPDATE instalments SET skipped = 0 WHERE id = ? AND user_id = ?").bind(String(inst.id), ctx.ownerId),
  ]);
  return c.json(await detail(c, ctx, String(inst.loan_id)));
});

instalmentRoutes.delete("/:id/payment", async (c) => {
  const { inst, ctx } = await instalmentWithAccess(c, c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM payments WHERE instalment_id = ? AND user_id = ?").bind(String(inst.id), ctx.ownerId).run();
  return c.json(await detail(c, ctx, String(inst.loan_id)));
});

instalmentRoutes.patch("/:id", async (c) => {
  const { inst, ctx } = await instalmentWithAccess(c, c.req.param("id"));
  const { skipped } = instalmentStatusPatchSchema.parse(await c.req.json());
  await c.env.DB.prepare("UPDATE instalments SET skipped = ? WHERE id = ? AND user_id = ?").bind(skipped ? 1 : 0, String(inst.id), ctx.ownerId).run();
  return c.json(await detail(c, ctx, String(inst.loan_id)));
});

// ---- Dashboard ----------------------------------------------------------------------------

/** Own loans only (shared loans are listed separately and never mixed into your totals). */
dashboardRoutes.get("/", async (c) => c.json(await getDashboard(c.env.DB, c.get("userId"))));
