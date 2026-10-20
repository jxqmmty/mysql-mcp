/**
 * Static SQL analysis and guard rails.
 *
 * The guard intentionally errs on the side of rejecting: it never tries to be a
 * full SQL parser, it only needs to be able to tell apart read / write / DDL
 * statements and to refuse anything that could smuggle extra behaviour in.
 */

export type StatementKind = 'read' | 'write' | 'ddl';

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlGuardError';
  }
}

export interface SqlAnalysis {
  /** Normalized statement: comments removed, single trailing semicolon stripped. */
  statement: string;
  kind: StatementKind;
  firstKeyword: string;
  /** Masked form used for keyword inspection (literals replaced by spaces). */
  masked: string;
}

const READ_STARTERS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'TABLE', 'VALUES']);
const WRITE_STARTERS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
const DDL_STARTERS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'RENAME',
  'OPTIMIZE',
  'ANALYZE',
  'REPAIR',
  'CHECK',
]);

/** Statements that neither return data nor change data, but change server state. */
const ADMIN_TOKENS = new Set([
  'SET',
  'USE',
  'CALL',
  'DO',
  'LOAD',
  'LOCK',
  'UNLOCK',
  'GRANT',
  'REVOKE',
  'FLUSH',
  'RESET',
  'PURGE',
  'KILL',
  'SHUTDOWN',
  'INSTALL',
  'UNINSTALL',
  'PREPARE',
  'EXECUTE',
  'DEALLOCATE',
  'START',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'XA',
  'HANDLER',
  'CHANGE',
  'IMPORT',
  'CLONE',
  'BINLOG',
]);

const MUTATING_TOKENS = new Set([...WRITE_STARTERS, ...DDL_STARTERS, ...ADMIN_TOKENS]);

/** Tokens that must never appear in a read-only statement. */
const FORBIDDEN_IN_READ = new Set([...MUTATING_TOKENS, 'OUTFILE', 'DUMPFILE']);

/**
 * Tokens that must never appear in a write statement. Kept to the unambiguously
 * dangerous verbs so that valid DML (`INSERT INTO t SET a = 1`) is not rejected.
 */
const FORBIDDEN_IN_WRITE = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'LOAD',
  'SHUTDOWN',
  'KILL',
  'INSTALL',
  'UNINSTALL',
  'OUTFILE',
  'DUMPFILE',
]);

/** Tokens that must never appear in a DDL statement. */
const FORBIDDEN_IN_DDL = new Set([
  'GRANT',
  'REVOKE',
  'SHUTDOWN',
  'KILL',
  'INSTALL',
  'UNINSTALL',
  'OUTFILE',
  'DUMPFILE',
]);

interface MaskResult {
  masked: string;
  /** True when a MySQL executable comment (`/*! ... *\/`) was found. */
  hasExecutableComment: boolean;
}

/**
 * Replaces every string literal, quoted identifier and comment with spaces,
 * keeping the original length so offsets stay meaningful. This makes keyword
 * scanning immune to values such as `WHERE note = 'drop table x'`.
 */
function maskLiterals(sql: string): MaskResult {
  const out: string[] = [];
  let hasExecutableComment = false;
  let i = 0;

  const push = (count: number): void => {
    for (let n = 0; n < count; n += 1) out.push(' ');
  };

  while (i < sql.length) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      let j = i + 1;
      let terminated = false;
      while (j < sql.length) {
        if (sql[j] === '\\' && quote !== '`') {
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          terminated = true;
          j += 1;
          break;
        }
        j += 1;
      }
      push(j - i);
      if (!terminated && j >= sql.length) {
        throw new SqlGuardError('Unterminated string literal or quoted identifier in SQL statement');
      }
      i = j;
      continue;
    }

    if (char === '-' && next === '-') {
      const after = sql[i + 2];
      if (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '\r') {
        let j = i;
        while (j < sql.length && sql[j] !== '\n') j += 1;
        push(j - i);
        i = j;
        continue;
      }
    }

    if (char === '#') {
      let j = i;
      while (j < sql.length && sql[j] !== '\n') j += 1;
      push(j - i);
      i = j;
      continue;
    }

    if (char === '/' && next === '*') {
      if (sql[i + 2] === '!') hasExecutableComment = true;
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) {
        throw new SqlGuardError('Unterminated block comment in SQL statement');
      }
      push(end + 2 - i);
      i = end + 2;
      continue;
    }

    out.push(char);
    i += 1;
  }

  return { masked: out.join(''), hasExecutableComment };
}

function tokenize(masked: string): string[] {
  return (masked.toUpperCase().match(/[A-Z_][A-Z0-9_$]*/g) ?? []).map((token) => token);
}

function findForbidden(masked: string, forbidden: Set<string>): string[] {
  const hits = new Set<string>();
  for (const token of tokenize(masked)) {
    if (forbidden.has(token)) hits.add(token);
  }
  return [...hits];
}

/** True when the masked statement contains a top level `WHERE` clause. */
function hasWhereClause(masked: string): boolean {
  return /\bWHERE\b/.test(masked.toUpperCase());
}

/** True when the masked statement contains a `LIMIT` clause. */
function hasLimitClause(masked: string): boolean {
  return /\bLIMIT\b/.test(masked.toUpperCase());
}

function splitStatements(masked: string): number {
  let count = 0;
  for (const part of masked.split(';')) {
    if (part.trim().length > 0) count += 1;
  }
  return count;
}

function normalizeStatement(sql: string, masked: string): string {
  // Strip a single trailing semicolon from the original statement using the
  // masked copy to locate it (the masked copy preserves offsets).
  let statement = sql;
  const lastSemicolon = masked.lastIndexOf(';');
  if (lastSemicolon !== -1 && masked.slice(lastSemicolon + 1).trim() === '') {
    statement = sql.slice(0, lastSemicolon) + masked.slice(lastSemicolon + 1);
  }
  return statement.trim();
}

