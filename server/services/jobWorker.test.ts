import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { workerInstances } = vi.hoisted(() => ({
  workerInstances: [] as Array<EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }>,
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
      workerInstances.push(this);
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
    failProjectJobWithoutOwnershipMock.mockClear();
    delete process.env.PROJECT_JOB_EXECUTION_TIMEOUT_MS;
    process.env.NODE_ENV = "test";
  });

  it("terminates a stuck worker request after the execution timeout", async () => {
    vi.useFakeTimers();
    process.env.NODE_ENV = "development";
    process.env.PROJECT_JOB_EXECUTION_TIMEOUT_MS = "25";

    const { runProjectJob } = await import("./jobWorker");
    const promise = runProjectJob(42);
    const expectation = expect(promise).rejects.toThrow("Project job 42 exceeded execution timeout (25 ms).");
    await vi.advanceTimersByTimeAsync(25);

    await expectation;
    expect(workerInstances).toHaveLength(1);
    expect(workerInstances[0].postMessage).toHaveBeenCalledWith({ id: 1, jobId: 42 });
    expect(workerInstances[0].terminate).toHaveBeenCalledTimes(1);
    expect(failProjectJobWithoutOwnershipMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ code: "PROJECT_JOB_TIMEOUT" })
    );
  });
});
