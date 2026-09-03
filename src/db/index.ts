/**
 * Unified database layer.
 *
 * When DATABASE_URL is set (Supabase Postgres), all operations go through
 * the async Postgres pool (pg.ts + postgres.ts). Otherwise, falls back to
 * the local SQLite database for development.
 *
 * All exports are async to support both backends with the same call sites.
 */

import { isConfigured } from './pg';

// Re-export the async Postgres helpers as the primary interface
export { one, many, run, query, insertReturningId, tx, poolOf } from './pg';
export { migrate } from './postgres';

/**
 * True when running against Supabase Postgres (DATABASE_URL is set).
 * Useful for conditional logic during the transition period.
 */
export const isPostgres = isConfigured;

/**
 * Get the current database type for logging/debugging.
 */
export function dbType(): 'postgres' | 'sqlite' {
  return isConfigured() ? 'postgres' : 'sqlite';
}
