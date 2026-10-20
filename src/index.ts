#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig, type ServerConfig } from './config.js';
import { DatabaseManager } from './db.js';
import { discoverConnections, resolveScanRoot } from './discovery.js';
import { logger } from './logger.js';
import { registerTools } from './tools.js';

const SERVER_NAME = 'mysql-mcp';
const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  'This server exposes a MySQL database over MCP.',
  '',
  'Recommended workflow:',
  '1. Call list_connections to see the available connection names and the current write/DDL policy.',
  '2. If no connection is configured, call discover_connections: it reads the project database config files ' +
    '(.env, including MYSQL_* / DB_* variables and mysql:// DATABASE_URL) and registers the connections it finds, ' +
    'so credentials never have to be configured by hand.',
  '3. Call list_databases / list_tables / describe_table to understand the schema before querying.',
  '4. Use read_query for inspection. Prefer "params" over inline literals for values.',
  '5. write_query and execute_ddl are only available when the operator enabled them; their tool descriptions report the current state.',
  '',
  'Only one SQL statement per call is accepted, and only the statement type matching the tool is executed ' +
    '(e.g. read_query refuses INSERT/UPDATE/DELETE and DDL).',
].join('\n');

/**
 * When the operator configured no connection at all, try the project directory
 * the server was launched in before giving up: that is the whole point of the
 * discovery feature — zero manual credential configuration.
 */
function bootstrapFromProject(config: ServerConfig, db: DatabaseManager): void {
  if (config.connections.size > 0) return;

  try {
    const root = resolveScanRoot(config.configRoot);
    const discovery = discoverConnections({ root, port: 3306, charset: 'utf8mb4', connectTimeoutMs: 10_000 });
    if (discovery.candidates.length === 0) {
      logger.warn('No MySQL settings found in the project config files', { scannedRoot: root });
      return;
    }

    for (const candidate of discovery.candidates) {
      try {
        db.registerConnection(candidate.profile);
        config.defaultConnection = candidate.name;
        logger.info('Using discovered connection as the default', {
          connection: candidate.name,
          sourceFile: candidate.sourceFile,
          host: candidate.host,
          port: candidate.port,
          database: candidate.database,
        });
        return;
      } catch (error) {
        logger.debug('Candidate rejected during startup discovery', {
          connection: candidate.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    logger.warn('Startup discovery failed', { message: error instanceof Error ? error.message : String(error) });
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(`Configuration error: ${error.message}`);
      logger.error('See the "Configuration" section of .env.example for the supported environment variables.');
      process.exit(1);
    }
    throw error;
  }

  const db = new DatabaseManager(config);
  bootstrapFromProject(config, db);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  registerTools(server, db, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('Server started', {
    connections: [...config.connections.keys()].join(', ') || '(none)',
    defaultConnection: config.defaultConnection || '(none)',
    configRoot: config.configRoot,
    allowWrite: config.allowWrite,
    allowDdl: config.allowDdl,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);
    try {
      await server.close();
      await db.closeAll();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('close', () => {
    // The MCP client closed the pipe: release the MySQL connections.
    void db.closeAll().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  logger.error(`Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
