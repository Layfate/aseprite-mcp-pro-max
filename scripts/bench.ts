// Token / latency / process benchmarks for the 2.0 profiles against the v1 baseline.
// Usage: npm run build && npx tsx scripts/bench.ts
// Writes bench/results.json and docs/benchmarks.md.
//
// Token counts use OpenAI's o200k_base and cl100k_base encodings (js-tiktoken). They are
// proxies: Claude's tokenizer differs, but ratios between profiles carry over.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getEncoding } from "js-tiktoken";
import { animatedCharacter, engineSamples, modifyAndRestore, referenceToSprite, seamlessTileset, type Call } from "../examples/workflows.js";
import { startClient, type TestClient } from "../tests/helpers/client.js";

const enc = { o200k: getEncoding("o200k_base"), cl100k: getEncoding("cl100k_base") };
const tok = (s: string) => ({ o200k: enc.o200k.encode(s).length, cl100k: enc.cl100k.encode(s).length });
type Tok = ReturnType<typeof tok>;
const add = (a: Tok, b: Tok): Tok => ({ o200k: a.o200k + b.o200k, cl100k: a.cl100k + b.cl100k });
const ZERO: Tok = { o200k: 0, cl100k: 0 };
const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (a: number, b: number) => `${Math.round((1 - a / b) * 100)}%`;
const vs = (a: number, b: number) => (a <= b ? `${pct(a, b)} less` : `${Math.round((a / b - 1) * 100)}% more`);

// ---------------------------------------------------------------- 1. startup context

interface Startup { name: string; tools: number; bytes: number; tokens: Tok; startMs: number }

/** What a client puts in the model's context at session start: tool definitions + server instructions. */
async function startup(name: string, args: string[], env: Record<string, string>): Promise<Startup> {
  const t0 = performance.now();
  const client = new Client({ name: "bench", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args, env: { ...(process.env as Record<string, string>), ASEPRITE_MCP_LIVE_PORT: "0", ...env }, stderr: "pipe" }));
  const { tools } = await client.listTools();
  const startMs = performance.now() - t0;
  const defs = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })));
  const all = defs + (client.getInstructions() ?? "");
  await client.close();
  return { name, tools: tools.length, bytes: Buffer.byteLength(all), tokens: tok(all), startMs };
}

const dist = path.resolve("dist/index.js");
const profiles: Startup[] = [];
profiles.push(await startup("v1 baseline", [path.resolve("bench/baseline-v1/dist/index.js")], {}));
for (const p of ["core", "legacy", "core,legacy", "typed", "full"]) profiles.push(await startup(p, [dist], { ASEPRITE_MCP_PROFILE: p }));
const prof = (n: string) => profiles.find((p) => p.name === n)!;

// ---------------------------------------------------------------- 2. workflows (core profile)

interface CallRec { workflow: string; tool: string; op?: string; ms: number; req: Tok; res: Tok; images: number; imageBytes: number; error: boolean }
const calls: CallRec[] = [];
const opsUsed = new Set<string>();
let current = "";

const c: TestClient = await startClient({});
const call: Call = async (tool, args) => {
  if (tool === "run_op") opsUsed.add(String(args.op));
  if (tool === "batch") for (const o of args.ops as Array<{ op: string }>) opsUsed.add(o.op);
  const req = JSON.stringify({ name: tool, arguments: args });
  const t0 = performance.now();
  const r = await c.call(tool, args);
  const ms = performance.now() - t0;
  const imageBytes = r.images.reduce((s, b64) => s + Math.floor((b64.length * 3) / 4), 0);
  calls.push({ workflow: current, tool, op: args.op as string | undefined, ms, req: tok(req), res: tok(r.text), images: r.images.length, imageBytes, error: !!r.isError });
  if (r.isError) throw new Error(`${tool} ${String(args.op ?? "")}: ${r.text}`);
  return r.json;
};
const caps = async () => (await c.call("capabilities", {})).json as { memoryMB: number; spawns: number; cache: { hits: number; misses: number } };

