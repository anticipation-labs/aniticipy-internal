/**
 * Applies `migrations/*.sql` in filename order, once each.
 *
 * Wrangler normally does this against D1. On Node we do it at boot, tracking
 * applied files in the same `d1_migrations` bookkeeping table Wrangler uses so
 * the two paths agree on what "already applied" means.
 *
 * Each file is executed whole rather than split on semicolons: three of the
 * migrations define FTS5 triggers whose bodies contain their own statements,
 * and naive splitting would tear those in half.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export function applyMigrations(db: DatabaseSync, dir: string): { applied: string[]; skipped: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`);

  const done = new Set(
    (db.prepare(`SELECT name FROM d1_migrations`).all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const name of files) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    // One transaction per file: a migration that fails halfway leaves no
    // partial schema behind and stays unrecorded, so the next boot retries it.
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare(`INSERT INTO d1_migrations (name) VALUES (?)`).run(name);
      db.exec("COMMIT");
      applied.push(name);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${(err as Error).message}`, { cause: err });
    }
  }
  return { applied, skipped: files.length - applied.length };
}
