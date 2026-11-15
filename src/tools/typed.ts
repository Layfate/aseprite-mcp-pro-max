import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATALOG } from "../catalog/registry.js";
import type { OpDef } from "../catalog/types.js";
import type { Context } from "../context.js";
import { executeOp, submitJob, type Detail } from "../runtime/executor.js";
import { registerTool } from "./core.js";

/** MCP tool name for an operation id: draw.line -> op_draw_line */
export const toolName = (id: string) => `op_${id.replace(/\./g, "_")}`;

const docFields = (d: OpDef): z.ZodRawShape => {
  const f: Record<string, z.ZodType> = {};
  if (d.doc !== "none") {
    f.path = z.string().max(4096).optional();
    if (d.live) f.live = z.boolean().optional();
    f.expectVersion = z.string().max(32).optional();
  }
  f.detail = z.enum(["min", "normal", "full"]).optional();
  if (d.kind === "edit") f.dryRun = z.boolean().optional();
  if (d.kind === "render") f.output = z.enum(["image", "file"]).optional();
  if (d.slow) f.background = z.boolean().optional();
  return f;
};

/** Select ops by area name, id prefix ("tile.") or exact id; "all" selects everything. */
export function selectOps(selectors: string[]): OpDef[] {
  if (selectors.includes("all")) return CATALOG;
  return CATALOG.filter((d) => selectors.some((s) => d.area === s || d.id === s || (s.endsWith(".") && d.id.startsWith(s)) || d.id.startsWith(`${s}.`)));
}

/**
 * Typed profile: operations exposed as direct MCP tools with their full schemas, for
 * clients that work better with explicit tools. Larger startup schema; same execution path.
 */
export function registerTypedTools(server: McpServer, ctx: Context, ops: OpDef[]): number {
  for (const d of ops) {
    const extra = docFields(d);
    const shape = { ...d.shape, ...extra } as z.ZodRawShape;
    registerTool(server, toolName(d.id), d.summary, shape, async (a: Record<string, unknown>) => {
      const { path, live, expectVersion, detail, dryRun, output, background, ...args } = a;
      for (const k of Object.keys(extra)) if (k in d.shape) (args as Record<string, unknown>)[k] = a[k];
      const opts = { path: path as string | undefined, live: live as boolean | undefined, expectVersion: expectVersion as string | undefined, detail: detail as Detail, dryRun: dryRun as boolean | undefined, output: output as "image" | "file" | undefined };
      if (background) return submitJob(ctx, d.id, (signal, progress) => executeOp(ctx, d.id, args, { ...opts, signal, progress }));
      return executeOp(ctx, d.id, args, opts);
    }, d.kind === "query" || d.kind === "render" ? { readOnlyHint: true } : {});
  }
  return ops.length;
}
