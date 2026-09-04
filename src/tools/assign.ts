import type { Env } from "../env";
import { ingestEvent } from "../consumer";
import { eventsFromDelivery } from "../webhook";
import { type GhIssueListItem, issueDelivery, nextLink } from "./backfill";
import { type Summarizer, type IssueSummary, geminiIssueSummarizer, storeIssueSummary } from "./summarize";
import { applyEventProgress } from "./progress";
import { list_people } from "./reads";
import { all } from "../db";
import type { PersonRow } from "@shared/rows";

// Human-triggered task assignment: the ONE place Canopy writes OUT to GitHub.
//
// Everything else in this codebase reads GitHub (webhook deliveries, the admin
// backfill, the scheduled progress recompute) — this module is the single
// outbound seam, and it exists because My Work's To-do list is a pure projection
// of "open issues assigned to you". There is no Canopy-local task store to write
// to: to put work on someone's To-do you must put it on the GitHub issue, which
// is the actual source of truth the whole projection is built from.
//
// The write is GitHub-first, then captured locally through the SAME pipeline a
// webhook delivery takes — issueDelivery() → the PURE eventsFromDelivery()
// derivation → the ingestEvent gate fn — so the assignment appears on My Work
// immediately instead of waiting for the webhook round-trip. Provenance is
// "canopy" (distinct from "webhook"/"backfill") and the writer is the
// authenticated principal who clicked Assign, never a fixed string.
//
// The webhook WILL also deliver this same assignment moments later. That is
// harmless and deliberate: the delivery derives an identical semantic_key
// (gh:issue:N:assigned:<login>:<updated_at>) and the UNIQUE-key INSERT OR IGNORE
// drops it as `unchanged`. No double-write, no reconciliation needed.

const GH_API = "application/vnd.github+json";
const USER_AGENT = "canopy";

export type Priority = "P0" | "P1" | "P2" | "P3";
const PRIORITIES: readonly string[] = ["P0", "P1", "P2", "P3"];

export function isPriority(v: unknown): v is Priority {
  return typeof v === "string" && PRIORITIES.includes(v);
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  assignee: string;
  priority?: Priority | null;
  labels?: string[];
}

export interface AssignResult {
  ok: boolean;
  error?: string;
  /** The issue number written to / assigned. Present on success. */
  number?: number;
  url?: string;
  /** Whether the local capture wrote a NEW event (false = already captured). */
  captured?: boolean;
  /** The login the issue is now assigned to, read back from GitHub's response. */
  assignee?: string;
}

interface AssignOpts {
  fetchImpl?: typeof fetch;
  issueSummarizer?: Summarizer<IssueSummary> | null;
}

function failed(error: string): AssignResult {
  return { ok: false, error };
}

function ghHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: GH_API,
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
  };
}

/** `[P1] Fix the thing` — the exact shape mywork.ts's priorityOf() parses back
 *  out (and strips from the displayed title). Priority is carried ON the GitHub
 *  title because GitHub has no priority field and the title is what round-trips
 *  through the webhook; a Canopy-only column would be lost on the next capture. */
function titleWithPriority(title: string, priority: Priority | null | undefined): string {
  return priority ? `[${priority}] ${title}` : title;
}

/**
 * Capture a just-written GitHub issue locally, exactly as a webhook delivery of
 * the same assignment would be captured: reuse the pure derivation, ingest
 * through the gate, then mirror the webhook's two downstream seams (milestone
 * progress, issue summary). `assigneeLogin` pins the delivery's assignee to the
 * person we just assigned — NOT assignees[0], which on a multi-assignee issue
 * would key the event to the wrong person and file it on their To-do instead.
 */
