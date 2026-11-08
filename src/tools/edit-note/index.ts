import * as z from "zod";

import { MAX_CONTENT_BYTES } from "../../constants.js";
import type { Runtime } from "../../runtime.js";
import type { ToolDefinition } from "../../types.js";
import { ToolFailure } from "../../utils/errors.js";
import { sha256 } from "../../utils/hash.js";
import {
  etagSchema,
  outputEtagSchema,
  outputPathSchema,
  relativePathSchema,
  transactionIdSchema,
  vaultSchema
} from "../../utils/schemas.js";
import { MUTATE } from "../../utils/tool-factory.js";
import { assertByteLimit, assertIfMatch } from "../../utils/validation.js";

export const TOOL_NAME = "obsidian_edit_note";

/**
 * A replace that produces less than half of the current note is treated as a
 * likely accidental overwrite. Callers must opt in with force_shrink.
 */
export const MIN_REPLACE_RATIO = 0.5;

const inputSchema = z
  .object({
    vault: vaultSchema,
    path: relativePathSchema,
    operation: z
      .enum(["append", "prepend", "replace", "patch"], {
        error: "operation must be one of 'append', 'prepend', 'replace', or 'patch'."
      })
      .meta({
        description:
          "append/prepend add text; replace overwrites the entire note; patch replaces one unique occurrence"
      }),
    content: z
      .string({ error: "content must be a Markdown string when provided." })
      .max(MAX_CONTENT_BYTES, "Content exceeds the 5 MiB limit.")
      .refine((value) => Buffer.byteLength(value) <= MAX_CONTENT_BYTES, {
        error: "Content exceeds the 5 MiB UTF-8 byte limit."
      })
      .optional()
      .meta({
        description:
          "Content for append/prepend, or the complete replacement for replace; omit for patch"
      }),
    old_string: z
      .string({ error: "old_string must be a string when provided." })
      .min(1, "old_string cannot be empty.")
      .max(MAX_CONTENT_BYTES, "old_string exceeds the 5 MiB limit.")
      .optional()
      .meta({
        description: "Exact case-sensitive text to replace; it must occur exactly once (patch only)"
      }),
    new_string: z
      .string({ error: "new_string must be a string when provided." })
      .max(MAX_CONTENT_BYTES, "new_string exceeds the 5 MiB limit.")
      .optional()
      .meta({
        description: "Replacement text for patch; an empty string deletes the matched text"
      }),
    base_chars: z
      .number({ error: "base_chars must be an integer number of characters." })
      .int("base_chars must be a whole number.")
      .min(0, "base_chars cannot be negative.")
      .optional()
      .meta({
        description:
          "Expected UTF-16 code-unit length of the current note (total_characters from obsidian_read_note); replace is refused when it differs"
      }),
    force_shrink: z
      .boolean({ error: "force_shrink must be true or false." })
      .optional()
      .meta({
        description: `Allow replace when the new note is below ${MIN_REPLACE_RATIO * 100}% of the current length`
      }),
    if_match: etagSchema.optional().meta({
      description: "Optional revision guard; obtain it from obsidian_read_note before editing"
    })
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.operation === "patch") {
      if (value.old_string === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["old_string"],
          message: "old_string is required when operation is 'patch'."
        });
      }
      if (value.new_string === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["new_string"],
          message: "new_string is required when operation is 'patch'."
        });
      }
      if (value.content !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["content"],
          message: "content is not valid with operation 'patch'; use new_string."
        });
      }
    } else {
      if (value.content === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["content"],
          message: "content is required for append, prepend, and replace."
        });
      }
      if (value.old_string !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["old_string"],
          message: "old_string is only valid with operation 'patch'."
        });
      }
      if (value.new_string !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["new_string"],
          message: "new_string is only valid with operation 'patch'."
        });
      }
    }
    if (value.operation !== "replace") {
      if (value.base_chars !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["base_chars"],
          message: "base_chars is only valid with operation 'replace'."
        });
      }
      if (value.force_shrink !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["force_shrink"],
          message: "force_shrink is only valid with operation 'replace'."
        });
      }
    }
  });

