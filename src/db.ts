import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';
import type { ConnectionProfile, ServerConfig } from './config.js';
import { logger } from './logger.js';

export class DatabaseError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
  }
}

export interface QueryResult {
  /** `rows` when the statement produced a result set, `mutation` otherwise. */
  type: 'rows' | 'mutation';
  columns: string[];
  rows: Record<string, unknown>[];
  /** Rows returned before truncation (only meaningful for result sets). */
  returnedRows: number;
  /** True when more rows were available than `maxRows` allows. */
  truncated: boolean;
  /** Present for INSERT / UPDATE / DELETE / REPLACE. */
  affectedRows?: number;
  changedRows?: number;
  insertId?: string | number;
  warnings?: number;
}

function buildPoolOptions(profile: ConnectionProfile): PoolOptions {
  return {
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password: profile.password,
    database: profile.database,
    charset: profile.charset,
    connectTimeout: profile.connectTimeoutMs,
    ssl: profile.ssl as PoolOptions['ssl'],
    waitForConnections: true,
    connectionLimit: 4,
    maxIdle: 4,
    idleTimeout: 60_000,
    queueLimit: 0,
    enableKeepAlive: true,
    // Statements are executed one at a time; the safety guard rejects
    // delimiter-packed SQL, and the driver gives us a second line of defence.
    multipleStatements: false,
    // Preserve BIGINT precision and keep DECIMAL as strings instead of floats.
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    // Return DATE / DATETIME / TIMESTAMP as strings so results stay portable.
    dateStrings: true,
    rowsAsArray: false,
  };
}

/**
 * Converts driver values into plain JSON-friendly data: BigInt becomes a string,
 * Buffers become `{"type":"Buffer","length":n,"data":"<base64>"}`, Dates are
 * ISO strings. This keeps `JSON.stringify` safe for every MySQL column type.
 */
function toJsonSafe(value: unknown, maxFieldLength: number): unknown {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'bigint':
      return value.toString();
    case 'number':
    case 'boolean':
      return value;
    case 'string':
      return value.length > maxFieldLength ? `${value.slice(0, maxFieldLength)}…[truncated ${value.length - maxFieldLength} chars]` : value;
    case 'object':
      break;
    default:
      return String(value);
  }

  if (Buffer.isBuffer(value)) {
    const base64 = value.toString('base64');
    return base64.length > maxFieldLength
      ? { type: 'Buffer', length: value.length, truncated: true, data: `${base64.slice(0, maxFieldLength)}…` }
      : { type: 'Buffer', length: value.length, data: base64 };
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item, maxFieldLength));
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = toJsonSafe(nested, maxFieldLength);
  }
  return result;
}

function isResultSet(rows: unknown): rows is Record<string, unknown>[] {
  return Array.isArray(rows);
}

interface HeaderLike {
  affectedRows?: number;
  changedRows?: number;
  insertId?: number | string;
  warningStatus?: number;
  info?: string;
}

export class DatabaseManager {
  private readonly pools = new Map<string, Pool>();
  private readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  /** Resolves a connection name, falling back to the configured default. */
  resolveProfile(name?: string, database?: string): ConnectionProfile {
    const key = name?.trim() || this.config.defaultConnection;
    if (!key) {
      throw new DatabaseError(
        'No connection available. Call the discover_connections tool to pick up connections from the project config files, ' +
          'or configure MYSQL_HOST / MYSQL_USER / ... in the server environment.',
      );
    }
    const profile = this.config.connections.get(key);
    if (!profile) {
      const available = [...this.config.connections.keys()].join(', ');
      throw new DatabaseError(
        `Unknown connection "${key}". Available connections: ${available || '(none)'}` +
          (available ? '' : ' — call discover_connections to detect one from the project config files'),
      );
    }
    const effectiveDatabase = database?.trim() || profile.database;
    return { ...profile, database: effectiveDatabase };
  }

  /**
   * Adds a connection at runtime (used by `discover_connections`). The name must
   * be unique so that a discovered file can never shadow an operator-defined one.
   */
  registerConnection(profile: ConnectionProfile): ConnectionProfile {
    const existing = this.config.connections.get(profile.name);
    if (existing) {
      throw new DatabaseError(
        `Connection "${profile.name}" is already registered (source: ${existing.source}). ` +
          'Rename the discovered profile or remove the conflicting configuration.',
      );
    }
    this.config.connections.set(profile.name, profile);
    logger.info('Registered discovered connection', { connection: profile.name, host: profile.host, database: profile.database });
    return profile;
  }

