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
export const PROJECT_JOB_EXECUTION_TIMEOUT_MS = parsePositiveIntEnv("PROJECT_JOB_EXECUTION_TIMEOUT_MS", 30 * 60 * 1000);
const pendingRequests = new Map<
  number,
  {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }
>();

function parsePositiveIntEnv(name: string, fallback: number) {
  const rawValue = process.env[name];
  const parsedValue = Number.parseInt(String(rawValue ?? ""), 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

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
    clearTimeout(request.timeout);
    if (message.ok) {
      request.resolve();
      return;
    }

    request.reject(new Error(message.error));
  });

  worker.on("error", (error) => {
    for (const [requestId, pending] of pendingRequests.entries()) {
      pendingRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    workerInstance = null;
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`Project job worker exited with code ${code}.`);
      for (const [requestId, pending] of pendingRequests.entries()) {
        pendingRequests.delete(requestId);
        clearTimeout(pending.timeout);
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
    const timeout = setTimeout(() => {
      const request = pendingRequests.get(requestId);
      if (!request) {
        return;
      }

      pendingRequests.delete(requestId);
      const timedOutWorker = workerInstance;
      workerInstance = null;
      void timedOutWorker?.terminate();
      reject(new Error(`Project job ${jobId} exceeded execution timeout (${PROJECT_JOB_EXECUTION_TIMEOUT_MS} ms).`));
    }, PROJECT_JOB_EXECUTION_TIMEOUT_MS);
    timeout.unref?.();

    pendingRequests.set(requestId, { resolve, reject, timeout });
    worker.postMessage({
      id: requestId,
      jobId,
    } satisfies WorkerRequest);
  });
}
