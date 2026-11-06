import os from "node:os";
import path from "node:path";
import process from "node:process";

import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

import {
  DEFAULT_RECOVERY_BYTES,
  DEFAULT_RECOVERY_DAYS,
  MAX_VAULTS,
  SERVER_VERSION
} from "./constants.js";
import { startHttpServer } from "./http.js";
import { Runtime } from "./runtime.js";
import { buildServer } from "./server.js";
import {
  argsForDisplay,
  type Diagnostic,
  UserFacingError,
  writeDiagnostic
} from "./utils/diagnostics.js";
import { Logger, type LogLevel } from "./utils/logger.js";
import { VaultRegistry, type VaultDefinition } from "./utils/vault.js";

type Command = "serve" | "doctor" | "recovery-list" | "recovery-restore";

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 8787;
const DEFAULT_HTTP_PATH = "/mcp";

interface CliOptions {
  command: Command;
  vaults: VaultDefinition[];
  recoveryDays: number;
  recoveryMaxBytes: number;
  logLevel: LogLevel;
  legacy: "serve" | "reject";
  transport: "stdio" | "http";
  host: string;
  port: number;
  httpPath: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  canonicalArgs: string[];
  warnings: Diagnostic[];
  recoveryId?: string;
  authToken?: string;
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments([...args]);
  if (parsed === "help") {
    process.stdout.write(helpText());
    return;
  }
  if (parsed === "version") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  for (const warning of parsed.warnings) writeDiagnostic("warning", warning);

  const logger = new Logger(parsed.logLevel);
  const registry = await VaultRegistry.create(parsed.vaults);
  const runtime = new Runtime(
    registry,
    { recoveryDays: parsed.recoveryDays, recoveryMaxBytes: parsed.recoveryMaxBytes },
    logger
  );
  await runtime.initialize();

  if (parsed.command === "doctor") {
    process.stdout.write(
      `${JSON.stringify({ ok: true, vaults: await runtime.doctor() }, null, 2)}\n`
    );
    return;
  }
  if (parsed.command === "recovery-list") {
    const result = Object.fromEntries(
      await Promise.all(
        registry
          .ids()
          .map(async (id) => [id, await runtime.forVault(id).transactions.listRecovery()] as const)
      )
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (parsed.command === "recovery-restore") {
    if (parsed.recoveryId === undefined) {
      throw usageError(
        "CLI_MISSING_RECOVERY_ID",
        "Recovery restore requires a transaction id.",
        "No --id value was supplied.",
        ["Add --id <transaction-id> to the recovery restore command."],
        "recovery-changes"
      );
    }
    if (registry.ids().length !== 1) {
      throw usageError(
        "CLI_RECOVERY_VAULT_COUNT",
        "Recovery restore operates on exactly one configured vault.",
        `${registry.ids().length} vaults were configured.`,
        "Run the command again with one --vault id=/absolute/path argument.",
        "recovery-changes"
      );
    }
    const vaultId = registry.ids()[0];
    if (vaultId === undefined) throw new Error("Missing vault after validation.");
    const transactionId = await runtime
      .forVault(vaultId)
      .transactions.restoreRecovery(parsed.recoveryId);
    process.stdout.write(
      `${JSON.stringify({ ok: true, transaction_id: transactionId }, null, 2)}\n`
    );
    return;
  }

  if (parsed.command === "serve" && parsed.transport === "http") {
    const handle = await startHttpServer({
      runtime,
      host: parsed.host,
      port: parsed.port,
      path: parsed.httpPath,
      legacy: parsed.legacy,
      allowedHosts: parsed.allowedHosts,
      allowedOrigins: parsed.allowedOrigins,
      logger,
      ...(parsed.authToken === undefined ? {} : { authToken: parsed.authToken })
    });
    let closing = false;
    const close = async (signal: string): Promise<void> => {
      if (closing) return;
      closing = true;
      logger.log("info", "server_stopping", { signal });
      await handle.close();
    };
    const onSignal = (signal: string): void => {
      void close(signal).catch((error: unknown) => {
        logger.log("error", "server_stop_failed", {
          signal,
          message: error instanceof Error ? error.message : String(error)
        });
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    return;
  }

  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 10 * 1024 * 1024
  });
  let warnedLegacyClient = false;
  let reportedStrictRejection = false;
  const handle = serveStdio(
    ({ era }) => {
      if (era === "legacy" && !warnedLegacyClient) {
        warnedLegacyClient = true;
        writeDiagnostic("warning", legacyProtocolWarning(parsed.canonicalArgs));
      }
      return buildServer(runtime);
    },
    {
      legacy: parsed.legacy,
      transport,
      onerror: (error) => {
        if (
          parsed.legacy === "reject" &&
          error.message.includes("Rejected 2025-era request") &&
          !reportedStrictRejection
        ) {
          reportedStrictRejection = true;
          writeDiagnostic("error", strictProtocolDiagnostic(parsed.canonicalArgs));
          return;
        }
        logger.log("error", "stdio_error", { message: error.message });
      }
    }
  );
  logger.log("info", "server_started", { vaults: registry.ids(), version: SERVER_VERSION });
  let closing = false;
  const close = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.log("info", "server_stopping", { signal });
    await handle.close();
  };
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));
}

