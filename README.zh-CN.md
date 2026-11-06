# Obsidian MCP

[English](README.md) | **简体中文**

一个本地 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器，让兼容 MCP 的助手可以通过 stdio 或 Streamable HTTP，安全地读取和修改显式配置的 Obsidian vault。

版本 2 默认同时支持 MCP `2026-07-28` 和 2025 版协议的客户端，并要求 Node.js 22 或更高版本。默认使用 stdio，也可以显式启用本地 Streamable HTTP transport。它直接操作 Markdown 文件，因此不需要打开 Obsidian。旧协议和 v1 位置参数路径兼容已弃用，运行时会向 stderr 输出准确的迁移说明。

> [!IMPORTANT]
> MCP 客户端可以调用破坏性工具。请备份重要的 vault，检查客户端的权限确认提示，并在并发编辑笔记时使用修订前置条件。

## 快速开始

需要 Node.js 22 或更高版本：

```bash
node --version # v22 or newer
```

无需全局安装，直接用 `npx` 运行。固定主版本可以在不跨入未来大版本的前提下获得兼容的 2.x 更新：

```bash
npx -y obsidian-mcp@2 serve --vault notes=/absolute/path/to/vault
```

配置 MCP 客户端通过 stdio 启动同一命令：

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-mcp@2", "serve", "--vault", "notes=/absolute/path/to/vault"]
    }
  }
}
```

也可以全局安装，然后把 `"command"` 改为 `"obsidian-mcp"`，参数从 `"serve"` 开始保持不变：

```bash
npm install -g obsidian-mcp@2
```

每个 vault 必须已经包含 `.obsidian` 目录，并且必须使用绝对路径配置。

两种协议版本共用同一套工具定义。确认 MCP 客户端可以协商 `2026-07-28` 后，可以在 `args` 中加入 `"--legacy", "reject"` 启用仅现代协议模式。

Vault id 只能使用小写字母、数字、`_` 和 `-`，必须以字母开头，也是助手调用工具时传入的值。最多可以配置十个 vault。重复传入 `--vault` 可以暴露多个 vault：

```bash
obsidian-mcp serve \
  --vault work=/Users/me/Documents/WorkVault \
  --vault personal=/Users/me/Documents/PersonalVault
```

允许使用网络、可移动、隐藏和同步目录，因为显式传入 `--vault` 即被视为授权；所有位置都应用相同的路径隔离保护。

## Streamable HTTP transport

stdio 仍是默认方式。通过 `--transport http` 显式启用 Streamable HTTP：

```bash
npx -y obsidian-mcp@2 serve --vault notes=/absolute/path/to/vault --transport http
```

服务器默认监听 `http://127.0.0.1:8787/mcp`。把 MCP 客户端指向该 URL：

