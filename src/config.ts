import 'dotenv/config';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { logger } from './logger.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Prefix of a connection registered at runtime from a discovered config file. */
export const DISCOVERED_PREFIX = 'discovered:';

export interface ConnectionProfile {
  /** Unique, user-facing name used to select this connection in tool calls. */
  name: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  /** Default schema. Individual tool calls may override it. */
  database?: string;
  ssl?: boolean | Record<string, unknown>;
  charset: string;
  connectTimeoutMs: number;
  /** Where the connection came from: the environment or a discovered config file. */
  source: 'env' | 'discovered';
}

export interface ServerConfig {
  connections: Map<string, ConnectionProfile>;
  defaultConnection: string;
  /** Enables `write_query` (INSERT / UPDATE / DELETE / REPLACE). */
  allowWrite: boolean;
  /** Enables `execute_ddl` (CREATE / ALTER / DROP / TRUNCATE / RENAME / ...). */
  allowDdl: boolean;
  /** Rows returned per query before the result is truncated. */
  maxRows: number;
  /** Maximum length of a single string / binary cell before truncation. */
  maxFieldLength: number;
  /** Client side query timeout in milliseconds. */
  queryTimeoutMs: number;
  /** Directory that `discover_connections` is allowed to scan. */
  configRoot: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3306;
const DEFAULT_CHARSET = 'utf8mb4';
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

const profileSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    user: z.string().min(1, 'connection profile is missing "user"'),
    password: z.string().optional(),
    database: z.string().min(1).optional(),
    ssl: z.union([z.boolean(), z.record(z.any())]).optional(),
    charset: z.string().min(1).optional(),
    connectTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const namedProfileSchema = profileSchema.extend({ name: z.string().min(1) });

function readString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = readString(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), got "${raw}"`);
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = readString(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function normalizeProfile(
  name: string,
  raw: z.infer<typeof profileSchema>,
  source: ConnectionProfile['source'] = 'env',
): ConnectionProfile {
  return {
    name,
    host: raw.host ?? DEFAULT_HOST,
    port: raw.port ?? DEFAULT_PORT,
    user: raw.user,
    password: raw.password,
    database: raw.database,
    ssl: raw.ssl,
    charset: raw.charset ?? DEFAULT_CHARSET,
    connectTimeoutMs: raw.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    source,
  };
}

/**
 * `MYSQL_CONNECTIONS` accepts either a map of `{ name: profile }` or an array of
 * profiles that each carry a `name`. Returns `undefined` when the variable is unset.
 */
function parseProfilesJson(raw: string): Map<string, ConnectionProfile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`MYSQL_CONNECTIONS is not valid JSON: ${(error as Error).message}`);
  }

  const result = new Map<string, ConnectionProfile>();

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const profile = namedProfileSchema.safeParse(entry);
      if (!profile.success) {
        throw new ConfigError(`Invalid entry in MYSQL_CONNECTIONS: ${profile.error.issues.map((i) => `${i.path.join('.') || 'profile'}: ${i.message}`).join('; ')}`);
      }
      const { name, ...rest } = profile.data;
      result.set(name, normalizeProfile(name, rest));
    }
    return result;
  }

  if (parsed && typeof parsed === 'object') {
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const profile = profileSchema.safeParse(entry);
      if (!profile.success) {
        throw new ConfigError(`Invalid connection "${name}" in MYSQL_CONNECTIONS: ${profile.error.issues.map((i) => `${i.path.join('.') || 'profile'}: ${i.message}`).join('; ')}`);
      }
      result.set(name, normalizeProfile(name, profile.data));
    }
    return result;
  }

  throw new ConfigError('MYSQL_CONNECTIONS must be a JSON object of profiles or an array of profiles');
}

export function loadConfig(): ServerConfig {
  const allowWrite = readBool('MYSQL_ALLOW_WRITE', false);
  const allowDdl = readBool('MYSQL_ALLOW_DDL', false);
  const maxRows = readInt('MYSQL_MAX_ROWS', 1000, 1, 100_000);
  const maxFieldLength = readInt('MYSQL_MAX_FIELD_LENGTH', 4096, 64, 1_000_000);
  const queryTimeoutMs = readInt('MYSQL_QUERY_TIMEOUT_MS', 30_000, 1000, 600_000);

  const connections = new Map<string, ConnectionProfile>();

  // 1) Explicit multi-connection configuration.
  const connectionsJson = readString('MYSQL_CONNECTIONS');
  if (connectionsJson) {
    for (const [name, profile] of parseProfilesJson(connectionsJson)) {
      connections.set(name, profile);
    }
  }

  // 2) The "default" connection derived from the flat MYSQL_* variables.
  const host = readString('MYSQL_HOST');
  const user = readString('MYSQL_USER');
  const password = readString('MYSQL_PASSWORD');
  const database = readString('MYSQL_DATABASE');

  if (host || user || password || database) {
    if (connections.has('default')) {
      throw new ConfigError(
        'The flat MYSQL_HOST / MYSQL_USER / ... variables define a connection named "default", ' +
          'which is already defined in MYSQL_CONNECTIONS. Rename one of them.',
      );
    }
    const parsed = profileSchema.safeParse({
      host,
      port: readInt('MYSQL_PORT', DEFAULT_PORT, 1, 65535),
      user: user ?? 'root',
      password,
      database,
      ssl: readBool('MYSQL_SSL', false),
      charset: readString('MYSQL_CHARSET'),
      connectTimeoutMs: readInt('MYSQL_CONNECT_TIMEOUT_MS', DEFAULT_CONNECT_TIMEOUT_MS, 100, 600_000),
    });
    if (!parsed.success) {
      throw new ConfigError(`Invalid MySQL connection settings: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    connections.set('default', normalizeProfile('default', parsed.data));
  }

  if (connections.size === 0) {
    // Not an error: `discover_connections` can register connections at runtime
    // from the project's own database configuration files.
    logger.warn(
      'No connection configured via MYSQL_* variables. The server will start anyway; ' +
        'call the discover_connections tool to pick up connections from the project config files.',
    );
  }

  // 3) Pick the default connection: the explicit choice wins, otherwise prefer
  //    "default" and fall back to the first configured connection.
  const requestedDefault = readString('MYSQL_DEFAULT_CONNECTION');
  const defaultConnection = requestedDefault ?? (connections.has('default') ? 'default' : [...connections.keys()][0] ?? '');

  if (requestedDefault !== undefined && !connections.has(defaultConnection)) {
    throw new ConfigError(
      `MYSQL_DEFAULT_CONNECTION is "${defaultConnection}" but no such connection is configured. ` +
        `Available: ${[...connections.keys()].join(', ') || '(none)'}`,
    );
  }

  const configRoot = resolveConfigRoot(readString('MYSQL_CONFIG_ROOT'));

  return {
    connections,
    defaultConnection,
    allowWrite,
    allowDdl,
    maxRows,
    maxFieldLength,
    queryTimeoutMs,
    configRoot,
  };
}

/**
 * The directory `discover_connections` may scan. Defaults to the process working
 * directory (for a stdio MCP server that is the client's project directory).
 */
function resolveConfigRoot(raw: string | undefined): string {
  const root = resolve(raw ?? process.cwd());
  try {
    if (!statSync(root).isDirectory()) {
      throw new ConfigError(`MYSQL_CONFIG_ROOT is not a directory: ${root}`);
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`MYSQL_CONFIG_ROOT does not exist: ${root}`);
  }
  return root;
}
