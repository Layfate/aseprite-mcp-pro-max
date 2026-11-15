// check.craft, draw.shade and kb.* against a real Aseprite. The rulebook's own
// "tell" / "fixed" template pairs are the ground truth for the detectors.
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allTemplates } from "../../src/kb.js";
import { hasAseprite, startClient, type TestClient } from "../helpers/client.js";

const suite = hasAseprite() ? describe : describe.skip;

suite("craft quality (real Aseprite)", () => {
  let c: TestClient;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await c.call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return r.json;
  };
  const op = (id: string, args: Record<string, unknown>, p?: string) => call("run_op", { op: id, args, path: p });
  const craft = async (p: string, args: Record<string, unknown> = {}) => (await op("check.craft", args, p)).result;
  const ids = (r: { findings: Array<{ id: string }> }) => r.findings.map((f) => f.id);

  /** New document holding one template (optionally a row/column slice), 2 px margin. */
  async function fromTemplate(name: string, opts: { rows?: [number, number]; cols?: [number, number]; brief?: Record<string, unknown> } = {}) {
    const t = allTemplates().get(name)!;
    expect(t, name).toBeDefined();
    let rows = t.rows.slice(opts.rows?.[0] ?? 0, opts.rows?.[1] ?? t.rows.length);
    if (opts.cols) rows = rows.map((r) => r.slice(opts.cols![0], opts.cols![1]));
    const file = `${name}${opts.rows ? `-${opts.rows.join("_")}` : ""}${opts.cols ? `-c${opts.cols.join("_")}` : ""}.aseprite`;
    await op("doc.create", { path: file, width: rows[0]!.length + 4, height: rows.length + 4, overwrite: true });
    const ops: Array<Record<string, unknown>> = [{ op: "draw.pixel_map", x: 2, y: 2, rows, legend: t.legend }];
    if (opts.brief) ops.push({ op: "brief.set", brief: opts.brief });
    await call("batch", { path: file, ops });
    return file;
  }

  beforeAll(async () => {
    c = await startClient({ ASEPRITE_MCP_COVERAGE_FILE: path.resolve("tests/.coverage/craft.txt") });
  });
  afterAll(async () => {
    await c?.close();
  });

  it("pillow shading: flags the pillowed sphere, passes the lit one and reads its light", async () => {
    const pillow = await craft(await fromTemplate("tells-sphere-pillow"));
    expect(ids(pillow)).toContain("C7");
    const lit = await craft(await fromTemplate("tells-sphere-lit"));
    expect(ids(lit)).not.toContain("C7");
    expect(lit.subject.light.estimated).toBe("top-left");
  });

  it("light against the brief is blocking", async () => {
    const r = await craft(await fromTemplate("tells-sphere-lit", { brief: { light: "right" } }));
    const f = r.findings.find((x: { id: string }) => x.id === "C6");
    expect(f?.severity).toBe("blocking");
    expect(r.verdict).toBe("blocking");
    const ok = await craft(await fromTemplate("tells-sphere-lit", { brief: { light: "top-left" } }));
    expect(ids(ok)).not.toContain("C6");
  });

  it("banding: flags full-width stripes, passes staggered boundaries", async () => {
    expect(ids(await craft(await fromTemplate("tells-band-stripes")))).toContain("X3");
    expect(ids(await craft(await fromTemplate("tells-band-broken")))).not.toContain("X3");
  });

  it("confetti: flags scattered lone pixels, allows one deliberate specular", async () => {
    expect(ids(await craft(await fromTemplate("tells-confetti-before")))).toContain("C5");
    expect(ids(await craft(await fromTemplate("tells-confetti-after")))).not.toContain("C5");
  });

  it("ramps: flags a brightness-only ramp, passes a hue-shifted one", async () => {
    const flat = await craft(await fromTemplate("tells-ramps-flat-vs-shifted", { rows: [0, 2] }));
    expect(ids(flat)).toContain("C3");
    const shifted = await craft(await fromTemplate("tells-ramps-flat-vs-shifted", { rows: [3, 5] }));
    expect(ids(shifted)).not.toContain("C3");
  });

  it("mechanical tells: near-duplicates, semi-transparency, symmetry, doubled outline, strays, bloat", async () => {
    await op("doc.create", { path: "mech.aseprite", width: 20, height: 20 });
    await call("batch", {
      path: "mech.aseprite",
      ops: [
        { op: "draw.rect", x: 4, y: 4, width: 12, height: 12, color: "#202040", filled: true },
        { op: "draw.rect", x: 6, y: 6, width: 8, height: 8, color: "#c04030", filled: true },
        { op: "draw.rect", x: 8, y: 8, width: 4, height: 4, color: "#c14131", filled: true },
        { op: "draw.pixels", pixels: [{ x: 9, y: 2, color: "#ffffff80" }, { x: 0, y: 19, color: "#ffffff" }] },
      ],
    });
    const r = await craft("mech.aseprite");
    expect(ids(r)).toEqual(expect.arrayContaining(["C2", "E1", "E4", "X0"]));
    expect(r.findings.find((f: { id: string }) => f.id === "E1").severity).toBe("blocking");
    const sym = await craft(await fromTemplate("tells-sphere-pillow"));
    expect(ids(sym)).toContain("S4");
    expect(ids(await craft(await fromTemplate("tells-sphere-lit")))).not.toContain("S4");
    const big = await craft("mech.aseprite", { maxColors: 2 });
    expect(ids(big)).toContain("C1");
  });

  it("jaggies: a broken staircase is flagged, a clean 2:1 slope is not", async () => {
    await op("doc.create", { path: "jag.aseprite", width: 24, height: 12 });
    // top edges: clean 2:1 stair vs runs 2,3,1,2,2
    await call("batch", {
      path: "jag.aseprite",
      ops: [{
        op: "draw.pixel_map", x: 1, y: 1, legend: { a: "#3060c0" },
        rows: [
          "..........aaaaaaaaaaaaaa",
          "........aaaaaaaaaaaaaaaa",
          "......aaaaaaaaaaaaaaaaaa",
          "....aaaaaaaaaaaaaaaaaaaa",
          "..aaaaaaaaaaaaaaaaaaaaaa",
          "aaaaaaaaaaaaaaaaaaaaaaaa",
        ].map((r) => r.slice(0, 22)),
      }],
    });
    expect(ids(await craft("jag.aseprite"))).not.toContain("G6");
    await op("doc.create", { path: "jag2.aseprite", width: 24, height: 12 });
    await call("batch", {
      path: "jag2.aseprite",
      ops: [{
        op: "draw.pixel_map", x: 1, y: 1, legend: { a: "#3060c0" },
        rows: [
          "..........aaaaaaaaaaaa",
          "........aaaaaaaaaaaaaa",
          ".......aaaaaaaaaaaaaaa",
          "....aaaaaaaaaaaaaaaaaa",
          "..aaaaaaaaaaaaaaaaaaaa",
          "aaaaaaaaaaaaaaaaaaaaaa",
        ],
      }],
    });
    const j = await craft("jag2.aseprite");
    expect(ids(j)).toContain("G6");
  });

  it("draw.shade steps along palette colours with a hue shift", async () => {
    await op("doc.create", { path: "shade.aseprite", width: 8, height: 8, palette: "sweetie-16" });
    await call("batch", { path: "shade.aseprite", ops: [{ op: "draw.rect", x: 0, y: 0, width: 8, height: 8, color: "#b13e53", filled: true }] });
    const r = await call("batch", { path: "shade.aseprite", ops: [{ op: "draw.shade", x: 4, y: 0, width: 4, height: 8, steps: -1 }] });
    expect(r.ok ?? true).toBe(true);
    const px = (await op("pixels.read", {}, "shade.aseprite")).result;
    const left = px.legend[px.rows[0][0]];
    const right = px.legend[px.rows[0][7]];
    expect(left).toBe("#b13e53");
    expect(right).not.toBe("#b13e53");
    // sweetie-16 has the purple #5d275d one step down from the red: a cool shadow, not a darker red
    expect(right).toBe("#5d275d");
  });

  it("kb ops serve rules, skills and ready-to-draw templates", async () => {
    const list = (await op("kb.rules", {})).result;
    expect(list.rules.length).toBeGreaterThanOrEqual(60);
    const sec = (await op("kb.rule", { name: "02-shading-and-light", section: "Hue-shift" })).result;
    expect(sec.text).toMatch(/blue\/purple/);
    const t = (await op("kb.template", { name: "tells-sphere-lit", x: 3, y: 3 })).result;
    expect(t.draw.op).toBe("draw.pixel_map");
    await op("doc.create", { path: "tpl.aseprite", width: 16, height: 16 });
    await call("batch", { path: "tpl.aseprite", ops: [t.draw] });
    expect((await craft("tpl.aseprite")).subject.light.estimated).toBe("top-left");
  });

  it("real art: the bundled examples are not drowned in blocking findings", async () => {
    const { copyFileSync } = await import("node:fs");
    copyFileSync(path.resolve("examples/output/dragon/dragon.aseprite"), path.join(c.workdir, "dragon.aseprite"));
    copyFileSync(path.resolve("examples/output/slime.aseprite"), path.join(c.workdir, "slime.aseprite"));
    const dragon = await craft("dragon.aseprite");
    const slime = await craft("slime.aseprite");
    console.log(JSON.stringify({ dragon, slime }, null, 1).slice(0, 6000));
    expect(dragon.counts.blocking).toBe(0);
    expect(slime.counts.blocking).toBe(0);
  });
});
