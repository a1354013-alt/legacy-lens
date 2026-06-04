export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

const isDevAuthBypassEnabled = () => {
  const useDevBypass = String(import.meta.env.VITE_DEV_AUTH_BYPASS ?? "").toLowerCase();
  return useDevBypass === "1" || useDevBypass === "true" || useDevBypass === "yes" || useDevBypass === "on";
};

const buildAuthUrl = (path: string) => {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("next", window.location.pathname || "/");
  return url.toString();
};

export const getLoginUrl = () => {
  return buildAuthUrl(isDevAuthBypassEnabled() ? "/api/dev/login" : "/api/oauth/start");
};

export const getLogoutRedirectUrl = () => {
  return buildAuthUrl(isDevAuthBypassEnabled() ? "/api/dev/logout" : "/login");
};

export const getAuthModeLabel = () => {
  return isDevAuthBypassEnabled() ? "Local Dev: demo auth bypass" : "Signed in";
};
