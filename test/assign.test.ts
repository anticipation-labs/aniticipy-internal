import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import { createTask, assignTask, listAssignees, assigneeRoster } from "../src/tools/assign";
import { getMyWork } from "../src/tools/mywork";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import type { Env } from "../src/env";
import type { Summarizer, IssueSummary } from "../src/tools/summarize";
import type { EventRow, IssueSummaryRow } from "@shared/rows";

const NOW = "2026-06-28T00:00:00Z";

function envWith(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), GITHUB_SERVICE_TOKEN: "svc-token", GITHUB_REPO: "o/r", ...overrides };
}

async function cookieFor(login: string): Promise<string> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
  ).bind(login, login, "2026-01-01T00:00:00Z").run();
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

const ISSUE_STUB: IssueSummary = { title: "Humanized", summary: "The AI summary", next_step: "Start here" };
function countingSummarizer(): Summarizer<IssueSummary> & { calls: number } {
  const s: Summarizer<IssueSummary> & { calls: number } = {
    calls: 0,
    model: "test-model",
    async summarize() { s.calls++; return ISSUE_STUB; },
  };
  return s;
}

/** The issue GitHub echoes back from a create/assign call. */
function ghIssue(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: "Fix the thing",
    body: "Some context.",
    html_url: "https://github.com/o/r/issues/42",
    state: "open",
    updated_at: NOW,
    user: { login: "assigner" },
    assignees: [{ login: "jose" }],
    labels: [],
    milestone: null,
    ...over,
  };
}

/** Response-level fetch stub — the pool exports no fetch mock, so never network.
 *  Records the last request so tests can assert what was sent to GitHub. */
