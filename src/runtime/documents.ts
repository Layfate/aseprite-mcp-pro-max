import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Sidecar directory next to a document: `.aseprite-mcp/` */
export function sidecar(file: string, ...parts: string[]): string {
  return path.join(path.dirname(file), ".aseprite-mcp", ...parts);
}

export interface ChangeEntry {
  at: string;
  from?: string;
  to: string;
  label?: string;
  ops?: string[];
  summary?: unknown;
  kind: "edit" | "create" | "restore" | "undo" | "redo" | "import" | "recipe";
}

export interface JournalEntry {
  id: string;
  target: string;
  work: string;
  beforeVersion?: string;
  checkpoint?: string;
  state: "staged" | "checkpointed" | "committing";
  pid: number;
  at: string;
}

export interface RecoveryReport {
  file: string;
  action: "none" | "rolled-back" | "completed" | "restored-checkpoint" | "removed-orphan";
  detail?: string;
}

/**
 * Per-document state kept by the server:
 *   - content versions (sha256 prefix), memoized by mtime+size
 *   - a version-keyed result cache for inspections, queries and previews
 *   - an append-only change log (`.aseprite-mcp/changes/<name>.jsonl`)
 *   - a write-ahead journal for crash recovery (`.aseprite-mcp/journal/<name>.json`)
 */
export class DocumentStore {
  private versions = new Map<string, { mtimeMs: number; size: number; version: string }>();
  private cache = new Map<string, unknown>();
  private readonly maxCache: number;
  stats = { hits: 0, misses: 0 };

  constructor(maxCache = 256) {
    this.maxCache = maxCache;
  }

  static hash(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  }

  /** Content version of a file, or undefined if it does not exist. */
  async version(file: string): Promise<string | undefined> {
    let s;
    try {
      s = await stat(file);
    } catch {
      this.versions.delete(file);
      return undefined;
    }
    const memo = this.versions.get(file);
    if (memo && memo.mtimeMs === s.mtimeMs && memo.size === s.size) return memo.version;
    const version = DocumentStore.hash(await readFile(file));
    this.versions.set(file, { mtimeMs: s.mtimeMs, size: s.size, version });
    return version;
  }

  /** Forget memoized state for a file (after the server wrote it). */
  touch(file: string): void {
    this.versions.delete(file);
    const prefix = `${file}|`;
    for (const k of [...this.cache.keys()]) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  async cached<T>(file: string, key: string, compute: (version: string | undefined) => Promise<T>): Promise<{ value: T; version?: string; cached: boolean }> {
    const version = await this.version(file);
    const k = `${file}|${version}|${key}`;
    if (version && this.cache.has(k)) {
      this.stats.hits++;
      const value = this.cache.get(k) as T;
      this.cache.delete(k); // LRU refresh
      this.cache.set(k, value);
      return { value, version, cached: true };
    }
    this.stats.misses++;
    const value = await compute(version);
    // Only cache when the file did not change while computing.
    if (version && (await this.version(file)) === version) {
      this.cache.set(k, value);
      while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value as string);
    }
    return { value, version, cached: false };
  }

  // ---------------------------------------------------------------- change log

  private changePath(file: string): string {
    return sidecar(file, "changes", `${path.basename(file)}.jsonl`);
  }

  async logChange(file: string, entry: ChangeEntry): Promise<void> {
    const p = this.changePath(file);
    await mkdir(path.dirname(p), { recursive: true });
    await appendFile(p, JSON.stringify(entry) + "\n", "utf8");
    // keep the log bounded
    const s = await stat(p);
    if (s.size > 512 * 1024) {
      const lines = (await readFile(p, "utf8")).trim().split("\n");
      await writeFile(p, lines.slice(-200).join("\n") + "\n", "utf8");
    }
  }

