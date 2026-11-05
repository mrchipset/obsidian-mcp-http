# Obsidian MCP

**English** | [简体中文](README.zh-CN.md)

A local [Model Context Protocol](https://modelcontextprotocol.io/) server that lets MCP-compatible assistants safely read and modify explicitly configured Obsidian vaults over stdio or Streamable HTTP.

Version 2 supports both MCP `2026-07-28` and 2025-era clients by default, and requires Node.js 22 or newer. It serves stdio by default and can opt into a local Streamable HTTP transport. It works directly with Markdown files, so Obsidian does not need to be open. Legacy protocol and v1 positional-path compatibility are deprecated and print exact migration instructions to stderr.

> [!IMPORTANT]
> MCP clients can invoke destructive tools. Back up important vaults, review client permission prompts, and use revision preconditions for concurrently edited notes.

## Quick start

Node.js 22 or newer is required:

```bash
node --version # v22 or newer
```

Run with `npx` without installing the package globally. Pinning the major version receives compatible 2.x updates without automatically crossing a future major version:

```bash
npx -y obsidian-mcp@2 serve --vault notes=/absolute/path/to/vault
```

Configure an MCP client to launch the same command over stdio:

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

Alternatively, install the package globally and use `"command": "obsidian-mcp"` with the same arguments beginning at `"serve"`:

```bash
npm install -g obsidian-mcp@2
```

Each vault must already contain an `.obsidian` directory and must be configured using an absolute path.

Both protocol eras are served from the same tool definitions. After confirming that your MCP client negotiates `2026-07-28`, you may opt into modern-only mode by adding `"--legacy", "reject"` to `args`.

Vault ids use lowercase letters, digits, `_`, and `-`, must begin with a letter, and are the values assistants pass to tools. Up to ten vaults may be configured. Repeat `--vault` to expose more than one vault:

```bash
obsidian-mcp serve \
  --vault work=/Users/me/Documents/WorkVault \
  --vault personal=/Users/me/Documents/PersonalVault
```

Network, removable, hidden, and synced locations are allowed because an explicit `--vault` is treated as authorization; the same containment protections apply to every location.

## Streamable HTTP transport

stdio remains the default. Enable Streamable HTTP explicitly with `--transport http`:

```bash
npx -y obsidian-mcp@2 serve --vault notes=/absolute/path/to/vault --transport http
```

The server listens on `http://127.0.0.1:8787/mcp` by default. Point an MCP client at that URL:

```json
{
  "mcpServers": {
    "obsidian": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

To require a bearer token, start the server with `--auth-token` or set `OBSIDIAN_MCP_HTTP_TOKEN` in the server's environment, then send the same value as a header from the client:

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

`OBSIDIAN_MCP_HTTP_TOKEN` configures the server only. MCP client configuration files are not shell scripts, so substitute the token literally (or use your client's own secret expansion) instead of writing `$OBSIDIAN_MCP_HTTP_TOKEN` in the header.

| Flag                        | Default        | Purpose                                                           |
| --------------------------- | -------------- | ----------------------------------------------------------------- |
| `--transport <stdio\|http>` | `stdio`        | Serve over stdio or Streamable HTTP.                              |
| `--host <host>`             | `127.0.0.1`    | Network interface to bind.                                        |
| `--port <port>`             | `8787`         | TCP port. `0` selects an ephemeral port and reports it on stderr. |
| `--path <path>`             | `/mcp`         | HTTP endpoint path.                                               |
| `--allowed-host <hostname>` | loopback names | Additional accepted `Host` hostnames (repeatable).                |
| `--allowed-origin <origin>` | loopback names | Additional accepted `Origin` hostnames (repeatable).              |
| `--auth-token <token>`      | none           | Require `Authorization: Bearer <token>` on non-OPTIONS requests.  |
| `OBSIDIAN_MCP_HTTP_TOKEN`   | none           | Environment alternative to `--auth-token`.                        |

HTTP security notes:

- The server binds to loopback by default. Bind another interface only when you intend to accept remote connections.
- `Host` and `Origin` validation default to localhost and loopback names, which blocks DNS-rebinding attacks. Add `--allowed-host` or `--allowed-origin` only for trusted names. When binding a wildcard address such as `0.0.0.0` or `::`, also pass the public hostname with `--allowed-host`, otherwise requests addressed to it are rejected.
- Origin matching is hostname-based and ignores scheme and port, so any page served from an allowed hostname can call the endpoint. Configure a bearer token before relying on origin checks alone.
- HTTP clients are not authenticated unless `--auth-token` or `OBSIDIAN_MCP_HTTP_TOKEN` is configured. Use a token and a reverse proxy with TLS before exposing the endpoint beyond this machine.
- In the default `--legacy serve` mode, 2025-era clients are served per request without session state; `GET` and `DELETE` on the endpoint return `405`.

Smoke-test the endpoint with `curl`:

```bash
curl -i http://127.0.0.1:8787/mcp \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'
```

## Docker

Build the image and run the HTTP transport. A container must bind `0.0.0.0`, because the CLI defaults to loopback:

```bash
docker build -t obsidian-mcp .
docker run --rm -p 8787:8787 \
  -v /absolute/path/to/vault:/vault \
  -e OBSIDIAN_MCP_HTTP_TOKEN=replace-me \
  obsidian-mcp serve --vault notes=/vault --transport http --host 0.0.0.0
```

Then point clients at `http://127.0.0.1:8787/mcp` with the same bearer token. The image runs as the unprivileged `node` user (uid 1000), so the mounted vault must be readable and writable by that uid. Add `--allowed-host <hostname>` when clients address the container by a name other than localhost or 127.0.0.1. Binding `0.0.0.0` without a token exposes the vault tools to the container network.

## Design principles

- Vault access is explicitly allowlisted at process startup.
- Every tool path is vault-relative, segment-checked, and blocked from symlinks and reserved state.
- File mutations are journaled, conflict-checked, atomically replaced, and rolled back as one transaction.
- The server does not send telemetry. It uses stdio unless the HTTP transport is explicitly enabled, in which case it binds loopback by default.
- In stdio mode, stdout is reserved exclusively for MCP messages; structured diagnostics go to stderr.
- Results are bounded, paginated where appropriate, and available as both text and structured content.

## Tools

| Tool                        | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `obsidian_list_vaults`      | List configured vault ids without exposing host paths.                        |
| `obsidian_read_note`        | Read a bounded page of a note and return its SHA-256 `etag`.                  |
| `obsidian_create_note`      | Atomically create a note without overwriting.                                 |
| `obsidian_edit_note`        | Append, prepend, or replace exact note content.                               |
| `obsidian_delete_note`      | Move a note to MCP trash or permanently delete it with explicit confirmation. |
| `obsidian_move_note`        | Move or rename a note and update unambiguous backlinks transactionally.       |
| `obsidian_create_directory` | Transactionally create a directory inside a vault.                            |
| `obsidian_search_vault`     | Search content, filenames, or tags with bounded cursor pagination.            |
| `obsidian_add_tags`         | Add tags to one or more notes atomically.                                     |
| `obsidian_remove_tags`      | Remove exact, nested, or wildcard-selected tags atomically.                   |
| `obsidian_rename_tag`       | Rename a tag across the vault atomically.                                     |
| `obsidian_manage_tags`      | Unified add/remove tag workflow using the same implementation.                |

All schemas are strict JSON Schema 2020-12 contracts generated from Zod. Mutating results include a transaction id; tool failures return `isError: true` with an actionable error code.

### Reading and concurrency

`obsidian_read_note` returns an `etag`. Pass it as `if_match` to edit, move, or delete when avoiding lost updates matters. Batch tag operations accept an `expected_etags` map. A changed note returns `REVISION_CONFLICT` rather than being overwritten.

Large notes are paginated using an opaque cursor bound to the path and `etag`. Search uses an opaque cursor bound to the query and options. Tool text responses are capped at 25,000 characters.

### Deletion and recovery

Trash is the default. Deleted note bytes and metadata are stored separately under `.obsidian-mcp/trash`; metadata is never injected into the note. Permanent deletion requires `confirm_path` to exactly match the canonical relative path.

Transactions and recovery snapshots live in `.obsidian-mcp/transactions`. Completed data is retained for 30 days and pruned oldest-first above 1 GiB by default:

```bash
obsidian-mcp serve --vault work=/path \
  --recovery-days 14 \
  --recovery-max-bytes 536870912
```

Inspect or restore a completed transaction while the MCP server is stopped:

```bash
obsidian-mcp recovery list --vault work=/path
obsidian-mcp recovery restore --vault work=/path --id <transaction-id>
```

Recovery refuses to overwrite content changed since the selected transaction. Permanent deletion snapshots are purged after commit and cannot be restored.

## Path and filesystem safety

The server:

- canonicalizes configured vault roots and rejects duplicate or nested roots;
- rejects absolute, UNC, Windows-drive, NUL, backslash, empty, and dot-segment tool paths;
- reserves `.obsidian`, `.obsidian-mcp`, `.git`, `.backup`, and `.trash` from tool access;
- checks existing targets and the nearest existing ancestor for new targets;
- rejects symlinks, junctions, and reparse-point paths, and skips them during scans;
- performs no shell execution for filesystem validation;
- strictly decodes UTF-8 and does not silently replace invalid bytes.

The process needs read and write access to each configured vault. `obsidian-mcp doctor --vault id=/path` validates startup readiness and recovery state.

## Link and tag behavior

Moves recognize Obsidian Wikilinks, embeds, Markdown links, aliases, URL-encoded destinations, headings, and block anchors. A link is rewritten only when it resolves unambiguously to the source note; ambiguous links are reported and left unchanged. Deletion preserves backlinks unless `backlink_action: "mark_broken"` is requested.

Tags follow Obsidian's case-insensitive rules and support Unicode, emoji, `_`, `-`, `/`, and nested tags. Frontmatter tags are written as YAML lists. Inline tag processing ignores fenced/inline code and HTML comments. Wildcards use a bounded matcher rather than regular expressions.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run ci
```

Each tool owns a typed definition under `src/tools/<tool>/index.ts`; the small registry in `src/tools/index.ts` applies shared MCP registration and response behavior. Filesystem, transaction, Markdown, link, and search behavior live in reusable utilities. A new tool must use `VaultFs` for every path, `TransactionManager` for mutations, strict input/output schemas, structured results, annotations, and security/integration tests.

See [MIGRATING.md](MIGRATING.md) for the 1.x migration and [SECURITY.md](SECURITY.md) for vulnerability reporting.

Startup errors and compatibility warnings are written only to stderr with a stable code, the detected problem, an exact fix, a verification step, and a link to the matching migration section. If the server does not appear, find the code in the MCP client logs and use the [diagnostic reference](MIGRATING.md#diagnostic-reference).

## License

MIT
