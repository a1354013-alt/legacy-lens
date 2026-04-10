import { z } from "zod";

const runtimeEnvSchema = z.object({
  VITE_APP_ID: z.string().trim().min(1, "VITE_APP_ID is required."),
  VITE_OAUTH_PORTAL_URL: z.string().trim().min(1, "VITE_OAUTH_PORTAL_URL is required."),
  JWT_SECRET: z.string().trim().min(1, "JWT_SECRET is required."),
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required."),
  OAUTH_SERVER_URL: z.string().trim().min(1, "OAUTH_SERVER_URL is required."),
  OWNER_OPEN_ID: z.string().trim().min(1, "OWNER_OPEN_ID is required."),
  BUILT_IN_FORGE_API_URL: z.string().trim().optional(),
  BUILT_IN_FORGE_API_KEY: z.string().trim().optional(),
  NODE_ENV: z.string().trim().optional(),
});

type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;

function readRuntimeEnv(source: NodeJS.ProcessEnv): RuntimeEnv {
  return runtimeEnvSchema.parse(source);
}

export function validateRuntimeConfig(source: NodeJS.ProcessEnv = process.env) {
  return readRuntimeEnv(source);
}

const parsedEnv = runtimeEnvSchema.safeParse(process.env);

export const ENV = {
  appId: parsedEnv.success ? parsedEnv.data.VITE_APP_ID : process.env.VITE_APP_ID ?? "",
  oAuthPortalUrl: parsedEnv.success ? parsedEnv.data.VITE_OAUTH_PORTAL_URL : process.env.VITE_OAUTH_PORTAL_URL ?? "",
  cookieSecret: parsedEnv.success ? parsedEnv.data.JWT_SECRET : process.env.JWT_SECRET ?? "",
  databaseUrl: parsedEnv.success ? parsedEnv.data.DATABASE_URL : process.env.DATABASE_URL ?? "",
  oAuthServerUrl: parsedEnv.success ? parsedEnv.data.OAUTH_SERVER_URL : process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: parsedEnv.success ? parsedEnv.data.OWNER_OPEN_ID : process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: parsedEnv.success ? parsedEnv.data.BUILT_IN_FORGE_API_URL ?? "" : process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: parsedEnv.success ? parsedEnv.data.BUILT_IN_FORGE_API_KEY ?? "" : process.env.BUILT_IN_FORGE_API_KEY ?? "",
} as const;
