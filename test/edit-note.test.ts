import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { Runtime } from "../src/runtime.js";
import { createEditNoteTool } from "../src/tools/edit-note/index.js";
import { ToolFailure } from "../src/utils/errors.js";
import { Logger } from "../src/utils/logger.js";
import { VaultRegistry } from "../src/utils/vault.js";
import { createVault } from "./helpers.js";

test("patch replaces exactly one unique occurrence and leaves the rest byte-for-byte", async () => {
  const initial = "# 标题\n\n😀 alpha\nbeta\nkeep\n";
  const { run, read } = await setup(initial);

  const result = await run({
    vault: "test",
    path: "Note.md",
    operation: "patch",
    old_string: "alpha\nbeta",
    new_string: "ALPHA\nBETA"
  });

  assert.equal(await read(), "# 标题\n\n😀 ALPHA\nBETA\nkeep\n");
  assert.match(result.etag, /^[a-f0-9]{64}$/u);
  assert.match(result.transaction_id, /^[0-9a-f-]{36}$/u);
});

test("patch treats replacement text literally, including dollar sequences", async () => {
  const initial = "a $& b\nrest\n";
  const { run, read } = await setup(initial);

  await run({
    vault: "test",
    path: "Note.md",
    operation: "patch",
    old_string: "a $& b",
    new_string: "x $1 y"
  });

  assert.equal(await read(), "x $1 y\nrest\n");
});

test("patch allows new_string to be empty to delete one passage", async () => {
  const initial = "keep\nremove me\nkeep2\n";
  const { run, read } = await setup(initial);

  await run({
    vault: "test",
    path: "Note.md",
    operation: "patch",
    old_string: "remove me\n",
    new_string: ""
  });

  assert.equal(await read(), "keep\nkeep2\n");
});

test("patch rejects a missing old_string and leaves the file unchanged", async () => {
  const initial = "one\ntwo\n";
  const { run, read } = await setup(initial);

  await assert.rejects(
    () =>
      run({
        vault: "test",
        path: "Note.md",
        operation: "patch",
        old_string: "three",
        new_string: "x"
      }),
    isFailure("INVALID_ARGUMENT", /old_string was not found/u)
  );
  assert.equal(await read(), initial);
});

test("patch rejects multiple matches and asks for more context", async () => {
  const initial = "repeat\nx\nrepeat\n";
  const { run, read } = await setup(initial);

  await assert.rejects(
    () =>
      run({
        vault: "test",
        path: "Note.md",
        operation: "patch",
        old_string: "repeat",
        new_string: "once"
      }),
    isFailure("INVALID_ARGUMENT", /matched 2 times.*exactly once.*more surrounding context/u)
  );
  assert.equal(await read(), initial);
});

test("patch requires old_string and new_string in the input schema", async () => {
  const { tool } = await setup("content\n");

  const missingOld = tool.inputSchema.safeParse({
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

  const missingNew = tool.inputSchema.safeParse({
    vault: "test",
    path: "Note.md",
    operation: "patch",
    old_string: "old"
  });
  assert.equal(missingNew.success, false);
  if (!missingNew.success) {
    assert.deepEqual(
      missingNew.error.issues.map((issue) => [issue.path.join("."), issue.message]),
      [["new_string", "new_string is required when operation is 'patch'."]]
    );
  }
});

test("replace overwrites the whole note when the length is comparable", async () => {
  const initial = "a".repeat(100);
  const replacement = "b".repeat(80);
  const { run, read } = await setup(initial);

  const result = await run({
    vault: "test",
    path: "Note.md",
    operation: "replace",
    content: replacement,
    base_chars: initial.length
  });

  assert.equal(await read(), replacement);
  assert.match(result.etag, /^[a-f0-9]{64}$/u);
});

test("replace refuses an accidental shrink and leaves the file unchanged", async () => {
  const initial = "a".repeat(1_000);
  const { run, read } = await setup(initial);

  await assert.rejects(
    () =>
      run({
        vault: "test",
        path: "Note.md",
        operation: "replace",
        content: "b".repeat(100)
      }),
    isFailure("INVALID_ARGUMENT", /Refusing to replace: new content is 10%/u)
  );
  assert.equal(await read(), initial);
});

test("replace allows an intentional shrink when force_shrink is true", async () => {
  const initial = "a".repeat(1_000);
  const replacement = "b".repeat(100);
  const { run, read } = await setup(initial);

  await run({
    vault: "test",
    path: "Note.md",
    operation: "replace",
    content: replacement,
    force_shrink: true
  });

  assert.equal(await read(), replacement);
});

test("replace refuses a stale base_chars and asks for a re-read", async () => {
  const initial = "a".repeat(200);
  const { run, read } = await setup(initial);

  await assert.rejects(
    () =>
      run({
        vault: "test",
        path: "Note.md",
        operation: "replace",
        content: "b".repeat(150),
        base_chars: 199
      }),
    isFailure("REVISION_CONFLICT", /base_chars is 199.*current note has 200 characters/u)
  );
  assert.equal(await read(), initial);
});

test("base_chars uses the UTF-16 length returned by read_note", async () => {
  const initial = "😀note";
  const replacement = "😀changed";
  const { run, read } = await setup(initial);

  await run({
    vault: "test",
    path: "Note.md",
    operation: "replace",
    content: replacement,
    base_chars: initial.length
  });
  assert.equal(await read(), replacement);

  await assert.rejects(
    () =>
      run({
        vault: "test",
        path: "Note.md",
        operation: "replace",
        content: replacement,
        base_chars: initial.length - 1
      }),
    isFailure("REVISION_CONFLICT", /base_chars is 5/u)
  );
  assert.equal(await read(), replacement);
});

test("append and prepend keep their existing semantics", async () => {
  const appended = await setup("base");
  await appended.run({
    vault: "test",
    path: "Note.md",
    operation: "append",
    content: " tail"
  });
  assert.equal(await appended.read(), "base tail");

  const prepended = await setup("base");
  await prepended.run({
    vault: "test",
    path: "Note.md",
    operation: "prepend",
    content: "head "
  });
  assert.equal(await prepended.read(), "head base");
});

async function setup(initial: string) {
  const root = await createVault("obsidian-mcp-edit-");
  const registry = await VaultRegistry.create([{ id: "test", root }]);
  const runtime = new Runtime(
    registry,
    { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
    new Logger("error")
  );
  await runtime.initialize();
  const file = path.join(root, "Note.md");
  await fs.writeFile(file, initial, "utf8");
  const tool = createEditNoteTool(runtime);
  return {
    tool,
    run: async (input: Record<string, unknown>) =>
      tool.execute(tool.inputSchema.parse(input), { signal: new AbortController().signal }),
    read: () => fs.readFile(file, "utf8")
  };
}

function isFailure(code: ToolFailure["code"], pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ToolFailure);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return true;
  };
}
