import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { DEFAULT_UPLOAD_MAX_BYTES, readByteLimit } from "./assets/limits.js";
import { readUploadRequest, storeUpload, UploadRequestError } from "./assets/upload.js";
import { SERVER_VERSION } from "./constants.js";
import type { Runtime } from "./runtime.js";
import { buildServer } from "./server.js";
import { UserFacingError } from "./utils/diagnostics.js";
import { ToolFailure } from "./utils/errors.js";
import type { Logger } from "./utils/logger.js";

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const UPLOAD_PATH = "/upload";
const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];
const CORS_ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const CORS_ALLOW_HEADERS =
  "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID";
const CORS_EXPOSE_HEADERS = "Mcp-Session-Id";

export interface HttpServerOptions {
  runtime: Runtime;
  host: string;
  port: number;
  path: string;
  legacy: "serve" | "reject";
  authToken?: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  logger: Logger;
}

export interface HttpServerHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const { logger } = options;
  const endpointPath = normalizeEndpointPath(options.path);

  const allowedHostnames = buildAllowedHostnames(options.host, options.allowedHosts);
  // The SDK guard compares Origin hostnames exactly, while URL parsing lowercases
  // the incoming hostname, so normalize configured origins before registering them.
  const allowedOrigins = [
    ...DEFAULT_ALLOWED_HOSTS,
    ...options.allowedOrigins.map((origin) => origin.trim().toLowerCase())
  ];

  const validateHost = hostHeaderValidation(allowedHostnames);
  const validateOrigin = originValidation(allowedOrigins);
  const authToken = options.authToken;
  const authDigest = authToken === undefined ? undefined : sha256Buffer(authToken);
  const uploadMaxBytes = readByteLimit("UPLOAD_MAX_BYTES", DEFAULT_UPLOAD_MAX_BYTES);

  const handler = createMcpHandler(() => buildServer(options.runtime), {
    legacy: options.legacy === "serve" ? "stateless" : "reject",
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    onerror: (error) => {
      logger.log("error", "http_handler_error", { message: error.message });
    }
  });
  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    onerror: (error) => {
      logger.log("error", "http_transport_error", { message: error.message });
    }
  });

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;

    applyCors(req, res, allowedOrigins);

    const pathname = requestPathname(req.url);
    const method = req.method ?? "GET";

    if (pathname === UPLOAD_PATH || pathname === `${UPLOAD_PATH}/`) {
      if (method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      if (authDigest === undefined || !isAuthorized(req, authDigest)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="obsidian-mcp"');
        sendJson(res, 401, {
          error: "unauthorized",
          message:
            "The upload endpoint requires a bearer token configured with --auth-token, OBSIDIAN_MCP_HTTP_TOKEN, or MCP_API_KEY."
        });
        return;
      }
      await handleUpload(req, res, options.runtime, logger, uploadMaxBytes);
      return;
    }

    if (pathname !== endpointPath && pathname !== `${endpointPath}/`) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (authDigest !== undefined && !isAuthorized(req, authDigest)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="obsidian-mcp"');
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    await nodeHandler(req as unknown as Parameters<typeof nodeHandler>[0], res);
  };

  const serveRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    void handleRequest(req, res).catch((error: unknown) => {
      logger.log("error", "http_request_error", {
        message: error instanceof Error ? error.message : String(error)
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  };

  const server = http.createServer(serveRequest);

  try {
    await listen(server, options.port, options.host);
  } catch (error) {
    await handler.close().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new UserFacingError(
      {
        code: "HTTP_LISTEN_FAILED",
        problem: "The Streamable HTTP endpoint could not listen.",
        detected: `${options.host}:${options.port}: ${message}`,
        fix: [
          `Change the port with '--port <port>' (currently ${options.port}).`,
          "Stop the other process using this address, or choose a different --host.",
          "Run 'obsidian-mcp doctor --vault <id>=<absolute-path>' to validate the configuration."
        ],
        helpAnchor: "streamable-http"
      },
      1
    );
  }

  server.on("error", (error: Error) => {
    logger.log("error", "http_server_error", { message: error.message });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : options.port;
  const url = `http://${formatHostForUrl(options.host)}:${actualPort}${endpointPath}`;

  logger.log("info", "http_listening", {
    url,
    host: options.host,
    port: actualPort,
    path: endpointPath,
    uploadPath: UPLOAD_PATH,
    vaults: options.runtime.registry.ids(),
    version: SERVER_VERSION
  });

  if (authToken === undefined) {
    logger.log("warn", "http_upload_requires_token", {
      detail:
        "POST /upload returns 401 until --auth-token, OBSIDIAN_MCP_HTTP_TOKEN, or MCP_API_KEY is configured."
    });
  }

  if (options.legacy === "serve") {
    logger.log("info", "http_legacy_stateless", {
      detail:
        "2025-era requests are served per-request without sessions; GET and DELETE return 405."
    });
  }

  if (!isLoopbackHost(options.host)) {
    logger.log("warn", "http_exposed", {
      host: options.host,
      detail:
        "The endpoint may be reachable from the network. Restrict --host, add the public --allowed-host values, and protect it with --auth-token or a reverse proxy."
    });
    if (authToken === undefined) {
      logger.log("warn", "http_unauthenticated", {
        host: options.host,
        detail:
          "No --auth-token is configured. Anyone who can reach this address can use the vault tools."
      });
    }
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= closeServer(server, handler);
    return closing;
  };

  return { url, port: actualPort, close };
}

async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: Runtime,
  logger: Logger,
  maxBytes: number
): Promise<void> {
  let input;
  try {
    input = await readUploadRequest(req, maxBytes);
  } catch (error) {
    if (error instanceof UploadRequestError) {
      logUploadRejection(logger, error);
      sendJson(res, error.status, { error: error.code, message: error.message });
      return;
    }
    throw error;
  }

  try {
    const result = await storeUpload(runtime, input);
    logger.log("info", "upload_stored", {
      vault: result.vault,
      path: result.path,
      bytes: result.bytes,
      sha256: result.sha256,
      mimeType: result.mimeType
    });
    sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof UploadRequestError) {
      logUploadRejection(logger, error);
      sendJson(res, error.status, { error: error.code, message: error.message });
      return;
    }
    if (error instanceof ToolFailure) {
      const status = uploadStatusFor(error.code);
      logger.log("warn", "upload_rejected", { status, code: error.code });
      sendJson(res, status, { error: error.code, message: error.message });
      return;
    }
    throw error;
  }
}

function logUploadRejection(logger: Logger, error: UploadRequestError): void {
  logger.log("warn", "upload_rejected", { status: error.status, code: error.code });
}

function uploadStatusFor(code: ToolFailure["code"]): number {
  switch (code) {
    case "VAULT_NOT_FOUND":
      return 404;
    case "PATH_REJECTED":
    case "SYMLINK_NOT_ALLOWED":
    case "INVALID_ARGUMENT":
      return 400;
    case "ALREADY_EXISTS":
      return 409;
    case "INPUT_TOO_LARGE":
      return 413;
    default:
      return 500;
  }
}

async function closeServer(
  server: http.Server,
  handler: { close: () => Promise<void> }
): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => {
      // Tolerate close-time races; the listener is gone either way.
      resolve();
    });
  });
  await handler.close();
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function buildAllowedHostnames(bindHost: string, extra: readonly string[]): string[] {
  const result = [...DEFAULT_ALLOWED_HOSTS];
  const normalizedBind = normalizeHostname(bindHost);
  if (!isWildcardHost(bindHost) && normalizedBind.length > 0) result.push(normalizedBind);
  for (const host of extra) result.push(normalizeHostname(host));
  return [...new Set(result.map((host) => host.toLowerCase()))];
}

function applyCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigins: readonly string[]
): void {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return;
  if (!isOriginAllowed(origin, allowedOrigins)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
}

function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return allowedOrigins.some((entry) => entry.toLowerCase() === hostname);
}

function isAuthorized(req: http.IncomingMessage, expectedDigest: Buffer): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  const token = match?.[1];
  if (token === undefined) return false;
  const provided = sha256Buffer(token);
  return timingSafeEqual(provided, expectedDigest);
}

function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function requestPathname(url: string | undefined): string {
  const raw = url ?? "/";
  const queryIndex = raw.search(/[?#]/u);
  const pathOnly = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  return pathOnly.length === 0 ? "/" : pathOnly;
}

function normalizeEndpointPath(value: string): string {
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  const segments = withLeadingSlash.split("/").filter((segment) => segment.length > 0);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function normalizeHostname(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") || !trimmed.includes(":")) return trimmed;
  return `[${trimmed}]`;
}

function formatHostForUrl(host: string): string {
  const normalized = normalizeHostname(host);
  return normalized;
}

function isWildcardHost(host: string): boolean {
  const trimmed = host.trim();
  return trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const payload = `${JSON.stringify(body)}\n`;
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}
