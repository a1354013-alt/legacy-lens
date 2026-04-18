import type { Express, Request, Response, NextFunction } from "express";
import type { RateLimitOptions } from "express-rate-limit";

// Dynamic import to avoid issues if package not installed
let rateLimitModule: typeof import("express-rate-limit") | null = null;

async function getRateLimitModule() {
  if (!rateLimitModule) {
    try {
      rateLimitModule = await import("express-rate-limit");
    } catch {
      console.warn("[RateLimiter] express-rate-limit not installed, rate limiting disabled");
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
  // Strict limiter for authentication endpoints
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per window
    message: "Too many authentication attempts, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
  },
  
  // General API limiter
  api: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per window
    message: "Too many requests, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
  },
  
  // Lenient limiter for read-only endpoints
  read: {
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    message: "Too many requests, please slow down",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
  },
  
  // Very strict limiter for file uploads
  upload: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 uploads per hour
    message: "Too many upload requests, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
  },
};

export function createRateLimiter(configName: keyof typeof defaultConfigs = "api") {
  const config = defaultConfigs[configName];
  
  return async function rateLimiterMiddleware(req: Request, res: Response, next: NextFunction) {
    const module = await getRateLimitModule();
    if (!module) {
      // Skip rate limiting if module not available
      return next();
    }

    const { rateLimit } = module;
    
    const options: RateLimitOptions = {
      windowMs: config.windowMs,
      max: config.max,
      message: { 
        error: "Too Many Requests",
        message: config.message,
      },
      standardHeaders: config.standardHeaders,
      legacyHeaders: config.legacyHeaders,
      handler: (req, res) => {
        res.status(429).json({
          error: "Too Many Requests",
          message: config.message,
        });
      },
      keyGenerator: (req) => {
        // Use IP address or fallback to anonymous identifier
        return req.ip || req.headers["x-forwarded-for"] as string || "anonymous";
      },
      skip: (req) => {
        // Skip rate limiting in test environment
        if (process.env.NODE_ENV === "test") {
          return true;
        }
        // Skip health check endpoints
        if (req.path === "/health" || req.path === "/api/health") {
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
  // Apply auth rate limiter to OAuth endpoints
  app.use("/api/oauth", createRateLimiter("auth"));
  
  // Apply upload rate limiter to file upload endpoints
  app.use("/api/trpc/projects.uploadFiles", createRateLimiter("upload"));
  
  // General API rate limiter applied by default in index.ts
}

export { defaultConfigs };
