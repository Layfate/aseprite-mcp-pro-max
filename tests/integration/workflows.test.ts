// The five end-to-end workflows from examples/workflows.ts, asserted.
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { animatedCharacter, engineSamples, modifyAndRestore, referenceToSprite, seamlessTileset, type Call } from "../../examples/workflows.js";
import { hasAseprite, startClient, type TestClient } from "../helpers/client.js";

const suite = hasAseprite() ? describe : describe.skip;

suite("end-to-end workflows (real Aseprite)", () => {
  let c: TestClient;
  let call: Call;
  beforeAll(async () => {
    c = await startClient({ ASEPRITE_MCP_COVERAGE_FILE: path.resolve("tests/.coverage/workflows.txt") });
    call = async (tool, args) => {
      const r = await c.call(tool, args);
      if (r.isError) throw new Error(`${tool} ${JSON.stringify(args).slice(0, 160)}: ${r.text}`);
      return r.json;
    };
  });
  afterAll(async () => c?.close());

  it("1. reference image -> editable sprite", async () => {
    const r = await referenceToSprite(call);
    expect(r.facts).toMatchObject({ pixelScale: 8, width: 128, height: 128 });
    expect(r.lint).toMatchObject({ valid: true });
    const g = r.grid as { rows: string[]; legend: Record<string, string> };
    expect(g.rows[2]).toBe(".......AAAAAA..."); // SLIME row 0 drawn at x=3+4
    expect(Object.values(g.legend).sort()).toEqual(["#008751", "#00e436", "#1d2b53", "#fff1e8"]);
  });

  it("2. consistent animated character with states and directions", async () => {
    const r = await animatedCharacter(call);
    expect(r.brief, JSON.stringify(r.brief)).toMatchObject({ valid: true });
    expect(r.identity).toMatchObject({ consistent: true });
    const timing = r.timing as { tags: Array<{ name: string; frames: number; totalMs: number }> };
    expect(timing.tags.map((t) => [t.name, t.frames, t.totalMs])).toEqual([["idle_e", 2, 440], ["walk_e", 4, 440], ["idle_w", 2, 440], ["walk_w", 4, 440]]);
    const jitter = r.jitter as { tags: Array<{ tag: string; baselineSpread: number }> };
    for (const t of jitter.tags) expect(t.baselineSpread).toBeLessThanOrEqual(1);
    expect(existsSync(path.join(c.workdir, String(r.contactSheet)))).toBe(true);
  });

  it("3. seamless tileset and editable tilemap", async () => {
    const r = await seamlessTileset(call);
    const self = r.seamsSelf as { seams: Array<{ tile: number }> };
    expect(self.seams.map((s) => s.tile)).not.toContain(1); // grass wraps
    expect(self.seams.map((s) => s.tile)).not.toContain(2); // dirt wraps
    const map = r.map as { rows: string[]; legend: Record<string, number> };
    const idx = map.rows.map((row) => [...row].map((ch) => (ch === "." ? 0 : map.legend[ch])));
    expect(idx[0]).toEqual([1, 1, 4, 1, 4, 1, 1, 1]);
    expect(idx[2]).toEqual([3, 3, 3, 3, 3, 3, 3, 3]); // edge row from the autotile rules
    expect(idx[3]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it("4. existing asset modified and safely restored", async () => {
    const r = await modifyAndRestore(call);
    expect(r.edited).not.toBe(r.original);
    expect(r.changedFrames).toBeGreaterThan(0);
    expect(r.identical).toBe(true);
  });

  it("5. assets exported into engine sample projects validate", async () => {
    const r = await engineSamples(call, "engines");
    expect(r.validate, JSON.stringify(r.validate)).toMatchObject({ valid: true });
  });
});
