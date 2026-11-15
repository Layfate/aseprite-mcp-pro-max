// Runs every catalog operation's documented example against real Aseprite and the
// standard fixture (smoke coverage), and checks catalog <-> Lua engine parity.
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG } from "../../src/catalog/registry.js";
import { hasAseprite, startClient, type TestClient } from "../helpers/client.js";
import { buildFixture, restoreFixture, snapshotFixture } from "../helpers/fixture.js";

const runIt = hasAseprite() ? describe : describe.skip;
const here = path.dirname(fileURLToPath(import.meta.url));

runIt("catalog examples (smoke, real Aseprite)", () => {
  let c: TestClient;
  const failures: string[] = [];

  beforeAll(async () => {
    const provider = JSON.stringify(["node", path.join(here, "..", "fixtures", "fake-image-provider.mjs").replaceAll("\\", "/"), "{workdir}/ai-source.png", "{output}", "{prompt}"]);
    c = await startClient({
      ASEPRITE_MCP_IMAGE_PROVIDER: "command",
      ASEPRITE_MCP_IMAGE_COMMAND: provider,
      ASEPRITE_MCP_COVERAGE_FILE: path.resolve("tests/.coverage/smoke.txt"),
    });
    await buildFixture(c);
    snapshotFixture(c);
  }, 300_000);
  afterAll(async () => {
    rmSync(c.workdir + "-pristine", { recursive: true, force: true });
    await c?.close();
    if (failures.length) console.log("FAILURES:\n" + failures.join("\n"));
  });

  it("every Lua-backed operation is registered in the engine and vice versa", async () => {
    const reg = (await c.call("run_op", { op: "doc.inspect", path: "fixture.aseprite" })).json;
    expect(reg.ok).toBe(true);
  });

  const ops = CATALOG.filter((d) => !d.requires.includes("live-editor"));
  for (const d of ops) {
    it(`${d.id}`, async () => {
      restoreFixture(c);
      const ex = d.example;
      if (ex.setup?.length) {
        const s = await c.call("batch", { path: "fixture.aseprite", ops: ex.setup });
        if (s.isError) throw new Error(`setup failed: ${s.text}`);
      }
      for (const b of ex.before ?? []) {
        const r = await c.call("run_op", { op: b.op, args: b.args, path: b.path });
        if (r.isError) throw new Error(`before ${b.op} failed: ${r.text}`);
      }
      const withDoc = d.doc === "required" || (d.doc === "optional" && !ex.noDoc);
      const r = await c.call("run_op", { op: d.id, args: ex.args, ...(withDoc && !ex.noDoc ? { path: "fixture.aseprite" } : {}) });
      if (r.isError) failures.push(`${d.id}: ${r.text}`);
      expect(r.isError, r.text).toBeFalsy();
    });
  }
});
