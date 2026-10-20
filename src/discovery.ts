/**
 * Discovers MySQL connections from a project's own database configuration files.
 *
 * Only dotenv files are read (`.env` family), and they are parsed as *text* with
 * `dotenv` itself — the reference implementation for `.env` files, so the values
 * discovered here are exactly what the project's own `dotenv.config()` would see.
 * Project code is never imported or executed, and no file is ever written.
 */
import { parse as parseDotenv } from 'dotenv';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { DISCOVERED_PREFIX, type ConnectionProfile } from './config.js';

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/** Ignore anything larger than this; a database config file is never this big. */
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Candidate file names, probed in this order (first match per name wins).
 * Template files (`.env.example`, `.sample`, `.template`, `.dist`) are
 * deliberately excluded: they hold placeholders, not real credentials, and
 * registering them would create a connection that can never work.
 */
const CONFIG_FILE_NAMES = ['.env', '.env.local', '.env.development.local', '.env.development', '.env.dev', '.env.test', '.env.mysql', '.env.database'];

/** Nested layouts worth probing explicitly (monorepos keep the API under apps/). */
const KNOWN_NESTED_DIRECTORIES = ['config', 'configs', 'conf', 'env', 'environments', 'docker', 'deploy', 'deployment', 'deployments', 'apps/api', 'apps/server'];

/** Directories that never hold a hand-written database config. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  'tmp',
  'temp',
  'cache',
  'public',
  'static',
  'assets',
  'docs',
  'fixtures',
  'test',
  'tests',
  '__tests__',
  '__pycache__',
  'venv',
  'migrations',
]);

/** Upper bound on how many sibling directories are probed. */
const MAX_SIBLING_DIRECTORIES = 30;

const URL_KEYS = ['DATABASE_URL', 'MYSQL_URL', 'MYSQL_DSN', 'DB_URL', 'DB_DSN'];

/**
 * Field -> environment variable names, most specific first. Both the `MYSQL_*`
 * and the `DB_*` families are covered (the latter is what Laravel/Rails emit).
 */
const FIELD_KEYS: Record<'host' | 'port' | 'user' | 'password' | 'database', string[]> = {
  host: ['MYSQL_HOST', 'DB_HOST', 'MYSQL_HOSTNAME', 'DB_HOSTNAME', 'MYSQL_SERVER', 'DB_SERVER'],
  port: ['MYSQL_PORT', 'DB_PORT'],
  user: ['MYSQL_USER', 'DB_USER', 'MYSQL_USERNAME', 'DB_USERNAME'],
  password: ['MYSQL_PASSWORD', 'DB_PASSWORD', 'MYSQL_PASS', 'DB_PASS', 'MYSQL_PWD', 'DB_PWD'],
  database: ['MYSQL_DATABASE', 'MYSQL_DB_NAME', 'MYSQL_DB', 'DB_DATABASE', 'DB_NAME', 'DB_DB'],
};

const URL_PROTOCOL = /^(?:jdbc:)?(?:mysql|mysql2|mariadb):\/\//i;

interface CandidateFields {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

export interface DiscoveredCandidate {
  /** Connection name to pass to other tools. */
  name: string;
  sourceFile: string;
  host: string;
  port: number;
  user: string;
  database: string | null;
  /** Always masked: the real password never leaves the process. */
  password: string | null;
  /** The environment variables the values were taken from. */
  matchedKeys: string[];
  /** Source profiles that resolve to the same settings (`.env` + `.env.local`, ...). */
  files: string[];
  /**
   * Ready-to-register profile, carrying the real password.
   *
   * Deliberately non-enumerable: `JSON.stringify` on a candidate (or on the whole
   * discovery result) can never leak credentials, and spreading a candidate loses
   * this field loudly instead of silently shipping a secret.
   */
  readonly profile: ConnectionProfile;
}

/** Attaches the profile as a non-enumerable property so it can never be serialized. */
function withProfile(candidate: Omit<DiscoveredCandidate, 'profile'>, profile: ConnectionProfile): DiscoveredCandidate {
  return Object.defineProperty(candidate, 'profile', { value: profile, enumerable: false }) as DiscoveredCandidate;
}

/** Resolves and validates a directory the caller asked to scan. */
export function resolveScanRoot(configRoot: string, requested?: string): string {
  const realRoot = realpathSync(configRoot);
  if (requested === undefined || requested.trim() === '') return realRoot;

  const target = resolve(realRoot, requested);
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    throw new DiscoveryError(`Directory does not exist: ${target}`);
  }
  if (!statSync(realTarget).isDirectory()) {
    throw new DiscoveryError(`Not a directory: ${realTarget}`);
  }

  const rel = relative(realRoot, realTarget);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new DiscoveryError(
      `Refusing to scan "${realTarget}": it is outside the allowed config root "${realRoot}". ` +
        'Point MYSQL_CONFIG_ROOT at a common parent directory if you need a wider scope.',
    );
  }
  return realTarget;
}

