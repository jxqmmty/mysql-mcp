import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type ConnectionProfile, type ServerConfig } from './config.js';
import type { DatabaseManager, QueryResult } from './db.js';
import { discoverConnections, resolveScanRoot, type DiscoveredCandidate } from './discovery.js';
import { logger } from './logger.js';
import {
  analyze,
  applyRowLimit,
  assertDdl,
  assertReadOnly,
  assertWritable,
  SqlGuardError,
  type SqlAnalysis,
} from './safety.js';

const JSON_INDENT = 2;

/** Keep the number of parallel verification connections (and the wait) bounded. */
const MAX_VERIFIED_CANDIDATES = 5;
const VERIFY_TIMEOUT_MS = 3000;

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, JSON_INDENT) }],
  };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/** Wraps a tool body so that any thrown error becomes a well-formed MCP error result. */
function handler<T>(name: string, body: (args: T) => Promise<CallToolResult>) {
  return async (args: T): Promise<CallToolResult> => {
    try {
      return await body(args);
    } catch (error) {
      if (!(error instanceof SqlGuardError)) {
        logger.warn(`Tool ${name} failed`, { message: error instanceof Error ? error.message : String(error) });
      }
      return errorResult(error);
    }
  };
}

function quoteIdentifier(name: string): string {
  if (name.length === 0 || /[`\0]/.test(name)) {
    throw new SqlGuardError(`Invalid identifier: ${JSON.stringify(name)} (backticks and NUL bytes are not allowed)`);
  }
  return `\`${name}\``;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** `SHOW ...` output key depends on the server version, so normalize it to an array. */
function firstColumnValues(rows: Record<string, unknown>[]): string[] {
  return rows
    .map((row) => Object.values(row)[0])
    .filter((value): value is string => typeof value === 'string');
}

function formatQueryResult(result: QueryResult, limit: LimitInfo): Record<string, unknown> {
  if (result.type === 'mutation') {
    return {
      type: 'mutation',
      affectedRows: result.affectedRows,
      changedRows: result.changedRows,
      insertId: result.insertId,
      warnings: result.warnings,
    };
  }
  return {
    type: 'rows',
    columns: result.columns,
    rowCount: result.returnedRows,
    truncated: result.truncated,
    limit: limit.rowLimit,
    autoLimitApplied: limit.autoApplied,
    ...(result.truncated ? { truncatedHint: `Only the first ${limit.rowLimit} rows are returned; refine the query (WHERE / LIMIT) to see more.` } : {}),
    rows: result.rows,
  };
}

interface LimitInfo {
  rowLimit: number;
  autoApplied: boolean;
}

interface CandidateReport {
  registered: boolean;
  error?: string;
  /** Name of an already-available connection with identical settings. */
  equivalent?: string;
  verification?: { status: 'ok' | 'failed' | 'skipped'; error?: string };
}

/** Two connections are interchangeable when every setting matches. */
function isSameConnection(a: ConnectionProfile, b: ConnectionProfile): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.port === b.port &&
    a.user === b.user &&
    (a.password ?? '') === (b.password ?? '') &&
    (a.database ?? '') === (b.database ?? '')
  );
}

function findEquivalentConnection(existing: Iterable<ConnectionProfile>, candidate: DiscoveredCandidate): string | undefined {
  for (const profile of existing) {
    if (isSameConnection(profile, candidate.profile)) return profile.name;
  }
  return undefined;
}

/** Renders a discovered candidate for the client, with the password masked. */
function describeCandidate(candidate: DiscoveredCandidate, report: CandidateReport): Record<string, unknown> {
  return {
    name: candidate.name,
    sourceFile: candidate.sourceFile,
    host: candidate.host,
    port: candidate.port,
    user: candidate.user,
    password: candidate.password,
    database: candidate.database,
    matchedKeys: candidate.matchedKeys,
    ...(candidate.files.length > 1 ? { sameSettingsAs: candidate.files.slice(1) } : {}),
    registered: report.registered,
    ...(report.equivalent ? { alreadyAvailableAs: report.equivalent } : {}),
    ...(report.error ? { registrationError: report.error } : {}),
    verification: report.verification
      ? { status: report.verification.status, ...(report.verification.error ? { error: report.verification.error } : {}) }
      : { status: 'skipped' },
  };
}

const connectionArg = z
  .string()
  .optional()
  .describe('Name of the configured connection to use. Defaults to the server default connection.');
const databaseArg = z.string().optional().describe('Database (schema) to operate on. Defaults to the connection default.');
const paramsArg = z
  .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .optional()
  .describe(
    'Values bound to the "?" placeholders in the statement, in order. Strongly preferred over embedding literals ' +
      'in the SQL string: it avoids quoting/escaping mistakes for strings, dates and NULL.',
  );

export function registerTools(server: McpServer, db: DatabaseManager, config: ServerConfig): void {
  // ---------------------------------------------------------------- discovery

  server.registerTool(
    'list_connections',
    {
      title: 'List MySQL connections',
      description:
        'Lists the MySQL connections available to this server, together with the current write/DDL permission policy. ' +
        'Call this first when you are unsure which connection name to use.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler('list_connections', async () =>
      textResult({
        defaultConnection: config.defaultConnection || null,
        configRoot: config.configRoot,
        policy: {
          allowWrite: config.allowWrite,
          allowDdl: config.allowDdl,
          maxRows: config.maxRows,
          queryTimeoutMs: config.queryTimeoutMs,
        },
        connections: [...config.connections.values()].map((profile) => ({
          name: profile.name,
          host: profile.host,
          port: profile.port,
          user: profile.user,
          database: profile.database ?? null,
          ssl: Boolean(profile.ssl),
          source: profile.source,
          isDefault: profile.name === config.defaultConnection,
        })),
        ...(config.connections.size === 0
          ? {
              hint:
                'No connection is configured yet. Call discover_connections to detect one from the project database config files ' +
                '(e.g. a .env with MYSQL_HOST / DB_HOST / DATABASE_URL).',
            }
          : {}),
      }),
    ),
  );

  server.registerTool(
    'discover_connections',
    {
      title: 'Discover connections from project config files',
      description:
        'Scans the project directory for database configuration files (.env and friends) and reads the MySQL host, port, user and password ' +
        'from them, so no credentials have to be configured by hand. Discovered connections are registered automatically and can then be used ' +
        'by every other tool via their "connection" name. Files are parsed as text only — project code is never executed, nothing is written to disk, ' +
        `and passwords are never returned (they are masked as "***"). The scan is confined to ${config.configRoot}.`,
      inputSchema: {
        root: z
          .string()
          .optional()
          .describe('Directory to scan, relative to the allowed config root (useful for monorepos, e.g. "apps/api"). Defaults to the config root.'),
        refresh: z
          .boolean()
          .optional()
          .describe('Remove connections discovered by an earlier call before scanning again, so stale entries do not linger.'),
        register: z
          .boolean()
          .optional()
          .describe('Register the discovered connections so other tools can use them (default true). Set false to only inspect.'),
        verify: z
          .boolean()
          .optional()
          .describe('Open a short-lived connection per candidate to confirm the credentials work (default true).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(
      'discover_connections',
      async ({
        root,
        refresh,
        register,
        verify,
      }: {
        root?: string;
        refresh?: boolean;
        register?: boolean;
        verify?: boolean;
      }) => {
        const shouldRegister = register !== false;
        const shouldVerify = verify !== false;

        const scannedRoot = resolveScanRoot(config.configRoot, root);

        const removed: string[] = [];
        if (refresh === true) {
          for (const profile of [...config.connections.values()]) {
            if (profile.source === 'discovered') {
              await db.removeConnection(profile.name);
              removed.push(profile.name);
            }
          }
        }

        const discovery = discoverConnections({
          root: scannedRoot,
          port: config.connections.get(config.defaultConnection)?.port ?? 3306,
          charset: 'utf8mb4',
          connectTimeoutMs: 10_000,
        });

        const warnings = [...discovery.warnings];
        if (discovery.candidates.length === 0) {
          warnings.push(
            `No MySQL settings found. Scanned: ${discovery.scannedFiles.join(', ') || '(no .env file present)'}. ` +
              `Looked for a host + user pair via MYSQL_* / DB_* variables or a mysql:// DATABASE_URL under ${scannedRoot}.`,
          );
        }

        const registered: string[] = [];
        const registrationErrors = new Map<string, string>();
        const alreadyAvailable = new Map<string, string>();

        for (const candidate of discovery.candidates) {
          // Startup already loads the working directory's .env via dotenv, so a
          // discovered file often holds exactly the settings of a connection that
          // is already usable. Registering it again would leave two names for one
          // database and invite the agent to pick the wrong one. This lookup is
          // reported even when registration is disabled, because it tells the
          // caller which connection name to use instead.
          const equivalent = findEquivalentConnection(config.connections.values(), candidate);
          if (equivalent !== undefined) {
            alreadyAvailable.set(candidate.name, equivalent);
            continue;
          }
          if (!shouldRegister) continue;
          try {
            db.registerConnection(candidate.profile);
            registered.push(candidate.name);
          } catch (error) {
            registrationErrors.set(candidate.name, error instanceof Error ? error.message : String(error));
          }
        }

        const verification = new Map<string, { status: 'ok' | 'failed' | 'skipped'; error?: string }>();
        if (shouldVerify && discovery.candidates.length > 0) {
          const targets = discovery.candidates
            .filter((candidate) => !alreadyAvailable.has(candidate.name))
            .slice(0, MAX_VERIFIED_CANDIDATES);
          if (targets.length < discovery.candidates.length - alreadyAvailable.size) {
            warnings.push(`Only the first ${MAX_VERIFIED_CANDIDATES} candidates were verified.`);
          }
          await Promise.all(
            targets.map(async (candidate) => {
              try {
                await db.verifyProfile(candidate.profile, VERIFY_TIMEOUT_MS);
                verification.set(candidate.name, { status: 'ok' });
              } catch (error) {
                verification.set(candidate.name, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
              }
            }),
          );
        }

        const candidates = discovery.candidates.map((candidate) =>
          describeCandidate(candidate, {
            registered: registered.includes(candidate.name),
            error: registrationErrors.get(candidate.name),
            equivalent: alreadyAvailable.get(candidate.name),
            verification: verification.get(candidate.name),
          }),
        );

        const usageName = registered[0] ?? [...alreadyAvailable.values()][0];
        return textResult({
          configRoot: config.configRoot,
          scannedRoot,
          scannedFiles: discovery.scannedFiles,
          removed,
          registered,
          candidates,
          warnings,
          ...(usageName
            ? { hint: `Use the discovered settings by passing connection: "${usageName}" to the other tools.` }
            : {}),
        });
      },
    ),
  );

  server.registerTool(
    'list_databases',
    {
      title: 'List databases',
      description: 'Lists the databases (schemas) visible to the configured MySQL user.',
      inputSchema: { connection: connectionArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler('list_databases', async ({ connection }: { connection?: string }) => {
      const profile = db.resolveProfile(connection);
      const result = await db.query(profile, 'SHOW DATABASES', config.maxRows);
      return textResult({
        connection: profile.name,
        databases: firstColumnValues(result.rows),
      });
    }),
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description:
        'Lists tables and views in a database. Optionally filter by a SQL LIKE pattern (e.g. "user%"). ' +
        'The response also includes the table type (BASE TABLE / VIEW).',
      inputSchema: {
        connection: connectionArg,
        database: databaseArg,
        pattern: z.string().optional().describe('Optional SQL LIKE pattern, e.g. "order%" or "%_log".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler('list_tables', async ({ connection, database, pattern }: { connection?: string; database?: string; pattern?: string }) => {
      const profile = db.resolveProfile(connection, database);
      if (!profile.database) {
        throw new SqlGuardError('No database selected. Pass "database" or configure MYSQL_DATABASE for this connection.');
      }
      const sql = pattern ? `SHOW FULL TABLES LIKE ${quoteLiteral(pattern)}` : 'SHOW FULL TABLES';
      const result = await db.query(profile, sql, config.maxRows);

      const tables = result.rows.map((row) => {
        const values = Object.values(row);
        return { name: String(values[0] ?? ''), type: String(values[1] ?? '') };
      });
      return textResult({
        connection: profile.name,
        database: profile.database,
        tableCount: tables.length,
        tables,
      });
    }),
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe table',
      description:
        'Returns the full column definition (type, nullability, default, key, extra, comment) and the indexes of a table. ' +
        'Use this before writing queries so column names and types are accurate.',
      inputSchema: {
        connection: connectionArg,
        database: databaseArg,
        table: z.string().describe('Table or view name.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler('describe_table', async ({ connection, database, table }: { connection?: string; database?: string; table: string }) => {
      const profile = db.resolveProfile(connection, database);
      if (!profile.database) {
        throw new SqlGuardError('No database selected. Pass "database" or configure MYSQL_DATABASE for this connection.');
      }
      const identifier = quoteIdentifier(table);
      const columns = await db.query(profile, `SHOW FULL COLUMNS FROM ${identifier}`, config.maxRows);
      const indexes = await db.query(profile, `SHOW INDEX FROM ${identifier}`, config.maxRows);

      if (columns.rows.length === 0) {
        throw new SqlGuardError(`Table or view "${table}" does not exist in database "${profile.database}".`);
      }

      return textResult({
        connection: profile.name,
        database: profile.database,
        table,
        columns: columns.rows,
        indexes: indexes.rows,
      });
    }),
  );

  // ------------------------------------------------------------------- querying

  server.registerTool(
    'read_query',
    {
      title: 'Run a read-only query',
      description:
        'Executes a single read-only statement (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH ... SELECT) and returns the rows as JSON. ' +
        `Results are capped at ${config.maxRows} rows unless you pass a smaller "max_rows". ` +
        'Use this for any data inspection; it is always available regardless of the write policy.',
      inputSchema: {
        connection: connectionArg,
        database: databaseArg,
        sql: z.string().describe('A single read-only SQL statement. Do not add a trailing semicolon or extra statements.'),
        params: paramsArg,
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(config.maxRows)
          .optional()
          .describe(`Maximum rows to return for this call (1-${config.maxRows}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(
      'read_query',
      async ({
        connection,
        database,
        sql,
        params,
        max_rows,
      }: {
        connection?: string;
        database?: string;
        sql: string;
        params?: (string | number | boolean | null)[];
        max_rows?: number;
      }) => {
        const analysis: SqlAnalysis = analyze(sql);
        assertReadOnly(analysis);

        const rowLimit = Math.min(max_rows ?? config.maxRows, config.maxRows);
        const limited = applyRowLimit(analysis, rowLimit);
        const profile = db.resolveProfile(connection, database);

        logger.debug('Executing read query', { connection: profile.name, database: profile.database });
        const result = await db.query(profile, limited.sql, rowLimit, params);
        return textResult({
          connection: profile.name,
          database: profile.database ?? null,
          sql: limited.sql,
          ...formatQueryResult(result, { rowLimit, autoApplied: limited.applied }),
        });
      },
    ),
  );

  // ------------------------------------------------------------------ mutation

  server.registerTool(
    'write_query',
    {
      title: 'Run a data modification',
      description:
        'Executes a single data modification statement (INSERT / UPDATE / DELETE / REPLACE) and reports the affected row count. ' +
        `Requires MYSQL_ALLOW_WRITE=true on the server; currently ${config.allowWrite ? 'ENABLED' : 'DISABLED'}. ` +
        'UPDATE / DELETE without a WHERE clause additionally require confirm_full_table=true.',
      inputSchema: {
        connection: connectionArg,
        database: databaseArg,
        sql: z.string().describe('A single INSERT / UPDATE / DELETE / REPLACE statement.'),
        params: paramsArg,
        confirm_full_table: z
          .boolean()
          .optional()
          .describe('Set to true to acknowledge an UPDATE / DELETE that has no WHERE clause and therefore affects every row.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handler(
      'write_query',
      async ({
        connection,
        database,
        sql,
        params,
        confirm_full_table,
      }: {
        connection?: string;
        database?: string;
        sql: string;
        params?: (string | number | boolean | null)[];
        confirm_full_table?: boolean;
      }) => {
        if (!config.allowWrite) {
          throw new SqlGuardError(
            'Data modification is disabled. Set MYSQL_ALLOW_WRITE=true in the server environment to enable INSERT / UPDATE / DELETE / REPLACE.',
          );
        }

        const analysis = analyze(sql);
        assertWritable(analysis, { allowFullTable: confirm_full_table === true });

        const profile = db.resolveProfile(connection, database);
        logger.info('Executing write query', {
          connection: profile.name,
          database: profile.database,
          keyword: analysis.firstKeyword,
        });
        const result = await db.query(profile, analysis.statement, config.maxRows, params);
        return textResult({
          connection: profile.name,
          database: profile.database ?? null,
          sql: analysis.statement,
          ...formatQueryResult(result, { rowLimit: config.maxRows, autoApplied: false }),
        });
      },
    ),
  );

  server.registerTool(
    'execute_ddl',
    {
      title: 'Run a schema change',
      description:
        'Executes a single DDL statement (CREATE / ALTER / DROP / TRUNCATE / RENAME / OPTIMIZE / ANALYZE / REPAIR / CHECK). ' +
        `Requires MYSQL_ALLOW_DDL=true on the server; currently ${config.allowDdl ? 'ENABLED' : 'DISABLED'}. ` +
        'DROP and TRUNCATE are irreversible, so confirm the target with list_tables / describe_table first.',
      inputSchema: {
        connection: connectionArg,
        database: databaseArg,
        sql: z.string().describe('A single schema modification statement.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handler('execute_ddl', async ({ connection, database, sql }: { connection?: string; database?: string; sql: string }) => {
      if (!config.allowDdl) {
        throw new SqlGuardError(
          'Schema modification is disabled. Set MYSQL_ALLOW_DDL=true in the server environment to enable CREATE / ALTER / DROP / TRUNCATE.',
        );
      }

      const analysis = analyze(sql);
      assertDdl(analysis);

      const profile = db.resolveProfile(connection, database);
      logger.info('Executing DDL', { connection: profile.name, database: profile.database, keyword: analysis.firstKeyword });
      const result = await db.query(profile, analysis.statement, config.maxRows);
      return textResult({
        connection: profile.name,
        database: profile.database ?? null,
        sql: analysis.statement,
        ...formatQueryResult(result, { rowLimit: config.maxRows, autoApplied: false }),
      });
    }),
  );
}