const outputSchema = z
  .object({
    path: outputPathSchema,
    etag: outputEtagSchema,
    transaction_id: transactionIdSchema
  })
  .strict();

export function createEditNoteTool(
  runtime: Runtime
): ToolDefinition<typeof inputSchema, typeof outputSchema> {
  return {
    name: TOOL_NAME,
    title: "Edit Obsidian Note",
    description:
      "Edit a note. 'append'/'prepend' add content; 'replace' OVERWRITES the entire note (it is not a partial replacement) and refuses a large shrink unless force_shrink is set; 'patch' replaces exactly one unique occurrence of old_string — use it to change a single passage. This tool never deletes notes.",
    inputSchema,
    outputSchema,
    annotations: MUTATE,
    execute: async ({
      vault,
      path: notePath,
      operation,
      content,
      old_string,
      new_string,
      base_chars,
      force_shrink,
      if_match
    }) => {
      const service = runtime.forVault(vault);
      const entry = await service.fs.resolveExisting(notePath, { markdown: true });
      const read = await service.fs.readText(entry);
      assertIfMatch(if_match, read.etag);

      let next: string;
      switch (operation) {
        case "patch": {
          if (old_string === undefined || new_string === undefined) {
            throw new ToolFailure("INVALID_ARGUMENT", "patch requires old_string and new_string.");
          }
          const occurrences = read.text.split(old_string).length - 1;
          if (occurrences === 0) {
            throw new ToolFailure(
              "INVALID_ARGUMENT",
              "old_string was not found in the note. Read the note and retry with an exact excerpt."
            );
          }
          if (occurrences > 1) {
            throw new ToolFailure(
              "INVALID_ARGUMENT",
              `old_string matched ${occurrences} times; it must match exactly once. Include more surrounding context to make it unique.`,
              { details: { occurrences } }
            );
          }
          const index = read.text.indexOf(old_string);
          next = `${read.text.slice(0, index)}${new_string}${read.text.slice(index + old_string.length)}`;
          break;
        }
        case "replace": {
          if (content === undefined) {
            throw new ToolFailure("INVALID_ARGUMENT", "replace requires content.");
          }
          if (base_chars !== undefined && base_chars !== read.text.length) {
            throw new ToolFailure(
              "REVISION_CONFLICT",
              `The note changed after it was read: base_chars is ${base_chars} but the current note has ${read.text.length} characters. Read the note again and retry.`,
              {
                retryable: true,
                details: { base_chars, current_chars: read.text.length }
              }
            );
          }
          const ratio = read.text.length === 0 ? 1 : content.length / read.text.length;
          if (ratio < MIN_REPLACE_RATIO && force_shrink !== true) {
            const percent = Math.round(ratio * 100);
            throw new ToolFailure(
              "INVALID_ARGUMENT",
              `Refusing to replace: new content is ${percent}% of the current note (${read.text.length} → ${content.length} chars). If this shrink is intentional, re-read the note and pass force_shrink: true.`,
              {
                details: {
                  current_chars: read.text.length,
                  new_chars: content.length,
                  threshold_ratio: MIN_REPLACE_RATIO
                }
              }
            );
          }
          next = content;
          break;
        }
        case "append":
        case "prepend": {
          if (content === undefined) {
            throw new ToolFailure("INVALID_ARGUMENT", `${operation} requires content.`);
          }
          next = operation === "append" ? `${read.text}${content}` : `${content}${read.text}`;
          break;
        }
      }

      assertByteLimit(next);
      const transactionId = await service.transactions.run([
        {
          kind: "write",
          path: entry.absolutePath,
          data: Buffer.from(next),
          expectedEtag: read.etag
        }
      ]);
      return { path: entry.relativePath, etag: sha256(next), transaction_id: transactionId };
    }
  };
}