export function parseArguments(args: string[]): CliOptions | "help" | "version" {
  if (args.includes("--help") || args[0] === "help") return "help";
  if (args.includes("--version")) return "version";
  if (args.length > 0 && args[0] !== undefined && !isCommandToken(args[0])) {
    const first = args[0];
    const commandSuggestion = closest(first, ["serve", "doctor", "recovery"]);
    if (looksLikePath(first) || editDistance(first, commandSuggestion) > 2) {
      return parseLegacyPositional(args);
    }
  }

  const first = args.shift();
  let command: Command;
  if (first === "serve" || first === "doctor") command = first;
  else if (first === "recovery") {
    const recoveryCommand = args.shift();
    if (recoveryCommand === "list") command = "recovery-list";
    else if (recoveryCommand === "restore") command = "recovery-restore";
    else {
      throw usageError(
        "CLI_UNKNOWN_RECOVERY_COMMAND",
        "The recovery subcommand is missing or unknown.",
        recoveryCommand ?? "No recovery subcommand supplied.",
        ["Use 'recovery list' or 'recovery restore'.", usageLine()],
        "diagnostic-reference"
      );
    }
  } else {
    const suggestion =
      first === undefined ? "serve" : closest(first, ["serve", "doctor", "recovery"]);
    throw usageError(
      "CLI_UNKNOWN_COMMAND",
      "The command is missing or unknown.",
      first ?? "No command supplied.",
      [
        `Did you mean '${suggestion}'?`,
        usageLine(),
        "For an old v1 configuration, keep the vault path as the first argument and the server will show its replacement."
      ],
      "diagnostic-reference"
    );
  }

  const vaults: VaultDefinition[] = [];
  let recoveryDays = DEFAULT_RECOVERY_DAYS;
  let recoveryMaxBytes = DEFAULT_RECOVERY_BYTES;
  let logLevel: LogLevel = "info";
  let legacy: CliOptions["legacy"] = "serve";
  let transport: CliOptions["transport"] = "stdio";
  let host = DEFAULT_HTTP_HOST;
  let port = DEFAULT_HTTP_PORT;
  let httpPath = DEFAULT_HTTP_PATH;
  const allowedHosts: string[] = [];
  const allowedOrigins: string[] = [];
  let authTokenFlag: string | undefined;
  let httpOptionUsed: string | undefined;
  let recoveryId: string | undefined;
  let sawVaultFlag = false;
  const canonicalArgs = commandArgs(command);
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === undefined) break;
    if (!flag.startsWith("--")) {
      throw usageError(
        sawVaultFlag ? "CLI_MIXED_CONFIG_SYNTAX" : "CLI_UNEXPECTED_POSITIONAL_ARGUMENT",
        sawVaultFlag
          ? "Positional vault paths cannot be mixed with --vault arguments."
          : "This v2 command received an unexpected positional argument.",
        flag,
        [
          `Use only: ${argsForDisplay([...canonicalArgs, "--vault", "notes=/absolute/path/to/vault"])}`,
          'Or use only positional paths temporarily: ["/absolute/path/to/vault"]'
        ],
        "v1-positional-vault-paths"
      );
    }
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) {
      throw usageError(
        "CLI_MISSING_OPTION_VALUE",
        `Option '${flag}' requires a value.`,
        value === undefined
          ? "The command ended before a value was supplied."
          : `Found '${value}'.`,
        `Supply a value after ${flag}. Run 'obsidian-mcp --help' for examples.`,
        "diagnostic-reference"
      );
    }
    if (flag === "--vault") {
      sawVaultFlag = true;
      const vault = parseVault(value);
      vaults.push(vault);
      canonicalArgs.push(flag, `${vault.id}=${vault.root}`);
    } else if (flag === "--recovery-days") {
      recoveryDays = parsePositiveInteger(value, flag);
      canonicalArgs.push(flag, value);
    } else if (flag === "--recovery-max-bytes") {
      recoveryMaxBytes = parsePositiveInteger(value, flag);
      canonicalArgs.push(flag, value);
    } else if (flag === "--log-level" && isLogLevel(value)) {
      logLevel = value;
      canonicalArgs.push(flag, value);
    } else if (flag === "--log-level") {
      throw usageError(
        "CLI_INVALID_LOG_LEVEL",
        "The log level is invalid.",
        value,
        "Use one of: error, warn, info, debug.",
        "diagnostic-reference"
      );
    } else if (flag === "--legacy" && isLegacyMode(value)) {
      legacy = value;
      canonicalArgs.push(flag, value);
    } else if (flag === "--legacy") {
      throw usageError(
        "CLI_INVALID_LEGACY_MODE",
        "The legacy protocol mode is invalid.",
        value,
        "Use '--legacy serve' for broad compatibility or '--legacy reject' for modern-only clients.",
        "legacy-mcp-clients"
      );
    } else if (
      flag === "--transport" ||
      flag === "--host" ||
      flag === "--port" ||
      flag === "--path" ||
      flag === "--allowed-host" ||
      flag === "--allowed-origin" ||
      flag === "--auth-token"
    ) {
      if (command !== "serve") throw httpFlagRequiresServe(command, flag);
      if (flag === "--transport") {
        if (!isTransport(value)) {
          throw usageError(
            "CLI_INVALID_TRANSPORT",
            "The transport is invalid.",
            value,
            "Use '--transport stdio' for MCP clients that launch the server, or '--transport http' for a Streamable HTTP endpoint.",
            "streamable-http"
          );
        }
        transport = value;
        canonicalArgs.push(flag, value);
        continue;
      }
      httpOptionUsed ??= flag;
      if (flag === "--host") {
        host = parseBindHost(value);
        canonicalArgs.push(flag, host);
      } else if (flag === "--port") {
        port = parsePort(value);
        canonicalArgs.push(flag, String(port));
      } else if (flag === "--path") {
        httpPath = parseHttpPath(value);
        canonicalArgs.push(flag, httpPath);
      } else if (flag === "--allowed-host") {
        allowedHosts.push(parseAllowedHost(value));
        canonicalArgs.push(flag, value);
      } else if (flag === "--allowed-origin") {
        allowedOrigins.push(parseAllowedOrigin(value));
        canonicalArgs.push(flag, value);
      } else if (flag === "--auth-token") {
        if (value.length === 0) {
          throw usageError(
            "CLI_INVALID_AUTH_TOKEN",
            "The auth token is empty.",
            flag,
            "Supply a non-empty token after --auth-token, or unset OBSIDIAN_MCP_HTTP_TOKEN.",
            "streamable-http"
          );
        }
        authTokenFlag = value;
        // Never place secrets in canonicalArgs (they appear in diagnostics output).
      }
    } else if (flag === "--id") {
      recoveryId = value;
      canonicalArgs.push(flag, value);
    } else {
      const suggestion = closest(flag, [
        "--vault",
        "--recovery-days",
        "--recovery-max-bytes",
        "--log-level",
        "--legacy",
        "--transport",
        "--host",
        "--port",
        "--path",
        "--allowed-host",
        "--allowed-origin",
        "--auth-token",
        "--id"
      ]);
      throw usageError(
        "CLI_UNKNOWN_OPTION",
        "The command contains an unknown option.",
        flag,
        [`Did you mean '${suggestion}'?`, "Run 'obsidian-mcp --help' to list supported options."],
        "diagnostic-reference"
      );
    }
  }
  if (command === "serve" && transport === "stdio" && httpOptionUsed !== undefined) {
    throw usageError(
      "CLI_HTTP_OPTION_WITHOUT_HTTP",
      "HTTP options require the Streamable HTTP transport.",
      httpOptionUsed,
      [
        `Add '--transport http' to serve over Streamable HTTP, or remove ${httpOptionUsed}.`,
        "Use --transport stdio (the default) for MCP clients that launch the server."
      ],
      "streamable-http"
    );
  }
  const envToken = process.env.OBSIDIAN_MCP_HTTP_TOKEN;
  const mcpApiKey = process.env.MCP_API_KEY;
  const authToken =
    transport === "http"
      ? (authTokenFlag ??
        (envToken !== undefined && envToken.length > 0 ? envToken : undefined) ??
        (mcpApiKey !== undefined && mcpApiKey.length > 0 ? mcpApiKey : undefined))
      : undefined;
  if (vaults.length === 0) {
    throw usageError(
      "CLI_VAULT_REQUIRED",
      "At least one Obsidian vault must be configured.",
      "No --vault argument was supplied.",
      `Use: ${argsForDisplay([...commandArgs(command), "--vault", "notes=/absolute/path/to/vault"])}`,
      "v1-positional-vault-paths"
    );
  }
  if (vaults.length > MAX_VAULTS) {
    throw usageError(
      "CLI_TOO_MANY_VAULTS",
      `At most ${MAX_VAULTS} vaults may be configured.`,
      `${vaults.length} vaults were supplied.`,
      `Remove vault arguments until no more than ${MAX_VAULTS} remain.`,
      "diagnostic-reference"
    );
  }
  return {
    command,
    vaults,
    recoveryDays,
    recoveryMaxBytes,
    logLevel,
    legacy,
    transport,
    host,
    port,
    httpPath,
    allowedHosts,
    allowedOrigins,
    canonicalArgs,
    warnings: [],
    ...(recoveryId === undefined ? {} : { recoveryId }),
    ...(authToken === undefined ? {} : { authToken })
  };
}

