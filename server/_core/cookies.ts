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
  const isLocalhost = req.hostname && LOCAL_HOSTS.has(req.hostname);
  
  // BUG-2 FIX: Strict environment detection
  // Development: localhost + HTTP only
  // Production: HTTPS (regardless of hostname)
  const isDevelopment = isLocalhost && !isSecure;
  
  // CRITICAL: Never use sameSite: "none" without secure: true
  // This will cause browsers to reject the cookie
  if (!isDevelopment && !isSecure) {
    console.warn(
      "[Cookie] WARNING: Non-HTTPS request detected in non-localhost environment. " +
      "Cookie may be rejected by browser. Ensure x-forwarded-proto header is set correctly."
    );
  }
  
  return {
    httpOnly: true,
    path: "/",
    // Development (localhost + HTTP): use lax for compatibility
    // Production (HTTPS): use none for cross-site requests
    sameSite: isDevelopment ? "lax" : "none",
    // CRITICAL: Only set secure if actually HTTPS
    // Development: secure=false (HTTP)
    // Production: secure=true (HTTPS)
    secure: isSecure,
  };
}
