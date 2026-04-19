import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import { getSessionCookieOptions } from "./cookies";
import { ENV, isDevAuthBypassEnabled } from "./env";
import { logger } from "./logger";
import { sdk } from "./sdk";
import * as db from "../db";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

function sanitizeRedirectPath(value: string | undefined) {
  if (!value || !value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  return value;
}

function getDevOpenId() {
  const configured = ENV.devAuthOpenId.trim();
  return configured.length > 0 ? configured : "local-dev-user";
}

export function registerDevAuthRoutes(app: Express) {
  app.get("/api/dev/login", async (req: Request, res: Response) => {
    if (!isDevAuthBypassEnabled()) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const redirectPath = sanitizeRedirectPath(getQueryParam(req, "next"));
    const openId = getDevOpenId();

    logger.info("Dev auth login started", { action: "auth.dev.login.start", status: "ok", openId });

    try {
      await db.upsertUser({
        openId,
        name: "Local Dev",
        email: null,
        loginMethod: "dev-bypass",
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(openId, {
        name: "Local Dev",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, redirectPath);

      logger.info("Dev auth login completed", { action: "auth.dev.login.complete", status: "ok", openId });
    } catch (error) {
      logger.error("Dev auth login failed", {
        action: "auth.dev.login.complete",
        status: "error",
        openId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Dev auth login failed" });
    }
  });

  app.get("/api/dev/logout", (req: Request, res: Response) => {
    if (!isDevAuthBypassEnabled()) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const redirectPath = sanitizeRedirectPath(getQueryParam(req, "next"));
    const cookieOptions = getSessionCookieOptions(req);
    res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    res.redirect(302, redirectPath);

    logger.info("Dev auth logout completed", { action: "auth.dev.logout", status: "ok" });
  });
}