function parseLegacyPositional(args: string[]): CliOptions {
  const flag = args.find((arg) => arg.startsWith("--"));
  if (flag !== undefined) {
    throw usageError(
      "CLI_MIXED_CONFIG_SYNTAX",
      "Positional vault paths cannot be mixed with v2 options.",
      `Found positional paths together with '${flag}'.`,
      [
        "Use only positional vault paths temporarily, or migrate every path to --vault id=/absolute/path.",
        'Example: ["serve", "--vault", "notes=/absolute/path/to/vault"]'
      ],
      "v1-positional-vault-paths"
    );
  }
  if (args.length > MAX_VAULTS) {
    throw usageError(
      "CLI_TOO_MANY_VAULTS",
      `At most ${MAX_VAULTS} vaults may be configured.`,
      `${args.length} positional paths were supplied.`,
      `Remove paths until no more than ${MAX_VAULTS} remain.`,
      "diagnostic-reference"
    );
  }
  const roots = args.map(expandLegacyPath);
  const ids = uniqueVaultIds(roots);
  const vaults = roots.map((root, index) => ({ id: ids[index] ?? "vault", root }));
  const canonicalArgs = ["serve"];
  for (const vault of vaults) canonicalArgs.push("--vault", `${vault.id}=${vault.root}`);
  const mappings = vaults.map((vault) => `${vault.root} -> ${vault.id}`);
  return {
    command: "serve",
    vaults,
    recoveryDays: DEFAULT_RECOVERY_DAYS,
    recoveryMaxBytes: DEFAULT_RECOVERY_BYTES,
    logLevel: "info",
    legacy: "serve",
    transport: "stdio",
    host: DEFAULT_HTTP_HOST,
    port: DEFAULT_HTTP_PORT,
    httpPath: DEFAULT_HTTP_PATH,
    allowedHosts: [],
    allowedOrigins: [],
    canonicalArgs,
    warnings: [
      {
        code: "V1_POSITIONAL_CONFIG_DEPRECATED",
        problem:
          "This v1 positional vault configuration still works, but it will become invalid in a future release.",
        detected: mappings,
        fix: [
          "Replace the MCP server args with:",
          argsForDisplay(canonicalArgs),
          "Restart the MCP client after saving the configuration."
        ],
        verify: argsForDisplay(["doctor", ...canonicalArgs.slice(1)]),
        helpAnchor: "v1-positional-vault-paths"
      }
    ]
  };
}

