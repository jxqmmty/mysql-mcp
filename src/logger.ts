/**
 * Logging helpers.
 *
 * IMPORTANT: over a stdio transport, stdout is the MCP message channel.
 * Every log line MUST go to stderr, otherwise it corrupts the protocol stream.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;

export type LogLevel = keyof typeof LEVELS;

function resolveLevel(): number {
  const raw = (process.env.MYSQL_MCP_LOG_LEVEL ?? 'info').toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

const threshold = resolveLevel();

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVELS[level] > threshold) return;
  const suffix = meta === undefined ? '' : ` ${safeStringify(meta)}`;
  process.stderr.write(`[mysql-mcp] ${level.toUpperCase()} ${message}${suffix}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  error: (message: string, meta?: unknown) => write('error', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
};
