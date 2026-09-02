/**
 * A D1Database-shaped adapter backed by Node's built-in SQLite (`node:sqlite`).
 *
 * Why this exists
 * ---------------
 * Canopy is written for Cloudflare Workers, where `env.DB` is a D1Database.
 * Railway runs Node, which has no D1. Every query in the app funnels through
 * three helpers in `src/db.ts`, and each one calls exactly:
 *
 *     db.prepare(sql).bind(...params).first() | .all() | .run()
 *
 * Implementing that surface here means the ~52 query sites, all 20 SQLite
 * migrations and the three FTS5 virtual tables run unchanged. The port swaps
 * the driver, not the SQL, so nothing under `src/` is edited and the existing
 * Workers test suite keeps covering the same code.
 *
 * Node ships SQLite 3.53 with FTS5 (verified: `porter unicode61` stemming
 * works), so the search index needs no rewrite either.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Row = Record<string, unknown>;

/** The value types `node:sqlite` will bind directly. */
type Bindable = null | number | bigint | string | Uint8Array;

/** D1's result envelope, reproduced for the fields `src/` actually reads. */
export interface D1ResultLike<T = Row> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number; duration: number; rows_read: number; rows_written: number };
}

const meta = (changes = 0, lastRowId = 0): D1ResultLike["meta"] => ({
  changes,
  last_row_id: lastRowId,
  duration: 0,
  rows_read: 0,
  rows_written: changes,
});

/**
 * D1 coerces JS booleans to 0/1 before binding; `node:sqlite` throws on them
 * (verified). It throws on `undefined` too, which callers building optional
 * columns reasonably expect to mean NULL. Normalising here keeps that
 * difference out of all 52 call sites.
 */
function toBindable(value: unknown): Bindable {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  // Objects and arrays are rejected by D1 as well. Fail loudly rather than
  // stringify something the surrounding SQL never meant to store.
  throw new TypeError(`cannot bind ${Object.prototype.toString.call(value)} as a SQL parameter`);
}

/** `lastInsertRowid` widens to bigint past 2^53; callers treat it as a number. */
const toNumber = (v: number | bigint): number => (typeof v === "bigint" ? Number(v) : v);

class PreparedStatement {
  constructor(
    private readonly stmt: StatementSync,
    private readonly values: Bindable[] = [],
  ) {}

  /** D1's bind() returns a new statement rather than mutating in place. */
  bind(...values: unknown[]): PreparedStatement {
    return new PreparedStatement(this.stmt, values.map(toBindable));
  }

  /** First row, or null. With a column name, that column of the first row. */
  async first<T = Row>(colName?: string): Promise<T | null> {
    const row = this.stmt.get(...this.values) as Row | undefined;
    if (row === undefined) return null; // node:sqlite returns undefined; D1 returns null
    return (colName === undefined ? row : (row[colName] ?? null)) as T | null;
  }

  async all<T = Row>(): Promise<D1ResultLike<T>> {
    const results = this.stmt.all(...this.values) as T[];
    return { results, success: true, meta: meta(0, 0) };
  }

  /** Writes. `meta.changes` and `meta.last_row_id` are both read by `src/`. */
  async run<T = Row>(): Promise<D1ResultLike<T>> {
    const r = this.stmt.run(...this.values);
    return { results: [], success: true, meta: meta(toNumber(r.changes), toNumber(r.lastInsertRowid)) };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.stmt.all(...this.values) as Row[];
    return rows.map((r) => Object.values(r)) as T[];
  }
}

export class SqliteD1 {
  /** Preparing is not free and the app reuses the same SQL constantly. */
  private readonly cache = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): PreparedStatement {
    let stmt = this.cache.get(query);
    if (!stmt) {
      stmt = this.db.prepare(query);
      this.cache.set(query, stmt);
    }
    return new PreparedStatement(stmt);
  }

  /** Multi-statement DDL/DML. Used by the test-style reset and migrations. */
  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.db.exec(query);
    return { count: 0, duration: 0 };
  }

  /**
   * D1 runs a batch in an implicit transaction. `node:sqlite` is synchronous,
   * so wrapping the already-bound statements in one transaction matches that.
   */
  async batch<T = Row>(statements: PreparedStatement[]): Promise<D1ResultLike<T>[]> {
    this.db.exec("BEGIN");
    try {
      const out: D1ResultLike<T>[] = [];
      for (const s of statements) out.push(await s.run<T>());
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  withSession(): SqliteD1 {
    return this; // D1 sessions are a replication concern; a local file has one copy.
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error("dump() is not supported on the SQLite adapter");
  }
}

/** Opens the database file, applying the pragmas a long-lived server wants. */
export function openDatabase(path: string): { db: DatabaseSync; d1: SqliteD1 } {
  const db = new DatabaseSync(path);
  // WAL survives an unclean stop far better than the rollback journal, which
  // matters on a platform that restarts containers without warning.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  return { db, d1: new SqliteD1(db) };
}