```json
{
  "mcpServers": {
    "obsidian": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

如需强制 Bearer Token，启动服务器时传入 `--auth-token`，或在服务器环境中设置 `OBSIDIAN_MCP_HTTP_TOKEN`（也支持 `MCP_API_KEY`），然后在客户端发送相同的值：

```json
{
  "mcpServers": {
    "obsidian": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

`OBSIDIAN_MCP_HTTP_TOKEN` 只用于配置服务器。MCP 客户端配置文件不是 shell 脚本，因此请在 header 中直接写入 token（或使用客户端自己的密钥展开机制），不要写 `$OBSIDIAN_MCP_HTTP_TOKEN`。

| 参数                        | 默认值       | 用途                                                          |
| --------------------------- | ------------ | ------------------------------------------------------------- |
| `--transport <stdio\|http>` | `stdio`      | 通过 stdio 或 Streamable HTTP 提供服务。                      |
| `--host <host>`             | `127.0.0.1`  | 绑定的网络接口。                                              |
| `--port <port>`             | `8787`       | TCP 端口。`0` 表示选择临时端口，并在 stderr 中报告。          |
| `--path <path>`             | `/mcp`       | HTTP 端点路径。                                               |
| `--allowed-host <hostname>` | 回环地址名称 | 额外接受的 `Host` 主机名（可重复）。                          |
| `--allowed-origin <origin>` | 回环地址名称 | 额外接受的 `Origin` 主机名（可重复）。                        |
| `--auth-token <token>`      | 无           | 要求所有非 OPTIONS 请求携带 `Authorization: Bearer <token>`。 |
| `OBSIDIAN_MCP_HTTP_TOKEN`   | 无           | `--auth-token` 的环境变量形式；`MCP_API_KEY` 同样可用。       |

HTTP 安全说明：

- 服务器默认只绑定回环地址。只有确实需要接受远程连接时，才绑定其他网络接口。
- `Host` 和 `Origin` 校验默认只接受 localhost 和回环地址名称，用于阻止 DNS 重绑定攻击。只为可信名称添加 `--allowed-host` 或 `--allowed-origin`。绑定 `0.0.0.0` 或 `::` 等通配地址时，还必须通过 `--allowed-host` 传入公网主机名，否则发往该主机名的请求会被拒绝。
- Origin 匹配只比较主机名，忽略 scheme 和端口，因此任何由允许的主机名提供的页面都可以调用该端点。不要只依赖 Origin 校验，应同时配置 Bearer Token。
- 除非配置了 `--auth-token`、`OBSIDIAN_MCP_HTTP_TOKEN` 或 `MCP_API_KEY`，否则 HTTP 客户端不会经过鉴权。把端点暴露到本机之外前，请使用 token，并放在带 TLS 的反向代理之后。
- 默认 `--legacy serve` 模式下，2025 版协议的客户端按请求无状态处理；端点上的 `GET` 和 `DELETE` 返回 `405`。

用 `curl` 对端点做一次冒烟测试：

```bash
curl -i http://127.0.0.1:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'
```

## Vault 文件资源与上传

### 以 MCP resource 读取文件

HTTP 和 stdio transport 都会注册一个 resource template，可通过 `resources/templates/list` 发现：

```text
obsidian-mcp://vaults/{vaultId}/files/{vault 相对路径}
```

例如 `obsidian-mcp://vaults/notes/files/publish/wechat-main/assets/demo/cover.png`。

- 文本文件（`.md`、`.txt`、`.json`、`.yaml`、`.csv`、`.html`、`.xml` 等）以 `text` 返回。
- `image/png`、`image/jpeg`、`image/webp`、`image/gif`、`image/svg+xml`、`application/pdf` 以 base64 `blob` 返回，并带正确的 `mimeType`。
- 读取为只读操作，复用与工具相同的 vault 路径校验，并受 `RESOURCE_MAX_BYTES` 限制（默认 10 MB）。文件不存在或超过限制时返回带可操作说明的 MCP resource 错误。
- 原有 `obsidian-mcp://vaults` 资源保持不变。

### 通过 HTTP 上传文件

`POST /upload` 与 MCP 共用同一个 HTTP server，请求体为 `multipart/form-data`，并要求与 MCP 相同的 Bearer Token：

| 字段        | 必填 | 说明                                |
| ----------- | ---- | ----------------------------------- |
| `vault`     | 是   | vault id，例如 `notes`。            |
| `path`      | 是   | vault 相对路径，包含文件名。        |
| `file`      | 是   | 文件内容。                          |
| `overwrite` | 否   | `true` 覆盖已有文件；默认 `false`。 |

```bash
export MCP_API_KEY=replace-me
curl -sS -X POST http://127.0.0.1:8811/upload \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -F vault=notes \
  -F "path=publish/wechat-main/assets/demo/cover.png" \
  -F file=@./cover.png
```

成功时返回规范化路径、字节数、SHA-256 与识别出的 MIME 类型：

```json
{
  "vault": "notes",
  "path": "publish/wechat-main/assets/demo/cover.png",
  "bytes": 12345,
  "sha256": "…",
  "mimeType": "image/png"
}
```

行为与限制：

- 允许 PNG、JPEG、WebP、GIF、SVG、PDF；其他扩展名返回 `415`。
- `UPLOAD_MAX_BYTES` 控制请求大小限制（默认 20 MB），超出返回 `413`。
- 自动创建缺失的父目录。文件先写入同目录临时文件再 rename，POSIX 下最终权限为 `0644`。
- 未显式传入 `overwrite=true` 时不会覆盖已有文件，冲突返回 `409`。
- 路径校验与工具完全一致：绝对路径、`..`、反斜杠、`.obsidian`、`.obsidian-mcp` 及其他保留目录返回 `400`。
- 未配置 token 时 `/upload` 始终返回 `401`。只有以 HTTP 模式启动时该路由才存在（`--transport http`；上面的示例使用 `--port 8811`）。

| 状态码 | 含义                                       |
| ------ | ------------------------------------------ |
| `400`  | 字段缺失/非法、路径不安全或 multipart 错误 |
| `401`  | Bearer Token 缺失或错误                    |
| `404`  | vault id 未配置                            |
| `409`  | 目标已存在且未传 `overwrite=true`          |
| `413`  | 请求体超过 `UPLOAD_MAX_BYTES`              |
| `415`  | 扩展名不在允许的 MIME 列表中               |

## Docker

构建镜像并运行 HTTP transport。容器必须绑定 `0.0.0.0`，因为 CLI 默认只监听回环地址：

```bash
docker build -t obsidian-mcp .
docker run --rm -p 8787:8787 \
  -v /absolute/path/to/vault:/vault \
  -e OBSIDIAN_MCP_HTTP_TOKEN=replace-me \
  obsidian-mcp serve --vault notes=/vault --transport http --host 0.0.0.0
```

然后把客户端指向 `http://127.0.0.1:8787/mcp`，并使用相同的 Bearer Token。镜像以非特权 `node` 用户（uid 1000）运行，因此挂载的 vault 必须对该 uid 可读写。如果客户端通过 localhost 或 127.0.0.1 之外的主机名访问容器，请添加 `--allowed-host <hostname>`。绑定 `0.0.0.0` 且不配置 token，会把 vault 工具暴露给容器网络。

## 设计原则

- Vault 访问在进程启动时显式加入允许列表。
- 所有工具路径都相对于 vault，逐段校验，并阻止符号链接和保留状态目录。
- 文件修改会记录事务日志、检查冲突、原子替换，并在单个事务中回滚。
- 服务器不发送遥测数据。除非显式启用 HTTP transport，否则使用 stdio；启用 HTTP 时默认只绑定回环地址。
- 在 stdio 模式下，stdout 专用于 MCP 消息；结构化诊断信息写入 stderr。
- 结果有大小上限，按需分页，并同时提供文本和结构化内容。

## 工具

| 工具                        | 用途                                                   |
| --------------------------- | ------------------------------------------------------ |
| `obsidian_list_vaults`      | 列出已配置的 vault id，不暴露宿主机路径。              |
| `obsidian_read_note`        | 读取笔记的一页内容，并返回其 SHA-256 `etag`。          |
| `obsidian_create_note`      | 原子创建笔记，不覆盖已有文件。                         |
| `obsidian_edit_note`        | 追加、前置或精确替换笔记内容。                         |
| `obsidian_delete_note`      | 把笔记移入 MCP 回收站，或在明确确认后永久删除。        |
| `obsidian_move_note`        | 移动或重命名笔记，并在同一事务中更新无歧义的反向链接。 |
| `obsidian_create_directory` | 在 vault 内以事务方式创建目录。                        |
| `obsidian_search_vault`     | 搜索正文、文件名或标签，支持有界游标分页。             |
| `obsidian_add_tags`         | 原子地为一篇或多篇笔记添加标签。                       |
| `obsidian_remove_tags`      | 原子地删除精确、嵌套或通配符匹配的标签。               |
| `obsidian_rename_tag`       | 在整个 vault 中原子地重命名标签。                      |
| `obsidian_manage_tags`      | 基于同一实现统一处理添加/删除标签。                    |

所有 schema 都是由 Zod 生成的严格 JSON Schema 2020-12 契约。修改类结果会包含 transaction id；工具失败时返回 `isError: true` 和可操作的错误码。

### 读取与并发

`obsidian_read_note` 会返回 `etag`。在需要避免丢失更新时，把它作为 `if_match` 传给编辑、移动或删除操作。批量标签操作支持 `expected_etags` 映射。如果笔记已被修改，操作会返回 `REVISION_CONFLICT`，而不是覆盖内容。

大笔记使用与路径和 `etag` 绑定的不透明游标分页。搜索使用与查询和选项绑定的不透明游标。工具文本响应上限为 25,000 个字符。

### 删除与恢复

默认使用回收站。被删除笔记的字节和元数据分别存放在 `.obsidian-mcp/trash` 下；元数据不会注入笔记内容。永久删除要求 `confirm_path` 与规范化的相对路径完全一致。

事务和恢复快照存放在 `.obsidian-mcp/transactions`。已完成的数据默认保留 30 天，超过 1 GiB 时按最旧优先清理：

```bash
obsidian-mcp serve --vault work=/path \
  --recovery-days 14 \
  --recovery-max-bytes 536870912
```

在 MCP 服务器停止时，可以检查或恢复已完成的事务：

```bash
obsidian-mcp recovery list --vault work=/path
obsidian-mcp recovery restore --vault work=/path --id <transaction-id>
```

恢复操作会拒绝覆盖自所选事务以来已修改的内容。永久删除的快照会在提交后清除，无法恢复。

## 路径与文件系统安全

服务器会：

- 规范化配置的 vault 根目录，并拒绝重复或嵌套的根目录；
- 拒绝绝对路径、UNC 路径、Windows 盘符、NUL、反斜杠、空段和点段工具路径；
- 保留 `.obsidian`、`.obsidian-mcp`、`.git`、`.backup` 和 `.trash`，禁止工具访问；
- 对已有目标检查目标本身，对新目标检查最近的已存在祖先；
- 拒绝符号链接、junction 和重解析点路径，并在扫描时跳过它们；
- 文件系统校验不执行任何 shell 命令；
- 严格按 UTF-8 解码，不会静默替换非法字节。

进程需要对每个配置的 vault 具有读写权限。`obsidian-mcp doctor --vault id=/path` 可以校验启动就绪状态和恢复状态。

## 链接与标签行为

移动操作会识别 Obsidian Wikilink、嵌入、Markdown 链接、别名、URL 编码目标、标题和块锚点。只有当链接无歧义地指向源笔记时才会重写；有歧义的链接会被报告并保持不变。删除操作默认保留反向链接，除非请求 `backlink_action: "mark_broken"`。

标签遵循 Obsidian 的大小写不敏感规则，支持 Unicode、emoji、`_`、`-`、`/` 和嵌套标签。Frontmatter 标签写为 YAML 列表。内联标签处理会忽略围栏代码、行内代码和 HTML 注释。通配符使用有界匹配器，而不是正则表达式。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run ci
```

每个工具在 `src/tools/<tool>/index.ts` 下拥有带类型的定义；`src/tools/index.ts` 中的小型注册表统一应用 MCP 注册和响应行为。文件系统、事务、Markdown、链接和搜索行为位于可复用的工具函数中。新增工具必须对每个路径使用 `VaultFs`，对修改使用 `TransactionManager`，并遵循严格的输入/输出 schema、结构化结果、annotations 以及安全/集成测试要求。

1.x 迁移见 [MIGRATING.md](MIGRATING.md)，漏洞报告见 [SECURITY.md](SECURITY.md)。

启动错误和兼容性警告只写入 stderr，包含稳定错误码、检测到的问题、准确的修复方法、验证步骤，以及指向对应迁移章节的链接。如果服务器没有出现，请在 MCP 客户端日志中找到错误码，并使用[诊断参考](MIGRATING.md#diagnostic-reference)。

## License

MIT
