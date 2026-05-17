import { Buffer } from "node:buffer";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function describeLastResult(lastStatus, lastError) {
  if (lastError) {
    const statusDetails = lastStatus !== null ? ` Last status: ${lastStatus}.` : "";
    return `Last error: ${lastError.code ?? lastError.message ?? String(lastError)}.${statusDetails}`;
  }

  if (lastStatus !== null) {
    return `Last status: ${lastStatus}.`;
  }

  return "No response received.";
}

function requestHttp(url, requestTimeoutMs) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    let settled = false;

    const request = transport.request(
      parsedUrl,
      {
        method: "GET",
        timeout: requestTimeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          settled = true;
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            ok: response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode ?? 0,
          });
        });
      }
    );

    request.on("timeout", () => {
      const error = new Error(`HTTP request timed out after ${requestTimeoutMs}ms`);
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });

    request.on("error", (error) => {
      if (!settled) {
        reject(error);
      }
    });

    request.end();
  });
}

export async function waitForHttp(
  url,
  validator,
  {
    pollIntervalMs = 2_000,
    requestTimeoutMs = 3_000,
    requestOnce = requestHttp,
    timeoutMs,
  }
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("waitForHttp requires a positive timeoutMs option.");
  }

  const startedAt = Date.now();
  let lastError = null;
  let lastStatus = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await requestOnce(url, requestTimeoutMs);
      lastStatus = response.status;
      lastError = null;

      if (await validator(response)) {
        return response;
      }

      lastError = new Error(`Unexpected response ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      break;
    }

    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  throw new Error(`Timed out waiting for ${url}. ${describeLastResult(lastStatus, lastError)}`);
}
