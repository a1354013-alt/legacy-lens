export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

export const getLoginUrl = () => {
  const url = new URL("/api/oauth/start", window.location.origin);
  url.searchParams.set("next", window.location.pathname || "/");
  return url.toString();
};
