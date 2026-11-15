import { randomBytes } from "node:crypto";
import { McpToolError } from "../errors.js";

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobInfo {
  id: string;
  op: string;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: { done: number; total: number; message?: string };
  error?: string;
}

interface Job extends JobInfo {
  controller: AbortController;
  run: (signal: AbortSignal, progress: (done: number, total: number, message?: string) => void) => Promise<unknown>;
  result?: unknown;
  timer?: NodeJS.Timeout;
}

/**
 * Bounded background job queue: `concurrency` jobs run at once, at most `maxQueued`
 * wait. Each job gets an AbortSignal (cancellation and timeout kill the Aseprite
 * process it is waiting on) and can report progress. Finished jobs are kept for
 * `retain` entries so their results can be fetched.
 */
export class JobQueue {
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = 0;

  constructor(
    private readonly concurrency = 2,
    private readonly maxQueued = 32,
    private readonly timeoutMs = 10 * 60_000,
    private readonly retain = 64,
  ) {}

  submit(op: string, run: Job["run"]): JobInfo {
    if (this.queue.length >= this.maxQueued) {
      throw new McpToolError("LIMIT", `the job queue is full (${this.maxQueued} waiting)`, "Wait for running jobs or cancel some.");
    }
    const job: Job = {
      id: "job_" + randomBytes(4).toString("hex"),
      op,
      state: "queued",
      createdAt: new Date().toISOString(),
      controller: new AbortController(),
      run,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.pump();
    this.prune();
    return this.info(job);
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.state !== "queued") continue;
      this.running++;
      job.state = "running";
      job.startedAt = new Date().toISOString();
      job.timer = setTimeout(() => job.controller.abort(new McpToolError("TIMEOUT", `job exceeded ${this.timeoutMs} ms`)), this.timeoutMs);
      const progress = (done: number, total: number, message?: string) => {
        job.progress = { done, total, message };
      };
      job
        .run(job.controller.signal, progress)
        .then((r) => {
          if (job.state === "running") {
            job.state = "done";
            job.result = r;
          }
        })
        .catch((e: unknown) => {
          if (job.state === "running") {
            job.state = job.controller.signal.aborted && !(job.controller.signal.reason instanceof McpToolError && job.controller.signal.reason.code === "TIMEOUT") ? "cancelled" : "failed";
            job.error = (e as Error)?.message ?? String(e);
          }
        })
        .finally(() => {
          clearTimeout(job.timer);
          job.finishedAt = new Date().toISOString();
          this.running--;
          this.pump();
        });
    }
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((j) => j.state !== "queued" && j.state !== "running");
    for (const j of finished.slice(0, Math.max(0, finished.length - this.retain))) this.jobs.delete(j.id);
  }

  private info(j: Job): JobInfo {
    return { id: j.id, op: j.op, state: j.state, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, progress: j.progress, error: j.error };
  }

  get(id: string): Job {
    const j = this.jobs.get(id);
    if (!j) throw new McpToolError("NOT_FOUND", `no job '${id}'`, "Jobs are kept in memory; finished jobs are pruned after a while.");
    return j;
  }

  status(id: string): JobInfo {
    return this.info(this.get(id));
  }

  result(id: string): { info: JobInfo; result?: unknown } {
    const j = this.get(id);
    return { info: this.info(j), result: j.result };
  }

  cancel(id: string): JobInfo {
    const j = this.get(id);
    if (j.state === "queued") {
      j.state = "cancelled";
      j.finishedAt = new Date().toISOString();
    } else if (j.state === "running") {
      j.controller.abort(new McpToolError("CANCELLED", "job cancelled"));
      j.state = "cancelled";
      j.error = "cancelled";
    }
    return this.info(j);
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((j) => this.info(j));
  }

  stats(): { running: number; queued: number; concurrency: number; maxQueued: number } {
    return { running: this.running, queued: this.queue.filter((j) => j.state === "queued").length, concurrency: this.concurrency, maxQueued: this.maxQueued };
  }

  cancelAll(): void {
    for (const j of this.jobs.values()) if (j.state === "running" || j.state === "queued") this.cancel(j.id);
  }
}
