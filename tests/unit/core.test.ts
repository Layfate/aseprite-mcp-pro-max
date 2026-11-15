import { mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeColors, parseColor } from "../../src/colors.js";
import { McpToolError } from "../../src/errors.js";
import { colorRamp, getPreset, PALETTES } from "../../src/palettes.js";
import { Workspace } from "../../src/paths.js";
import { Checkpoints, KeyedMutex, commitFile } from "../../src/transaction.js";
import { loadConfig } from "../../src/config.js";
import { pixelArtPrompt } from "../../src/ai.js";

describe("colors", () => {
  it("parses hex forms", () => {
    expect(parseColor("#ff8000")).toEqual({ r: 255, g: 128, b: 0, a: 255 });
    expect(parseColor("ff800080")).toEqual({ r: 255, g: 128, b: 0, a: 128 });
    expect(parseColor("#f80")).toEqual({ r: 255, g: 136, b: 0, a: 255 });
    expect(parseColor("#f808")).toEqual({ r: 255, g: 136, b: 0, a: 136 });
    expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor(7)).toEqual({ index: 7 });
    expect(parseColor("idx:12")).toEqual({ index: 12 });
  });

  it("rejects invalid colors", () => {
    expect(() => parseColor("#12345")).toThrow(McpToolError);
    expect(() => parseColor("red")).toThrow(/invalid color/);
    expect(() => parseColor(256)).toThrow(/0-255/);
    expect(() => parseColor(1.5)).toThrow();
  });

  it("is idempotent", () => {
    const c = parseColor("#102030");
    expect(parseColor(c)).toBe(c);
  });

  it("normalizes color fields in ops but leaves frame numbers alone", () => {
    const out = normalizeColors({
      op: "replace_color",
      fromColor: "#000",
      toColor: 3,
      from: 2,
      legend: { a: "#fff", b: "transparent" },
      colors: ["#000", 1],
    });
    expect(out).toEqual({
      op: "replace_color",
      fromColor: { r: 0, g: 0, b: 0, a: 255 },
      toColor: { index: 3 },
      from: 2,
      legend: { a: { r: 255, g: 255, b: 255, a: 255 }, b: { r: 0, g: 0, b: 0, a: 0 } },
      colors: [{ r: 0, g: 0, b: 0, a: 255 }, { index: 1 }],
    });
  });
});

describe("workspace sandbox", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ws-"));
  const ws = new Workspace([root]);

  it("resolves relative paths inside the root", () => {
    expect(ws.resolve("a/b.aseprite")).toBe(path.join(root, "a", "b.aseprite"));
    expect(ws.display(path.join(root, "a", "b.aseprite"))).toBe("a/b.aseprite");
  });

  it("blocks traversal and absolute escapes", () => {
    expect(() => ws.resolve("../x.aseprite")).toThrow(/outside/);
    expect(() => ws.resolve(path.join(tmpdir(), "elsewhere.aseprite"))).toThrow(/outside/);
    expect(() => ws.resolve("x\0.aseprite")).toThrow();
  });

  it("enforces extensions", () => {
    expect(() => ws.resolve("x.png", { extensions: [".aseprite"] })).toThrow(/extensions/);
  });

  it("blocks symlinks that point outside", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "out-"));
    const link = path.join(root, "link");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // symlinks not permitted on this machine
    }
    expect(() => ws.resolve("link/evil.aseprite")).toThrow(/outside/);
  });
});

describe("palettes", () => {
  it("has well-formed presets", () => {
    for (const p of Object.values(PALETTES)) {
      for (const c of p.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(PALETTES["pico-8"]!.colors).toHaveLength(16);
    expect(PALETTES["endesga-32"]!.colors).toHaveLength(32);
    expect(PALETTES["db32"]!.colors).toHaveLength(32);
  });

  it("looks up presets leniently", () => {
    expect(getPreset("PICO 8").name).toBe("PICO-8");
    expect(getPreset("sweetie_16").colors).toHaveLength(16);
    try {
      getPreset("nope");
      expect.unreachable();
    } catch (e) {
      expect((e as McpToolError).hint).toMatch(/Available: .*pico-8/);
    }
  });

  it("builds ramps from dark to light around the base", () => {
    const ramp = colorRamp("#ef7d57", 5);
    expect(ramp).toHaveLength(5);
    expect(ramp[2]).toBe("#ef7d57");
    const lum = (h: string) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
    for (let i = 1; i < ramp.length; i++) expect(lum(ramp[i]!)).toBeGreaterThan(lum(ramp[i - 1]!));
  });
});

describe("transactions", () => {
  it("serializes work per key", async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const slow = (tag: string, ms: number) => m.run("K", async () => {
      order.push(`${tag}-start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}-end`);
    });
    await Promise.all([slow("a", 30), slow("b", 1), slow("c", 1)]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end", "c-start", "c-end"]);
  });

  it("keeps the original when produce fails, checkpoints on success, supports undo/redo", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tx-"));
    const target = path.join(dir, "s.aseprite");
    writeFileSync(target, "v1");
    const cps = new Checkpoints(3);

    await expect(commitFile(target, cps, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(readFileSync(target, "utf8")).toBe("v1");

    await commitFile(target, cps, async (work) => writeFileSync(work, "v2"));
    expect(readFileSync(target, "utf8")).toBe("v2");
    expect(await cps.list(target)).toHaveLength(1);

    await cps.undo(target);
    expect(readFileSync(target, "utf8")).toBe("v1");
    await cps.redo(target);
    expect(readFileSync(target, "utf8")).toBe("v2");

    for (let i = 3; i <= 7; i++) await commitFile(target, cps, async (work) => writeFileSync(work, `v${i}`));
    expect((await cps.list(target)).length).toBeLessThanOrEqual(3);
  });

  it("refuses to commit when the file changed meanwhile", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tx-"));
    const target = path.join(dir, "s.aseprite");
    writeFileSync(target, "v1");
    const cps = new Checkpoints(3);
    await expect(
      commitFile(target, cps, async (work) => {
        writeFileSync(work, "mine");
        await new Promise((r) => setTimeout(r, 20));
        writeFileSync(target, "theirs");
      }),
    ).rejects.toThrow(/modified by another program/);
    expect(readFileSync(target, "utf8")).toBe("theirs");
  });

  it("dry runs leave the target untouched", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tx-"));
    const target = path.join(dir, "s.aseprite");
    writeFileSync(target, "v1");
    const res = await commitFile(target, new Checkpoints(3), async (work) => writeFileSync(work, "v2"), { dryRun: true });
    expect(readFileSync(target, "utf8")).toBe("v1");
    expect(existsSync(res.workPath!)).toBe(true);
  });
});

describe("config & prompts", () => {
  it("parses env", () => {
    const c = loadConfig({ ASEPRITE_MCP_ROOTS: ["a", "b"].join(path.delimiter), ASEPRITE_MCP_TIMEOUT_MS: "5000", ASEPRITE_MCP_ALLOW_LUA: "1" });
    expect(c.roots).toEqual([path.resolve("a"), path.resolve("b")]);
    expect(c.timeoutMs).toBe(5000);
    expect(c.allowLua).toBe(true);
    expect(loadConfig({}).allowLua).toBe(false);
  });

  it("steers image prompts toward pixel art", () => {
    const p = pixelArtPrompt("a red fox", 32, 32, "PICO-8");
    expect(p).toContain("a red fox");
    expect(p).toContain("32x32");
    expect(p).toContain("PICO-8");
  });
});

// keep mkdirSync referenced for platforms where symlink test returns early
void mkdirSync;
