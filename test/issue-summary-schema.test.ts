import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "../src/db";
import type { IssueSummaryRow } from "@shared/rows";

describe("issue_summaries schema (0017, re-keyed by 0020)", () => {
  const REPO = "anticipation-labs/Anticipy";
  const OTHER = "anticipation-labs/aniticipy-internal";

  it("stores a summary keyed by (repo, issue_number)", async () => {
    await run(
      env.DB,
      `INSERT INTO issue_summaries (repo, issue_number, summary, model, created_at) VALUES (?, ?, ?, ?, ?)`,
      REPO,
      17,
      "What the issue is about.",
      "test-model",
      "2026-07-04T10:00:00Z"
    );
    const row = await first<IssueSummaryRow>(
      env.DB,
      `SELECT * FROM issue_summaries WHERE repo = ? AND issue_number = ?`,
      REPO,
      17
    );
    expect(row).toMatchObject({
      repo: REPO,
      issue_number: 17,
      summary: "What the issue is about.",
      model: "test-model",
      created_at: "2026-07-04T10:00:00Z",
    });
  });

  it("(repo, issue_number) is the PK: INSERT OR REPLACE overwrites only the same repo's row", async () => {
    const put = (repo: string, summary: string, model: string, at: string) =>
      run(env.DB, `INSERT OR REPLACE INTO issue_summaries (repo, issue_number, summary, model, created_at) VALUES (?, ?, ?, ?, ?)`, repo, 20, summary, model, at);

    await put(REPO, "First summary", "m1", "2026-07-04T10:00:00Z");
    await put(REPO, "Second summary", "m2", "2026-07-04T11:00:00Z");

    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE repo = ? AND issue_number = ?`, REPO, 20);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("Second summary");
    expect(rows[0].model).toBe("m2");
  });

  it("keeps two repos' summaries for the SAME issue number apart", async () => {
    // The whole point of 0020: before it, issue #20 of a second repo would
    // overwrite issue #20 of the first, and one team's card would show the
    // other team's summary.
    await run(env.DB, `INSERT INTO issue_summaries (repo, issue_number, summary, model, created_at) VALUES (?, ?, ?, ?, ?)`, REPO, 20, "Anticipy's issue 20", "m", "2026-07-04T10:00:00Z");
    await run(env.DB, `INSERT INTO issue_summaries (repo, issue_number, summary, model, created_at) VALUES (?, ?, ?, ?, ?)`, OTHER, 20, "Canopy's issue 20", "m", "2026-07-04T10:00:00Z");

    const rows = await all<IssueSummaryRow>(env.DB, `SELECT * FROM issue_summaries WHERE issue_number = ? ORDER BY repo`, 20);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.summary)).toEqual(["Anticipy's issue 20", "Canopy's issue 20"]);
  });

  it("is truncated between tests (test-harness registration)", async () => {
    // If Step 1's row from a prior test file run were still here, this would be 1 not 0.
    expect((await all(env.DB, `SELECT * FROM issue_summaries`)).length).toBe(0);
  });
});
