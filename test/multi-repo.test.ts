/**
 * 0020 multi-repo capture. Before this, `semantic_key` named a PR/issue NUMBER
 * with no repo — so two repos' PR 40 collided on a UNIQUE index and the second
 * was dropped by INSERT OR IGNORE as "already seen". Silent data loss, and
 * guaranteed rather than unlikely: two active repos' number ranges overlap.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run, nowIso } from "../src/db";
import { eventsFromDelivery, isCapturedRepo, handleGithubWebhook } from "../src/webhook";
import { ingestEvent } from "../src/consumer";
import { applyEventProgress } from "../src/tools/progress";
import type { Env } from "../src/env";
import type { EventRow } from "@shared/rows";

const A = "anticipation-labs/Anticipy";
const B = "anticipation-labs/aniticipy-internal";

function prClosed(repo: string, number: number) {
  return {
    action: "closed",
    repository: { full_name: repo },
    pull_request: {
      number,
      title: `PR ${number}`,
      body: "b",
      html_url: `https://github.com/${repo}/pull/${number}`,
      merged: true,
      merged_at: "2026-09-01T00:00:00Z",
      closed_at: "2026-09-01T00:00:00Z",
      user: { login: "octocat" },
      base: { ref: "main" },
      milestone: null,
    },
  };
}

describe("repo is part of the dedupe identity", () => {
  it("derives DIFFERENT keys for the same PR number in two repos", () => {
    const [a] = eventsFromDelivery("pull_request", prClosed(A, 40));
    const [b] = eventsFromDelivery("pull_request", prClosed(B, 40));
    expect(a.semantic_key).toBe(`gh:${A}:pr:40:merged`);
    expect(b.semantic_key).toBe(`gh:${B}:pr:40:merged`);
    expect(a.semantic_key).not.toBe(b.semantic_key);
    expect(a.repo).toBe(A);
    expect(b.repo).toBe(B);
  });

  it("captures BOTH — the regression that motivated 0020", async () => {
    const [a] = eventsFromDelivery("pull_request", prClosed(A, 40));
    const [b] = eventsFromDelivery("pull_request", prClosed(B, 40));
    expect((await ingestEvent(env.DB, a, "github-webhook")).outcome).toBe("written");
    // Pre-0020 this second write was dropped as `unchanged` and PR 40 of the
    // other repo simply never appeared in anyone's My Work.
    expect((await ingestEvent(env.DB, b, "github-webhook")).outcome).toBe("written");

    const rows = await all<EventRow>(env.DB, `SELECT * FROM events WHERE ref_number = 40 ORDER BY repo`);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.repo)).toEqual([A, B]);
  });

  it("still dedupes a redelivery WITHIN one repo", async () => {
    const [a] = eventsFromDelivery("pull_request", prClosed(A, 41));
    expect((await ingestEvent(env.DB, a, "github-webhook")).outcome).toBe("written");
    expect((await ingestEvent(env.DB, a, "github-webhook")).outcome).toBe("unchanged");
    expect((await all(env.DB, `SELECT * FROM events WHERE ref_number = 41`)).length).toBe(1);
  });

  it("DROPS a delivery with no repository rather than guessing one", () => {
    // Defaulting here would re-create the collision: an unattributed PR 40 would
    // key onto whichever repo we assumed.
    const { repository, ...noRepo } = prClosed(A, 42);
    expect(eventsFromDelivery("pull_request", noRepo)).toEqual([]);
    expect(eventsFromDelivery("pull_request", { ...noRepo, repository: {} })).toEqual([]);
  });
});

describe("isCapturedRepo — the capture allowlist", () => {
  const withEnv = (o: Partial<Env>): Env => ({ ...(env as unknown as Env), ...o });

  it("allows exactly the repos GITHUB_REPOS names", () => {
    const e = withEnv({ GITHUB_REPOS: `${A}, ${B}` });
    expect(isCapturedRepo(e, A)).toBe(true);
    expect(isCapturedRepo(e, B)).toBe(true);
    expect(isCapturedRepo(e, "someone-else/private-repo")).toBe(false);
  });

  it("falls back to GITHUB_REPO alone when GITHUB_REPOS is unset", () => {
    const e = withEnv({ GITHUB_REPOS: undefined, GITHUB_REPO: A });
    expect(isCapturedRepo(e, A)).toBe(true);
    expect(isCapturedRepo(e, B)).toBe(false);
  });

  it("compares case-insensitively (GitHub logins are case-preserving, not case-sensitive)", () => {
    const e = withEnv({ GITHUB_REPOS: A });
    expect(isCapturedRepo(e, A.toUpperCase())).toBe(true);
  });

  it("captures nothing when neither is configured — fails closed", () => {
    const e = withEnv({ GITHUB_REPOS: undefined, GITHUB_REPO: undefined });
    expect(isCapturedRepo(e, A)).toBe(false);
  });
});

describe("webhook branch honours the allowlist", () => {
  async function deliver(repo: string): Promise<Response> {
    const body = JSON.stringify(prClosed(repo, 77));
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode("test-webhook-secret"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return handleGithubWebhook(
      new Request("https://x/webhook/github", {
        method: "POST",
        headers: { "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${hex}` },
        body,
      }),
      env as unknown as Env,
      { summarizer: null, issueSummarizer: null }
    );
  }

  it("ignores a correctly-signed delivery from a repo outside the allowlist", async () => {
    // A valid HMAC proves the delivery came from GitHub — NOT that it came from
    // a repo we meant to track. Acknowledged (never 4xx, which would make GitHub
    // retry and eventually disable the hook) but captured.
    const res = await deliver("stranger/repo");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true, reason: "repo not in capture allowlist" });
    expect((await all(env.DB, `SELECT * FROM events WHERE ref_number = 77`)).length).toBe(0);
  });

  it("captures a delivery from an allowlisted repo", async () => {
    const res = await deliver("SaplingLearn/canopy"); // bound in vitest.config.ts
    expect(res.status).toBe(200);
    const rows = await all<EventRow>(env.DB, `SELECT * FROM events WHERE ref_number = 77`);
    expect(rows.length).toBe(1);
    expect(rows[0].repo).toBe("SaplingLearn/canopy");
  });
});

describe("milestone progress is confined to the primary repo", () => {
  // `milestones.github_ref` is a BARE milestone number or a bare array of issue
  // numbers, both resolved against GITHUB_REPO. Another captured repo's
  // milestone 3 is not this repo's milestone 3, so letting its events through
  // would overwrite the progress cache with the wrong project's counts.
  const PRIMARY = "SaplingLearn/canopy"; // GITHUB_REPO in vitest.config.ts

  function issueWithMilestone(repo: string) {
    return {
      action: "closed",
      repository: { full_name: repo },
      issue: {
        number: 5, title: "i", body: null,
        html_url: `https://github.com/${repo}/issues/5`,
        state: "closed", updated_at: "2026-09-01T00:00:00Z",
        user: { login: "octocat" }, assignees: [], labels: [],
        milestone: { number: 3, title: "M", due_on: null, open_issues: 1, closed_issues: 5 },
      },
    };
  }

  async function seedMilestone(ref: string): Promise<number> {
    const res = await run(
      env.DB,
      `INSERT INTO milestones (title, target_date, status, github_ref, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      "M", "2026-08-01", "in_progress", ref, nowIso(), "admin"
    );
    return res.meta.last_row_id as number;
  }

  it("writes progress for an event from the PRIMARY repo", async () => {
    const id = await seedMilestone("3");
    await applyEventProgress(env.DB, issueWithMilestone(PRIMARY), PRIMARY, PRIMARY);
    const row = await first(env.DB, `SELECT * FROM milestone_progress WHERE milestone_id = ?`, id);
    expect(row).toMatchObject({ closed: 5, total: 6 });
  });

  it("IGNORES an event from another captured repo — the regression", async () => {
    const id = await seedMilestone("3");
    // Same milestone NUMBER, different repo. Pre-fix this overwrote the primary
    // repo's cache with a foreign project's counts.
    await applyEventProgress(env.DB, issueWithMilestone(B), B, PRIMARY);
    expect(await first(env.DB, `SELECT * FROM milestone_progress WHERE milestone_id = ?`, id)).toBeNull();
  });

  it("fails closed when no primary repo is configured", async () => {
    const id = await seedMilestone("3");
    await applyEventProgress(env.DB, issueWithMilestone(PRIMARY), PRIMARY, undefined);
    expect(await first(env.DB, `SELECT * FROM milestone_progress WHERE milestone_id = ?`, id)).toBeNull();
  });
});
