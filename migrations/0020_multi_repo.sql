-- Multi-repo capture. Until now every captured event implicitly belonged to the
-- single GITHUB_REPO, and the dedupe identity carried no repo: `gh:pr:40:merged`
-- names PR 40 of *some* repo. Point a second repo's webhook at the same worker
-- and its PR 40 derives the identical key, so the UNIQUE index + INSERT OR IGNORE
-- drop it as "already seen" — work silently missing from someone's My Work, with
-- no error. The number ranges of two active repos overlap immediately, so this is
-- a certainty, not an edge case.
--
-- Three things carried that assumption and all three are fixed here:
--   1. events.semantic_key      — repo-qualified: `gh:<owner>/<repo>:pr:40:merged`
--   2. issue_summaries          — was PRIMARY KEY(issue_number) alone
--   3. events had no repo column at all
--
-- Existing rows are rewritten to the qualified form rather than left in the old
-- shape: a mixed-format store would re-insert every historical event under a new
-- key on the next backfill, duplicating all of them.

-- ── events: add repo, backfill it, qualify the keys ──────────────────────────
ALTER TABLE events ADD COLUMN repo TEXT NOT NULL DEFAULT '';
UPDATE events SET repo = 'anticipation-labs/Anticipy' WHERE repo = '';

-- pr_summaries.semantic_key REFERENCES events(semantic_key), so rewriting the
-- parent key would trip the constraint whichever table is updated first. Rebuild
-- it without the FK: it is a derived projection, regenerable from events.raw and
-- never the source of truth, so the reference bought nothing it needs.
CREATE TABLE pr_summaries_new (
  semantic_key TEXT PRIMARY KEY,
  pr_number INTEGER NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  title TEXT,
  what TEXT,
  why TEXT,
  impact TEXT
);
INSERT INTO pr_summaries_new (semantic_key, pr_number, model, created_at, title, what, why, impact)
  SELECT semantic_key, pr_number, model, created_at, title, what, why, impact FROM pr_summaries;
DROP TABLE pr_summaries;
ALTER TABLE pr_summaries_new RENAME TO pr_summaries;

-- Qualify both sides in step. substr(key, 4) drops the leading 'gh:'.
UPDATE pr_summaries SET semantic_key = 'gh:anticipation-labs/Anticipy:' || substr(semantic_key, 4)
  WHERE semantic_key LIKE 'gh:%';
UPDATE events SET semantic_key = 'gh:anticipation-labs/Anticipy:' || substr(semantic_key, 4)
  WHERE semantic_key LIKE 'gh:%';

-- ── issue_summaries: re-key on (repo, issue_number) ──────────────────────────
CREATE TABLE issue_summaries_new (
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  summary TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  title TEXT,
  next_step TEXT,
  PRIMARY KEY (repo, issue_number)
);
INSERT INTO issue_summaries_new (repo, issue_number, summary, model, created_at, title, next_step)
  SELECT 'anticipation-labs/Anticipy', issue_number, summary, model, created_at, title, next_step
  FROM issue_summaries;
DROP TABLE issue_summaries;
ALTER TABLE issue_summaries_new RENAME TO issue_summaries;

-- Repo-scoped lookups (My Work's latest-snapshot-per-issue window, progress).
CREATE INDEX idx_events_repo_ref ON events(repo, event_type, ref_number);
