import { z } from "zod";

const runtimeEnvSchema = z.object({
  VITE_APP_ID: z.string().trim().min(1, "VITE_APP_ID is required."),
  JWT_SECRET: z.string().trim().min(1, "JWT_SECRET is required."),
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required."),

  // OAuth endpoints are required only when dev auth bypass is disabled.
  VITE_OAUTH_PORTAL_URL: z.string().trim().optional(),
  OAUTH_SERVER_URL: z.string().trim().optional(),

  DEV_AUTH_BYPASS: z.string().trim().optional(),
  DEV_AUTH_OPEN_ID: z.string().trim().optional(),
  NODE_ENV: z.string().trim().optional(),
});

type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;

function isTruthy(value: string | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readRuntimeEnv(source: NodeJS.ProcessEnv): RuntimeEnv {
  const parsed = runtimeEnvSchema.parse(source);
  const isProduction = parsed.NODE_ENV?.trim() === "production";
  const devAuthBypassEnabled = !isProduction && isTruthy(parsed.DEV_AUTH_BYPASS);

  if (!devAuthBypassEnabled) {
    const portalUrl = parsed.VITE_OAUTH_PORTAL_URL?.trim() ?? "";
    const serverUrl = parsed.OAUTH_SERVER_URL?.trim() ?? "";
    if (!portalUrl) {
      throw new Error("VITE_OAUTH_PORTAL_URL is required when DEV_AUTH_BYPASS is disabled.");
    }
    if (!serverUrl) {
      throw new Error("OAUTH_SERVER_URL is required when DEV_AUTH_BYPASS is disabled.");
    }
  }

  return parsed;
}

export function validateRuntimeConfig(source: NodeJS.ProcessEnv = process.env) {
  return readRuntimeEnv(source);
}

const parsedEnv = runtimeEnvSchema.safeParse(process.env);

export const ENV = {
  appId: parsedEnv.success ? parsedEnv.data.VITE_APP_ID : process.env.VITE_APP_ID ?? "",
  oAuthPortalUrl: parsedEnv.success ? parsedEnv.data.VITE_OAUTH_PORTAL_URL ?? "" : process.env.VITE_OAUTH_PORTAL_URL ?? "",
  cookieSecret: parsedEnv.success ? parsedEnv.data.JWT_SECRET : process.env.JWT_SECRET ?? "",
  databaseUrl: parsedEnv.success ? parsedEnv.data.DATABASE_URL : process.env.DATABASE_URL ?? "",
  oAuthServerUrl: parsedEnv.success ? parsedEnv.data.OAUTH_SERVER_URL ?? "" : process.env.OAUTH_SERVER_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  devAuthBypass:
    parsedEnv.success
      ? parsedEnv.data.DEV_AUTH_BYPASS ?? ""
      : process.env.DEV_AUTH_BYPASS ?? "",
  devAuthOpenId:
    parsedEnv.success
      ? parsedEnv.data.DEV_AUTH_OPEN_ID ?? ""
      : process.env.DEV_AUTH_OPEN_ID ?? "",
} as const;

export function isDevAuthBypassEnabled() {
  if (ENV.isProduction) return false;
  return isTruthy(ENV.devAuthBypass);
}
