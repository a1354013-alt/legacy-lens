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
  keyPrefix?: string;
}

type TrustProxyValue = boolean | number | string | string[];

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

  clone: {
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: "Too many Git clone requests, please wait before cloning another repository",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
  },

  analysis: {
    windowMs: 10 * 60 * 1000,
    max: 6,
    message: "Too many analysis requests, please wait for running analyses to finish",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
  },

  report: {
    windowMs: 5 * 60 * 1000,
    max: 20,
    message: "Too many report downloads, please slow down before retrying",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
  },
};

function parseTrustedProxySetting(rawValue: string | undefined): TrustProxyValue {
  const normalized = String(rawValue ?? "").trim();
  if (!normalized) {
    return false;
  }

  const lowerValue = normalized.toLowerCase();
  if (lowerValue === "true") {
    return true;
  }
  if (lowerValue === "false") {
    return false;
  }
  if (/^\d+$/.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }
  if (normalized.includes(",")) {
    return normalized
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return normalized;
}

export function configureTrustProxy(app: Express, env: NodeJS.ProcessEnv = process.env) {
  app.set("trust proxy", parseTrustedProxySetting(env.LEGACY_LENS_TRUST_PROXY));
}

function getClientIp(req: Request): string {
  return req.ip || "anonymous";
}

function getStableRequestPath(request: Request) {
  const stablePath = String(request.originalUrl || request.baseUrl || request.url || request.path || "").split("?")[0];
  return stablePath || "/";
}

export function createRateLimiter(configName: keyof typeof defaultConfigs = "api") {
  const config = defaultConfigs[configName];
  let limiterPromise:
    | Promise<((req: Request, res: Response, next: NextFunction) => void) | null>
    | null = null;

  const getLimiter = async () => {
    if (!limiterPromise) {
      limiterPromise = (async () => {
        const module = await getRateLimitModule();
        if (!module) {
          return null;
        }

        const rateLimit = module.default ?? module;

        return rateLimit({
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
          keyGenerator: (request: Request) => `${config.keyPrefix ?? configName}:${getClientIp(request)}`,
          skip: (request: Request) => {
            const stablePath = getStableRequestPath(request);

            if (process.env.NODE_ENV === "test") {
              return true;
            }

            if (stablePath === "/health" || stablePath === "/api/health") {
              return true;
            }

            if (
              configName === "api" &&
              [
                "/api/trpc/projects.uploadFiles",
                "/api/trpc/projects.cloneGit",
                "/api/trpc/analysis.trigger",
              ].includes(stablePath)
            ) {
              return true;
            }

            return false;
          },
        });
      })();
    }

    return limiterPromise;
  };

  return async function rateLimiterMiddleware(req: Request, res: Response, next: NextFunction) {
    const limiter = await getLimiter();
    if (!limiter) {
      return next();
    }

    return limiter(req, res, next);
  };
}

export function registerRateLimiters(app: Express) {
  app.use("/api/oauth", createRateLimiter("auth"));
  app.use("/api/trpc/projects.uploadFiles", createRateLimiter("upload"));
  app.use("/api/trpc/projects.cloneGit", createRateLimiter("clone"));
  app.use("/api/trpc/analysis.trigger", createRateLimiter("analysis"));
  app.use("/api/trpc", createRateLimiter("api"));
}

export { defaultConfigs, getStableRequestPath };
