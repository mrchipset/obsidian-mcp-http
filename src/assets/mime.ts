export type AssetKind = "text" | "blob";

export interface AssetMime {
  mimeType: string;
  kind: AssetKind;
  upload: boolean;
}

const ASSET_MIME_TYPES: Readonly<Record<string, AssetMime>> = {
  png: { mimeType: "image/png", kind: "blob", upload: true },
  jpg: { mimeType: "image/jpeg", kind: "blob", upload: true },
  jpeg: { mimeType: "image/jpeg", kind: "blob", upload: true },
  webp: { mimeType: "image/webp", kind: "blob", upload: true },
  gif: { mimeType: "image/gif", kind: "blob", upload: true },
  svg: { mimeType: "image/svg+xml", kind: "blob", upload: true },
  pdf: { mimeType: "application/pdf", kind: "blob", upload: true },
  md: { mimeType: "text/markdown", kind: "text", upload: false },
  markdown: { mimeType: "text/markdown", kind: "text", upload: false },
  txt: { mimeType: "text/plain", kind: "text", upload: false },
  json: { mimeType: "application/json", kind: "text", upload: false },
  yaml: { mimeType: "application/yaml", kind: "text", upload: false },
  yml: { mimeType: "application/yaml", kind: "text", upload: false },
  csv: { mimeType: "text/csv", kind: "text", upload: false },
  tsv: { mimeType: "text/tab-separated-values", kind: "text", upload: false },
  html: { mimeType: "text/html", kind: "text", upload: false },
  htm: { mimeType: "text/html", kind: "text", upload: false },
  xml: { mimeType: "application/xml", kind: "text", upload: false },
  css: { mimeType: "text/css", kind: "text", upload: false },
  js: { mimeType: "text/javascript", kind: "text", upload: false },
  mjs: { mimeType: "text/javascript", kind: "text", upload: false },
  ts: { mimeType: "text/plain", kind: "text", upload: false },
  tsx: { mimeType: "text/plain", kind: "text", upload: false },
  jsx: { mimeType: "text/plain", kind: "text", upload: false },
  toml: { mimeType: "application/toml", kind: "text", upload: false },
  ini: { mimeType: "text/plain", kind: "text", upload: false },
  log: { mimeType: "text/plain", kind: "text", upload: false }
};

export function assetMimeForPath(vaultPath: string): AssetMime | undefined {
  const extension = extensionOf(vaultPath);
  return extension === undefined ? undefined : ASSET_MIME_TYPES[extension];
}

export function uploadMimeForPath(vaultPath: string): string | undefined {
  const asset = assetMimeForPath(vaultPath);
  return asset?.upload === true ? asset.mimeType : undefined;
}

export function uploadMimeTypes(): string[] {
  return [
    ...new Set(
      Object.values(ASSET_MIME_TYPES)
        .filter((asset) => asset.upload)
        .map((asset) => asset.mimeType)
    )
  ].sort();
}

function extensionOf(vaultPath: string): string | undefined {
  const name = vaultPath.slice(vaultPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}
