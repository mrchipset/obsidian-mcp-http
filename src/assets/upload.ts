import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";

import type { Runtime } from "../runtime.js";
import { isNodeError } from "../utils/errors.js";
import { sha256 } from "../utils/hash.js";
import { uploadMimeForPath, uploadMimeTypes } from "./mime.js";

const LINK_FALLBACK_ERRORS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

export class UploadRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "UploadRequestError";
  }
}

export interface UploadStoreInput {
  vault: string;
  path: string;
  overwrite: boolean;
  bytes: Buffer;
}

export interface UploadStoreResult {
  vault: string;
  path: string;
  bytes: number;
  sha256: string;
  mimeType: string;
}

export async function readUploadRequest(
  request: IncomingMessage,
  maxBytes: number
): Promise<UploadStoreInput> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^multipart\/form-data\s*;\s*boundary=/iu.test(contentType)
  ) {
    throw new UploadRequestError(
      400,
      "invalid_request",
      "Expected a multipart/form-data body with a boundary."
    );
  }

  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new UploadRequestError(413, "payload_too_large", overLimitMessage(maxBytes));
  }

  const body = await readBody(request, maxBytes);
  let form: FormData;
  try {
    form = await new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body
    }).formData();
  } catch {
    throw new UploadRequestError(400, "invalid_request", "The multipart body could not be parsed.");
  }

  const vault = form.get("vault");
  const targetPath = form.get("path");
  const file = form.get("file");
  const overwriteValue = form.get("overwrite");

  if (typeof vault !== "string" || vault.length === 0) {
    throw new UploadRequestError(400, "invalid_request", "The 'vault' field is required.");
  }
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new UploadRequestError(400, "invalid_request", "The 'path' field is required.");
  }
  if (!isFileLike(file)) {
    throw new UploadRequestError(400, "invalid_request", "The 'file' field is required.");
  }

  let overwrite = false;
  if (overwriteValue !== null) {
    if (overwriteValue === "true") overwrite = true;
    else if (overwriteValue !== "false") {
      throw new UploadRequestError(
        400,
        "invalid_request",
        "The 'overwrite' field must be 'true' or 'false'."
      );
    }
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new UploadRequestError(413, "payload_too_large", overLimitMessage(maxBytes));
  }
  return { vault, path: targetPath, overwrite, bytes };
}

export async function storeUpload(
  runtime: Runtime,
  input: UploadStoreInput
): Promise<UploadStoreResult> {
  const entry = await runtime.forVault(input.vault).fs.resolveNew(input.path);
  const mimeType = uploadMimeForPath(entry.relativePath);
  if (mimeType === undefined) {
    throw new UploadRequestError(
      415,
      "unsupported_media_type",
      `Unsupported file type. Allowed types: ${uploadMimeTypes().join(", ")}.`
    );
  }

  await assertTargetAvailable(entry.absolutePath, input.overwrite);
  await fs.mkdir(path.dirname(entry.absolutePath), { recursive: true, mode: 0o755 });

  const temporary = path.join(path.dirname(entry.absolutePath), `.upload-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, input.bytes, { flag: "wx", mode: 0o644 });
    await fs.chmod(temporary, 0o644);
    if (input.overwrite) await fs.rename(temporary, entry.absolutePath);
    else await linkExclusive(temporary, entry.absolutePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }

  return {
    vault: input.vault,
    path: entry.relativePath,
    bytes: input.bytes.byteLength,
    sha256: sha256(input.bytes),
    mimeType
  };
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string);
    total += buffer.byteLength;
    if (total > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new UploadRequestError(413, "payload_too_large", overLimitMessage(maxBytes));
  return Buffer.concat(chunks, total);
}

async function assertTargetAvailable(target: string, overwrite: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile()) {
      throw new UploadRequestError(
        409,
        "already_exists",
        "A directory or special file already exists at the target path."
      );
    }
    if (!overwrite) {
      throw new UploadRequestError(
        409,
        "already_exists",
        "The target file already exists. Send overwrite=true to replace it."
      );
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function linkExclusive(source: string, target: string): Promise<void> {
  try {
    await fs.link(source, target);
    return;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new UploadRequestError(
        409,
        "already_exists",
        "The target file already exists. Send overwrite=true to replace it."
      );
    }
    if (!isNodeError(error) || !LINK_FALLBACK_ERRORS.has(error.code ?? "")) throw error;
  }

  try {
    await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new UploadRequestError(
        409,
        "already_exists",
        "The target file already exists. Send overwrite=true to replace it."
      );
    }
    throw error;
  }
}

function isFileLike(value: unknown): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).size === "number"
  );
}

function overLimitMessage(maxBytes: number): string {
  return `The upload exceeds the ${maxBytes}-byte limit. Raise UPLOAD_MAX_BYTES to accept larger files.`;
}