const workflows: Array<[string, () => Promise<unknown>]> = [
  ["1. reference → sprite", () => referenceToSprite(call)],
  ["2. animated character", () => animatedCharacter(call)],
  ["3. seamless tileset", () => seamlessTileset(call)],
  ["4. modify + restore", () => modifyAndRestore(call)],
  ["5. engine exports (11 targets)", () => engineSamples(call, "engines")],
];
const rssStart = (await caps()).memoryMB;
const perWorkflow: Array<{ name: string; calls: number; ms: number; tokens: Tok; images: number; imageBytes: number; spawns: number; errors: number }> = [];
for (const [name, fn] of workflows) {
  current = name;
  const s0 = (await caps()).spawns;
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  const mine = calls.filter((r) => r.workflow === name);
  perWorkflow.push({
    name, calls: mine.length, ms,
    tokens: mine.reduce((t, r) => add(t, add(r.req, r.res)), ZERO),
    images: mine.reduce((n, r) => n + r.images, 0),
    imageBytes: mine.reduce((n, r) => n + r.imageBytes, 0),
    spawns: (await caps()).spawns - s0,
    errors: mine.filter((r) => r.error).length,
  });
}

// Discovery a model without prior knowledge would need on the core profile: one
// search_ops per area touched and describe_ops for every op used (10 per call).
current = "discovery";
const ids = [...opsUsed].sort();
const areas = [...new Set(ids.map((id) => id.split(".")[0]!))];
for (const a of areas) await call("search_ops", { query: a });
for (let i = 0; i < ids.length; i += 10) await call("describe_ops", { ops: ids.slice(i, i + 10) });
const discovery = calls.filter((r) => r.workflow === "discovery");
const discoveryTok = discovery.reduce((t, r) => add(t, add(r.req, r.res)), ZERO);

// Cold vs warm: the same read twice on an unchanged document hits the version-keyed cache.
current = "cache";
const latency: Array<{ what: string; coldMs: number; warmMs: number }> = [];
const file = "hero/hero.aseprite";
for (const [what, tool, args] of [
  ["inspect", "inspect", { path: file }],
  ["preview (frames)", "preview", { path: file, tag: "walk_e" }],
  ["query check.lint", "run_op", { op: "check.lint", path: file, args: { maxColors: 16 } }],
] as const) {
  await call("batch", { path: file, ops: [{ op: "draw.pixels", layer: "body", pixels: [{ x: 0, y: 0, color: "transparent" }] }] }); // new version -> cold
  const a = performance.now();
  await call(tool, args as Record<string, unknown>);
  const coldMs = performance.now() - a;
  const b = performance.now();
  await call(tool, args as Record<string, unknown>);
  latency.push({ what, coldMs, warmMs: performance.now() - b });
}
const end = await caps();
await c.close();

// ---------------------------------------------------------------- 3. totals

const wfTok = perWorkflow.reduce((t, w) => add(t, w.tokens), ZERO);
const totalCore = add(add(prof("core").tokens, discoveryTok), wfTok);
const totalFull = add(prof("full").tokens, wfTok); // eager: every schema up front, no discovery calls
const results = {
  date: new Date().toISOString(),
  node: process.version,
  note: "o200k_base/cl100k_base are proxies for Claude's tokenizer.",
  startup: profiles,
  workflows: perWorkflow,
  discovery: { calls: discovery.length, areas: areas.length, ops: ids.length, tokens: discoveryTok },
  latency,
  totals: { core: totalCore, full: totalFull },
  process: { rssStartMB: rssStart, rssEndMB: end.memoryMB, spawns: end.spawns, cache: end.cache },
  calls: calls.length,
  errors: calls.filter((r) => r.error).length,
};
writeFileSync("bench/results.json", JSON.stringify(results, null, 1) + "\n");

// ---------------------------------------------------------------- 4. report

