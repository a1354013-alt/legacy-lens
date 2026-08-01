import type { Response } from "express";
import { AppError } from "./appError";
import { logger } from "./_core/logger";

export type HttpApiErrorCode = AppError["code"] | "UNAUTHORIZED" | "RATE_LIMITED" | "BAD_REQUEST" | "INTERNAL_SERVER_ERROR";

export function getHttpStatusForAppError(error: AppError) {
  switch (error.code) {
    case "PROJECT_NOT_FOUND":
    case "PROJECT_JOB_NOT_FOUND":
      return 404;
    case "PROJECT_JOB_ACTIVE":
    case "INVALID_PROJECT_STATE":
    case "REPORT_NOT_READY":
    case "UNSUPPORTED_SNAPSHOT_VERSION":
    case "DELETE_FAILED":
      return 409;
    case "ZIP_INVALID":
    case "ZIP_UNSAFE_PATH":
    case "ZIP_DUPLICATE_PATH":
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
    case "ANALYSIS_PARSE_FAILED":
    case "ANALYSIS_PERSIST_FAILED":
    case "ANALYSIS_SUMMARY_FAILED":
    case "ANALYSIS_UNKNOWN_FAILED":
      return 500;
    default:
      return 400;
  }
}

export function sendHttpErrorResponse(
  res: Response,
  status: number,
  code: HttpApiErrorCode,
  message: string,
  extras?: Record<string, unknown>
) {
  res.status(status).json({
    code,
    error: message,
    message,
    ...(extras ?? {}),
  });
}

export function sendAppErrorResponse(res: Response, error: AppError, extras?: Record<string, unknown>) {
  sendHttpErrorResponse(res, getHttpStatusForAppError(error), error.code, error.message, {
    ...(error.details ? { details: error.details } : {}),
    ...(extras ?? {}),
  });
}

export function sendUnexpectedHttpErrorResponse(
  res: Response,
  error: unknown,
  context: {
    action: string;
    fallbackMessage?: string;
    extra?: Record<string, unknown>;
  }
) {
  logger.error("Unexpected HTTP route error", {
    action: context.action,
    status: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    ...(context.extra ?? {}),
  });

  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : error instanceof Error
        ? error.message
        : context.fallbackMessage ?? "Unexpected server error.";

  sendHttpErrorResponse(res, 500, "INTERNAL_SERVER_ERROR", message);
}
