import type { AppErrorCode, AppErrorShape } from "../shared/contracts";

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly details?: string
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON(): AppErrorShape {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function toAppError(error: unknown, fallback: AppError): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(fallback.code, fallback.message, error.message);
  }

  return fallback;
}