function parseVault(value: string): VaultDefinition {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw usageError(
      "CLI_INVALID_VAULT_ARGUMENT",
      "The --vault value is malformed.",
      value,
      [
        "Use the form id=/absolute/path.",
        'Example: ["serve", "--vault", "notes=/absolute/path/to/vault"]'
      ],
      "v1-positional-vault-paths"
    );
  }
  return { id: value.slice(0, separator), root: value.slice(separator + 1) };
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw usageError(
      "CLI_INVALID_POSITIVE_INTEGER",
      `${flag} requires a positive integer.`,
      value,
      `Replace '${value}' with a whole number greater than zero.`,
      "diagnostic-reference"
    );
  }
  return parsed;
}

function expandLegacyPath(value: string): string {
  const expanded =
    value === "~"
      ? os.homedir()
      : value.startsWith(`~${path.sep}`) || value.startsWith("~/")
        ? path.join(os.homedir(), value.slice(2))
        : value;
  return path.resolve(expanded);
}

function uniqueVaultIds(roots: readonly string[]): string[] {
  const used = new Set<string>();
  return roots.map((root) => {
    const initial = vaultIdFromPath(root);
    let id = initial;
    let suffix = 2;
    while (used.has(id)) {
      const ending = `-${suffix}`;
      id = `${initial.slice(0, 64 - ending.length).replace(/[-_]+$/u, "")}${ending}`;
      suffix += 1;
    }
    used.add(id);
    return id;
  });
}

