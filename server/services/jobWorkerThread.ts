import { parentPort } from "node:worker_threads";

type WorkerRequest = {
  id: number;
  jobId: number;
};

parentPort?.on("message", async (message: WorkerRequest) => {
  const { runClaimedProjectJob } = await import("./projectWorkflow");

  try {
    await runClaimedProjectJob(message.jobId);
    parentPort?.postMessage({
      id: message.id,
      jobId: message.jobId,
      ok: true,
    });
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      jobId: message.jobId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
