export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

export const BYTES_PER_MB = 1024 * 1024;
export const MAX_UPLOAD_BYTES = 30 * BYTES_PER_MB;
export const MAX_ZIP_RAW_BYTES = MAX_UPLOAD_BYTES;
export const MAX_LEGACY_BASE64_ZIP_BYTES = 2 * BYTES_PER_MB;
export const MAX_EXTRACTED_BYTES = 500 * BYTES_PER_MB;
export const MAX_FILE_COUNT = 2_000;
export const MAX_TOTAL_ARCHIVE_ENTRIES = 10_000;
export const MAX_SINGLE_FILE_BYTES = 5 * BYTES_PER_MB;
export const MAX_REPORT_ARCHIVE_BYTES = 25 * BYTES_PER_MB;
export const JSON_UPLOAD_BODY_LIMIT_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 1.5);

export function formatBytes(bytes: number): string {
  if (bytes % BYTES_PER_MB === 0) {
    return `${bytes / BYTES_PER_MB}MB`;
  }

  return `${bytes} bytes`;
}
