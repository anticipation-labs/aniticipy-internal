export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_SECRET: string;
  GITHUB_WEBHOOK_SECRET?: string; // HMAC key for the /webhook/github third auth class; absent → the surface 401s
  GITHUB_ORG?: string;    // GitHub org whose active members may sign in; absent → DEFAULT_ORG in auth/github.ts
  GITHUB_REPO?: string;   // "owner/repo" for live roadmap progress; absent → milestones without progress
  DEV_LOGIN?: string;     // LOCAL DEV ONLY (set in .dev.vars): bypass OAuth, act as this seeded user. Never set in prod.
  GEMINI_API_KEY?: string; // Google Gemini key for capture-time PR/issue summaries (REST generateContent); absent → excerpt fallback.
  GITHUB_SERVICE_TOKEN?: string; // app-level token for the scheduled progress-cache recompute backstop; absent → scheduled() no-ops
  ADMIN_LOGINS?: string;  // comma-separated GitHub logins allowed to run admin actions (e.g. the server-side backfill)
}