const T = (t: Tok) => `${fmt(t.o200k)} / ${fmt(t.cl100k)}`;
const v1 = prof("v1 baseline");
const md = [
  "# Benchmarks",
  "",
  `_Generated by \`scripts/bench.ts\` on ${results.date.slice(0, 10)} (Node ${process.version}, ${process.platform}). Raw numbers: [bench/results.json](../bench/results.json)._`,
  "",
  "Token counts are **o200k_base / cl100k_base** (js-tiktoken). Claude's tokenizer is different, so treat them as proxies. The ratios between profiles are what matter.",
  "",
  "## Startup context (tool definitions + server instructions)",
  "",
  "This is what a client puts in the model's context at the start of every session, before any work happens.",
  "",
  "| Profile | Tools | Bytes | Tokens | vs v1 | Server start + tools/list |",
  "|---|---|---|---|---|---|",
  ...profiles.map((p) => `| ${p.name === "core" ? "**core** (default)" : p.name} | ${p.tools} | ${fmt(p.bytes)} | ${T(p.tokens)} | ${p === v1 ? "—" : vs(p.tokens.o200k, v1.tokens.o200k)} | ${Math.round(p.startMs)} ms |`),
  "",
  `Target: core startup < 4,000 tokens. Result: **${fmt(prof("core").tokens.o200k)}** (o200k), ${prof("core").tokens.o200k < 4000 ? "met" : "NOT met"}.`,
  "",
  "`typed` adds one tool per operation in the default typed areas; `full` adds one for each of the 252 operations, so it is the eager-loading reference.",
  "",
  "## Representative workflows (core profile, real Aseprite)",
  "",
  "These are the five workflows from `examples/workflows.ts`. Tokens are the request arguments plus the text of each result. Images are counted separately; these workflows write previews to files (`saveTo`), so they return none.",
  "",
  "| Workflow | Calls | Tokens | Images | Image bytes | Aseprite spawns | Errors/retries | Wall time |",
  "|---|---|---|---|---|---|---|---|",
  ...perWorkflow.map((w) => `| ${w.name} | ${w.calls} | ${T(w.tokens)} | ${w.images} | ${fmt(w.imageBytes)} | ${w.spawns} | ${w.errors} | ${(w.ms / 1000).toFixed(1)} s |`),
  `| **all** | ${perWorkflow.reduce((n, w) => n + w.calls, 0)} | ${T(wfTok)} | ${perWorkflow.reduce((n, w) => n + w.images, 0)} | ${fmt(perWorkflow.reduce((n, w) => n + w.imageBytes, 0))} | ${perWorkflow.reduce((n, w) => n + w.spawns, 0)} | ${perWorkflow.reduce((n, w) => n + w.errors, 0)} | ${(perWorkflow.reduce((n, w) => n + w.ms, 0) / 1000).toFixed(1)} s |`,
  "",
  `Discovery for a model that knows none of the ${ids.length} op ids used: ${areas.length} \`search_ops\` calls (one per id prefix) and ${Math.ceil(ids.length / 10)} \`describe_ops\` calls, ${T(discoveryTok)} tokens. This is the worst case; a model that already knows the ids from earlier turns or the guide skips it.`,
  "",
  "## Session total: lazy (core) vs eager (full)",
  "",
  "| | Startup | Discovery | Workflow calls | **Total** |",
  "|---|---|---|---|---|",
  `| core (lazy) | ${T(prof("core").tokens)} | ${T(discoveryTok)} | ${T(wfTok)} | **${T(totalCore)}** |`,
  `| full (eager) | ${T(prof("full").tokens)} | 0 | ${T(wfTok)} | **${T(totalFull)}** |`,
  "",
  `The core profile uses **${pct(totalCore.o200k, totalFull.o200k)} fewer tokens** than eager loading over the whole session (target ≥ 50%: ${totalCore.o200k <= totalFull.o200k / 2 ? "met" : "NOT met"}). The workflow-call cost is assumed to be the same for both profiles: a typed tool call carries the same arguments without the \`run_op\` wrapper, a difference of a few tokens per call.`,
  "",
  "## Cache: cold vs warm reads",
  "",
  "Reads are cached by document version (sha256), so repeating a read on an unchanged file does not start Aseprite again.",
  "",
  "| Read | Cold | Warm |",
  "|---|---|---|",
  ...latency.map((l) => `| ${l.what} | ${Math.round(l.coldMs)} ms | ${Math.round(l.warmMs)} ms |`),
  "",
  "## Process",
  "",
  `- Server RSS: ${rssStart} MB after connect, ${end.memoryMB} MB after ${calls.length} calls.`,
  `- Aseprite processes started: ${end.spawns} in total. Cache: ${end.cache.hits} hits, ${end.cache.misses} misses.`,
  `- Failed calls (each would be a model retry): ${results.errors}.`,
  "",
  "## Reproduce",
  "",
  "```bash",
  "npm run build",
  "npx tsx scripts/bench.ts",
  "```",
  "",
];
writeFileSync("docs/benchmarks.md", md.join("\n"));
console.log(md.slice(9, 18).join("\n"));
console.log(`total core ${T(totalCore)} vs full ${T(totalFull)} (${pct(totalCore.o200k, totalFull.o200k)} less)`);
