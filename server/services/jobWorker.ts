import { Worker } from "node:worker_threads";

type WorkerRequest = {
  id: number;
  jobId: number;
};

type WorkerResponse =
  | {
      id: number;
      jobId: number;
      ok: true;
    }
  | {
      id: number;
      jobId: number;
      ok: false;
      error: string;
    };

let nextRequestId = 1;
let workerInstance: Worker | null = null;
const pendingRequests = new Map<
  number,
  {
    resolve: () => void;
    reject: (error: Error) => void;
  }
>();

function isTestEnvironment() {
  return process.env.NODE_ENV === "test";
}

function getWorkerModuleUrl() {
  if (process.env.NODE_ENV === "production") {
    return new URL("./services/jobWorkerThread.js", import.meta.url);
  }

  return new URL("./jobWorkerThread.ts", import.meta.url);
}

function createWorker() {
  const worker = new Worker(getWorkerModuleUrl(), {
    execArgv: process.env.NODE_ENV === "production" ? [] : ["--import", "tsx"],
  });

  worker.on("message", (message: WorkerResponse) => {
    const request = pendingRequests.get(message.id);
    if (!request) {
      return;
    }

    pendingRequests.delete(message.id);
    if (message.ok) {
      request.resolve();
      return;
    }

    request.reject(new Error(message.error));
  });

  worker.on("error", (error) => {
    for (const [requestId, pending] of pendingRequests.entries()) {
      pendingRequests.delete(requestId);
      pending.reject(error);
    }
    workerInstance = null;
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`Project job worker exited with code ${code}.`);
      for (const [requestId, pending] of pendingRequests.entries()) {
        pendingRequests.delete(requestId);
        pending.reject(error);
      }
    }
    workerInstance = null;
  });

  return worker;
}

function getWorker() {
  workerInstance ??= createWorker();
  return workerInstance;
}

export async function runProjectJob(jobId: number) {
  if (isTestEnvironment()) {
    const { runClaimedProjectJob } = await import("./projectWorkflow");
    await runClaimedProjectJob(jobId);
    return;
  }

  const requestId = nextRequestId++;
  const worker = getWorker();

  await new Promise<void>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    worker.postMessage({
      id: requestId,
      jobId,
    } satisfies WorkerRequest);
  });
}
