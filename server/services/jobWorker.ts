import { Worker } from "node:worker_threads";
import type { AppErrorCode } from "../../shared/contracts";
import { AppError } from "../appError";
import { logger } from "../_core/logger";
import { parsePositiveIntEnv } from "../_core/env";
import type { ProjectJobOwnership } from "./project/projectJobLease";

type WorkerRequest = {
  id: number;
  jobId: number;
};

type WorkerReadyMessage = {
  type: "ready";
};

type WorkerResponse =
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
      errorCode?: AppErrorCode;
      errorMessage: string;
    };

type WorkerMessage = WorkerReadyMessage | WorkerResponse;

type WorkerState = {
  worker: Worker;
  ready: Promise<Worker>;
};

type ProjectJobFailurePersister = (ownership: ProjectJobOwnership, error: AppError) => Promise<unknown>;

let nextRequestId = 1;
let workerState: WorkerState | null = null;
let projectJobFailurePersisterOverride: ProjectJobFailurePersister | null = null;
export const PROJECT_JOB_EXECUTION_TIMEOUT_MS = parsePositiveIntEnv("PROJECT_JOB_EXECUTION_TIMEOUT_MS", 30 * 60 * 1000);
export const PROJECT_JOB_WORKER_START_TIMEOUT_MS = parsePositiveIntEnv("PROJECT_JOB_WORKER_START_TIMEOUT_MS", 15 * 1000);
const pendingRequests = new Map<
  number,
  {
    jobId: number;
    ownership: ProjectJobOwnership;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
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

function isWorkerReadyMessage(message: WorkerMessage): message is WorkerReadyMessage {
  return message.type === "ready";
}

function createWorkerState(): WorkerState {
  const moduleUrl = getWorkerModuleUrl();
  let readyResolve!: (worker: Worker) => void;
  let readyReject!: (error: Error) => void;
  let readySettled = false;

  const ready = new Promise<Worker>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => undefined);

  logger.info("Project job worker starting", {
    action: "project.job.worker.starting",
    status: "running",
    moduleUrl: moduleUrl.href,
  });

  const worker = new Worker(moduleUrl, {
    name: "project-job-worker",
    execArgv: process.env.NODE_ENV === "production" ? [] : ["--import", "tsx"],
  });

  const settleReady = (error?: Error) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    if (error) {
      readyReject(error);
      return;
    }
    readyResolve(worker);
  };

  worker.on("message", (message: WorkerMessage) => {
    if (isWorkerReadyMessage(message)) {
      settleReady();
      logger.info("Project job worker ready", {
        action: "project.job.worker.ready",
        status: "ok",
        moduleUrl: moduleUrl.href,
      });
      return;
    }

    logger.info("Project job worker message received", {
      action: "project.job.worker.message.received",
      status: message.ok ? "ok" : "error",
      requestId: message.id,
      jobId: message.jobId,
      ok: message.ok,
      errorCode: message.ok ? null : (message.errorCode ?? "PROJECT_JOB_WORKER_EXITED"),
      errorMessage: message.ok ? null : message.errorMessage,
    });

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

    request.reject(new AppError(message.errorCode ?? "PROJECT_JOB_WORKER_EXITED", message.errorMessage));
  });

  worker.on("error", (error) => {
    settleReady(error instanceof Error ? error : new Error(String(error)));
    logger.error("Project job worker error", {
      action: "project.job.worker.error",
      status: "error",
      moduleUrl: moduleUrl.href,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    for (const [requestId, pending] of pendingRequests.entries()) {
      pendingRequests.delete(requestId);
      clearTimeout(pending.timeout);
      void failPendingJobBestEffort(
        pending.ownership,
        new AppError("PROJECT_JOB_WORKER_EXITED", `Project job worker crashed while processing job ${pending.jobId}.`)
      );
      pending.reject(error);
    }
    if (workerState?.worker === worker) {
      workerState = null;
    }
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      settleReady(new Error(`Project job worker exited with code ${code}.`));
    } else {
      settleReady();
    }
    if (code !== 0) {
      const error = new Error(`Project job worker exited with code ${code}.`);
      logger.error("Project job worker error", {
        action: "project.job.worker.error",
        status: "error",
        moduleUrl: moduleUrl.href,
        errorMessage: error.message,
      });
      for (const [requestId, pending] of pendingRequests.entries()) {
        pendingRequests.delete(requestId);
        clearTimeout(pending.timeout);
        void failPendingJobBestEffort(
          pending.ownership,
          new AppError("PROJECT_JOB_WORKER_EXITED", `Project job worker exited with code ${code} while processing job ${pending.jobId}.`)
        );
        pending.reject(error);
      }
    }
    if (workerState?.worker === worker) {
      workerState = null;
    }
  });

  return { worker, ready };
}

