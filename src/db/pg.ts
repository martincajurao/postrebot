import { Pool, type QueryResult, type PoolClient } from 'pg';

/**
 * Postgres data layer (Supabase Postgres).
 *
 * Replaces node:sqlite. All DB access is async now. Helpers mirror the old
 * better-sqlite3-style semantics so converted call sites stay compact:
 *   - one(sql, params)  → first row or undefined      (was .get())
 *   - many(sql, params) → all rows                    (was .all())
 *   - run(sql, params)  → { rowCount }                (was .run())
 *   - tx(fn)            → wraps fn in a transaction
 *
 * Connection string comes from DATABASE_URL (Supabase → Project Settings →
 * Database → Connection string → "Connection pooling" / pgvector pooler URI,
 * port 6543, user postgres.<project-ref>).
 */

let pool: Pool | null = null;

export function poolOf(): Pool {
  if (!pool) {
    const cs = (process.env.DATABASE_URL || '').trim();
    if (!cs) throw new Error('DATABASE_URL must be set (Supabase Postgres connection string)');
    pool = new Pool({
      connectionString: cs,
      ssl: { rejectUnauthorized: false }, // Supabase requires SSL
      max: 10,
    });
    pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
  }
  return pool;
}

/** First row or undefined (replaces sqlite .get()). */
export async function one<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  const res = await poolOf().query(sql, params);
  return res.rows[0] as T | undefined;
}

/** All rows (replaces sqlite .all()). */
export async function many<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const res = await poolOf().query(sql, params);
  return res.rows as T[];
}

/** Execute INSERT/UPDATE/DELETE (replaces sqlite .run()); returns rowCount. */
export async function run(sql: string, params: any[] = []): Promise<number> {
  const res = await poolOf().query(sql, params);
  return res.rowCount || 0;
}

/** Raw query when you need rows + rowCount together. */
export async function query(sql: string, params: any[] = []): Promise<QueryResult> {
  return poolOf().query(sql, params);
}

/** INSERT ... RETURNING id helper — replaces sqlite out.lastInsertRowid. */
export async function insertReturningId(sql: string, params: any[] = []): Promise<number> {
  const res = await poolOf().query(sql, params);
  return Number(res.rows[0]?.id);
}

/** Transaction wrapper. fn receives a client bound to the transaction. */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await poolOf().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export function isConfigured(): boolean {
  return Boolean((process.env.DATABASE_URL || '').trim());
}

export function logConfig(): void {
  const cs = (process.env.DATABASE_URL || '').trim();
  if (!cs) { console.log('[pg] DATABASE_URL: MISSING'); return; }
  try {
    const u = new URL(cs);
    console.log(`[pg] host: ${u.host} | db: ${u.pathname.slice(1)} | user: ${decodeURIComponent(u.username)} | DATABASE_URL: set`);
  } catch {
    console.log('[pg] DATABASE_URL: set (unparseable)');
  }
}
