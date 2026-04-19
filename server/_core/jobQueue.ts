/**
 * Background Job Queue for long-running tasks
 * Prevents timeouts on large project analyses
 */

import { EventEmitter } from "node:events";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface Job<T = unknown, R = unknown> {
  id: string;
  name: string;
  status: JobStatus;
  priority: number;
  data: T;
  result?: R;
  error?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  progress?: number;
}

export interface JobHandler<T = unknown, R = unknown> {
  (job: Job<T, R>, updateProgress: (progress: number) => void): Promise<R>;
}

interface JobOptions {
  priority?: number;
  maxAttempts?: number;
}

export class JobQueue extends EventEmitter {
  private jobs: Map<string, Job> = new Map();
  private handlers: Map<string, JobHandler> = new Map();
  private processing = false;
  private workerInterval: NodeJS.Timeout | null = null;
  private concurrentJobs: number;
  private activeJobs: Set<string> = new Set();

  constructor(options: { concurrentJobs?: number } = {}) {
    super();
    this.concurrentJobs = options.concurrentJobs ?? 2;
  }

  /**
   * Register a handler for a job type
   */
  register<T, R>(name: string, handler: JobHandler<T, R>) {
    if (this.handlers.has(name)) {
      throw new Error(`Handler for job type "${name}" already registered`);
    }
    this.handlers.set(name, handler as JobHandler);
  }

  /**
   * Add a job to the queue
   */
  async add<T = unknown, R = unknown>(
    name: string,
    data: T,
    options: JobOptions = {}
  ): Promise<Job<T, R>> {
    if (!this.handlers.has(name)) {
      throw new Error(`No handler registered for job type "${name}"`);
    }

    const job: Job<T, R> = {
      id: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name,
      status: "pending",
      priority: options.priority ?? 5,
      data,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      createdAt: new Date(),
    };

    this.jobs.set(job.id, job as Job);
    this.emit("job:created", job);

    this.startWorker();
    return job;
  }

  /**
   * Get job by ID
   */
  getJob<T = unknown, R = unknown>(id: string): Job<T, R> | undefined {
    return this.jobs.get(id) as Job<T, R> | undefined;
  }

  /**
   * Get all jobs with optional status filter
   */
  getJobs(status?: JobStatus): Job[] {
    const jobs = Array.from(this.jobs.values());
    if (status) {
      return jobs.filter((job) => job.status === status);
    }
    return jobs;
  }

  /**
   * Cancel a pending or running job
   */
  cancelJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.status === "completed" || job.status === "cancelled") {
      return false;
    }

    job.status = "cancelled";
    job.completedAt = new Date();
    return true;
  }

  /**
   * Start the background worker
   */
  private startWorker() {
    if (this.processing) return;

    this.processing = true;
    this.workerInterval = setInterval(() => {
      void this.processNextJob();
    }, 100);
  }

  /**
   * Stop the background worker
   */
  stopWorker() {
    this.processing = false;
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }
  }

  /**
   * Process the next available job
   */
  private async processNextJob() {
    if (this.activeJobs.size >= this.concurrentJobs) {
      return;
    }

    const pendingJobs = Array.from(this.jobs.values())
      .filter((job) => job.status === "pending" && !this.activeJobs.has(job.id))
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    if (pendingJobs.length === 0) {
      const allFinished = Array.from(this.jobs.values()).every(
        (j) =>
          j.status === "completed" ||
          j.status === "failed" ||
          j.status === "cancelled"
      );

      if (allFinished) {
        this.stopWorker();
      }
      return;
    }

    const job = pendingJobs[0];
    await this.executeJob(job);
  }

  /**
   * Execute a single job
   */
  private async executeJob(job: Job) {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      job.status = "failed";
      job.error = `No handler found for job type "${job.name}"`;
      job.completedAt = new Date();
      this.emit("job:failed", job);
      return;
    }

    job.status = "running";
    job.startedAt = new Date();
    job.attempts += 1;
    this.activeJobs.add(job.id);
    this.emit("job:started", job);

    const updateProgress = (progress: number) => {
      job.progress = Math.min(100, Math.max(0, progress));
      this.emit("job:progress", { job, progress: job.progress });
    };

    try {
      const result = await handler(job as Job<unknown, unknown>, updateProgress);
      job.result = result;
      job.status = "completed";
      job.progress = 100;
      job.completedAt = new Date();
      this.emit("job:completed", job);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      job.error = errorMessage;

      if (job.attempts < job.maxAttempts) {
        job.status = "pending";
        return;
      }

      job.status = "failed";
      job.completedAt = new Date();
      this.emit("job:failed", job);
    } finally {
      this.activeJobs.delete(job.id);
    }
  }

  /**
   * Clear completed and failed jobs older than specified time
   */
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;

    for (const [id, job] of this.jobs.entries()) {
      if (
        (job.status === "completed" ||
          job.status === "failed" ||
          job.status === "cancelled") &&
        job.completedAt &&
        job.completedAt.getTime() < cutoff
      ) {
        this.jobs.delete(id);
      }
    }
  }

  /**
   * Get queue statistics
   */
  getStats() {
    const jobs = Array.from(this.jobs.values());

    return {
      total: jobs.length,
      pending: jobs.filter((j) => j.status === "pending").length,
      running: jobs.filter((j) => j.status === "running").length,
      completed: jobs.filter((j) => j.status === "completed").length,
      failed: jobs.filter((j) => j.status === "failed").length,
      cancelled: jobs.filter((j) => j.status === "cancelled").length,
      activeWorkers: this.activeJobs.size,
      maxWorkers: this.concurrentJobs,
    };
  }
}

export const globalJobQueue = new JobQueue({ concurrentJobs: 2 });