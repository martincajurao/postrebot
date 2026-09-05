/**
 * Database layer — Supabase Postgres only.
 *
 * All operations go through the async Postgres pool (pg.ts + postgres.ts).
 * SQLite has been removed; the project runs exclusively on Supabase.
 */

import * as pg from './pg';

// Re-export the async helpers
export const one = pg.one;
export const many = pg.many;
export const run = pg.run;
export const query = pg.query;
export const insertReturningId = pg.insertReturningId;
export const tx = pg.tx;
export const poolOf = pg.poolOf;

// Migrate from the Postgres schema
export { migrate } from './postgres';

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