async function getWorker() {
  if (!workerState) {
    try {
      workerState = createWorkerState();
    } catch (error) {
      const appError = new AppError(
        "PROJECT_JOB_WORKER_EXITED",
        `Project job worker could not start. ${error instanceof Error ? error.message : String(error)}`
      );
      logger.error("Project job worker error", {
        action: "project.job.worker.error",
        status: "error",
        moduleUrl: getWorkerModuleUrl().href,
        errorCode: appError.code,
        errorMessage: appError.message,
      });
      throw appError;
    }
  }
  const currentState = workerState;

  try {
    return await new Promise<Worker>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new AppError("PROJECT_JOB_WORKER_EXITED", `Project job worker did not become ready within ${PROJECT_JOB_WORKER_START_TIMEOUT_MS} ms.`));
      }, PROJECT_JOB_WORKER_START_TIMEOUT_MS);
      timeout.unref?.();

      currentState.ready
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timeout);
        });
    });
  } catch (error) {
    if (workerState?.worker === currentState.worker) {
      workerState = null;
    }
    void currentState.worker.terminate().catch(() => undefined);
    const appError =
      error instanceof AppError
        ? error
        : new AppError("PROJECT_JOB_WORKER_EXITED", error instanceof Error ? error.message : String(error));
    logger.error("Project job worker error", {
      action: "project.job.worker.error",
      status: "error",
      moduleUrl: getWorkerModuleUrl().href,
      errorCode: appError.code,
      errorMessage: appError.message,
    });
    throw appError;
  }
}

async function failPendingJob(ownership: ProjectJobOwnership, error: AppError) {
  if (projectJobFailurePersisterOverride) {
    await projectJobFailurePersisterOverride(ownership, error);
    return;
  }

  const { failClaimedProjectJobBestEffort } = await import("./projectWorkflow");
  await failClaimedProjectJobBestEffort(ownership, error);
}

async function failPendingJobBestEffort(ownership: ProjectJobOwnership, error: AppError) {
  try {
    await failPendingJob(ownership, error);
  } catch (persistError) {
    logger.warn("Project job failure persistence failed", {
      action: "project.job.failure_persist_failed",
      status: "error",
      jobId: ownership.jobId,
      lockedBy: ownership.lockedBy,
      attemptCount: ownership.attemptCount,
      errorCode: error.code,
      errorMessage: error.message,
      persistErrorMessage: persistError instanceof Error ? persistError.message : String(persistError),
    });
  }
}

export function setProjectJobFailurePersisterForTest(persister: ProjectJobFailurePersister | null) {
  projectJobFailurePersisterOverride = persister;
}

export async function runProjectJob(jobId: number, ownership: ProjectJobOwnership) {
  if (isTestEnvironment()) {
    const { runClaimedProjectJob } = await import("./projectWorkflow");
    await runClaimedProjectJob(jobId);
    return;
  }

  const requestId = nextRequestId++;
  try {
    const worker = await getWorker();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const request = pendingRequests.get(requestId);
        if (!request) {
          return;
        }

        pendingRequests.delete(requestId);
        const timedOutWorker = workerState?.worker === worker ? workerState.worker : worker;
        if (workerState?.worker === worker) {
          workerState = null;
        }
        void timedOutWorker.terminate();
        reject(new AppError("PROJECT_JOB_TIMEOUT", `Project job ${jobId} exceeded execution timeout (${PROJECT_JOB_EXECUTION_TIMEOUT_MS} ms).`));
      }, PROJECT_JOB_EXECUTION_TIMEOUT_MS);
      timeout.unref?.();

      pendingRequests.set(requestId, { jobId, ownership, resolve, reject, timeout });
      logger.info("Project job worker message sent", {
        action: "project.job.worker.message.sent",
        status: "running",
        requestId,
        jobId,
      });
      try {
        worker.postMessage({
          id: requestId,
          jobId,
        } satisfies WorkerRequest);
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimeout(timeout);
        reject(
          error instanceof AppError
            ? error
            : new AppError(
                "PROJECT_JOB_WORKER_EXITED",
                `Project job worker could not accept job ${jobId}. ${error instanceof Error ? error.message : String(error)}`
              )
        );
      }
    });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError("PROJECT_JOB_WORKER_EXITED", error instanceof Error ? error.message : String(error));
    await failPendingJobBestEffort(ownership, appError);
    throw appError;
  }
}