function vaultIdFromPath(root: string): string {
  let id = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-");
  id = id.replace(/^[-_]+|[-_]+$/gu, "");
  if (id.length === 0) id = "vault";
  if (!/^[a-z]/u.test(id)) id = `vault-${id}`;
  return id.slice(0, 64).replace(/[-_]+$/u, "") || "vault";
}

function usageError(
  code: string,
  problem: string,
  detected: string | readonly string[],
  fix: string | readonly string[],
  helpAnchor: string
): UserFacingError {
  return new UserFacingError({ code, problem, detected, fix, helpAnchor }, 2);
}

function legacyProtocolWarning(canonicalArgs: readonly string[]): Diagnostic {
  return {
    code: "LEGACY_MCP_PROTOCOL",
    problem:
      "The connected MCP client uses the 2025-era protocol. It is supported for now but will become unsupported in a future release.",
    detected: "A legacy initialize handshake was received.",
    fix: [
      "Upgrade the MCP client or host to one that negotiates MCP 2026-07-28.",
      "Keep the current configuration until the client upgrade is complete."
    ],
    verify: `After upgrading, strict mode should connect with args ${argsForDisplay(withLegacyMode(canonicalArgs, "reject"))}`,
    helpAnchor: "legacy-mcp-clients"
  };
}

