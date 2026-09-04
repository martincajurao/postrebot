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
import * as pg from './pg';
import * as sqlite from './database';

// Use Postgres when DATABASE_URL is set, otherwise use SQLite
const backend = isConfigured() ? pg : sqlite;

// Re-export the async helpers from the appropriate backend
export const one = backend.one;
export const many = backend.many;
export const run = backend.run;
export const query = backend.query;
export const insertReturningId = backend.insertReturningId;
export const tx = backend.tx;
export const poolOf = (backend as any).poolOf;

// Re-export migrate from the appropriate backend
import { migrate as pgMigrate } from './postgres';
export async function migrate(): Promise<void> {
  if (isConfigured()) return pgMigrate();
  return sqlite.migrate();
}

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
