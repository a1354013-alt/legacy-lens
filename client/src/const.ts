export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

const isDevAuthBypassEnabled = () => {
  const useDevBypass = String(import.meta.env.VITE_DEV_AUTH_BYPASS ?? "").toLowerCase();
  return useDevBypass === "1" || useDevBypass === "true" || useDevBypass === "yes" || useDevBypass === "on";
};

const buildAuthUrl = (path: string) => {
  const url = new URL(path, window.location.origin);
  const nextPath = `${window.location.pathname || "/"}${window.location.search || ""}${window.location.hash || ""}`;
  url.searchParams.set("next", nextPath);
  return url.toString();
};

export const getLoginUrl = () => {
  return buildAuthUrl(isDevAuthBypassEnabled() ? "/api/dev/login" : "/api/oauth/start");
};

export const getLogoutRedirectUrl = () => {
  return buildAuthUrl(isDevAuthBypassEnabled() ? "/api/dev/logout" : "/");
};

export const getAuthModeLabel = () => {
  return isDevAuthBypassEnabled() ? "本機開發：示範登入" : "已登入";
};
