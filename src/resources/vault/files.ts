import { promises as fs } from "node:fs";
import { TextDecoder } from "node:util";

import {
  INVALID_PARAMS,
  ProtocolError,
  ResourceNotFoundError,
  ResourceTemplate
} from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";

import { DEFAULT_RESOURCE_MAX_BYTES, readByteLimit } from "../../assets/limits.js";
import { assetMimeForPath } from "../../assets/mime.js";
import type { Runtime } from "../../runtime.js";
import { isNodeError, ToolFailure } from "../../utils/errors.js";

export const VAULT_FILE_RESOURCE_TEMPLATE = "obsidian-mcp://vaults/{vaultId}/files/{+path}";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function registerVaultFileResource(server: McpServer, runtime: Runtime): void {
  const maxBytes = readByteLimit("RESOURCE_MAX_BYTES", DEFAULT_RESOURCE_MAX_BYTES);
  server.registerResource(
    "Vault File",
    new ResourceTemplate(VAULT_FILE_RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: "Vault File",
      description: `Read a text or binary file from a configured vault. Images and PDFs are returned as base64 blobs. Reads are capped at ${maxBytes} bytes.`
    },
    async (uri, variables) => {
      const vaultId = decodeVariable("vaultId", variables.vaultId);
      const relativePath = decodeVariable("path", variables.path);

      let entry;
      try {
        entry = await runtime.forVault(vaultId).fs.resolveExisting(relativePath);
      } catch (error) {
        throw asResourceError(uri, error);
      }

      let stat;
      try {
        stat = await fs.stat(entry.absolutePath);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw new ResourceNotFoundError(uri.href, "The requested file does not exist.");
        }
        throw new ProtocolError(INVALID_PARAMS, "The requested file could not be inspected.");
      }
      if (!stat.isFile()) {
        throw new ProtocolError(INVALID_PARAMS, "The requested path is not a regular file.");
      }
      if (stat.size > maxBytes) {
        throw new ProtocolError(
          INVALID_PARAMS,
          `The file is ${stat.size} bytes, which exceeds RESOURCE_MAX_BYTES (${maxBytes}). Raise RESOURCE_MAX_BYTES or use a local channel; /upload only accepts writes.`
        );
      }

      let bytes: Buffer;
      try {
        bytes = await fs.readFile(entry.absolutePath);
      } catch (error) {
        throw asResourceError(uri, error);
      }
      if (bytes.byteLength > maxBytes) {
        throw new ProtocolError(
          INVALID_PARAMS,
          `The file grew beyond RESOURCE_MAX_BYTES (${maxBytes}) while it was being read.`
        );
      }

      const asset = assetMimeForPath(entry.relativePath);
      if (asset?.kind === "text") {
        let text: string;
        try {
          text = utf8Decoder.decode(bytes);
        } catch {
          throw new ProtocolError(INVALID_PARAMS, "The requested text file is not valid UTF-8.");
        }
        return {
          contents: [{ uri: uri.href, mimeType: asset.mimeType, text }]
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: asset?.mimeType ?? "application/octet-stream",
            blob: bytes.toString("base64")
          }
        ]
      };
    }
  );
}

function decodeVariable(name: string, value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError(INVALID_PARAMS, `The resource URI is missing a valid '${name}'.`);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ProtocolError(INVALID_PARAMS, `The resource URI has invalid '${name}' encoding.`);
  }
}

function asResourceError(uri: URL, error: unknown): ProtocolError {
  if (error instanceof ToolFailure) {
    if (error.code === "NOTE_NOT_FOUND") {
      return new ResourceNotFoundError(uri.href, "The requested file does not exist.");
    }
    if (error.code === "VAULT_NOT_FOUND") {
      return new ResourceNotFoundError(uri.href, error.message);
    }
    return new ProtocolError(INVALID_PARAMS, error.message);
  }
  if (isNodeError(error) && error.code === "ENOENT") {
    return new ResourceNotFoundError(uri.href, "The requested file does not exist.");
  }
  if (isNodeError(error) && (error.code === "EACCES" || error.code === "EPERM")) {
    return new ProtocolError(INVALID_PARAMS, "Permission was denied while reading the file.");
  }
  return new ProtocolError(INVALID_PARAMS, "The requested file could not be read.");
}
