import { Hono } from "hono";
import { deleteAccountSchema, settingsPatchSchema, type DeletionImpact, type Me, type Settings } from "@emi/shared";
import { clearSession } from "../lib/auth";
import type { AppEnv } from "../env";
import { ApiError, notFound } from "../lib/errors";
import { emailConfigured } from "../services/email";
import { SETTINGS_COLUMNS, settingsFromRow, settingsValue } from "../services/repo";

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.get("/me", async (c) => {
  const userId = c.get("userId");
  const row = await c.env.DB.prepare(
    "SELECT u.id, u.email, u.name, u.picture, s.* FROM users u JOIN settings s ON s.user_id = u.id WHERE u.id = ?",
  )
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!row) throw notFound("user_not_found");
  const me: Me = {
    user: { id: String(row.id), email: String(row.email), name: String(row.name), picture: row.picture ? String(row.picture) : null },
    settings: settingsFromRow(row),
    features: { email: emailConfigured(c.env), push: !!(c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY) },
  };
  return c.json(me);
});

accountRoutes.patch("/settings", async (c) => {
  const userId = c.get("userId");
  const patch = settingsPatchSchema.parse(await c.req.json());
  const keys = Object.keys(patch) as (keyof Settings)[];
  if (keys.length) {
    const sets = keys.map((k) => `${SETTINGS_COLUMNS[k]} = ?`).join(", ");
    await c.env.DB.prepare(`UPDATE settings SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ?`)
      .bind(...keys.map((k) => settingsValue(k, patch[k])), userId)
      .run();
  }
  const row = await c.env.DB.prepare("SELECT * FROM settings WHERE user_id = ?").bind(userId).first<Record<string, unknown>>();
  return c.json(settingsFromRow(row!));
});

/** What deleting the account will do, shown in the confirmation step. */
accountRoutes.get("/account/deletion-impact", async (c) => {
  const userId = c.get("userId");
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM loans WHERE user_id = ?1) AS owned_loans,
       (SELECT COUNT(DISTINCT loan_id) FROM loan_shares WHERE owner_id = ?1) AS owned_shared_loans,
       (SELECT COUNT(DISTINCT email) FROM loan_shares WHERE owner_id = ?1) AS share_recipients,
       (SELECT COUNT(*) FROM loan_shares WHERE user_id = ?1) AS shared_with_me`,
  )
    .bind(userId)
    .first<Record<string, number>>();
  const impact: DeletionImpact = {
    ownedLoans: Number(row?.owned_loans ?? 0),
    ownedSharedLoans: Number(row?.owned_shared_loans ?? 0),
    shareRecipients: Number(row?.share_recipients ?? 0),
    sharedWithMe: Number(row?.shared_with_me ?? 0),
  };
  return c.json(impact);
});

/** Tables holding user data, children first (deletion order). */
const USER_TABLES = ["expenses", "notifications", "push_subscriptions", "documents", "payments", "instalments", "rate_changes", "prepayments", "loans", "cards", "lenders", "settings"] as const;

/** Full data export (JSON). Push endpoints are omitted (device secrets, not user data). */
accountRoutes.get("/account/export", async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;
  const tables = ["settings", "lenders", "cards", "loans", "instalments", "payments", "rate_changes", "documents", "notifications", "expenses", "prepayments"] as const;
  const results = await db.batch([
    db.prepare("SELECT id, email, name, picture, created_at, last_login_at FROM users WHERE id = ?").bind(userId),
    ...tables.map((t) => db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).bind(userId)),
  ]);
  const data: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    format: "emi-tracker-export",
    version: 1,
    note: "Money values are integers in each currency's minor unit; dates are ISO 8601.",
    user: (results[0]!.results as Record<string, unknown>[])[0] ?? null,
  };
  tables.forEach((t, i) => {
    let rows = results[i + 1]!.results as Record<string, unknown>[];
    if (t === "documents") rows = rows.map(({ r2_key: _k, ...rest }) => rest);
    data[t] = rows;
  });
  // Sharing: who you shared your loans with, and which loans are shared with you (ids + access only).
  const [given, received] = await db.batch([
    db.prepare("SELECT id, loan_id, email, access, created_at, accepted_at FROM loan_shares WHERE owner_id = ?").bind(userId),
    db.prepare("SELECT loan_id, access, created_at, accepted_at FROM loan_shares WHERE user_id = ?").bind(userId),
  ]);
  data.sharesGiven = given!.results;
  data.sharesReceived = received!.results;
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="emi-tracker-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
});

/** Permanently delete the account: R2 files, every row, and the session. Requires typing the account email. */
accountRoutes.delete("/account", async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;
  const { confirmEmail } = deleteAccountSchema.parse(await c.req.json());
  const user = await db.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
  if (!user) throw new ApiError(404, "user_not_found");
  if (user.email.toLowerCase() !== confirmEmail.trim().toLowerCase()) throw new ApiError(422, "email_mismatch");

  // Delete R2 files first (by prefix, 1000 per page). If the DB step then fails, a retry
  // finds no files left and simply finishes the row deletion.
  let cursor: string | undefined;
  do {
    const page = await c.env.DOCS.list({ prefix: `u/${userId}/`, cursor, limit: 1000 });
    if (page.objects.length) await c.env.DOCS.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  await db.batch([
    // Sharing: revoke every share on loans this user owns, and remove them from loans
    // shared with them (including pending invites to their email). Others' loans are untouched.
    db.prepare("DELETE FROM loan_shares WHERE owner_id = ?1 OR user_id = ?1 OR email = lower(?2)").bind(userId, user.email),
    ...USER_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId)),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  clearSession(c);
  return c.body(null, 204);
});