function strictProtocolDiagnostic(canonicalArgs: readonly string[]): Diagnostic {
  return {
    code: "STRICT_PROTOCOL_REJECTION",
    problem: "Modern-only mode rejected a client using the 2025-era MCP protocol.",
    detected:
      "The client opened with a legacy initialize handshake while --legacy reject is active.",
    fix: [
      "Upgrade the MCP client to MCP 2026-07-28, or temporarily allow compatibility with:",
      argsForDisplay(withLegacyMode(canonicalArgs, "serve"))
    ],
    verify: "Restart the MCP client and confirm the server appears and lists tools.",
    helpAnchor: "legacy-mcp-clients"
  };
}

function withLegacyMode(args: readonly string[], mode: "serve" | "reject"): string[] {
  const result = [...args];
  const index = result.indexOf("--legacy");
  if (index >= 0) result.splice(index, 2, "--legacy", mode);
  else result.push("--legacy", mode);
  return result;
}

function commandArgs(command: Command): string[] {
  if (command === "recovery-list") return ["recovery", "list"];
  if (command === "recovery-restore") return ["recovery", "restore"];
  return [command];
}

function isCommandToken(value: string): boolean {
  return value === "serve" || value === "doctor" || value === "recovery";
}

function looksLikePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function isLogLevel(value: string): value is LogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug";
}

function isLegacyMode(value: string): value is CliOptions["legacy"] {
  return value === "serve" || value === "reject";
}

function isTransport(value: string): value is CliOptions["transport"] {
  return value === "stdio" || value === "http";
}

function httpFlagRequiresServe(command: Command, flag: string): UserFacingError {
  return usageError(
    "CLI_HTTP_OPTION_WITHOUT_HTTP",
    "HTTP options are only supported by the serve command.",
    `${flag} was supplied to '${commandArgs(command).join(" ")}'.`,
    [
      `Remove ${flag}, or run the serve command with '--transport http'.`,
      `Use: ${argsForDisplay([...commandArgs("serve"), "--transport", "http", "--vault", "notes=/absolute/path"])}`
    ],
    "streamable-http"
  );
}

function parseBindHost(value: string): string {
  const trimmed = value.trim();
  const hostWithPort = /^[^:]+:\d+$/u.test(trimmed);
  if (
    trimmed.length === 0 ||
    /[\s/?#%]/u.test(trimmed) ||
    trimmed.includes("://") ||
    hostWithPort
  ) {
    throw usageError(
      "CLI_INVALID_HOST",
      "The bind host is invalid.",
      value,
      "Use a hostname or IP address without a port, for example 127.0.0.1, localhost, or ::1.",
      "streamable-http"
    );
  }
  return trimmed;
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw invalidPort(value);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 65535) {
    throw invalidPort(value);
  }
  return parsed;
}

function invalidPort(value: string): UserFacingError {
  return usageError(
    "CLI_INVALID_PORT",
    "The HTTP port is invalid.",
    value,
    "Use a whole number between 0 and 65535 (0 selects an ephemeral port).",
    "streamable-http"
  );
}

