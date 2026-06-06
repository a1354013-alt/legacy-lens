import { parentPort } from "node:worker_threads";
import { AppError } from "../appError";

type WorkerRequest = {
  id: number;
  jobId: number;
};

type WorkerReadyMessage = {
  type: "ready";
};

type WorkerResultMessage =
  | {
      type: "result";
      id: number;
      jobId: number;
      ok: true;
    }
  | {
      type: "result";
      id: number;
      jobId: number;
      ok: false;
      errorCode?: string;
      errorMessage: string;
    };

if (!parentPort) {
  throw new Error("Project job worker thread requires a parent port.");
}

const workerPort = parentPort;

workerPort.postMessage({ type: "ready" } satisfies WorkerReadyMessage);

workerPort.on("message", async (message: WorkerRequest) => {
  const postResult = (result: WorkerResultMessage) => {
    workerPort.postMessage(result);
  };

  try {
    const { runClaimedProjectJob } = await import("./projectWorkflow");
    await runClaimedProjectJob(message.jobId);
    postResult({
      type: "result",
      id: message.id,
      jobId: message.jobId,
      ok: true,
    });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError("PROJECT_JOB_WORKER_EXITED", error instanceof Error ? error.message : String(error));
    postResult({
      type: "result",
      id: message.id,
      jobId: message.jobId,
      ok: false,
      errorCode: appError.code,
      errorMessage: appError.message,
    });
  }
});
