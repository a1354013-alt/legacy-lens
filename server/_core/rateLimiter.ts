import type { Express, Request, Response, NextFunction } from "express";
import { logger } from "./logger";

// Dynamic import to avoid issues if package not installed
let rateLimitModule: typeof import("express-rate-limit") | null = null;

async function getRateLimitModule() {
  if (!rateLimitModule) {
    try {
      rateLimitModule = await import("express-rate-limit");
    } catch {
      logger.warn("Rate limiting disabled (module missing)", { action: "rateLimiter.init", status: "error" });
      return null;
    }
  }
  return rateLimitModule;
}

export interface RateLimiterConfig {
  windowMs: number;
  max: number;
  message?: string;
  standardHeaders?: boolean;
  legacyHeaders?: boolean;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

const defaultConfigs: Record<string, RateLimiterConfig> = {
  auth: {
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: "Too many authentication attempts, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
  },

  api: {
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: "Too many requests, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
  },

  read: {
    windowMs: 1 * 60 * 1000,
    max: 30,
    message: "Too many requests, please slow down",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
  },

  upload: {
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: "Too many upload requests, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
  },
};

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0] ?? req.ip ?? "anonymous";
  }

  if (typeof forwarded === "string" && forwarded.trim() !== "") {
    return forwarded.split(",")[0]?.trim() || req.ip || "anonymous";
  }

  return req.ip || "anonymous";
}

export function createRateLimiter(configName: keyof typeof defaultConfigs = "api") {
  const config = defaultConfigs[configName];

  return async function rateLimiterMiddleware(req: Request, res: Response, next: NextFunction) {
    const module = await getRateLimitModule();
    if (!module) {
      return next();
    }

    const rateLimit = module.default ?? module;

    const options = {
      windowMs: config.windowMs,
      max: config.max,
      message: {
        error: "Too Many Requests",
        message: config.message,
      },
      standardHeaders: config.standardHeaders,
      legacyHeaders: config.legacyHeaders,
      handler: (_req: Request, response: Response) => {
        response.status(429).json({
          error: "Too Many Requests",
          message: config.message,
        });
      },
      keyGenerator: (request: Request) => {
        return getClientIp(request);
      },
      skip: (request: Request) => {
        if (process.env.NODE_ENV === "test") {
          return true;
        }

        if (request.path === "/health" || request.path === "/api/health") {
          return true;
        }

        return false;
      },
    };

    const limiter = rateLimit(options);
    return limiter(req, res, next);
  };
}

export function registerRateLimiters(app: Express) {
  app.use("/api/oauth", createRateLimiter("auth"));
  app.use("/api/trpc/projects.uploadFiles", createRateLimiter("upload"));
}

export { defaultConfigs };
