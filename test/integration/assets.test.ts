import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Stream } from "node:stream";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createVault } from "../helpers.js";

const TOKEN = "assets-test-token";
const FILE_TEMPLATE = "obsidian-mcp://vaults/{vaultId}/files/{+path}";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

interface RunningServer {
  child: ChildProcess;
  stderr: { value: string };
  url: string;
  baseUrl: string;
}

interface UploadOptions {
  vault?: string;
  path: string;
  bytes?: Buffer;
  overwrite?: string;
  token?: string | null;
  filename?: string;
  contentType?: string;
}

test("upload stores a nested image atomically and returns its sha256", async () => {
  const root = await createVault("obsidian-mcp-upload-");
  const server = await startServer(root, ["--auth-token", TOKEN]);
  try {
    const target = "publish/wechat-main/assets/demo/cover.png";
    const result = await upload(server.baseUrl, { path: target });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      vault: "test",
      path: target,
      bytes: PNG.byteLength,
      sha256: sha256(PNG),
      mimeType: "image/png"
    });

    const absolute = path.join(root, ...target.split("/"));
    assert.deepEqual(await fs.readFile(absolute), PNG);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(absolute)).mode & 0o777, 0o644);
    }
    assert.deepEqual(await fs.readdir(path.dirname(absolute)), ["cover.png"]);
    assert.ok(!server.stderr.value.includes(TOKEN), "logs must never contain the bearer token");
  } finally {
    await stopServer(server);
  }
});

test("upload rejects traversal, absolute paths, and reserved directories", async () => {
  const root = await createVault("obsidian-mcp-upload-paths-");
  const server = await startServer(root, ["--auth-token", TOKEN]);
  try {
    const rejected = [
      "../escape.png",
      "../../escape.png",
      "/etc/passwd.png",
      "C:/escape.png",
      "a\\b.png",
      ".obsidian/evil.png",
      ".obsidian-mcp/evil.png",
      "a/../../b.png"
    ];
    for (const target of rejected) {
      const result = await upload(server.baseUrl, { path: target });
      assert.equal(result.status, 400, `${target} must be rejected`);
    }
    const emptyPath = await upload(server.baseUrl, { path: "" });
    assert.equal(emptyPath.status, 400);

    const unknownVault = await upload(server.baseUrl, { vault: "nope", path: "cover.png" });
    assert.equal(unknownVault.status, 404);

    await assert.rejects(() => fs.stat(path.join(root, "..", "escape.png")));
    assert.deepEqual((await fs.readdir(root)).sort(), [".obsidian", ".obsidian-mcp"]);
  } finally {
    await stopServer(server);
  }
});

test("upload requires the configured bearer token", async () => {
  const root = await createVault("obsidian-mcp-upload-auth-");
  const server = await startServer(root, ["--auth-token", TOKEN]);
  try {
    const missing = await upload(server.baseUrl, { path: "cover.png", token: null });
    assert.equal(missing.status, 401);
    const wrong = await upload(server.baseUrl, { path: "cover.png", token: "wrong" });
    assert.equal(wrong.status, 401);

    const ok = await upload(server.baseUrl, { path: "cover.png" });
    assert.equal(ok.status, 200);
  } finally {
    await stopServer(server);
  }

  const unauthenticated = await startServer(root);
  try {
    const refused = await upload(unauthenticated.baseUrl, { path: "other.png", token: "anything" });
    assert.equal(refused.status, 401);
  } finally {
    await stopServer(unauthenticated);
  }
});

test("MCP_API_KEY authenticates uploads", async () => {
  const root = await createVault("obsidian-mcp-upload-env-");
  const server = await startServer(root, [], { MCP_API_KEY: "env-api-key" });
  try {
    const refused = await upload(server.baseUrl, { path: "cover.png", token: "wrong" });
    assert.equal(refused.status, 401);
    const ok = await upload(server.baseUrl, { path: "cover.png", token: "env-api-key" });
    assert.equal(ok.status, 200);
  } finally {
    await stopServer(server);
  }
});