async function captureAssignment(
  env: Env,
  principalLogin: string,
  issue: GhIssueListItem,
  assigneeLogin: string,
  opts?: AssignOpts
): Promise<boolean> {
  const payload = issueDelivery(issue, assigneeLogin);
  let captured = false;
  for (const base of eventsFromDelivery("issues", payload)) {
    const res = await ingestEvent(env.DB, { ...base, provenance: "canopy" as const }, principalLogin);
    if (res.outcome === "written") {
      captured = true;
      await applyEventProgress(env.DB, payload);
    }
  }

  // Summarize now so the To-do card lands with a Summary + Next step rather
  // than a bare title that only fills in on the next Sync. A failed AI call
  // falls back to the deterministic excerpt inside storeIssueSummary; a failure
  // here must never fail the assignment itself — the GitHub write already
  // succeeded and the event is already captured.
  const summarizer =
    opts?.issueSummarizer !== undefined
      ? opts.issueSummarizer
      : env.GEMINI_API_KEY
        ? geminiIssueSummarizer(env.GEMINI_API_KEY)
        : null;
  try {
    await storeIssueSummary(env.DB, summarizer, {
      issue_number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
    });
  } catch {
    /* summary is a nicety; the assignment stands without it */
  }
  return captured;
}

/**
 * GitHub silently drops assignees that lack push access on the repo — the issue
 * is still created, just unassigned, which would read to the assigner as "I gave
 * them the task" while it never reaches anyone's To-do. Read the assignment back
 * off GitHub's own response rather than trusting the request.
 */
function assigneeLanded(issue: GhIssueListItem, login: string): boolean {
  const wanted = login.toLowerCase();
  return (issue.assignees ?? []).some((a) => a.login.toLowerCase() === wanted);
}

/**
 * Create a NEW GitHub issue already assigned to someone, then capture it so it
 * appears on their My Work To-do immediately. The assigner is the authenticated
 * principal (recorded as the event's writer); the assignee is the event subject.
 */
export async function createTask(
  env: Env,
  principalLogin: string,
  input: CreateTaskInput,
  opts?: AssignOpts
): Promise<AssignResult> {
  const token = env.GITHUB_SERVICE_TOKEN;
  const repo = env.GITHUB_REPO;
  if (!token || !repo) return failed("service token or repo not configured");

  const title = input.title.trim();
  const assignee = input.assignee.trim();
  if (!title) return failed("title required");
  if (!assignee) return failed("assignee required");
  if (input.priority != null && !isPriority(input.priority)) return failed("invalid priority");

  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({
      title: titleWithPriority(title, input.priority),
      body: input.body?.trim() ? input.body.trim() : "",
      assignees: [assignee],
      ...(input.labels?.length ? { labels: input.labels } : {}),
    }),
  });
  if (!res.ok) {
    // 403/404 here is almost always an under-scoped GITHUB_SERVICE_TOKEN
    // (issues:write on GITHUB_REPO); 422 is a rejected field (bad label).
    return failed(`GitHub ${res.status} creating the issue (check GITHUB_SERVICE_TOKEN has issues:write on ${repo})`);
  }
  const issue = (await res.json()) as GhIssueListItem;
  if (!assigneeLanded(issue, assignee)) {
    return failed(`Issue #${issue.number} was created, but GitHub did not assign ${assignee} — they may not have access to ${repo}`);
  }

  const captured = await captureAssignment(env, principalLogin, issue, assignee, opts);
  return { ok: true, number: issue.number, url: issue.html_url, captured, assignee };
}

/**
 * Assign an EXISTING open issue to someone (additive — GitHub's add-assignees
 * endpoint does not displace existing assignees), then capture it the same way.
 */
