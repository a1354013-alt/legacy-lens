import { MAX_UPLOAD_BYTES, formatBytes } from "@shared/const";

export const MAX_UPLOAD_ZIP_SIZE = MAX_UPLOAD_BYTES;

export function validateUploadedZip(file: File) {
  if (file.size > MAX_UPLOAD_ZIP_SIZE) {
    return `This ZIP is too large. Legacy Lens accepts ZIP uploads up to ${formatBytes(MAX_UPLOAD_ZIP_SIZE)}. Remove large files or shrink the archive and try again.`;
  }

  return null;
}