test("upload protects existing files unless overwrite=true", async () => {
  const root = await createVault("obsidian-mcp-upload-overwrite-");
  const server = await startServer(root, ["--auth-token", TOKEN]);
  try {
    assert.equal((await upload(server.baseUrl, { path: "cover.png" })).status, 200);

    const duplicate = await upload(server.baseUrl, { path: "cover.png" });
    assert.equal(duplicate.status, 409);
    const explicitFalse = await upload(server.baseUrl, {
      path: "cover.png",
      overwrite: "false"
    });
    assert.equal(explicitFalse.status, 409);

    const replacement = Buffer.from([9, 9, 9]);
    const overwritten = await upload(server.baseUrl, {
      path: "cover.png",
      bytes: replacement,
      overwrite: "true"
    });
    assert.equal(overwritten.status, 200);
    assert.deepEqual(await fs.readFile(path.join(root, "cover.png")), replacement);
    assert.equal((overwritten.body as { sha256: string }).sha256, sha256(replacement));

    const invalid = await upload(server.baseUrl, { path: "cover.png", overwrite: "yes" });
    assert.equal(invalid.status, 400);
  } finally {
    await stopServer(server);
  }
});

test("upload enforces the MIME whitelist and size limit", async () => {
  const root = await createVault("obsidian-mcp-upload-limits-");
  const server = await startServer(root, ["--auth-token", TOKEN]);
  try {
    for (const target of ["notes.txt", "payload.exe", "archive.zip", "no-extension"]) {
      const result = await upload(server.baseUrl, { path: target });
      assert.equal(result.status, 415, `${target} must be rejected`);
    }
    const upperCase = await upload(server.baseUrl, { path: "cover.PNG" });
    assert.equal(upperCase.status, 200);
    assert.equal((upperCase.body as { mimeType: string }).mimeType, "image/png");
  } finally {
    await stopServer(server);
  }

  const limited = await startServer(root, ["--auth-token", TOKEN], { UPLOAD_MAX_BYTES: "64" });
  try {
    const tooLarge = await upload(limited.baseUrl, { path: "big.png", bytes: Buffer.alloc(128) });
    assert.equal(tooLarge.status, 413);
  } finally {
    await stopServer(limited);
  }
});

test("resources serve text and binary files without changing the static vault resource", async () => {
  const root = await createVault("obsidian-mcp-resource-");
  await fs.writeFile(path.join(root, "Note.md"), "# Note\n\nbody\n");
  await fs.writeFile(path.join(root, "data.json"), '{"ok":true}\n');
  await fs.writeFile(path.join(root, "shape.svg"), SVG);
  const server = await startServer(root, ["--auth-token", TOKEN]);
  const client = await connect(server.url, TOKEN);
  try {
    const listed = await client.listResources();
    assert.deepEqual(
      listed.resources.map((resource) => resource.uri),
      ["obsidian-mcp://vaults"]
    );
    const beforeRead = await fs.readdir(root);
    const templates = await client.listResourceTemplates();
    assert.deepEqual(
      templates.resourceTemplates.map((template) => template.uriTemplate),
      [FILE_TEMPLATE]
    );

    const text = await client.readResource({
      uri: "obsidian-mcp://vaults/test/files/Note.md"
    });
    assert.equal(text.contents.length, 1);
    const textContent = text.contents[0];
    assert.ok(textContent);
    assert.equal(textContent.mimeType, "text/markdown");
    assert.equal(textContent.text, "# Note\n\nbody\n");

    const json = await client.readResource({
      uri: "obsidian-mcp://vaults/test/files/data.json"
    });
    assert.equal(json.contents[0]?.mimeType, "application/json");
    assert.equal(json.contents[0]?.text, '{"ok":true}\n');

    const image = await client.readResource({
      uri: "obsidian-mcp://vaults/test/files/shape.svg"
    });
    assert.equal(image.contents[0]?.mimeType, "image/svg+xml");
    assert.equal(image.contents[0]?.blob, SVG.toString("base64"));
    assert.deepEqual(await fs.readdir(root), beforeRead);
  } finally {
    await client.close();
    await stopServer(server);
  }
});

