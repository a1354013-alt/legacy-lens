import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  workerInstances,
  workerCtorErrorRef,
  autoReadyRef,
} = vi.hoisted(() => ({
  workerInstances: [] as Array<
    EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    }
  >,
  workerCtorErrorRef: { current: null as Error | null },
  autoReadyRef: { current: true },
}));
const { failProjectJobWithoutOwnershipMock } = vi.hoisted(() => ({
  failProjectJobWithoutOwnershipMock: vi.fn(async () => true),
}));

vi.mock("node:worker_threads", () => ({
  Worker: class Worker extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => 0);

    constructor() {
      super();
      if (workerCtorErrorRef.current) {
        throw workerCtorErrorRef.current;
      }
      workerInstances.push(this);
      if (autoReadyRef.current) {
        queueMicrotask(() => {
          this.emit("message", { type: "ready" });
        });
      }
    }
  },
}));

vi.mock("./projectWorkflow", () => ({
  failProjectJobWithoutOwnership: failProjectJobWithoutOwnershipMock,
  runClaimedProjectJob: vi.fn(),
}));

describe("runProjectJob", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    workerInstances.length = 0;
    workerCtorErrorRef.current = null;
    autoReadyRef.current = true;
    failProjectJobWithoutOwnershipMock.mockClear();
    delete process.env.PROJECT_JOB_EXECUTION_TIMEOUT_MS;
    delete process.env.PROJECT_JOB_WORKER_START_TIMEOUT_MS;
    process.env.NODE_ENV = "test";
  });

  it("fails the claimed job when the worker constructor throws before dispatch", async () => {
    process.env.NODE_ENV = "production";
    workerCtorErrorRef.current = new Error("bundle missing");

    const { runProjectJob } = await import("./jobWorker");

    await expect(runProjectJob(42)).rejects.toMatchObject({
      code: "PROJECT_JOB_WORKER_EXITED",
      message: expect.stringContaining("bundle missing"),
    });

    expect(failProjectJobWithoutOwnershipMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ code: "PROJECT_JOB_WORKER_EXITED", message: expect.stringContaining("bundle missing") })
    );
  });

  it("fails the claimed job when the worker never becomes ready", async () => {
    vi.useFakeTimers();
    process.env.NODE_ENV = "production";
    process.env.PROJECT_JOB_WORKER_START_TIMEOUT_MS = "25";
    autoReadyRef.current = false;

    const { runProjectJob } = await import("./jobWorker");
    const promise = runProjectJob(42);
    const expectation = expect(promise).rejects.toMatchObject({
      code: "PROJECT_JOB_WORKER_EXITED",
    });
    await vi.advanceTimersByTimeAsync(25);

    await expectation;
    expect(failProjectJobWithoutOwnershipMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ code: "PROJECT_JOB_WORKER_EXITED" })
    );
  });

  it("fails the claimed job when the worker rejects the dispatched job", async () => {
    process.env.NODE_ENV = "production";

    const { runProjectJob } = await import("./jobWorker");
    const promise = runProjectJob(42);

    await vi.waitFor(() => {
      expect(workerInstances).toHaveLength(1);
      expect(workerInstances[0].postMessage).toHaveBeenCalledWith({ id: 1, jobId: 42 });
    });

    workerInstances[0].emit("message", {
      type: "result",
      id: 1,
      jobId: 42,
      ok: false,
      errorCode: "IMPORT_FAILED",
      errorMessage: "ZIP import failed.",
    });

    await expect(promise).rejects.toMatchObject({
      code: "IMPORT_FAILED",
      message: "ZIP import failed.",
    });
    expect(failProjectJobWithoutOwnershipMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ code: "IMPORT_FAILED", message: "ZIP import failed." })
    );
  });

  it("terminates a stuck worker request after the execution timeout", async () => {
    vi.useFakeTimers();
    process.env.NODE_ENV = "production";
    process.env.PROJECT_JOB_EXECUTION_TIMEOUT_MS = "25";

    const { runProjectJob } = await import("./jobWorker");
    const promise = runProjectJob(42);
    await vi.waitFor(() => {
      expect(workerInstances).toHaveLength(1);
      expect(workerInstances[0].postMessage).toHaveBeenCalledWith({ id: 1, jobId: 42 });
    });

    const expectation = expect(promise).rejects.toMatchObject({
      code: "PROJECT_JOB_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(25);

    await expectation;
    expect(workerInstances[0].terminate).toHaveBeenCalledTimes(1);
    expect(failProjectJobWithoutOwnershipMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ code: "PROJECT_JOB_TIMEOUT" })
    );
  });
});
