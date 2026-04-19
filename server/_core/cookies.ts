import type { CookieOptions, Request } from "express";
import { logger } from "./logger";

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
    logger.warn("Non-HTTPS request detected; using sameSite=lax for compatibility", {
      action: "cookie.options",
      status: "ok",
    });
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
