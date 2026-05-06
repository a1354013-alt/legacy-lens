export const MAX_UPLOAD_ZIP_SIZE = 30 * 1024 * 1024;

export function validateUploadedZip(file: File) {
  if (file.size > MAX_UPLOAD_ZIP_SIZE) {
    return `This ZIP is too large. Legacy Lens accepts ZIP uploads up to 30MB. Remove large files or shrink the archive and try again.`;
  }

  return null;
}
