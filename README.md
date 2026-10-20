# mysql-mcp

基于 Node.js + TypeScript 的 MySQL MCP（Model Context Protocol）服务器。通过 MCP 协议把 MySQL 的查询与结构操作暴露给 AI 客户端（opencode / Trae / Cursor / Claude Desktop 等）。

- **传输方式**：stdio（标准输入输出），兼容所有主流 MCP 客户端
- **默认权限**：只读。增删改与 DDL 需显式开启
- **凭据来源**：可手写配置，也可从项目自身的 `.env` 自动发现，无需手工填写账号密码

> **验证状态**：协议握手、工具注册、SQL 安全拦截、配置解析、连接发现均已通过自动化测试（含真实 stdio 子进程的端到端用例）。但开发环境没有可用的 MySQL 实例，**真实数据库的往返查询尚未验证**——接入真实库后建议先用 `npm run inspector` 确认链路。

---

## 目录

- [快速开始](#快速开始)
- [客户端配置](#客户端配置)
- [工具列表](#工具列表)
- [使用示例](#使用示例)
- [自动发现连接](#自动发现连接)
- [安全模型](#安全模型)
- [配置项速查](#配置项速查)
- [结果格式](#结果格式)
- [项目结构](#项目结构)
- [开发与调试](#开发与调试)
- [已知限制](#已知限制)

---

## 快速开始

要求 Node.js >= 18。

```bash
cd d:\xm\mysql-mcp
npm install
npm run build      # 编译到 dist/，入口为 dist/index.js
```

---

## 客户端配置

### 方案 A：零配置（推荐）

不写任何账号密码。服务启动时会自动从项目数据库配置文件里读取连接信息。

```jsonc
// opencode（项目根目录的 opencode.json，或全局 ~/.config/opencode/opencode.json）
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "mysql": {
        "type": "local",
        "command": ["node", "d:\\xm\\mysql-mcp\\dist\\index.js"]
      }
    }
  }
}
```

```json
// Trae / Cursor / Claude Desktop
{
  "mcpServers": {
    "mysql": {
      "command": "node",
      "args": ["d:\\xm\\mysql-mcp\\dist\\index.js"]
    }
  }
}
```

> **注意客户端写法差异**：opencode 用 `mcp.servers.<名字>` 配合 `"disabled": false`（v2），而 Trae / Cursor / Claude Desktop 用 `mcpServers.<名字>` 配合 `env`。在 opencode v2.0.29 上，旧文档里的 `"mcp": { "<名字>": {...} }` 形式会被**静默忽略**——不报错，但 MCP 根本不会加载。

### 方案 B：显式指定连接

要连的库不在项目配置里时使用。

```jsonc
{
  "mcp": {
    "servers": {
      "mysql": {
        "type": "local",
        "command": ["node", "d:\\xm\\mysql-mcp\\dist\\index.js"],
        "environment": {
          "MYSQL_HOST": "10.88.10.100",
          "MYSQL_PORT": "3306",
          "MYSQL_USER": "readonly",
          "MYSQL_PASSWORD": "your-password",
          "MYSQL_DATABASE": "app",
          "MYSQL_MAX_ROWS": "500"
        }
      }
    }
  }
}
```

也可以直接把 [.env.example](.env.example) 复制为项目目录下的 `.env`（服务启动时用 dotenv 自动加载）。

### 方案 C：开启写权限

默认只读。在上面基础上追加：

```jsonc
"MYSQL_ALLOW_WRITE": "true",   // 允许 INSERT / UPDATE / DELETE / REPLACE
"MYSQL_ALLOW_DDL": "true"      // 再允许 CREATE / ALTER / DROP / TRUNCATE（不可恢复，谨慎）
```

### 方案 D：同时连接多个库

```jsonc
"MYSQL_CONNECTIONS": "{\"prod\":{\"host\":\"10.0.0.5\",\"user\":\"readonly\",\"password\":\"xxx\",\"database\":\"app\"},\"olap\":{\"host\":\"db2.internal\",\"user\":\"etl\",\"password\":\"yyy\",\"database\":\"warehouse\"}}"
```

JSON 配置里需写成一行并转义引号；写在 `.env` 文件里则不用转义。之后在工具调用中通过 `connection` 参数选择。

验证是否接上：

```bash
opencode mcp list          # 期望看到 ✓ mysql connected
```

---

## 工具列表

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_connections` | — | 列出可用连接、默认连接、读写权限状态与可扫描的配置根目录 |
| `discover_connections` | `root?` `refresh?` `register?` `verify?` | 扫描项目配置并自动注册连接 |
| `list_databases` | `connection?` | 列出可见的库（schema） |
| `list_tables` | `connection?` `database?` `pattern?` | 列出表/视图及类型，`pattern` 支持 SQL `LIKE` |
| `describe_table` | **`table`** `connection?` `database?` | 返回完整列定义与索引 |
| `read_query` | **`sql`** `params?` `connection?` `database?` `max_rows?` | 执行单条只读语句（SELECT / SHOW / DESCRIBE / EXPLAIN / WITH） |
| `write_query` | **`sql`** `params?` `confirm_full_table?` `connection?` `database?` | 执行增删改（需 `MYSQL_ALLOW_WRITE=true`） |
| `execute_ddl` | **`sql`** `connection?` `database?` | 执行结构变更（需 `MYSQL_ALLOW_DDL=true`） |

**加粗**为必填参数。参数含义：

- `connection`：连接名，省略则用默认连接
- `database`：库名，省略则用该连接配置的默认库
- `params`：绑定到 SQL 中 `?` 占位符的值数组。**推荐优先使用**，可避免字符串/日期/NULL 的引号转义问题
- `confirm_full_table`：`UPDATE` / `DELETE` 不带 `WHERE` 时需传 `true` 显式确认
- `max_rows`：本次调用返回行数上限（不超过 `MYSQL_MAX_ROWS`）

每个工具都带 `readOnlyHint` / `destructiveHint` 注解，客户端可据此做权限提示。

---

## 使用示例

配置好之后直接用自然语言即可，AI 会自动选择工具：

> 用 mysql 工具看看这个项目数据库里有哪些表
> 查一下 users 表里最近 10 条记录
> orders 表有哪些字段？哪个是主键？

推荐的调用顺序：

1. `list_connections` — 确认有哪些连接、权限状态
2. `discover_connections` — 若尚无连接，从项目配置里自动发现
3. `list_tables` / `describe_table` — 先搞清结构再查询
4. `read_query` — 取数据

带参数的查询示例（由 AI 调用）：

```jsonc
{
  "name": "read_query",
  "arguments": {
    "sql": "SELECT id, name FROM users WHERE status = ? AND created_at > ? LIMIT 20",
    "params": ["active", "2026-01-01"]
  }
}
```

---

## 自动发现连接

`discover_connections` 让服务从项目**自身**的数据库配置里读取地址、端口、账号、密码，无需在任何地方硬编码凭据。

**扫描的文件**：`<项目目录>/.env`、`.env.local`、`.env.development`、`.env.test` 等，以及 `config/`、`apps/api/` 等常见嵌套位置。

**识别的内容**：

- `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`，以及同义的 `DB_*` 系列
- `DATABASE_URL` / `MYSQL_URL` / `DB_URL` 等，形如 `mysql://user:pass@host:port/db`（含 `jdbc:` 前缀、`mysql2:` / `mariadb:` 协议、`%40` 百分号编码）

**安全边界**：

- 只做**文本解析**，绝不 `require` / `import` 项目代码，不执行任何项目文件
- 不向磁盘写入任何内容
- 扫描范围严格限制在 `MYSQL_CONFIG_ROOT`（默认服务启动时的工作目录）之内，`../` 逃逸会被拒绝
- 返回值中密码**永远是 `***`**；真实密码仅存在于服务进程内存
- `.env.example` / `.sample` / `.template` / `.dist` 等模板文件**不会**被扫描（里面的占位符不是真实凭据）

**其他行为**：

- 启动时若没有任何手写连接配置，会自动尝试扫描一次工作目录；配合 dotenv 对 `.env` 的自动加载，项目凭据通常无需任何手写配置即可用
- 与已存在连接**设置完全相同**的候选不会被重复注册，而是报告 `alreadyAvailableAs: "<已有连接名>"`
- 默认对候选做一次临时连接校验（3 秒超时、最多 5 个），结果在 `verification` 字段中；校验失败不影响注册状态

`discover_connections` 参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `root` | 配置根目录 | 相对扫描目录，用于 monorepo（如 `apps/api`） |
| `refresh` | `false` | 先移除上次发现的连接再重新扫描 |
| `register` | `true` | 是否注册发现的连接；`false` 表示仅查看 |
| `verify` | `true` | 是否开临时连接校验凭据 |

---

## 安全模型

默认最小权限：只开只读查询，其余全部拒绝并返回明确原因（而非静默失败）。

| 规则 | 说明 |
|---|---|
| 单语句限制 | 每次调用只允许一条语句，`SELECT 1; DROP TABLE x` 会被拒绝 |
| 可执行注释 | 拒绝 `/*! ... */` 形式，防止用注释绕过关键字检查 |
| 会话污染 | 拒绝 `USE` / `SET` 等语句 |
| 工具与语句类型匹配 | `read_query` 只接受只读语句，`write_query` 只接受 DML，`execute_ddl` 只接受 DDL |
| 锁读 | `read_query` 拒绝 `FOR UPDATE` / `LOCK IN SHARE MODE` |
| 文件操作 | 拒绝 `INTO OUTFILE` / `INTO DUMPFILE` |
| 危险动词 | `execute_ddl` 拒绝 `GRANT` / `REVOKE` / `KILL` / `SHUTDOWN` / `LOAD` |
| 全表改写 | `UPDATE` / `DELETE` 无 `WHERE` 时必须传 `confirm_full_table: true` |
| 字面量免疫 | 字符串与注释内的关键字不参与判定，`WHERE note = 'drop table x'` 不会被误拦 |
| 行数限制 | 读查询自动追加 `LIMIT maxRows+1` 探测并截断，结果标记 `truncated` |
| 错误信息 | 带 `[连接名@host:port]` 上下文，**不回显密码** |

---

## 配置项速查

完整中文说明见 [.env.example](.env.example)。关键项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | `127.0.0.1` / `3306` / `root` / — / — | 定义名为 `default` 的连接；整段留空则以自动发现模式启动 |
| `MYSQL_SSL` | `false` | 是否启用 SSL/TLS |
| `MYSQL_CHARSET` | `utf8mb4` | 连接字符集 |
| `MYSQL_CONNECT_TIMEOUT_MS` | `10000` | 建立连接超时（100–600000） |
| `MYSQL_CONNECTIONS` | — | JSON 多连接定义 |
| `MYSQL_DEFAULT_CONNECTION` | `default` | 工具未指定 `connection` 时用哪个；无 `default` 则取第一个 |
| `MYSQL_ALLOW_WRITE` | `false` | 开启 `write_query` |
| `MYSQL_ALLOW_DDL` | `false` | 开启 `execute_ddl` |
| `MYSQL_MAX_ROWS` | `1000` | 单次返回行数上限（1–100000） |
| `MYSQL_MAX_FIELD_LENGTH` | `4096` | 单字段截断长度（64–1000000） |
| `MYSQL_QUERY_TIMEOUT_MS` | `30000` | 查询超时（1000–600000） |
| `MYSQL_CONFIG_ROOT` | 启动工作目录 | 允许扫描的根目录 |
| `MYSQL_MCP_LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug`，只写 stderr |

其他内建行为：连接池按「连接名 + 库名」分池（每个连接的库级覆盖不会互相污染会话）、池大小 4、空闲 60 秒回收、池懒创建（启动阶段不连库，故工具列表响应不受数据库可用性影响）。

---

## 结果格式

查询结果统一为 JSON 文本，已做 JSON 安全化处理，可直接被模型消费：

| MySQL 类型 | 转换后 |
|---|---|
| `BIGINT` | 字符串（避免超出 JS 安全整数丢失精度） |
| `DECIMAL` | 字符串（避免浮点误差） |
| `DATE` / `DATETIME` / `TIMESTAMP` | 字符串（避免时区歧义） |
| `BLOB` / `BINARY` | `{"type":"Buffer","length":n,"data":"<base64>"}` |
| 超长字符串/二进制 | 按 `MYSQL_MAX_FIELD_LENGTH` 截断并标注 |

读查询返回 `columns`、`rowCount`、`rows`、`truncated`；写操作返回 `affectedRows`、`changedRows`、`insertId`、`warnings`。

---

## 项目结构

```
src/
  index.ts       stdio 入口：MCP Server 初始化、启动时自动发现、优雅关闭
  config.ts      环境变量解析与校验（zod）、多连接 profile、默认连接解析
  db.ts          连接池管理、结果 JSON 安全化、临时连接校验
  safety.ts      SQL 静态分析：语句分类、关键字拦截、LIMIT 注入
  discovery.ts   .env / DATABASE_URL 文本解析与连接发现
  tools.ts       8 个 MCP 工具的定义与实现
  logger.ts      仅写 stderr，避免污染 stdio 协议通道
```

日志**绝不写 stdout**：stdio 传输下 stdout 专用于 MCP 协议消息，任何日志写入都会破坏协议流。

---

## 开发与调试

```bash
npm run build      # 编译
npm run watch      # 编译监听
npm run typecheck  # 仅类型检查
npm run inspector  # 官方 MCP Inspector，可视化点按每个工具
```

排查问题：

| 现象 | 处理 |
|---|---|
| `No connection available` | 设置 `MYSQL_CONFIG_ROOT` 指向项目，或用方案 B 显式配置 |
| `Unknown connection` | 连接名拼错，先调 `list_connections` 看准确名称 |
| 认证失败 | 用 `discover_connections` 的 `verification` 字段定位是哪条候选连不上 |
| 客户端看不到工具 | 检查配置写法（见[客户端配置](#客户端配置)），`opencode mcp list` 确认连接状态 |
| 工作目录不对 | 调 `list_connections` 看返回的 `configRoot` 是否指向你的项目 |

---

## 已知限制

- **未做真实数据库验证**：开发环境无可用 MySQL 实例，真实建连与往返查询尚未实测
- **仅支持 stdio**：未实现 HTTP/SSE 远程传输
- **发现仅覆盖 `.env` 系列**：不支持 `docker-compose.yml`、`application.yml`（Spring）、`knexfile.js`、`prisma/schema.prisma` 等
- **密码含未转义 `#` 的 URL 无法解析**：`DATABASE_URL` 中的密码需做百分号编码
- **不解析 `.env` 转义序列**：`\n` 等保持字面量，与 dotenv 自身行为一致

## License

MIT
