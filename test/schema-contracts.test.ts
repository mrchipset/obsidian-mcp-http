import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import { MAX_CONTENT_BYTES } from "../src/constants.js";
import { Runtime } from "../src/runtime.js";
import { createToolDefinitions } from "../src/tools/index.js";
import { Logger } from "../src/utils/logger.js";
import { READ_ONLY, registerTool } from "../src/utils/tool-factory.js";
import { VaultRegistry } from "../src/utils/vault.js";
import { createVault } from "./helpers.js";

test("tool input schemas return actionable issues and apply documented defaults", async () => {
  const definitions = await definitionsForTest();

  const edit = findDefinition(definitions, "obsidian_edit_note");
  const invalidEdit = edit.inputSchema.safeParse({
    vault: "test",
    path: "",
    operation: "merge",
    content: "x"
  });
  assert.equal(invalidEdit.success, false);
  if (!invalidEdit.success) {
    assert.deepEqual(
      invalidEdit.error.issues.map((issue) => [issue.path.join("."), issue.message]),
      [
        ["path", "Path cannot be empty."],
        ["operation", "operation must be one of 'append', 'prepend', 'replace', or 'patch'."]
      ]
    );
  }

  const remove = findDefinition(definitions, "obsidian_remove_tags");
  const invalidRemove = remove.inputSchema.safeParse({
    vault: "test",
    paths: ["Note.md"],
    tags: [],
    patterns: []
  });
  assert.equal(invalidRemove.success, false);
  if (!invalidRemove.success) {
    assert.deepEqual(invalidRemove.error.issues[0]?.path, ["tags"]);
    assert.equal(
      invalidRemove.error.issues[0]?.message,
      "At least one tag or pattern is required for a remove operation."
    );
  }

  const deleteNote = findDefinition(definitions, "obsidian_delete_note");
  const invalidDelete = deleteNote.inputSchema.safeParse({
    vault: "test",
    path: "Note.md",
    mode: "permanent"
  });
  assert.equal(invalidDelete.success, false);
  if (!invalidDelete.success) {
    assert.deepEqual(invalidDelete.error.issues[0]?.path, ["confirm_path"]);
  }

  const search = findDefinition(definitions, "obsidian_search_vault");
  const searchDefaults = search.inputSchema.parse({ vault: "test", query: "plan" }) as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    {
      mode: searchDefaults.mode,
      case_sensitive: searchDefaults.case_sensitive,
      limit: searchDefaults.limit
    },
    { mode: "content", case_sensitive: false, limit: 50 }
  );
});

test("edit-note patch parameters are conditionally required and scoped", async () => {
  const definitions = await definitionsForTest();
  const edit = findDefinition(definitions, "obsidian_edit_note");

  const missingOld = edit.inputSchema.safeParse({
    vault: "test",
    path: "Note.md",
    operation: "patch",
    new_string: "x"
  });
  assert.equal(missingOld.success, false);
  if (!missingOld.success) {
    assert.deepEqual(
      missingOld.error.issues.map((issue) => [issue.path.join("."), issue.message]),
      [["old_string", "old_string is required when operation is 'patch'."]]
    );
  }

  const oldOnAppend = edit.inputSchema.safeParse({
    vault: "test",
    path: "Note.md",
    operation: "append",
    content: "x",
    old_string: "a"
  });
  assert.equal(oldOnAppend.success, false);
  if (!oldOnAppend.success) {
    assert.deepEqual(
      oldOnAppend.error.issues.map((issue) => [issue.path.join("."), issue.message]),
      [["old_string", "old_string is only valid with operation 'patch'."]]
    );
  }

  const baseOnAppend = edit.inputSchema.safeParse({
    vault: "test",
    path: "Note.md",
    operation: "append",
    content: "x",
    base_chars: 1
  });
  assert.equal(baseOnAppend.success, false);
  if (!baseOnAppend.success) {
    assert.deepEqual(
      baseOnAppend.error.issues.map((issue) => [issue.path.join("."), issue.message]),
      [["base_chars", "base_chars is only valid with operation 'replace'."]]
    );
  }

  const missingContent = edit.inputSchema.safeParse({
    vault: "test",
    path: "Note.md",
    operation: "replace"
  });
  assert.equal(missingContent.success, false);
  if (!missingContent.success) {
    assert.deepEqual(
      missingContent.error.issues.map((issue) => [issue.path.join("."), issue.message]),
      [["content", "content is required for append, prepend, and replace."]]
    );
  }
});

test("content schemas enforce the UTF-8 byte limit before a handler runs", async () => {
  const definitions = await definitionsForTest();
  const createNote = findDefinition(definitions, "obsidian_create_note");
  const oversizedUtf8 = "é".repeat(Math.floor(MAX_CONTENT_BYTES / 2) + 1);

  const result = createNote.inputSchema.safeParse({
    vault: "test",
    path: "Large.md",
    content: oversizedUtf8
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0]?.path.join("."), "content");
    assert.equal(result.error.issues[0]?.message, "Content exceeds the 5 MiB UTF-8 byte limit.");
  }
});

test("the MCP SDK blocks invalid input and malformed structured output", async () => {
  const server = new McpServer(
    { name: "schema-contract-test", version: "1.0.0" },
    { supportedProtocolVersions: ["2026-07-28"] }
  );
  let executions = 0;
  const boundedInput = z
    .object({
      limit: z.number().int().max(2, "limit cannot exceed 2; submit a smaller page.")
    })
    .strict();
  const dataSchema = z.object({ value: z.string() }).strict();

  registerTool(server, {
    name: "test_schema_contract",
    title: "Test Schema Contract",
    description: "Exercise input and output validation.",
    inputSchema: boundedInput,
    outputSchema: dataSchema,
    annotations: READ_ONLY,
    execute: () => {
      executions += 1;
      return Promise.resolve({ value: "valid" });
    }
  });
  registerTool(server, {
    name: "test_malformed_output",
    title: "Test Malformed Output",
    description: "Return a deliberately invalid result.",
    inputSchema: z.object({}).strict(),
    outputSchema: dataSchema,
    annotations: READ_ONLY,
    execute: () => Promise.resolve({ value: 42 } as never)
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-contract-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const invalidInput = await client.callTool({
      name: "test_schema_contract",
      arguments: { limit: 3 }
    });
    assert.equal(invalidInput.isError, true);
    assert.match(textOf(invalidInput), /limit: limit cannot exceed 2; submit a smaller page\./u);
    assert.equal(executions, 0);

    const invalidOutput = await client.callTool({ name: "test_malformed_output", arguments: {} });
    assert.equal(invalidOutput.isError, true);
    assert.match(textOf(invalidOutput), /Output validation error/u);
    assert.match(textOf(invalidOutput), /data\.value: Invalid input: expected string/u);
  } finally {
    await client.close();
    await server.close();
  }
});

async function definitionsForTest(): Promise<ReturnType<typeof createToolDefinitions>> {
  const root = await createVault("obsidian-mcp-schema-");
  const registry = await VaultRegistry.create([{ id: "test", root }]);
  const runtime = new Runtime(
    registry,
    { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
    new Logger("error")
  );
  await runtime.initialize();
  return createToolDefinitions(runtime);
}

function findDefinition(
  definitions: ReturnType<typeof createToolDefinitions>,
  name: string
): ReturnType<typeof createToolDefinitions>[number] {
  const definition = definitions.find((candidate) => candidate.name === name);
  assert.ok(definition, `Missing tool definition ${name}`);
  return definition;
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  return content?.find((item) => item.type === "text")?.text ?? "";
}
