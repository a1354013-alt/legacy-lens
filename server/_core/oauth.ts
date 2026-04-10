import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { ENV } from "./env";
import { sdk } from "./sdk";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const oauthStateSchema = z.object({
  purpose: z.literal("oauth-login"),
  appId: z.string().trim().min(1),
  nonce: z.string().trim().min(16),
  redirectUri: z.string().url(),
  redirectPath: z.string().trim().min(1),
});

type OAuthStatePayload = z.infer<typeof oauthStateSchema>;

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

function sanitizeRedirectPath(value: string | undefined) {
  if (!value || !value.startsWith("/")) {
    return "/";
  }

  if (value.startsWith("//")) {
    return "/";
  }

  return value;
}

function getStateSecret() {
  return new TextEncoder().encode(ENV.cookieSecret);
}

function buildRedirectUri(req: Request) {
  return `${req.protocol}://${req.get("host")}/api/oauth/callback`;
}

export async function createOAuthStateToken(req: Request, redirectPath = "/") {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const payload: OAuthStatePayload = {
    purpose: "oauth-login",
    appId: ENV.appId,
    nonce,
    redirectUri: buildRedirectUri(req),
    redirectPath: sanitizeRedirectPath(redirectPath),
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + OAUTH_STATE_TTL_MS) / 1000))
    .sign(getStateSecret());
}

export async function verifyOAuthStateToken(token: string) {
  const { payload } = await jwtVerify(token, getStateSecret(), {
    algorithms: ["HS256"],
  });

  const parsed = oauthStateSchema.parse(payload);
  if (parsed.appId !== ENV.appId) {
    throw new Error("OAuth state appId mismatch.");
  }

  return parsed;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/start", async (req: Request, res: Response) => {
    try {
      const redirectPath = sanitizeRedirectPath(getQueryParam(req, "next"));
      const redirectUri = buildRedirectUri(req);
      const state = await createOAuthStateToken(req, redirectPath);

      const url = new URL(`${ENV.oAuthPortalUrl.replace(/\/+$/, "")}/app-auth`);
      url.searchParams.set("appId", ENV.appId);
      url.searchParams.set("redirectUri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("type", "signIn");

      res.redirect(302, url.toString());
    } catch (error) {
      console.error("[OAuth] Failed to start login flow", error);
      res.status(500).json({ error: "OAuth login initialization failed" });
    }
  });

  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const stateToken = getQueryParam(req, "state");

    if (!code || !stateToken) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const state = await verifyOAuthStateToken(stateToken);
      const tokenResponse = await sdk.exchangeCodeForToken(code, state.redirectUri);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }

      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name ?? null,
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, state.redirectPath);
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(400).json({ error: "OAuth callback validation failed" });
    }
  });
}
