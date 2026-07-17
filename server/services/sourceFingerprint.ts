import { createHash } from "node:crypto";

export type SourceFingerprintFile = {
  filePath?: string | null;
  path?: string | null;
  fileType?: string | null;
  language?: string | null;
  lineCount?: number | null;
  content?: string | Buffer | null;
};

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeSourcePath(value: string | null | undefined) {
  return (value ?? "unknown").replace(/\\/g, "/");
}

export function buildSourceManifest(files: SourceFingerprintFile[]) {
  return files
    .map((file) => ({
      path: normalizeSourcePath(file.filePath ?? file.path),
      fileType: file.fileType ?? file.language ?? null,
      lineCount: typeof file.lineCount === "number" ? file.lineCount : null,
      sha256: hash(file.content ?? ""),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function calculateSourceFingerprint(files: SourceFingerprintFile[]) {
  return hash(
    stableJson(
      buildSourceManifest(files).map((file) => ({
        path: file.path,
        sha256: file.sha256,
      }))
    )
  );
}

export function stableSourceJson(value: unknown) {
  return stableJson(value);
}
