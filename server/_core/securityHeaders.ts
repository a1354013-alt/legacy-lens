import type { Express, Request, Response, NextFunction } from "express";

function isTruthyEnv(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function shouldAllowUnsafeEval() {
  return isTruthyEnv(process.env.CSP_ALLOW_UNSAFE_EVAL);
}

export function buildProductionCspDirectives() {
  const scriptSrc = ["script-src", "'self'"];

  if (shouldAllowUnsafeEval()) {
    scriptSrc.push("'unsafe-eval'");
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc.join(" "),
    "connect-src 'self'",
  ].join("; ");
}

export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");

  if (process.env.NODE_ENV === "production") {
    res.setHeader("Content-Security-Policy", buildProductionCspDirectives());
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }

  next();
}

export function registerSecurityHeaders(app: Express) {
  app.use(securityHeadersMiddleware);
}
