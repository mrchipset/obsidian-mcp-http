import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseArguments } from "../src/cli.js";
import { UserFacingError } from "../src/utils/diagnostics.js";
import { Logger } from "../src/utils/logger.js";
import { TransactionManager } from "../src/utils/transaction.js";
import { VaultRegistry, sha256 } from "../src/utils/vault.js";
import { createVault } from "./helpers.js";

const run = promisify(execFile);

test("startup failures never write non-MCP output to stdout", async () => {
  await assert.rejects(
    () => run(process.execPath, ["dist/main.js", "serve", "--vault", "bad=/does/not/exist"]),
    (error: unknown) => {
      const failure = error as Error & { stdout?: string; stderr?: string };
      assert.equal(failure.stdout, "");
      assert.match(failure.stderr ?? "", /error \[VAULT_PATH_NOT_FOUND\]/u);
      assert.match(failure.stderr ?? "", /Problem:/u);
      assert.match(failure.stderr ?? "", /Detected: \/does\/not\/exist/u);
      assert.match(failure.stderr ?? "", /Fix:/u);
      assert.match(failure.stderr ?? "", /Verify:/u);
      assert.match(failure.stderr ?? "", /More help:/u);
      return true;
    }
  );
});

test("CLI usage failures are actionable, typo-aware, and exit with status 2", async () => {
  await assert.rejects(
    () => run(process.execPath, ["dist/main.js", "server"]),
    (error: unknown) => {
      const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
      assert.equal(failure.code, 2);
      assert.equal(failure.stdout, "");
      assert.match(failure.stderr ?? "", /error \[CLI_UNKNOWN_COMMAND\]/u);
      assert.match(failure.stderr ?? "", /Did you mean 'serve'\?/u);
      return true;
    }
  );

  await assert.rejects(
    () => run(process.execPath, ["dist/main.js", "serve", "--valt", "/vault"]),
    (error: unknown) => {
      const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
      assert.equal(failure.code, 2);
      assert.equal(failure.stdout, "");
      assert.match(failure.stderr ?? "", /error \[CLI_UNKNOWN_OPTION\]/u);
      assert.match(failure.stderr ?? "", /Did you mean '--vault'\?/u);
      return true;
    }
  );
});

test("v1 positional paths produce deterministic v2 vault mappings", () => {
  const parsed = parseArguments([
    "/tmp/one/123 Project",
    "/tmp/two/123 Project",
    "/tmp/three/über"
  ]);
  if (typeof parsed === "string") assert.fail("Expected parsed CLI options.");
  assert.deepEqual(
    parsed.vaults.map(({ id }) => id),
    ["vault-123-project", "vault-123-project-2", "ber"]
  );
  assert.equal(parsed.legacy, "serve");
  assert.equal(parsed.warnings[0]?.code, "V1_POSITIONAL_CONFIG_DEPRECATED");
  assert.deepEqual(parsed.canonicalArgs, [
    "serve",
    ...parsed.vaults.flatMap(({ id, root }) => ["--vault", `${id}=${root}`])
  ]);
});

test("mixed positional and v2 vault syntax is rejected with a replacement", () => {
  assert.throws(
    () => parseArguments(["/tmp/vault", "--vault", "notes=/tmp/vault"]),
    (error: unknown) => {
      assert.match(String(error), /Positional vault paths cannot be mixed/u);
      return true;
    }
  );
});

test("CLI and package versions stay synchronized", async () => {
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8")) as {
    version: string;
  };
  const result = await run(process.execPath, ["dist/main.js", "--version"]);
  assert.equal(result.stdout.trim(), packageJson.version);
  assert.equal(result.stderr, "");
});

test("doctor and recovery CLI commands operate on an explicit vault", async () => {
  const root = await createVault("obsidian-mcp-cli-");
  const doctor = await run(process.execPath, [
    "dist/main.js",
    "doctor",
    "--vault",
    `test=${root}`,
    "--log-level",
    "error"
  ]);
  const diagnosis = JSON.parse(doctor.stdout) as {
    ok: boolean;
    vaults: { vault: string }[];
  };
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.vaults[0]?.vault, "test");

  const registry = await VaultRegistry.create([{ id: "test", root }]);
  const target = path.join(registry.get("test").root, "note.md");
  await fs.writeFile(target, "before");
  const manager = new TransactionManager(
    registry.get("test"),
    { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
    new Logger("error")
  );
  await manager.initialize();
  const id = await manager.run([
    { kind: "write", path: target, data: Buffer.from("after"), expectedEtag: sha256("before") }
  ]);

  const restored = await run(process.execPath, [
    "dist/main.js",
    "recovery",
    "restore",
    "--vault",
    `test=${root}`,
    "--id",
    id,
    "--log-level",
    "error"
  ]);
  assert.equal((JSON.parse(restored.stdout) as { ok: boolean }).ok, true);
  assert.equal(await fs.readFile(target, "utf8"), "before");
});

function parseServe(
  args: string[]
): Exclude<ReturnType<typeof parseArguments>, "help" | "version"> {
  const parsed = parseArguments(args);
  if (typeof parsed === "string") assert.fail(`Expected parsed CLI options, got '${parsed}'.`);
  return parsed;
}