  /** Drops a runtime-registered connection and closes all of its pools. */
  async removeConnection(name: string): Promise<boolean> {
    const profile = this.config.connections.get(name);
    if (!profile) return false;
    if (profile.source !== 'discovered') {
      throw new DatabaseError(`Connection "${name}" was configured via the environment and cannot be removed at runtime.`);
    }
    this.config.connections.delete(name);

    const prefix = `${name}::`;
    const doomed = [...this.pools.entries()].filter(([key]) => key.startsWith(prefix));
    for (const [key] of doomed) this.pools.delete(key);
    await Promise.allSettled(doomed.map(([, pool]) => pool.end()));
    logger.info('Removed discovered connection', { connection: name });
    return true;
  }

  /**
   * Opens a throwaway connection to check credentials without touching the pool
   * cache (a candidate that never gets registered must leave no trace).
   */
  async verifyProfile(profile: ConnectionProfile, timeoutMs: number): Promise<void> {
    let connection;
    try {
      connection = await mysql.createConnection({ ...buildPoolOptions(profile), connectTimeout: timeoutMs, connectionLimit: undefined });
      await connection.query('SELECT 1');
    } catch (error) {
      throw this.wrap(error, profile);
    } finally {
      await connection?.end().catch(() => undefined);
    }
  }

  private getPool(profile: ConnectionProfile): Pool {
    const key = `${profile.name}::${profile.database ?? ''}`;
    const existing = this.pools.get(key);
    if (existing) return existing;

    logger.debug('Creating connection pool', {
      connection: profile.name,
      database: profile.database,
      host: profile.host,
      port: profile.port,
    });
    const pool = mysql.createPool(buildPoolOptions(profile));
    this.pools.set(key, pool);
    return pool;
  }

  async query(profile: ConnectionProfile, sql: string, maxRows: number, values?: unknown[]): Promise<QueryResult> {
    const pool = this.getPool(profile);
    let raw: unknown;
    try {
      const [rows] = await pool.query({ sql, values, timeout: this.config.queryTimeoutMs });
      raw = rows;
    } catch (error) {
      throw this.wrap(error, profile);
    }

    if (isResultSet(raw)) {
      const columns = raw.length > 0 ? Object.keys(raw[0]!) : [];
      const truncated = raw.length > maxRows;
      const limited = truncated ? raw.slice(0, maxRows) : raw;
      return {
        type: 'rows',
        columns,
        rows: limited.map((row) => toJsonSafe(row, this.config.maxFieldLength) as Record<string, unknown>),
        returnedRows: limited.length,
        truncated,
      };
    }

    const header = (raw ?? {}) as HeaderLike;
    return {
      type: 'mutation',
      columns: [],
      rows: [],
      returnedRows: 0,
      truncated: false,
      affectedRows: header.affectedRows ?? 0,
      changedRows: header.changedRows ?? 0,
      insertId: header.insertId ?? 0,
      warnings: header.warningStatus ?? 0,
    };
  }

  async ping(profile: ConnectionProfile): Promise<void> {
    try {
      await this.getPool(profile).query('SELECT 1');
    } catch (error) {
      throw this.wrap(error, profile);
    }
  }

  async closeAll(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(pools.map((pool) => pool.end()));
  }

  private wrap(error: unknown, profile: ConnectionProfile): DatabaseError {
    if (error instanceof DatabaseError) return error;

    const err = error as { code?: string; errno?: number; sqlMessage?: string; message?: string };
    // Never include the password in surfaced messages.
    const detail = err.sqlMessage ?? err.message ?? 'unknown error';
    const code = err.code ?? (err.errno !== undefined ? `ER_${err.errno}` : undefined);
    const message = `[${profile.name}@${profile.host}:${profile.port}] ${detail}${code ? ` (${code})` : ''}`;
    logger.debug('Query failed', { connection: profile.name, code });
    return new DatabaseError(message, code);
  }
}
