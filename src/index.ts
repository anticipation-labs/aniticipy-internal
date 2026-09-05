import { app } from "./routes";
import { handleMcp } from "./mcp";
import { handleGithubWebhook } from "./webhook";
import { resolveBearerPrincipal } from "./auth/principal";
import { recomputeAllProgress } from "./tools/progress";
import type { Env } from "./env";
import { CANOPY_BASE_PATH, basePathFor, routeRequest } from "./base-path";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const incomingUrl = new URL(request.url);
    const basePath = basePathFor(incomingUrl.pathname);

    // A trailing slash makes the Vite build's relative asset URLs resolve below
    // /internal instead of at the anticipy.ai origin root.
    if (basePath && incomingUrl.pathname === CANOPY_BASE_PATH) {
      incomingUrl.pathname = `${CANOPY_BASE_PATH}/`;
      return Response.redirect(incomingUrl.toString(), 308);
    }

    const appRequest = routeRequest(request, basePath);
    const url = new URL(appRequest.url);

    // Requests under /internal do not match the root-level asset manifest, so
    // the Worker strips the prefix and asks the assets binding explicitly.
    if (basePath && (appRequest.method === "GET" || appRequest.method === "HEAD")) {
      const asset = await env.ASSETS.fetch(appRequest);
      if (asset.status !== 404) return asset;
    }

    // Static assets are served by the assets binding before this handler runs.
    if (url.pathname === "/mcp") {
      // Bearer ONLY. On missing/invalid credentials: bare 401, NO WWW-Authenticate,
      // NO OAuth discovery/metadata — Claude Code must use the configured header.
      const principal = await resolveBearerPrincipal(appRequest, env);
      if (!principal) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return handleMcp(appRequest, env, ctx, principal);
    }
    // Third auth class: GitHub webhook deliveries, HMAC-verified over the raw
    // body against GITHUB_WEBHOOK_SECRET. Never touches sessionGate.
    if (url.pathname === "/webhook/github" && request.method === "POST") {
      return handleGithubWebhook(appRequest, env);
    }
    return app.fetch(appRequest, env, ctx);
  },

  // Backstop: recompute per-milestone progress from GitHub on a schedule with the
  // app-level service token — a computed direct writer (promote class), never on
  // the render path.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.GITHUB_SERVICE_TOKEN || !env.GITHUB_REPO) return;
    await recomputeAllProgress(env.DB, { token: env.GITHUB_SERVICE_TOKEN, repo: env.GITHUB_REPO });
  },
} satisfies ExportedHandler<Env>;
