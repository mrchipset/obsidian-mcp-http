export const DEFAULT_RESOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export function readByteLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
