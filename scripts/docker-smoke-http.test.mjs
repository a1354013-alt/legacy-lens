import { describe, expect, it, vi } from "vitest";
import { waitForHttp } from "./docker-smoke-http.mjs";

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

describe("waitForHttp", () => {
  it("retries after request timeout errors", async () => {
    const requestOnce = vi
      .fn()
      .mockRejectedValueOnce(codedError("ETIMEDOUT"))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await expect(
      waitForHttp("http://127.0.0.1:38080/health", (response) => response.ok, {
        pollIntervalMs: 1,
        requestOnce,
        requestTimeoutMs: 5,
        timeoutMs: 100,
      })
    ).resolves.toEqual({ ok: true, status: 200 });

    expect(requestOnce).toHaveBeenCalledTimes(2);
  });

  it("retries after ECONNREFUSED errors", async () => {
    const requestOnce = vi
      .fn()
      .mockRejectedValueOnce(codedError("ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await waitForHttp("http://127.0.0.1:38080/health", (response) => response.ok, {
      pollIntervalMs: 1,
      requestOnce,
      requestTimeoutMs: 5,
      timeoutMs: 100,
    });

    expect(requestOnce).toHaveBeenCalledTimes(2);
  });

  it("resolves when the validator accepts the response", async () => {
    const response = { ok: false, status: 302 };
    const requestOnce = vi.fn().mockResolvedValueOnce(response);

    await expect(
      waitForHttp("http://127.0.0.1:38080/api/dev/login?next=%2F", (result) => result.status === 302, {
        pollIntervalMs: 1,
        requestOnce,
        requestTimeoutMs: 5,
        timeoutMs: 100,
      })
    ).resolves.toBe(response);
  });

  it("throws with the last error when the total timeout expires", async () => {
    const requestOnce = vi.fn().mockRejectedValue(codedError("ECONNRESET"));

    await expect(
      waitForHttp("http://127.0.0.1:38080/health", (response) => response.ok, {
        pollIntervalMs: 1,
        requestOnce,
        requestTimeoutMs: 5,
        timeoutMs: 50,
      })
    ).rejects.toThrow("Timed out waiting for http://127.0.0.1:38080/health. Last error: ECONNRESET.");

    expect(requestOnce.mock.calls.length).toBeGreaterThan(1);
  });

  it("throws with the last status when responses never validate", async () => {
    const requestOnce = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    await expect(
      waitForHttp("http://127.0.0.1:38080/health", (response) => response.ok, {
        pollIntervalMs: 1,
        requestOnce,
        requestTimeoutMs: 5,
        timeoutMs: 10,
      })
    ).rejects.toThrow(
      "Timed out waiting for http://127.0.0.1:38080/health. Last error: Unexpected response 503"
    );
  });
});
