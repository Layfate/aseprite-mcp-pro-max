import { z } from "zod";
import type { Context } from "../context.js";

/**
 * How an operation executes:
 *  - edit:   mutates a document inside an atomic, checkpointed transaction (Lua OPS)
 *  - query:  reads a document; cached by document version (Lua QUERIES)
 *  - render: renders a document to an image; cached by document version (Lua VIEWS)
 *  - action: runs in the server (files, palettes, engine exporters, jobs) and may call Aseprite
 */
export type Kind = "edit" | "query" | "render" | "action";

/** What an operation needs to run. */
export type Requirement = "aseprite" | "node" | "live-editor" | "image-provider" | "bg-provider";

export type Area =
  | "documents"
  | "layers"
  | "selection"
  | "drawing"
  | "transform"
  | "palette"
  | "animation"
  | "tiles"
  | "reference"
  | "cleanup"
  | "validation"
  | "sheets"
  | "engines"
  | "production"
  | "preview";

export const AREAS: Area[] = [
  "documents", "layers", "selection", "drawing", "transform", "palette", "animation", "tiles",
  "reference", "cleanup", "validation", "sheets", "engines", "production", "preview",
];

export interface Artifact {
  path: string;
  kind: string;
  bytes?: number;
}

/** Result of an action; queries/edits/renders are wrapped by the executor. */
export interface ActionResult {
  data?: unknown;
  artifacts?: Artifact[];
  warnings?: string[];
  /** Base64 PNG to return as image content (render-like actions). */
  image?: string;
  /** Documents this action modified (their caches are invalidated). */
  touched?: string[];
}

export interface RunEnv {
  ctx: Context;
  signal?: AbortSignal;
  progress?: (done: number, total: number, message?: string) => void;
  /** Resolved target document for doc-bound actions. */
  file?: string;
  live?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyShape = Record<string, z.ZodType<any>>;

export interface OpExample {
  args: Record<string, unknown>;
  /** Edit ops (batch) applied to the fixture before the example runs. */
  setup?: Array<Record<string, unknown>>;
  /** Run without a document even for doc-bound kinds. */
  noDoc?: boolean;
  /** Other operations (run_op) that prepare files the example needs. */
  before?: Array<{ op: string; args: Record<string, unknown>; path?: string }>;
}

export interface OpDef {
  id: string;
  area: Area;
  summary: string;
  kind: Kind;
  shape: AnyShape;
  /** Requires a target document (path or live). Edit/query/render always do. */
  doc: "required" | "optional" | "none";
  requires: Requirement[];
  status: "stable" | "experimental";
  /** Works against the live editor (Lua-backed ops do). */
  live: boolean;
  /** Extra search keywords. */
  keywords?: string[];
  /** Server-side preparation (path sandboxing, preset expansion) before Lua sees the op. */
  prepare?: (args: Record<string, unknown>, env: RunEnv) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Action implementation. */
  run?: (args: Record<string, unknown>, env: RunEnv) => Promise<ActionResult>;
  /** Render ops: default output mode. */
  defaultOutput?: "image" | "file";
  example: OpExample;
  notes?: string;
  /** Long-running: may be started in the background. */
  slow?: boolean;
}

export interface DefOptions {
  doc?: OpDef["doc"];
  requires?: Requirement[];
  status?: OpDef["status"];
  live?: boolean;
  keywords?: string[];
  prepare?: OpDef["prepare"];
  run?: OpDef["run"];
  defaultOutput?: OpDef["defaultOutput"];
  notes?: string;
  slow?: boolean;
}

export function op(
  id: string,
  area: Area,
  kind: Kind,
  summary: string,
  shape: AnyShape,
  example: OpExample | Record<string, unknown>,
  o: DefOptions = {},
): OpDef {
  const ex: OpExample = "args" in example && typeof example.args === "object" ? (example as OpExample) : { args: example as Record<string, unknown> };
  const luaBacked = kind !== "action";
  return {
    id,
    area,
    kind,
    summary,
    shape,
    example: ex,
    doc: o.doc ?? (luaBacked ? "required" : "none"),
    requires: o.requires ?? (luaBacked ? ["aseprite"] : ["node"]),
    status: o.status ?? "stable",
    live: o.live ?? luaBacked,
    keywords: o.keywords,
    prepare: o.prepare,
    run: o.run,
    defaultOutput: o.defaultOutput,
    notes: o.notes,
    slow: o.slow,
  };
}
