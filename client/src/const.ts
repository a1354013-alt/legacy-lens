export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

export const getLoginUrl = () => {
  const useDevBypass = String(import.meta.env.VITE_DEV_AUTH_BYPASS ?? "").toLowerCase();
  const path = useDevBypass === "1" || useDevBypass === "true" || useDevBypass === "yes" || useDevBypass === "on"
    ? "/api/dev/login"
    : "/api/oauth/start";

  const url = new URL(path, window.location.origin);
  url.searchParams.set("next", window.location.pathname || "/");
  return url.toString();
};