function expectUsageError(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof UserFacingError, `Expected UserFacingError, got ${String(error)}`);
    assert.equal(error.exitCode, 2);
    assert.equal(error.diagnostic.code, code);
    return true;
  });
}

test("stdio serve defaults keep the HTTP transport disabled", () => {
  const parsed = parseServe(["serve", "--vault", "notes=/tmp/vault"]);
  assert.equal(parsed.transport, "stdio");
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 8787);
  assert.equal(parsed.httpPath, "/mcp");
  assert.deepEqual(parsed.allowedHosts, []);
  assert.deepEqual(parsed.allowedOrigins, []);
  assert.equal(parsed.authToken, undefined);
});

test("HTTP transport flags parse, including repeatable allowed host and origin values", () => {
  const parsed = parseServe([
    "serve",
    "--vault",
    "notes=/tmp/vault",
    "--transport",
    "http",
    "--host",
    "0.0.0.0",
    "--port",
    "9000",
    "--path",
    "//mcp//",
    "--allowed-host",
    "notes.example.com",
    "--allowed-host",
    "[::1]",
    "--allowed-origin",
    "app.example.com",
    "--auth-token",
    "secret-token",
    "--legacy",
    "reject"
  ]);
  assert.equal(parsed.transport, "http");
  assert.equal(parsed.host, "0.0.0.0");
  assert.equal(parsed.port, 9000);
  assert.equal(parsed.httpPath, "/mcp");
  assert.deepEqual(parsed.allowedHosts, ["notes.example.com", "[::1]"]);
  assert.deepEqual(parsed.allowedOrigins, ["app.example.com"]);
  assert.equal(parsed.authToken, "secret-token");
  assert.equal(parsed.legacy, "reject");
  assert.ok(!parsed.canonicalArgs.includes("secret-token"));
});

test("bind hosts and allowed origins reject ports, schemes, and zone ids", () => {
  for (const host of ["localhost:8787", "http://localhost", "fe80::1%eth0"]) {
    expectUsageError(
      () =>
        parseServe(["serve", "--vault", "notes=/tmp/vault", "--transport", "http", "--host", host]),
      "CLI_INVALID_HOST"
    );
  }
  for (const origin of [
    "https://*",
    "http://*",
    "app.example.com:8787",
    "https://app.example.com"
  ]) {
    expectUsageError(
      () =>
        parseServe([
          "serve",
          "--vault",
          "notes=/tmp/vault",
          "--transport",
          "http",
          "--allowed-origin",
          origin
        ]),
      "CLI_INVALID_ALLOWED_ORIGIN"
    );
  }
});

test("port 0 is accepted and out-of-range or non-numeric ports are rejected", () => {
  const parsed = parseServe([
    "serve",
    "--vault",
    "notes=/tmp/vault",
    "--transport",
    "http",
    "--port",
    "0"
  ]);
  assert.equal(parsed.port, 0);

  for (const port of ["65536", "-1", "abc"]) {
    expectUsageError(
      () =>
        parseServe(["serve", "--vault", "notes=/tmp/vault", "--transport", "http", "--port", port]),
      "CLI_INVALID_PORT"
    );
  }
});

test("HTTP path must start with a slash", () => {
  expectUsageError(
    () =>
      parseServe(["serve", "--vault", "notes=/tmp/vault", "--transport", "http", "--path", "mcp"]),
    "CLI_INVALID_HTTP_PATH"
  );

  const parsed = parseServe([
    "serve",
    "--vault",
    "notes=/tmp/vault",
    "--transport",
    "http",
    "--path",
    "/mcp"
  ]);
  assert.equal(parsed.httpPath, "/mcp");
});

test("HTTP-only options require --transport http", () => {
  expectUsageError(
    () => parseServe(["serve", "--vault", "notes=/tmp/vault", "--port", "9000"]),
    "CLI_HTTP_OPTION_WITHOUT_HTTP"
  );
});

test("HTTP options are rejected on non-serve commands", () => {
  expectUsageError(
    () => parseServe(["doctor", "--vault", "notes=/tmp/vault", "--transport", "http"]),
    "CLI_HTTP_OPTION_WITHOUT_HTTP"
  );
});

test("auth token flag wins and the environment variable is a fallback", () => {
  const previous = process.env.OBSIDIAN_MCP_HTTP_TOKEN;
  try {
    process.env.OBSIDIAN_MCP_HTTP_TOKEN = "env-token";
    const fromEnv = parseServe(["serve", "--vault", "notes=/tmp/vault", "--transport", "http"]);
    assert.equal(fromEnv.authToken, "env-token");

    const fromFlag = parseServe([
      "serve",
      "--vault",
      "notes=/tmp/vault",
      "--transport",
      "http",
      "--auth-token",
      "flag-token"
    ]);
    assert.equal(fromFlag.authToken, "flag-token");

    process.env.OBSIDIAN_MCP_HTTP_TOKEN = "";
    const emptyEnv = parseServe(["serve", "--vault", "notes=/tmp/vault", "--transport", "http"]);
    assert.equal(emptyEnv.authToken, undefined);
  } finally {
    if (previous === undefined) delete process.env.OBSIDIAN_MCP_HTTP_TOKEN;
    else process.env.OBSIDIAN_MCP_HTTP_TOKEN = previous;
  }
});
