import type { Response } from "express";
import { AppError } from "./appError";

export function getHttpStatusForAppError(error: AppError) {
  switch (error.code) {
    case "PROJECT_NOT_FOUND":
    case "PROJECT_JOB_NOT_FOUND":
      return 404;
    case "PROJECT_JOB_ACTIVE":
    case "INVALID_PROJECT_STATE":
    case "REPORT_NOT_READY":
    case "DELETE_FAILED":
      return 409;
    case "ZIP_INVALID":
    case "ZIP_UNSAFE_PATH":
    case "INVALID_GIT_URL":
    case "GIT_CLONE_FAILED":
    case "EMPTY_SOURCE":
      return 400;
    case "REPORT_TOO_LARGE":
      return 413;
    case "DATABASE_UNAVAILABLE":
    case "PROJECT_JOB_STALE":
    case "IMPORT_FAILED":
    case "ANALYSIS_FAILED":
      return 500;
    default:
      return 400;
  }
}

export function sendAppErrorResponse(res: Response, error: AppError, extras?: Record<string, unknown>) {
  res.status(getHttpStatusForAppError(error)).json({
    error: error.message,
    code: error.code,
    ...(extras ?? {}),
  });
}