function readEnvFile(filePath: string): Record<string, string> | undefined {
  let size: number;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return undefined;
    size = stats.size;
  } catch {
    return undefined;
  }
  if (size > MAX_FILE_BYTES) return undefined;

  try {
    return parseDotenv(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Redeem a percent-encoded URL component, tolerating stray `%` characters. */
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Expands a `mysql://user:pass@host:port/db` (or `jdbc:mysql://...`) URL. */
function parseConnectionUrl(raw: string): CandidateFields | undefined {
  const trimmed = raw.trim();
  if (!URL_PROTOCOL.test(trimmed)) return undefined;

  const normalized = trimmed.replace(/^jdbc:/i, '').replace(/^(?:mysql2|mariadb):/i, 'mysql:');
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return undefined;
  }

  const database = decodeComponent(url.pathname.replace(/^\/+/, ''));
  const port = url.port === '' ? undefined : Number(url.port);
  return {
    host: decodeComponent(url.hostname) || undefined,
    port: port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined,
    user: decodeComponent(url.username) || undefined,
    password: url.password === '' ? undefined : decodeComponent(url.password),
    database: database || undefined,
  };
}

function isValidPort(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0 && value <= 65535;
}

function fromEnvMap(env: Record<string, string>): { fields: CandidateFields; matchedKeys: string[] } | undefined {
  const matchedKeys: string[] = [];
  const pick = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = env[key];
      if (value !== undefined && value.trim() !== '') {
        matchedKeys.push(key);
        return value.trim();
      }
    }
    return undefined;
  };

  // A connection URL is the most authoritative single source; individual
  // MYSQL_* / DB_* variables still win over it when both are present.
  let urlFields: CandidateFields | undefined;
  for (const key of URL_KEYS) {
    const value = env[key];
    if (value === undefined || value.trim() === '') continue;
    const parsed = parseConnectionUrl(value);
    if (!parsed) continue;
    urlFields = parsed;
    matchedKeys.push(key);
    break;
  }

  const rawPort = pick(FIELD_KEYS.port);
  const port = rawPort === undefined ? urlFields?.port : Number(rawPort);

  const fields: CandidateFields = {
    host: pick(FIELD_KEYS.host) ?? urlFields?.host,
    user: pick(FIELD_KEYS.user) ?? urlFields?.user,
    password: pick(FIELD_KEYS.password) ?? urlFields?.password,
    database: pick(FIELD_KEYS.database) ?? urlFields?.database,
    port: isValidPort(port) ? port : undefined,
  };

  if (!fields.host || !fields.user) return undefined;
  return { fields, matchedKeys };
}

function slugify(relativePath: string): string {
  return relativePath
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function dedupeKey(fields: CandidateFields, defaults: { port: number }): string {
  return [fields.host, fields.port ?? defaults.port, fields.user, fields.database ?? '', fields.password ?? ''].join('\u0000');
}

export interface DiscoveryResult {
  scannedRoot: string;
  scannedFiles: string[];
  candidates: DiscoveredCandidate[];
  warnings: string[];
}

export interface DiscoverOptions {
  root: string;
  port: number;
  charset: string;
  connectTimeoutMs: number;
}

/**
 * Directories to probe: the scan root, a fixed set of conventional nested
 * locations, and the root's own subdirectories (skipping build/vendor trees).
 * Bounded by `MAX_SIBLING_DIRECTORIES` so a huge repo stays fast.
 */
function candidateDirectories(root: string): string[] {
  const directories = new Set<string>(['', ...KNOWN_NESTED_DIRECTORIES]);

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [...directories];
  }

  const siblings = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && !SKIPPED_DIRECTORIES.has(name.toLowerCase()))
    .sort()
    .slice(0, MAX_SIBLING_DIRECTORIES);

  for (const sibling of siblings) directories.add(sibling);
  return [...directories];
}

export function discoverConnections(options: DiscoverOptions): DiscoveryResult {
  const scannedFiles: string[] = [];
  const warnings: string[] = [];
  const byKey = new Map<string, DiscoveredCandidate>();

  for (const directory of candidateDirectories(options.root)) {
    for (const fileName of CONFIG_FILE_NAMES) {
      const filePath = resolve(options.root, directory, fileName);
      const env = readEnvFile(filePath);
      if (!env) continue;

      const relativePath = relative(options.root, filePath).replace(/\\/g, '/');
      scannedFiles.push(relativePath);

      const extracted = fromEnvMap(env);
      if (!extracted) {
        warnings.push(`${relativePath}: no MySQL connection settings found (needs a host + user, or a mysql:// DATABASE_URL).`);
        continue;
      }

      const fields = extracted.fields;
      const port = fields.port ?? options.port;
      const key = dedupeKey(fields, { port: options.port });

      const existing = byKey.get(key);
      if (existing) {
        existing.files.push(relativePath);
        continue;
      }

      const name = `${DISCOVERED_PREFIX}${slugify(relativePath)}`;
      byKey.set(
        key,
        withProfile(
          {
            name,
            sourceFile: relativePath,
            host: fields.host!,
            port,
            user: fields.user!,
            database: fields.database ?? null,
            password: fields.password === undefined ? null : '***',
            matchedKeys: extracted.matchedKeys,
            files: [relativePath],
          },
          {
            name,
            host: fields.host!,
            port,
            user: fields.user!,
            password: fields.password,
            database: fields.database,
            charset: options.charset,
            connectTimeoutMs: options.connectTimeoutMs,
            source: 'discovered',
          },
        ),
      );
    }
  }

  return { scannedRoot: options.root, scannedFiles, candidates: [...byKey.values()], warnings };
}
