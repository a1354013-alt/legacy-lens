import { z } from "zod";

const runtimeEnvSchema = z.object({
  VITE_APP_ID: z.string().trim().min(1, "VITE_APP_ID is required."),
  VITE_OAUTH_PORTAL_URL: z.string().trim().min(1, "VITE_OAUTH_PORTAL_URL is required."),
  JWT_SECRET: z
    .string()
    .trim()
    .min(32, "JWT_SECRET must be at least 32 characters."),
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required."),
  OAUTH_SERVER_URL: z.string().trim().min(1, "OAUTH_SERVER_URL is required."),

  DEV_AUTH_BYPASS: z.string().trim().optional(),
  DEV_AUTH_OPEN_ID: z.string().trim().optional(),
  DEV_AUTH_BYPASS_UNSAFE_ALLOW: z.string().trim().optional(),
  LEGACY_LENS_GIT_HOST_ALLOWLIST: z.string().trim().optional(),
  LEGACY_LENS_TRUST_PROXY: z.string().trim().optional(),
  PROJECT_JOB_STALE_MS: z.string().trim().optional(),
  PROJECT_JOB_LEASE_MS: z.string().trim().optional(),
  PROJECT_JOB_HEARTBEAT_MS: z.string().trim().optional(),
  PROJECT_JOB_MAX_ATTEMPTS: z.string().trim().optional(),
  UPLOAD_TEMP_ZIP_TTL_MS: z.string().trim().optional(),
  LAST_SIGNED_IN_WRITE_THROTTLE_MS: z.string().trim().optional(),
  APP_VERSION: z.string().trim().optional(),
  GIT_COMMIT: z.string().trim().optional(),
  NODE_ENV: z.string().trim().optional(),
});

type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;

function isTruthy(value: string | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readRuntimeEnv(source: NodeJS.ProcessEnv): RuntimeEnv {
  const parsed = runtimeEnvSchema.parse(source);
  return parsed;
}

export function validateRuntimeConfig(source: NodeJS.ProcessEnv = process.env) {
  return readRuntimeEnv(source);
}

export function parsePositiveIntEnv(name: string, fallback: number, source: NodeJS.ProcessEnv = process.env): number {
  const raw = source[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

const parsedEnv = runtimeEnvSchema.safeParse(process.env);

export const ENV = {
  appId: parsedEnv.success ? parsedEnv.data.VITE_APP_ID : process.env.VITE_APP_ID ?? "",
  oAuthPortalUrl: parsedEnv.success ? parsedEnv.data.VITE_OAUTH_PORTAL_URL : process.env.VITE_OAUTH_PORTAL_URL ?? "",
  cookieSecret: parsedEnv.success ? parsedEnv.data.JWT_SECRET : process.env.JWT_SECRET ?? "",
  databaseUrl: parsedEnv.success ? parsedEnv.data.DATABASE_URL : process.env.DATABASE_URL ?? "",
  oAuthServerUrl: parsedEnv.success ? parsedEnv.data.OAUTH_SERVER_URL : process.env.OAUTH_SERVER_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  devAuthBypass:
    parsedEnv.success
      ? parsedEnv.data.DEV_AUTH_BYPASS ?? ""
      : process.env.DEV_AUTH_BYPASS ?? "",
  devAuthOpenId:
    parsedEnv.success
      ? parsedEnv.data.DEV_AUTH_OPEN_ID ?? ""
      : process.env.DEV_AUTH_OPEN_ID ?? "",
  devAuthBypassUnsafeAllow:
    parsedEnv.success
      ? parsedEnv.data.DEV_AUTH_BYPASS_UNSAFE_ALLOW ?? ""
      : process.env.DEV_AUTH_BYPASS_UNSAFE_ALLOW ?? "",
} as const;

export function isDevAuthBypassEnabled() {
  if (ENV.isProduction && !isTruthy(ENV.devAuthBypassUnsafeAllow)) return false;
  return isTruthy(ENV.devAuthBypass);
}
