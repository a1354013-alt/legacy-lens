import { COOKIE_NAME } from "@shared/const";
import type { Express, Request, Response, NextFunction } from "express";
import { sendHttpErrorResponse } from "../httpApiErrors";
import { logger } from "./logger";

// Dynamic import to avoid issues if package not installed
let rateLimitModule: typeof import("express-rate-limit") | null = null;

async function getRateLimitModule() {
  if (!rateLimitModule) {
    try {
      rateLimitModule = await import("express-rate-limit");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (process.env.NODE_ENV === "production") {
        throw new Error(`Rate limiting failed to initialize in production: ${message}`);
      }
      logger.warn("Rate limiting disabled (module missing)", { action: "rateLimiter.init", status: "error", message });
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

export interface CreateRateLimiterOptions {
  skipInTest?: boolean;
}

export type ProcedureRateLimitBucket = "upload" | "clone" | "analysis" | "heavyRead" | "api";
type ProcedureRateLimitIdentity = {
  path: string;
  userId?: number | null;
  sessionId?: string | null;
  ip?: string | null;
};

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

  heavyRead: {
    windowMs: 1 * 60 * 1000,
    max: 12,
    message: "Request limit reached for analysis data. Please wait and try again.",
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

const heavyReadPaths = [
  "/api/trpc/analysis.getSnapshot",
  "/api/trpc/analysis.getSymbolsPage",
  "/api/trpc/analysis.getFieldsPage",
  "/api/trpc/analysis.getRisksPage",
  "/api/trpc/analysis.getRulesPage",
  "/api/trpc/analysis.getDependenciesPage",
  "/api/trpc/analysis.getFieldDependenciesPage",
  "/api/trpc/analysis.getImpact",
  "/api/projects/:projectId/report.zip",
] as const;

const procedureBucketByPath: Record<string, ProcedureRateLimitBucket> = {
  "projects.uploadFiles": "upload",
  "projects.cloneGit": "clone",
  "analysis.trigger": "analysis",
  "analysis.getSnapshot": "heavyRead",
  "analysis.getSymbolsPage": "heavyRead",
  "analysis.getFieldsPage": "heavyRead",
  "analysis.getRisksPage": "heavyRead",
  "analysis.getRulesPage": "heavyRead",
  "analysis.getDependenciesPage": "heavyRead",
  "analysis.getFieldDependenciesPage": "heavyRead",
  "analysis.getImpact": "heavyRead",
};

const procedureLimiterStore = new Map<string, { count: number; resetAt: number }>();

function parseSessionIdFromCookieHeader(cookieHeader: string | undefined) {
  const match = String(cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));

  return match ? decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) : null;
}

function getProcedureRateLimitMessage(bucket: ProcedureRateLimitBucket) {
  return defaultConfigs[bucket].message ?? defaultConfigs.api.message ?? "Too many requests, please try again later";
}

export function getProcedureRateLimitBucket(path: string): ProcedureRateLimitBucket {
  return procedureBucketByPath[path] ?? "api";
}

export function buildProcedureRateLimitKey(identity: ProcedureRateLimitIdentity) {
  const bucket = getProcedureRateLimitBucket(identity.path);
  const sessionPart = identity.sessionId ? `session:${identity.sessionId}` : null;
  const userPart = identity.userId ? `user:${identity.userId}` : null;
  const ipPart = identity.ip ? `ip:${identity.ip}` : "ip:anonymous";
  return `${bucket}:${userPart ?? sessionPart ?? ipPart}:${identity.path}`;
}

export function consumeProcedureRateLimit(identity: ProcedureRateLimitIdentity, now = Date.now()) {
  const bucket = getProcedureRateLimitBucket(identity.path);
  const config = defaultConfigs[bucket];
  const key = buildProcedureRateLimitKey(identity);
  const existing = procedureLimiterStore.get(key);

  if (!existing || existing.resetAt <= now) {
    procedureLimiterStore.set(key, {
      count: 1,
      resetAt: now + config.windowMs,
    });
    return { allowed: true, bucket };
  }

  if (existing.count >= config.max) {
    return {
      allowed: false,
      bucket,
      retryAfterMs: Math.max(existing.resetAt - now, 0),
      message: getProcedureRateLimitMessage(bucket),
    };
  }

  existing.count += 1;
  procedureLimiterStore.set(key, existing);
  return { allowed: true, bucket };
}

export function resetProcedureRateLimiterStore() {
  procedureLimiterStore.clear();
}

export function buildProcedureRateLimitIdentityFromRequest(request: Request, path: string, userId?: number | null): ProcedureRateLimitIdentity {
  return {
    path,
    userId,
    sessionId: parseSessionIdFromCookieHeader(request.headers.cookie),
    ip: getClientIp(request),
  };
}

export function createRateLimiter(configName: keyof typeof defaultConfigs = "api", options: CreateRateLimiterOptions = {}) {
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
            sendHttpErrorResponse(response, 429, "RATE_LIMITED", config.message ?? "Too many requests, please try again later");
          },
          keyGenerator: (request: Request) => `${config.keyPrefix ?? configName}:${getClientIp(request)}`,
          skip: (request: Request) => {
            const stablePath = getStableRequestPath(request);

            if (options.skipInTest !== false && process.env.NODE_ENV === "test") {
              return true;
            }

            if (stablePath === "/health" || stablePath === "/ready" || stablePath === "/api/health") {
              return true;
            }

            if (
              configName === "api" &&
              [
                "/api/trpc/projects.uploadFiles",
                "/api/trpc/projects.cloneGit",
                "/api/trpc/analysis.trigger",
                "/api/trpc/analysis.getSnapshot",
                "/api/trpc/analysis.getSymbolsPage",
                "/api/trpc/analysis.getFieldsPage",
                "/api/trpc/analysis.getRisksPage",
                "/api/trpc/analysis.getRulesPage",
                "/api/trpc/analysis.getDependenciesPage",
                "/api/trpc/analysis.getFieldDependenciesPage",
                "/api/trpc/analysis.getImpact",
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
  app.use("/api/trpc/analysis.getSnapshot", createRateLimiter("heavyRead"));
  app.use("/api/trpc/analysis.getSymbolsPage", createRateLimiter("heavyRead"));
  app.use("/api/trpc/analysis.getFieldsPage", createRateLimiter("heavyRead"));
  app.use("/api/trpc/analysis.getRisksPage", createRateLimiter("heavyRead"));
  app.use("/api/trpc/analysis.getRulesPage", createRateLimiter("heavyRead"));
  app.use("/api/trpc/analysis.getDependenciesPage", createRateLimiter("heavyRead"));
  app.use("/api/trpc/analysis.getFieldDependenciesPage", createRateLimiter("heavyRead"));
  app.use("/api/trpc/analysis.getImpact", createRateLimiter("heavyRead"));
  app.use("/api/trpc", createRateLimiter("api"));
}

export { defaultConfigs, getStableRequestPath, heavyReadPaths };