test("resource reads return protocol errors for bad paths and oversized files", async () => {
  const root = await createVault("obsidian-mcp-resource-errors-");
  await fs.writeFile(path.join(root, "Note.md"), "# Note\n");
  await fs.writeFile(path.join(root, "bad.md"), Buffer.from([0xff, 0xfe, 0xfd]));
  await fs.writeFile(path.join(root, "big.txt"), "x".repeat(128));
  const server = await startServer(root, ["--auth-token", TOKEN]);
  const client = await connect(server.url, TOKEN);
  try {
    await assert.rejects(
      () => client.readResource({ uri: "obsidian-mcp://vaults/test/files/missing.png" }),
      /does not exist/u
    );
    await assert.rejects(
      () => client.readResource({ uri: "obsidian-mcp://vaults/nope/files/Note.md" }),
      /not configured/u
    );
    await assert.rejects(
      () => client.readResource({ uri: "obsidian-mcp://vaults/test/files/.obsidian/app.json" }),
      /reserved/u
    );
    await assert.rejects(
      () => client.readResource({ uri: "obsidian-mcp://vaults/test/files/a%2F..%2F..%2FNote.md" }),
      /dot segments|portable/u
    );
    await assert.rejects(
      () => client.readResource({ uri: "obsidian-mcp://vaults/test/files/%2Fetc%2Fpasswd" }),
      /portable/u
    );
    await assert.rejects(
      () => client.readResource({ uri: "obsidian-mcp://vaults/test/files/bad.md" }),
      /UTF-8/u
    );
  } finally {
    await client.close();
    await stopServer(server);
  }

  const limited = await startServer(root, ["--auth-token", TOKEN], { RESOURCE_MAX_BYTES: "32" });
  const limitedClient = await connect(limited.url, TOKEN);
  try {
    await assert.rejects(
      () => limitedClient.readResource({ uri: "obsidian-mcp://vaults/test/files/big.txt" }),
      /exceeds RESOURCE_MAX_BYTES/u
    );
  } finally {
    await limitedClient.close();
    await stopServer(limited);
  }
});

async function upload(
  baseUrl: string,
  options: UploadOptions
): Promise<{ status: number; body: unknown }> {
  const body = new FormData();
  body.set("vault", options.vault ?? "test");
  body.set("path", options.path);
  body.set(
    "file",
    new Blob([options.bytes ?? PNG], { type: options.contentType ?? "image/png" }),
    options.filename ?? "cover.png"
  );
  if (options.overwrite !== undefined) body.set("overwrite", options.overwrite);
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/upload`, { method: "POST", headers, body });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client(
    { name: "assets-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  return client;
}

async function startServer(
  root: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {}
): Promise<RunningServer> {
  const env = { ...process.env };
  delete env.OBSIDIAN_MCP_HTTP_TOKEN;
  delete env.MCP_API_KEY;
  Object.assign(env, extraEnv);
  const child = spawn(
    process.execPath,
    [
      "dist/main.js",
      "serve",
      "--vault",
      `test=${root}`,
      "--transport",
      "http",
      "--port",
      "0",
      ...extraArgs
    ],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] }
  );
  const stderr = capture(child.stderr);
  child.stdout?.resume();
  try {
    const listening = await waitForListening(child, stderr, 5_000);
    return { child, stderr, ...listening };
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
): Promise<{ url: string; baseUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of stderr.value.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const event = JSON.parse(trimmed) as { event?: string; url?: string; port?: number };
        if (event.event === "http_listening" && typeof event.url === "string") {
          return { url: event.url, baseUrl: `http://127.0.0.1:${String(event.port)}` };
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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
