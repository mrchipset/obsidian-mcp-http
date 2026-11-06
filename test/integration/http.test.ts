import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import type { Stream } from "node:stream";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { TOOL_NAMES } from "../../src/tools/index.js";
import { createVault } from "../helpers.js";

interface RunningServer {
  child: ChildProcess;
  stderr: { value: string };
  url: string;
}

test("modern streamable HTTP client lists and executes tools", async () => {
  const root = await createVault("obsidian-mcp-http-modern-");
  await fs.writeFile(path.join(root, "Source.md"), "# Source\n\nbody\n");
  const server = await startServer(["--vault", `test=${root}`, "--transport", "http"]);
  const client = modernClient("http-modern-test");
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    assert.equal(client.getProtocolEra(), "modern");
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      TOOL_NAMES
    );

    const read = await success(client, "obsidian_read_note", {
      vault: "test",
      path: "Source.md"
    });
    assert.match(String(read.etag), /^[a-f0-9]{64}$/u);

    await success(client, "obsidian_create_note", {
      vault: "test",
      path: "Http.md",
      content: "created over HTTP\n"
    });
    const created = await success(client, "obsidian_read_note", {
      vault: "test",
      path: "Http.md"
    });
    assert.match(String(created.content), /created over HTTP/u);
  } finally {
    await client.close();
    await stopServer(server);
  }
});

test("2025-era streamable HTTP client is served statelessly", async () => {
  const root = await createVault("obsidian-mcp-http-legacy-");
  await fs.writeFile(path.join(root, "Source.md"), "# Source\n\nbody\n");
  const server = await startServer(["--vault", `test=${root}`, "--transport", "http"]);
  const client = new Client({ name: "http-legacy-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    assert.equal(client.getProtocolEra(), "legacy");
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 12);
    await success(client, "obsidian_read_note", { vault: "test", path: "Source.md" });
  } finally {
    await client.close();
    await stopServer(server);
  }
});

test("bearer token is enforced", async () => {
  const root = await createVault("obsidian-mcp-http-auth-");
  const server = await startServer([
    "--vault",
    `test=${root}`,
    "--transport",
    "http",
    "--auth-token",
    "s3cret"
  ]);
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const missing = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    assert.equal(missing.status, 401);
    assert.ok(missing.headers.get("www-authenticate"));

    const wrong = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body
    });
    assert.equal(wrong.status, 401);

    const correct = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
      body
    });
    assert.notEqual(correct.status, 401);
  } finally {
    await stopServer(server);
  }
});

test("host and origin rebinding guards reject unexpected values", async () => {
  const root = await createVault("obsidian-mcp-http-guards-");
  const server = await startServer(["--vault", `test=${root}`, "--transport", "http"]);
  const url = new URL(server.url);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  try {
    const evilHost = await rawPost(url, { host: "evil.example" }, body);
    assert.equal(evilHost, 403);

    const evilOrigin = await rawPost(url, { host: url.host, origin: "http://evil.example" }, body);
    assert.equal(evilOrigin, 403);

    const localOrigin = await rawPost(url, { host: url.host, origin: "http://localhost" }, body);
    assert.notEqual(localOrigin, 403);
  } finally {
    await stopServer(server);
  }
});

test("modern-only HTTP mode rejects a 2025-era client", async () => {
  const root = await createVault("obsidian-mcp-http-reject-");
  const server = await startServer([
    "--vault",
    `test=${root}`,
    "--transport",
    "http",
    "--legacy",
    "reject"
  ]);
  const legacy = new Client({ name: "http-legacy-rejected", version: "1.0.0" });
  try {
    let failure = "";
    try {
      await legacy.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      await legacy.listTools();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      await legacy.close();
    }
    assert.match(failure, /Unsupported protocol version|2026-07-28|protocol/iu);

    const modern = modernClient("http-modern-after-reject");
    try {
      await modern.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      const listed = await modern.listTools();
      assert.equal(listed.tools.length, 12);
    } finally {
      await modern.close();
    }
  } finally {
    await stopServer(server);
  }
});

test("CORS preflight advertises modern MCP headers and allowed origins are case-insensitive", async () => {
  const root = await createVault("obsidian-mcp-http-cors-");
  const server = await startServer([
    "--vault",
    `test=${root}`,
    "--transport",
    "http",
    "--allowed-origin",
    "App.Example.com"
  ]);
  try {
    const preflight = await fetch(server.url, {
      method: "OPTIONS",
      headers: {
        origin: "http://app.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, mcp-method, mcp-name, mcp-protocol-version"
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://app.example.com");
    const allowedHeaders = (
      preflight.headers.get("access-control-allow-headers") ?? ""
    ).toLowerCase();
    for (const header of ["mcp-method", "mcp-name", "mcp-protocol-version", "authorization"]) {
      assert.ok(allowedHeaders.includes(header), `${header} must be allowed by CORS`);
    }

    const upperCaseOrigin = await fetch(server.url, {
      method: "OPTIONS",
      headers: { origin: "http://APP.EXAMPLE.COM" }
    });
    assert.notEqual(upperCaseOrigin.status, 403);

    const unrelated = await fetch(server.url, {
      method: "OPTIONS",
      headers: { origin: "http://evil.example" }
    });
    assert.equal(unrelated.status, 403);
  } finally {
    await stopServer(server);
  }
});

test("unknown paths return 404", async () => {
  const root = await createVault("obsidian-mcp-http-404-");
  const server = await startServer(["--vault", `test=${root}`, "--transport", "http"]);
  try {
    const response = await fetch(`${server.url}/wrong`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(response.status, 404);
  } finally {
    await stopServer(server);
  }
});

function modernClient(name: string): Client {
  return new Client(
    { name, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
}

async function startServer(extraArgs: string[]): Promise<RunningServer> {
  const env = { ...process.env };
  delete env.OBSIDIAN_MCP_HTTP_TOKEN;
  delete env.MCP_API_KEY;
  const child = spawn(process.execPath, ["dist/main.js", "serve", ...extraArgs, "--port", "0"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stderr = capture(child.stderr);
  child.stdout?.resume();
  try {
    const url = await waitForListening(child, stderr, 5_000);
    return { child, stderr, url };
  } catch (error) {
    child.kill();
    throw error;
  }
}

function capture(stream: Stream | null): { value: string } {
  const target = { value: "" };
  stream?.on("data", (chunk: Buffer | string) => {
    target.value += chunk.toString();
  });
  return target;
}

async function waitForListening(
  child: ChildProcess,
  stderr: { value: string },
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of stderr.value.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const event = JSON.parse(trimmed) as { event?: string; url?: string };
        if (event.event === "http_listening" && typeof event.url === "string") {
          return event.url;
        }
      } catch {
        // Ignore non-JSON stderr lines while waiting for the listening event.
      }
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Server did not report http_listening.\nstderr:\n${stderr.value}`);
}

async function stopServer(server: RunningServer): Promise<void> {
  const { child } = server;
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function success(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const structured = result.structuredContent as { ok: boolean; data: Record<string, unknown> };
  assert.equal(structured.ok, true);
  return structured.data;
}

async function rawPost(url: URL, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers
        }
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}