export async function assignTask(
  env: Env,
  principalLogin: string,
  issueNumber: number,
  assigneeInput: string,
  opts?: AssignOpts
): Promise<AssignResult> {
  const token = env.GITHUB_SERVICE_TOKEN;
  const repo = env.GITHUB_REPO;
  if (!token || !repo) return failed("service token or repo not configured");

  const assignee = assigneeInput.trim();
  if (!assignee) return failed("assignee required");
  if (!Number.isInteger(issueNumber) || issueNumber < 1) return failed("invalid issue number");

  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/assignees`, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({ assignees: [assignee] }),
  });
  if (!res.ok) {
    return failed(`GitHub ${res.status} assigning issue #${issueNumber} (check GITHUB_SERVICE_TOKEN has issues:write on ${repo})`);
  }
  const issue = (await res.json()) as GhIssueListItem;
  if (issue.pull_request) return failed(`#${issueNumber} is a pull request, not an issue`);
  if (!assigneeLanded(issue, assignee)) {
    return failed(`GitHub did not assign ${assignee} to #${issueNumber} — they may not have access to ${repo}`);
  }

  const captured = await captureAssignment(env, principalLogin, issue, assignee, opts);
  return { ok: true, number: issue.number, url: issue.html_url, captured, assignee };
}


// ── who can be assigned ──────────────────────────────────────────────────────
// The assignee picker's roster. This asks GITHUB, not Canopy: `people` is an
// identity map for ATTRIBUTING past events to a display name, and using it as a
// roster was wrong in both directions — it listed people who left (and whom
// GitHub would refuse to assign) while omitting people who joined. GitHub's
// /assignees endpoint answers the actual question, "who can be assigned on this
// repo", and stays right on its own as the team changes.
//
// `people` still supplies the DISPLAY NAME for a login it knows, so the chips
// read "Jose" rather than "Jose-Gael-Cruz-Lopez"; an unmapped login shows as
// itself. On any GitHub failure the caller falls back to the identity map — a
// stale roster beats a form you cannot use.

export interface Assignee {
  login: string;
  person: string;
}

export interface AssigneeList {
  ok: boolean;
  error?: string;
  assignees: Assignee[];
}

export async function listAssignees(
  env: Env,
  opts?: { fetchImpl?: typeof fetch }
): Promise<AssigneeList> {
  const token = env.GITHUB_SERVICE_TOKEN;
  const repo = env.GITHUB_REPO;
  if (!token || !repo) return { ok: false, error: "service token or repo not configured", assignees: [] };

  const doFetch = opts?.fetchImpl ?? fetch;
  const logins: string[] = [];
  let url: string | null = `https://api.github.com/repos/${repo}/assignees?per_page=100`;
  while (url) {
    const res: Response = await doFetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: GH_API,
        "user-agent": USER_AGENT,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) return { ok: false, error: `GitHub ${res.status} listing assignees for ${repo}`, assignees: [] };
    const page = (await res.json()) as { login?: string }[];
    for (const u of page) if (u.login) logins.push(u.login);
    url = nextLink(res);
  }

  // Display names off the identity map, matched case-insensitively (GitHub
  // logins are case-preserving but not case-sensitive, and the map was written
  // by hand). A login with no mapping shows as the login itself.
  const people = await all<PersonRow>(env.DB, `SELECT login, person FROM people`);
  const byLogin = new Map(people.map((p) => [p.login.toLowerCase(), p.person]));
  const assignees = logins.map((login) => ({ login, person: byLogin.get(login.toLowerCase()) ?? login }));
  assignees.sort((a, b) => a.person.localeCompare(b.person));
  return { ok: true, assignees };
}

/** The roster with the identity map as a fallback, so a GitHub outage degrades
 *  the picker instead of breaking the form. Never throws. */
export async function assigneeRoster(
  env: Env,
  opts?: { fetchImpl?: typeof fetch }
): Promise<{ assignees: Assignee[]; degraded: boolean; error?: string }> {
  let res: AssigneeList;
  try {
    res = await listAssignees(env, opts);
  } catch (e) {
    res = { ok: false, error: e instanceof Error ? e.message : String(e), assignees: [] };
  }
  if (res.ok) return { assignees: res.assignees, degraded: false };
  try {
    const people = await list_people(env.DB);
    return { assignees: people, degraded: true, error: res.error };
  } catch {
    return { assignees: [], degraded: true, error: res.error };
  }
}
