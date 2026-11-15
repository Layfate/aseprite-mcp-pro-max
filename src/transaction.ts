import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { McpToolError } from "./errors.js";
import { DocumentStore } from "./runtime/documents.js";

/** Serializes async work per key (one writer per file). */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const k = process.platform === "win32" || process.platform === "darwin" ? key.toLowerCase() : key;
    const prev = this.tails.get(k) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => gate);
    this.tails.set(k, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(k) === tail) this.tails.delete(k);
    }
  }
}

export interface Checkpoint {
  id: string;
  createdAt: string;
  bytes: number;
  label?: string;
}

/** A sibling path with the same extension, so Aseprite picks the same format. */
export function workingPath(target: string): string {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  return path.join(dir, `.${base}.mcp-${randomBytes(4).toString("hex")}${ext}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const CP_RE = /^(\d{13})-(\d{4})(?:--(.*))?\.[^.]+$/;

/**
 * Bounded undo/redo history kept next to the sprite:
 *   `.aseprite-mcp/checkpoints/<file>/<timestamp>-<seq>[--label].ext`  (undo stack, oldest first)
 *   `.aseprite-mcp/redo/<file>/<timestamp>-<seq>.ext`                  (redo stack)
 */
export class Checkpoints {
  constructor(private readonly max: number) {}

  dir(target: string): string {
    return path.join(path.dirname(target), ".aseprite-mcp", "checkpoints", path.basename(target));
  }

  private redoDir(target: string): string {
    return path.join(path.dirname(target), ".aseprite-mcp", "redo", path.basename(target));
  }

  private async listDir(dir: string): Promise<Checkpoint[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: Checkpoint[] = [];
    for (const name of names.sort()) {
      const m = CP_RE.exec(name);
      if (!m) continue;
      const s = await stat(path.join(dir, name));
      out.push({ id: name, createdAt: new Date(Number(m[1])).toISOString(), bytes: s.size, label: m[3]?.replace(/_/g, " ") });
    }
    return out;
  }

  list(target: string): Promise<Checkpoint[]> {
    return this.listDir(this.dir(target));
  }

  redoList(target: string): Promise<Checkpoint[]> {
    return this.listDir(this.redoDir(target));
  }

  private seq = 0;

  private newId(target: string, label?: string): string {
    this.seq = (this.seq + 1) % 10000;
    const safeLabel = label ? "--" + label.replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "_").slice(0, 40) : "";
    return `${Date.now()}-${String(this.seq).padStart(4, "0")}${safeLabel}${path.extname(target)}`;
  }

  async create(target: string, label?: string): Promise<Checkpoint | undefined> {
    if (!(await exists(target))) return undefined;
    const dir = this.dir(target);
    await mkdir(dir, { recursive: true });
    const id = this.newId(target, label);
    await copyFile(target, path.join(dir, id));
    const all = await this.list(target);
    for (const old of all.slice(0, Math.max(0, all.length - this.max))) await rm(path.join(dir, old.id), { force: true });
    const s = await stat(path.join(dir, id));
    return { id, createdAt: new Date().toISOString(), bytes: s.size, label };
  }

  private async replaceWith(target: string, src: string): Promise<void> {
    const tmp = workingPath(target);
    await copyFile(src, tmp);
    await rename(tmp, target);
  }

  /** Copy a checkpoint over the target (used by crash recovery). */
  async restoreRaw(target: string, id: string): Promise<void> {
    await this.replaceWith(target, path.join(this.dir(target), id));
  }

  private async pushRedo(target: string): Promise<void> {
    const dir = this.redoDir(target);
    await mkdir(dir, { recursive: true });
    await copyFile(target, path.join(dir, this.newId(target)));
    const all = await this.redoList(target);
    for (const old of all.slice(0, Math.max(0, all.length - this.max))) await rm(path.join(dir, old.id), { force: true });
  }

  /** Step back `steps` checkpoints; each replaced state goes onto the redo stack. */
  async undo(target: string, steps = 1): Promise<Checkpoint> {
    const all = await this.list(target);
    if (all.length === 0) throw new McpToolError("NO_CHECKPOINT", "no checkpoints exist for this file");
    if (steps > all.length) throw new McpToolError("NO_CHECKPOINT", `only ${all.length} checkpoint(s) available`);
    let restored!: Checkpoint;
    for (let i = 0; i < steps; i++) {
      const cp = all[all.length - 1 - i]!;
      await this.pushRedo(target);
      await this.replaceWith(target, path.join(this.dir(target), cp.id));
      await rm(path.join(this.dir(target), cp.id), { force: true });
      restored = cp;
    }
    return restored;
  }

  /** Re-apply states that undo replaced (most recent first). */
  async redo(target: string, steps = 1): Promise<number> {
    const stack = await this.redoList(target);
    if (stack.length === 0) throw new McpToolError("NO_CHECKPOINT", "nothing to redo");
    const n = Math.min(steps, stack.length);
    for (let i = 0; i < n; i++) {
      const top = stack[stack.length - 1 - i]!;
      await this.create(target, "before redo");
      await this.replaceWith(target, path.join(this.redoDir(target), top.id));
      await rm(path.join(this.redoDir(target), top.id), { force: true });
    }
    return n;
  }

  /** Restore a specific checkpoint; the current state is checkpointed first. */
  async restore(target: string, id: string): Promise<Checkpoint> {
    const all = await this.list(target);
    const cp = all.find((c) => c.id === id);
    if (!cp) throw new McpToolError("NO_CHECKPOINT", `checkpoint '${id}' not found`, all.length ? `Latest: ${all[all.length - 1]!.id}` : undefined);
    await this.create(target, "before restore");
    await this.replaceWith(target, path.join(this.dir(target), cp.id));
    await this.clearRedo(target);
    return cp;
  }

  /** A new edit invalidates the redo stack. */
  async clearRedo(target: string): Promise<void> {
    await rm(this.redoDir(target), { recursive: true, force: true });
    // v1 used a single redo file at this path
    await rm(path.join(path.dirname(target), ".aseprite-mcp", "redo", path.basename(target)), { force: true, recursive: true });
  }
}

export interface CommitOptions {
  label?: string;
  dryRun?: boolean;
  mustExist?: boolean;
  /** Reject the edit unless the document is at this version (stale-edit protection). */
  expectVersion?: string;
  docs?: DocumentStore;
  /** Journal ids of transactions in flight (so recovery never touches them). */
  inFlight?: Set<string>;
}

/**
 * Apply a change to `target` safely:
 *   1. check the expected version, write a journal entry
 *   2. `produce(work)` writes the new version to a sibling working file
 *   3. the original is checkpointed
 *   4. the working file atomically replaces the original (rename)
 * If the original changed on disk meanwhile (content hash), the commit is refused.
 */
export async function commitFile<T>(
  target: string,
  checkpoints: Checkpoints,
  produce: (workPath: string) => Promise<T>,
  opts: CommitOptions = {},
): Promise<{ result: T; checkpoint?: Checkpoint; workPath?: string; before?: string; after?: string }> {
  const hashOf = async (p: string) => {
    try {
      return DocumentStore.hash(await readFile(p));
    } catch {
      return undefined;
    }
  };
  const before = opts.docs ? await opts.docs.version(target) : await hashOf(target);
  if (opts.mustExist && before === undefined) throw new McpToolError("FILE_NOT_FOUND", `'${target}' does not exist`);
  if (opts.expectVersion && opts.expectVersion !== before) {
    throw new McpToolError(
      "STALE_VERSION",
      `'${path.basename(target)}' is at version ${before ?? "(missing)"}, not ${opts.expectVersion}; nothing was changed`,
      "Inspect the document again and retry with the current version.",
    );
  }
  const work = workingPath(target);
  const id = randomUUID();
  opts.inFlight?.add(id);
  const journal = !opts.dryRun && opts.docs;
  try {
    if (journal) await opts.docs!.journalBegin({ id, target, work, beforeVersion: before, state: "staged", pid: process.pid, at: new Date().toISOString() });
    const result = await produce(work);
    if (!(await exists(work))) throw new McpToolError("ASEPRITE_FAILED", "Aseprite did not write the working file");
    if (opts.dryRun) return { result, workPath: work, before };
    const now = await hashOf(target);
    if (now !== before) {
      throw new McpToolError("CONFLICT", `'${path.basename(target)}' was modified by another program while editing; nothing was changed`, "Re-run the edit.");
    }
    const checkpoint = before !== undefined ? await checkpoints.create(target, opts.label) : undefined;
    if (journal) await opts.docs!.journalUpdate(target, { state: "committing", checkpoint: checkpoint?.id });
    await rename(work, target);
    await checkpoints.clearRedo(target);
    if (journal) await opts.docs!.journalEnd(target);
    opts.docs?.touch(target);
    const after = opts.docs ? await opts.docs.version(target) : await hashOf(target);
    return { result, checkpoint, before, after };
  } catch (e) {
    if (journal) await opts.docs!.journalEnd(target);
    throw e;
  } finally {
    opts.inFlight?.delete(id);
    if (!opts.dryRun) await rm(work, { force: true });
  }
}