export function analyze(sql: string): SqlAnalysis {
  if (!sql || sql.trim().length === 0) {
    throw new SqlGuardError('SQL statement is empty');
  }

  const { masked, hasExecutableComment } = maskLiterals(sql);
  if (hasExecutableComment) {
    throw new SqlGuardError('MySQL executable comments (/*! ... */) are not allowed; please send a plain statement instead');
  }

  const statements = splitStatements(masked);
  if (statements === 0) {
    throw new SqlGuardError('SQL statement is empty after removing comments');
  }
  if (statements > 1) {
    throw new SqlGuardError('Multiple SQL statements in a single call are not allowed; please send one statement at a time');
  }

  const statement = normalizeStatement(sql, masked);
  const normalizedMasked = maskLiterals(statement).masked;
  const tokens = tokenize(normalizedMasked);
  const firstKeyword = tokens[0] ?? '';

  let kind: StatementKind;
  if (READ_STARTERS.has(firstKeyword)) kind = 'read';
  else if (WRITE_STARTERS.has(firstKeyword)) kind = 'write';
  else if (DDL_STARTERS.has(firstKeyword)) kind = 'ddl';
  else throw new SqlGuardError(`Unsupported SQL statement starting with "${firstKeyword || '(none)'}"`);

  return { statement, kind, firstKeyword, masked: normalizedMasked };
}

export function assertReadOnly(analysis: SqlAnalysis): void {
  if (analysis.kind !== 'read') {
    throw new SqlGuardError(
      `Only read-only statements (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH) are allowed here, got "${analysis.firstKeyword}"`,
    );
  }
  const upper = analysis.masked.toUpperCase();
  if (/\bFOR\s+UPDATE\b/.test(upper) || /\bLOCK\s+IN\s+SHARE\s+MODE\b/.test(upper)) {
    throw new SqlGuardError('Locking reads (FOR UPDATE / LOCK IN SHARE MODE) are not allowed in read_query');
  }
  const forbidden = findForbidden(analysis.masked, FORBIDDEN_IN_READ);
  if (forbidden.length > 0) {
    throw new SqlGuardError(
      `Read-only query contains forbidden keyword(s): ${forbidden.join(', ')}. ` +
        'Use write_query or execute_ddl for data or schema modifications.',
    );
  }
}

export function assertWritable(analysis: SqlAnalysis, options: { allowFullTable?: boolean } = {}): void {
  if (analysis.kind !== 'write') {
    throw new SqlGuardError(
      `Only data modification statements (INSERT / UPDATE / DELETE / REPLACE) are allowed here, got "${analysis.firstKeyword}". ` +
        'Use read_query for queries or execute_ddl for schema changes.',
    );
  }
  const forbidden = findForbidden(analysis.masked, FORBIDDEN_IN_WRITE);
  if (forbidden.length > 0) {
    throw new SqlGuardError(`Write statement contains forbidden keyword(s): ${forbidden.join(', ')}`);
  }

  // UPDATE / DELETE without WHERE rewrite the whole table; require an explicit ack.
  const rewritesEverything = analysis.firstKeyword === 'UPDATE' || analysis.firstKeyword === 'DELETE';
  if (rewritesEverything && !hasWhereClause(analysis.masked) && options.allowFullTable !== true) {
    throw new SqlGuardError(
      `${analysis.firstKeyword} without a WHERE clause affects every row. ` +
        'Add a WHERE clause, or pass confirm_full_table=true to acknowledge the full-table operation.',
    );
  }
}

export function assertDdl(analysis: SqlAnalysis): void {
  if (analysis.kind !== 'ddl') {
    throw new SqlGuardError(
      `Only schema statements (CREATE / ALTER / DROP / TRUNCATE / RENAME / OPTIMIZE / ANALYZE / REPAIR / CHECK) are allowed here, got "${analysis.firstKeyword}"`,
    );
  }
  const forbidden = findForbidden(analysis.masked, FORBIDDEN_IN_DDL);
  if (forbidden.length > 0) {
    throw new SqlGuardError(`DDL statement contains forbidden keyword(s): ${forbidden.join(', ')}`);
  }
}

export interface LimitInjection {
  sql: string;
  applied: boolean;
}

/**
 * Bounds how many rows the server may buffer for a read query by appending a
 * `LIMIT` when the statement does not define one. The caller keeps `maxRows`
 * rows and reports truncation, so the extra probe row is intentional.
 */
export function applyRowLimit(analysis: SqlAnalysis, maxRows: number): LimitInjection {
  if (analysis.kind !== 'read') return { sql: analysis.statement, applied: false };
  if (!['SELECT', 'WITH'].includes(analysis.firstKeyword)) return { sql: analysis.statement, applied: false };

  const upper = analysis.masked.toUpperCase();
  if (hasLimitClause(analysis.masked)) return { sql: analysis.statement, applied: false };
  // `FOR UPDATE` / `LOCK IN SHARE MODE` must stay at the end of the statement.
  if (/\bFOR\s+UPDATE\b/.test(upper) || /\bLOCK\s+IN\s+SHARE\s+MODE\b/.test(upper)) {
    return { sql: analysis.statement, applied: false };
  }

  const probe = maxRows + 1;
  // The separator must be a newline: a trailing `--` / `#` comment in the
  // original statement would otherwise swallow the appended LIMIT clause.
  return {
    sql: `${analysis.statement}\nLIMIT ${probe}`,
    applied: true,
  };
}
