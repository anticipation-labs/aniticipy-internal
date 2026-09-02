/**
 * Node entry point for Canopy on Railway.
 *
 * The Workers handler in `src/index.ts` is imported and called directly rather
 * than reimplemented, so routing, auth and the MCP surface stay defined in
 * exactly one place. This file supplies the three things the Workers runtime
 * would otherwise provide:
 *
 *   1. `env`      — bindings, read from the process environment, with `DB`
 *                   backed by the SQLite adapter in ./d1.
 *   2. static     — Cloudflare's [assets] binding serves matched files *before*
 *                   the worker runs, so we try the built web app first and fall
 *                   through to the handler, preserving that order.
 *   3. `scheduled`— the [triggers] cron, run here on a timer.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index";
import { openDatabase } from "./d1";
import { applyMigrations } from "./migrate";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8080);

/**
 * Railway mounts a persistent volume here. Without one the container's disk is
 * replaced on every deploy, so the database must live on the mount, not beside
 * the code.
 */
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH ?? join(DATA_DIR, "canopy.db");

const { db, d1 } = openDatabase(DB_PATH);
const { applied, skipped } = applyMigrations(db, join(ROOT, "migrations"));
console.log(`[canopy] db=${DB_PATH} migrations applied=${applied.length} already-present=${skipped}`);

/**
 * The bindings object. `DB` is the adapter; the cast is the one place where the
 * Workers type and the Node implementation meet, and it is honest — the adapter
 * implements the D1 surface `src/` uses, not the whole D1 interface.
 *
 * ASSETS is declared on Env but never called in `src/` (static files are served
 * by the platform), so it is deliberately absent here.
 */
const env = {
  DB: d1,
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? "",
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? "",
  COOKIE_SECRET: process.env.COOKIE_SECRET ?? "",
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  GITHUB_REPO: process.env.GITHUB_REPO,
  DEV_LOGIN: process.env.DEV_LOGIN,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GITHUB_SERVICE_TOKEN: process.env.GITHUB_SERVICE_TOKEN,
  ADMIN_LOGINS: process.env.ADMIN_LOGINS,
} as unknown as Parameters<typeof worker.fetch>[1];

/** Workers hand the handler an ExecutionContext; only waitUntil is meaningful here. */
const ctx = {
  waitUntil(promise: Promise<unknown>): void {
    void Promise.resolve(promise).catch((err) => console.error("[canopy] waitUntil rejected:", err));
  },
  passThroughOnException(): void {},
  props: {},
} as unknown as Parameters<typeof worker.fetch>[2];

const server = new Hono();

// Liveness. Deliberately above the static layer and outside the worker so it
// answers even if the app's own routes are unhappy.
server.get("/healthz", (c) =>
  c.json({
    ok: true,
    db: DB_PATH,
    // `applied` counts only this boot, which is 0 on every restart after the
    // first. Reporting the total as well keeps a healthy service from looking
    // like one with no schema.
    migrations: { total: applied.length + skipped, appliedThisBoot: applied.length },
  }),
);

// 1. Static assets, mirroring the [assets] binding's precedence.
server.use("/*", serveStatic({ root: "./web/dist" }));

// 2. Anything unmatched is the worker's, exactly as on Cloudflare.
server.all("/*", (c) => worker.fetch(c.req.raw, env, ctx));

/**
 * The [triggers] cron fires every six hours. A plain interval is
 * the honest equivalent for a single always-on container: it does not align to
 * the clock, and it does not fire while the container is down.
 */
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const cron = setInterval(() => {
  void worker
    .scheduled?.(
      { scheduledTime: Date.now(), cron: "0 */6 * * *", noRetry() {} } as never,
      env,
      ctx,
    )
    .catch((err: unknown) => console.error("[canopy] scheduled run failed:", err));
}, SIX_HOURS_MS);
cron.unref();

const listener = serve({ fetch: server.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`[canopy] listening on http://0.0.0.0:${info.port}`);
});

/** Railway sends SIGTERM on redeploy; close the database so WAL is checkpointed. */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[canopy] ${signal} received, shutting down`);
    clearInterval(cron);
    listener.close(() => {
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
  });
}