function stubFetch(issue: unknown, status = 200) {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(issue), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("createTask", () => {
  it("creates the issue on GitHub, then captures it as an 'assigned' event under the assigner", async () => {
    const { impl, calls } = stubFetch(ghIssue());
    const res = await createTask(envWith(), "assigner", { title: "Fix the thing", assignee: "jose" }, {
      fetchImpl: impl, issueSummarizer: null,
    });

    expect(res.ok).toBe(true);
    expect(res.number).toBe(42);
    expect(res.captured).toBe(true);
    expect(res.assignee).toBe("jose");

    // The GitHub call itself: a POST to the repo's issues collection.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ title: "Fix the thing", assignees: ["jose"] });

    const events = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(events).toHaveLength(1);
    // subject is the ASSIGNEE (whose to-do it lands on); writer is the assigner.
    expect(events[0].subject_login).toBe("jose");
    expect(events[0].recorded_by).toBe("assigner");
    expect(events[0].provenance).toBe("canopy");
    expect(events[0].semantic_key).toBe(`gh:issue:42:assigned:jose:${NOW}`);
  });

  it("prefixes the GitHub title with the priority tag so My Work parses it back out", async () => {
    const { impl, calls } = stubFetch(ghIssue({ title: "[P1] Fix the thing" }));
    await createTask(envWith(), "assigner", { title: "Fix the thing", assignee: "jose", priority: "P1" }, {
      fetchImpl: impl, issueSummarizer: null,
    });
    expect(calls[0].body).toMatchObject({ title: "[P1] Fix the thing" });

    await env.DB.prepare(`INSERT OR REPLACE INTO people (login, person) VALUES (?, ?)`).bind("jose", "Jose").run();
    const work = await getMyWork(env.DB, "jose");
    expect(work.todo).toHaveLength(1);
    expect(work.todo[0].priority).toBe("P1");
    expect(work.todo[0].title).toBe("Fix the thing"); // tag stripped from the display
  });

  it("summarizes the new task at capture time, so the to-do card is not a bare title", async () => {
    const { impl } = stubFetch(ghIssue());
    const summarizer = countingSummarizer();
    await createTask(envWith(), "assigner", { title: "Fix the thing", assignee: "jose" }, {
      fetchImpl: impl, issueSummarizer: summarizer,
    });
    expect(summarizer.calls).toBe(1);
    const row = await first<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = 42`);
    expect(row?.summary).toBe("The AI summary");
    expect(row?.next_step).toBe("Start here");
  });

  it("lands on the assignee's My Work to-do immediately — no webhook round-trip", async () => {
    await env.DB.prepare(`INSERT OR REPLACE INTO people (login, person) VALUES (?, ?)`).bind("jose", "Jose").run();
    const { impl } = stubFetch(ghIssue());
    await createTask(envWith(), "assigner", { title: "Fix the thing", assignee: "jose" }, {
      fetchImpl: impl, issueSummarizer: countingSummarizer(),
    });

    const work = await getMyWork(env.DB, "jose");
    expect(work.todo).toHaveLength(1);
    expect(work.todo[0].number).toBe(42);
    expect(work.todo[0].summary).toBe("The AI summary");
    // and NOT on the assigner's — the event subject is the assignee
    await env.DB.prepare(`INSERT OR REPLACE INTO people (login, person) VALUES (?, ?)`).bind("assigner", "Assigner").run();
    expect((await getMyWork(env.DB, "assigner")).todo).toHaveLength(0);
  });

  it("fails loudly when GitHub silently drops the assignee (no repo access)", async () => {
    // GitHub creates the issue but returns it UNASSIGNED when the assignee lacks
    // push access. Reporting ok here would tell the assigner they handed off work
    // that never reaches anyone's to-do.
    const { impl } = stubFetch(ghIssue({ assignees: [] }));
    const res = await createTask(envWith(), "assigner", { title: "Fix the thing", assignee: "ghost" }, {
      fetchImpl: impl, issueSummarizer: null,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("did not assign ghost");
    expect(await all<EventRow>(env.DB, `SELECT * FROM events`)).toHaveLength(0);
  });

  it("fails without writing anything when GitHub rejects the call", async () => {
    const { impl } = stubFetch({ message: "Not Found" }, 404);
    const res = await createTask(envWith(), "assigner", { title: "x", assignee: "jose" }, {
      fetchImpl: impl, issueSummarizer: null,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("GitHub 404");
    expect(await all<EventRow>(env.DB, `SELECT * FROM events`)).toHaveLength(0);
  });

  it("refuses to call GitHub at all when the service token is unset", async () => {
    const { impl, calls } = stubFetch(ghIssue());
    const res = await createTask(envWith({ GITHUB_SERVICE_TOKEN: undefined }), "assigner",
      { title: "x", assignee: "jose" }, { fetchImpl: impl, issueSummarizer: null });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("service token or repo not configured");
    expect(calls).toHaveLength(0);
  });
});

describe("assignTask (existing issue)", () => {
  it("posts to the add-assignees endpoint and captures the assignment", async () => {
    const { impl, calls } = stubFetch(ghIssue());
    const res = await assignTask(envWith(), "assigner", 42, "jose", { fetchImpl: impl, issueSummarizer: null });

    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/42/assignees");
    expect(calls[0].body).toEqual({ assignees: ["jose"] });
    expect(await all<EventRow>(env.DB, `SELECT * FROM events`)).toHaveLength(1);
  });

  it("keys the event to the person just assigned, not assignees[0]", async () => {
    // A multi-assignee issue: without pinning, the delivery would be derived from
    // assignees[0] (alice) and the task would land on HER to-do, not jose's.
    const { impl } = stubFetch(ghIssue({ assignees: [{ login: "alice" }, { login: "jose" }] }));
    await assignTask(envWith(), "assigner", 42, "jose", { fetchImpl: impl, issueSummarizer: null });

    const events = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(events[0].subject_login).toBe("jose");
    expect(events[0].semantic_key).toBe(`gh:issue:42:assigned:jose:${NOW}`);
  });

  it("is idempotent — re-assigning the same snapshot writes no second event", async () => {
    const first = stubFetch(ghIssue());
    const a = await assignTask(envWith(), "assigner", 42, "jose", { fetchImpl: first.impl, issueSummarizer: null });
    expect(a.captured).toBe(true);

    // The same GitHub snapshot again (the shape a webhook redelivery would take):
    // the semantic key is identical, so INSERT OR IGNORE drops it.
    const second = stubFetch(ghIssue());
    const b = await assignTask(envWith(), "assigner", 42, "jose", { fetchImpl: second.impl, issueSummarizer: null });
    expect(b.ok).toBe(true);
    expect(b.captured).toBe(false);
    expect(await all<EventRow>(env.DB, `SELECT * FROM events`)).toHaveLength(1);
  });

  it("rejects a number that turns out to be a pull request", async () => {
    const { impl } = stubFetch(ghIssue({ pull_request: { url: "https://api.github.com/repos/o/r/pulls/42" } }));
    const res = await assignTask(envWith(), "assigner", 42, "jose", { fetchImpl: impl, issueSummarizer: null });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("pull request");
  });
});

describe("POST /tasks + /tasks/:number/assign (session-gated)", () => {
  it("401s without a session", async () => {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x", assignee: "jose" }),
    }, env);
    expect(res.status).toBe(401);
  });

  it("is NOT admin-gated — an ordinary member may assign work", async () => {
    // Reaches the tool (which 502s only because GITHUB_SERVICE_TOKEN is unset in
    // tests). A 403 here would mean the route had been admin-gated by mistake.
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookieFor("not-admin") },
      body: JSON.stringify({ title: "Fix the thing", assignee: "jose" }),
    }, env);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "service token or repo not configured" });
  });

  it("400s on a missing title, a missing assignee, or a bad priority", async () => {
    const cookie = await cookieFor("member");
    const post = (body: unknown) => app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }, env);

    expect((await post({ assignee: "jose" })).status).toBe(400);
    expect((await post({ title: "x" })).status).toBe(400);
    expect((await post({ title: "  ", assignee: "jose" })).status).toBe(400);
    const bad = await post({ title: "x", assignee: "jose", priority: "P9" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "priority must be one of P0, P1, P2, P3" });
  });

  it("400s on a non-numeric issue number for the assign-existing route", async () => {
    const res = await app.request("/tasks/abc/assign", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookieFor("member") },
      body: JSON.stringify({ assignee: "jose" }),
    }, env);
    expect(res.status).toBe(400);
  });
});

describe("assignee roster — sourced from GitHub, not the identity map", () => {
  // A repo whose assignable users are NOT the identity map: "gone" is mapped but
  // has left (GitHub would refuse to assign them), "newbie" has joined but was
  // never mapped. Using `people` as the roster got BOTH of these wrong.
  function stubAssignees(logins: string[], status = 200) {
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify(logins.map((login) => ({ login }))), {
        status, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("lists who GitHub says can be assigned, not who is in `people`", async () => {
    await env.DB.prepare(`INSERT OR REPLACE INTO people (login, person) VALUES (?, ?)`).bind("gone", "Departed Dan").run();
    const { impl, calls } = stubAssignees(["jose", "newbie"]);
    const res = await listAssignees(envWith(), { fetchImpl: impl });

    expect(res.ok).toBe(true);
    expect(calls[0]).toBe("https://api.github.com/repos/o/r/assignees?per_page=100");
    expect(res.assignees.map((a) => a.login).sort()).toEqual(["jose", "newbie"]);
    // the mapped-but-departed person is NOT offered
    expect(res.assignees.some((a) => a.login === "gone")).toBe(false);
  });

  it("fills display names from the identity map and falls back to the login", async () => {
    await env.DB.prepare(`INSERT OR REPLACE INTO people (login, person) VALUES (?, ?)`).bind("jose", "Jose").run();
    const { impl } = stubAssignees(["jose", "newbie"]);
    const res = await listAssignees(envWith(), { fetchImpl: impl });
    expect(res.assignees).toEqual([
      { login: "jose", person: "Jose" },      // mapped → display name
      { login: "newbie", person: "newbie" },  // unmapped → the login itself
    ]);
  });

  it("matches the identity map case-insensitively", async () => {
    await env.DB.prepare(`INSERT OR REPLACE INTO people (login, person) VALUES (?, ?)`).bind("Jose-Gael-Cruz-Lopez", "Jose").run();
    const { impl } = stubAssignees(["jose-gael-cruz-lopez"]);
    const res = await listAssignees(envWith(), { fetchImpl: impl });
    expect(res.assignees[0].person).toBe("Jose");
  });

  it("reports failure rather than an empty roster when GitHub rejects the call", async () => {
    const { impl } = stubAssignees([], 403);
    const res = await listAssignees(envWith(), { fetchImpl: impl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("GitHub 403");
  });

  it("assigneeRoster degrades to the identity map instead of breaking the form", async () => {
    const { impl } = stubAssignees([], 500);
    const res = await assigneeRoster(envWith(), { fetchImpl: impl });
    expect(res.degraded).toBe(true);
    expect(res.error).toContain("GitHub 500");
    // the seeded identity map stands in, so the picker still shows chips
    expect(res.assignees.length).toBeGreaterThan(0);
  });

  it("degrades the same way when the service token is unset", async () => {
    const res = await assigneeRoster(envWith({ GITHUB_SERVICE_TOKEN: undefined }));
    expect(res.degraded).toBe(true);
    expect(res.error).toBe("service token or repo not configured");
  });
});

describe("GET /assignees", () => {
  it("401s without a session", async () => {
    expect((await app.request("/assignees", {}, env)).status).toBe(401);
  });

  it("returns the degraded identity-map roster when GitHub is unreachable", async () => {
    // GITHUB_SERVICE_TOKEN is never set in tests, so this exercises the fallback
    // through the real route rather than the tool.
    const res = await app.request("/assignees", { headers: { cookie: await cookieFor("member") } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assignees: { login: string; person: string }[]; degraded: boolean };
    expect(body.degraded).toBe(true);
    expect(body.assignees.length).toBeGreaterThan(0);
  });

  it("no longer exposes the raw identity map at /people", async () => {
    // The picker must not read `people` as a roster — the route is gone so a
    // future caller cannot reintroduce the bug by reaching for it.
    const res = await app.request("/people", { headers: { cookie: await cookieFor("member") } }, env);
    expect(res.status).toBe(404);
  });
});
