import type { CookieOptions, Request } from "express";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isIpAddress(host: string) {
  // Basic IPv4 check and IPv6 presence detection.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;

  const protoList = Array.isArray(forwardedProto)
    ? forwardedProto
    : forwardedProto.split(",");

  return protoList.some(proto => proto.trim().toLowerCase() === "https");
}

export function getSessionCookieOptions(
  req: Request
): Pick<CookieOptions, "domain" | "httpOnly" | "path" | "sameSite" | "secure"> {
  const isSecure = isSecureRequest(req);
  
  // P0 FIX: Core rule - NEVER allow sameSite:none + secure:false
  // Only use sameSite:none when isSecure=true (HTTPS)
  // Otherwise always use sameSite:lax
  // This prevents browsers from rejecting the cookie
  
  if (!isSecure) {
    console.warn(
      "[Cookie] Non-HTTPS request detected. Using sameSite=lax for compatibility. " +
      "For production, ensure x-forwarded-proto header is set correctly or use HTTPS."
    );
  }
  
  return {
    httpOnly: true,
    path: "/",
    // P0 FIX: Core rule - sameSite depends ONLY on isSecure
    // isSecure=true (HTTPS): sameSite=none (allows cross-site)
    // isSecure=false (HTTP): sameSite=lax (never none)
    sameSite: isSecure ? "none" : "lax",
    // CRITICAL: Only set secure if actually HTTPS
    // Browsers will reject sameSite:none + secure:false
    secure: isSecure,
  };
}