function parseHttpPath(value: string): string {
  if (!value.startsWith("/") || /[\s?#]/u.test(value)) {
    throw usageError(
      "CLI_INVALID_HTTP_PATH",
      "The HTTP endpoint path is invalid.",
      value,
      "Use a path that starts with '/', contains no whitespace, query, or fragment, for example /mcp.",
      "streamable-http"
    );
  }
  const segments = value.split("/").filter((segment) => segment.length > 0);
  const normalized = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  if (normalized === "/upload") {
    throw usageError(
      "CLI_INVALID_HTTP_PATH",
      "The '/upload' path is reserved for asset uploads.",
      value,
      "Choose a different --path, for example /mcp.",
      "streamable-http"
    );
  }
  return normalized;
}

function parseAllowedHost(value: string): string {
  const trimmed = value.trim();
  const bracketedIpv6 = /^\[[0-9a-f:.]+\]$/iu.test(trimmed);
  if (
    trimmed.length === 0 ||
    /[\s/?#]/u.test(trimmed) ||
    trimmed.includes("://") ||
    (trimmed.includes(":") && !bracketedIpv6)
  ) {
    throw usageError(
      "CLI_INVALID_ALLOWED_HOST",
      "The allowed host is invalid.",
      value,
      "Use a bare hostname without a scheme or port (for example notes.example.com, or [::1] for IPv6).",
      "streamable-http"
    );
  }
  return trimmed;
}

function parseAllowedOrigin(value: string): string {
  const trimmed = value.trim();
  const bracketedIpv6 = /^\[[0-9a-f:.]+\]$/iu.test(trimmed);
  if (
    trimmed.length === 0 ||
    /[\s/?#]/u.test(trimmed) ||
    trimmed.includes("://") ||
    (trimmed.includes(":") && !bracketedIpv6)
  ) {
    throw invalidAllowedOrigin(value);
  }
  return trimmed;
}

function invalidAllowedOrigin(value: string): UserFacingError {
  return usageError(
    "CLI_INVALID_ALLOWED_ORIGIN",
    "The allowed origin is invalid.",
    value,
    "Use a bare hostname without a scheme or port, for example localhost, 192.168.1.10, or [::1].",
    "streamable-http"
  );
}

function closest(value: string, candidates: readonly string[]): string {
  return [...candidates].sort((a, b) => editDistance(value, a) - editDistance(value, b))[0] ?? "";
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + substitution
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function usageLine(): string {
  return "Usage: obsidian-mcp serve --vault notes=/absolute/path/to/vault";
}

function helpText(): string {
  return `obsidian-mcp ${SERVER_VERSION}

Usage:
  obsidian-mcp serve --vault <id>=<absolute-path> [--vault ...] [--transport stdio|http] [--legacy serve|reject]
  obsidian-mcp doctor --vault <id>=<absolute-path> [--vault ...]
  obsidian-mcp recovery list --vault <id>=<absolute-path> [--vault ...]
  obsidian-mcp recovery restore --vault <id>=<absolute-path> --id <transaction-id>

Compatibility:
  obsidian-mcp <vault-path> [vault-path ...]  Deprecated v1 syntax; prints replacement args

Options:
  --vault <id>=<path>          Configure one vault (required, repeatable, maximum 10)
  --recovery-days <days>       Completed journal retention (default: 30)
  --recovery-max-bytes <bytes> Recovery storage limit (default: 1073741824)
  --log-level <level>          error, warn, info, or debug
  --legacy <mode>              2025-era client handling: serve (default) or reject
  --help                       Show help
  --version                    Show version

HTTP transport options (serve only, with --transport http):
  --transport <mode>           stdio (default) or http
  --host <host>                Bind address (default: 127.0.0.1)
  --port <port>                TCP port, 0 selects an ephemeral port (default: 8787)
  --path <path>                Endpoint path (default: /mcp)
  --allowed-host <hostname>    Extra allowed Host header value (repeatable)
  --allowed-origin <origin>    Extra allowed Origin hostname (repeatable)
  --auth-token <token>         Require Authorization: Bearer <token>
                               (falls back to OBSIDIAN_MCP_HTTP_TOKEN, then MCP_API_KEY)

  Asset endpoints (with --transport http):
  POST /upload                 multipart/form-data: vault, path, file, overwrite
                               Requires the same bearer token
  Resources                    obsidian-mcp://vaults/{vaultId}/files/{path}

  Note: 2025-era HTTP requests are served statelessly; GET and DELETE return 405.
`;
}
