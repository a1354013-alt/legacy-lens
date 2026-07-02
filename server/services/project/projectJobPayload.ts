import { z } from "zod";

export type ProjectJobPayload =
  | { type: "import_zip"; zipContent: string }
  | { type: "import_zip"; tempFilePath: string; originalFileName?: string | null }
  | { type: "import_git"; gitUrl: string }
  | { type: "analyze" };

const importZipInlinePayloadSchema = z
  .object({
    type: z.literal("import_zip"),
    zipContent: z.string().min(1),
    tempFilePath: z.undefined().optional(),
    originalFileName: z.undefined().optional(),
  })
  .strict();

const importZipTempFilePayloadSchema = z
  .object({
    type: z.literal("import_zip"),
    tempFilePath: z.string().min(1),
    originalFileName: z.string().nullable().optional(),
    zipContent: z.undefined().optional(),
  })
  .strict();

export const projectJobPayloadSchema = z.union([
  importZipInlinePayloadSchema,
  importZipTempFilePayloadSchema,
  z.object({ type: z.literal("import_git"), gitUrl: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal("analyze") }).strict(),
]);

export function serializeProjectJobPayload(payload: ProjectJobPayload) {
  return JSON.stringify(payload);
}

export function getImportZipPayloadTempPath(payload: ProjectJobPayload) {
  return payload.type === "import_zip" && "tempFilePath" in payload ? payload.tempFilePath : null;
}
