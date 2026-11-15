// Builds the engine sample projects in examples/engines/ from scratch:
// draws the hero and the tileset with the core tools (workflows 2 and 3), then
// exports them into every engine host project (workflow 5).
//
//   npm run build && npx tsx examples/build-samples.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startClient } from "../tests/helpers/client.js";
import { animatedCharacter, engineSamples, seamlessTileset, type Call } from "./workflows.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "engines");
const c = await startClient({ ASEPRITE_MCP_ROOTS: root });
const call: Call = async (tool, args) => {
  const r = await c.call(tool, args);
  if (r.isError) throw new Error(`${tool} ${String(args.op ?? "")}: ${r.text}`);
  return r.json;
};

try {
  const hero = "source/hero.aseprite";
  const level = "source/level.aseprite";
  const h = await animatedCharacter(call, hero);
  console.log("hero:", JSON.stringify(h.brief));
  await seamlessTileset(call, level);
  const r = await engineSamples(call, ".", hero, level);
  for (const [k, v] of Object.entries(r.exports as Record<string, { files: number; warnings?: string[] }>)) {
    console.log(`${k.padEnd(34)} ${v.files} files${v.warnings?.length ? `  ⚠ ${v.warnings.join("; ")}` : ""}`);
  }
  const validate = r.validate as { valid: boolean; results: Array<{ file: string; errors: string[] }> };
  for (const f of validate.results) if (f.errors.length) console.log(`✗ ${f.file}: ${f.errors.join("; ")}`);
  console.log(validate.valid ? "all engine files valid" : "validation FAILED");
  process.exitCode = validate.valid ? 0 : 1;
} finally {
  await c.close();
}
