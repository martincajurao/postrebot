/**
 * Database layer — Supabase only.
 *
 * All operations go through the Supabase client.
 * The raw SQL/PG helpers below are kept solely for the one-time
 * schema migration on startup — no application code uses them.
 */

import * as pg from './pg';

// Re-export all Supabase-based query helpers
export * from './supabase-queries';

// Re-export the async helpers (only used by migration + legacy upload lookup)
export const one = pg.one;
export const many = pg.many;
export const run = pg.run;
export const query = pg.query;
export const insertReturningId = pg.insertReturningId;
export const tx = pg.tx;
export const poolOf = pg.poolOf;

/**
 * Always true — the project runs on Supabase Postgres.
 */
export const isPostgres = () => true;

/**
 * Get the current database type for logging/debugging.
 */
export function dbType(): 'postgres' {
  return 'postgres';
}
