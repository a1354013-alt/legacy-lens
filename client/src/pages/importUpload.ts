import { MAX_UPLOAD_BYTES, formatBytes } from "@shared/const";
import { t } from "@/locales";

export const MAX_UPLOAD_ZIP_SIZE = MAX_UPLOAD_BYTES;

export function validateUploadedZip(file: File) {
  if (file.size > MAX_UPLOAD_ZIP_SIZE) {
    return t("uploadValidation.zipTooLarge", {
      size: formatBytes(MAX_UPLOAD_ZIP_SIZE),
    });
  }

  return null;
}
