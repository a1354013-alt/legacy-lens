import { TRPCError } from "@trpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "./appError";
import { toTrpcError } from "./routers";

describe("toTrpcError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves user-facing AppError messages", () => {
    const error = toTrpcError(new AppError("INVALID_GIT_URL", "Git URL is not allowed."));

    expect(error).toBeInstanceOf(TRPCError);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe("Git URL is not allowed.");
  });

  it("masks unknown errors in production while keeping the original cause", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      const error = toTrpcError(new Error("database socket exploded"));
      expect(error.code).toBe("INTERNAL_SERVER_ERROR");
      expect(error.message).toBe("Internal server error");
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toBe("database socket exploded");
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("keeps unknown error messages in test for debugging", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";

    try {
      const error = toTrpcError(new Error("debug me"));
      expect(error.message).toBe("debug me");
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