  async changes(file: string, opts: { since?: string; limit?: number } = {}): Promise<ChangeEntry[]> {
    let text = "";
    try {
      text = await readFile(this.changePath(file), "utf8");
    } catch {
      return [];
    }
    let entries = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChangeEntry);
    if (opts.since) {
      const i = entries.findIndex((e) => e.to === opts.since);
      entries = i >= 0 ? entries.slice(i + 1) : entries;
    }
    return entries.slice(-(opts.limit ?? 20));
  }

  // ---------------------------------------------------------------- journal

  private journalPath(file: string): string {
    return sidecar(file, "journal", `${path.basename(file)}.json`);
  }

  async journalBegin(entry: JournalEntry): Promise<void> {
    const p = this.journalPath(entry.target);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(entry), "utf8");
  }

  async journalUpdate(target: string, patch: Partial<JournalEntry>): Promise<void> {
    const p = this.journalPath(target);
    try {
      const cur = JSON.parse(await readFile(p, "utf8")) as JournalEntry;
      await writeFile(p, JSON.stringify({ ...cur, ...patch }), "utf8");
    } catch {
      // journal already gone
    }
  }

  async journalEnd(target: string): Promise<void> {
    await rm(this.journalPath(target), { force: true });
  }

  /**
   * Repair an interrupted transaction on `file`:
   *  - working file present, target unchanged  -> roll back (delete the working file)
   *  - target missing but a checkpoint exists  -> restore the checkpoint
   *  - working file gone, target present        -> the swap finished; drop the journal
   */
  async recover(file: string, restoreCheckpoint: (cpId: string) => Promise<void>, liveWriters: Set<string>): Promise<RecoveryReport> {
    const p = this.journalPath(file);
    if (!existsSync(p)) return { file, action: "none" };
    let j: JournalEntry;
    try {
      j = JSON.parse(await readFile(p, "utf8")) as JournalEntry;
    } catch {
      await rm(p, { force: true });
      return { file, action: "none", detail: "unreadable journal removed" };
    }
    if (liveWriters.has(j.id)) return { file, action: "none", detail: "transaction in progress" };
    const targetExists = existsSync(file);
    const workExists = existsSync(j.work);
    let report: RecoveryReport;
    if (!targetExists && j.checkpoint) {
      await restoreCheckpoint(j.checkpoint);
      report = { file, action: "restored-checkpoint", detail: j.checkpoint };
    } else if (workExists) {
      const v = targetExists ? DocumentStore.hash(await readFile(file)) : undefined;
      if (v === j.beforeVersion || !j.beforeVersion) {
        report = { file, action: "rolled-back", detail: "the interrupted edit was discarded; the document is unchanged" };
      } else {
        report = { file, action: "rolled-back", detail: `document changed since the edit started (now ${v}); working copy discarded` };
      }
    } else {
      report = { file, action: "completed", detail: "the edit had already been committed" };
    }
    if (workExists) await rm(j.work, { force: true });
    await rm(p, { force: true });
    this.touch(file);
    return report;
  }

  /** Find journals and orphaned working copies (`.name.mcp-xxxxxxxx.ext`) in a directory tree. */
  async scan(dir: string, depth = 4): Promise<{ journals: string[]; orphans: string[] }> {
    const journals: string[] = [];
    const orphans: string[] = [];
    const walk = async (d: string, level: number) => {
      let names: string[];
      try {
        names = await readdir(d);
      } catch {
        return;
      }
      for (const n of names) {
        const full = path.join(d, n);
        if (n === ".aseprite-mcp") {
          try {
            for (const j of await readdir(path.join(full, "journal"))) journals.push(path.join(full, "journal", j));
          } catch {
            // no journal dir
          }
          continue;
        }
        if (/^\..+\.mcp-[0-9a-f]{8}\.[^.]+$/.test(n)) orphans.push(full);
        if (level < depth && !n.startsWith(".") && n !== "node_modules") {
          try {
            if ((await stat(full)).isDirectory()) await walk(full, level + 1);
          } catch {
            // vanished
          }
        }
      }
    };
    await walk(dir, 0);
    return { journals, orphans };
  }
}
