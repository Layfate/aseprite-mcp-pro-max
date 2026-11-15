// Opt-in: launches the Aseprite GUI and installs the bridge extension into the
// user's Aseprite extensions folder. Uses the v1 tool names (legacy profile).
// Run with ASEPRITE_MCP_TEST_LIVE=1.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { candidateExecutables, firstExisting } from "../../src/config.js";
import { hasAseprite, startClient, type TestClient } from "../helpers/client.js";

const enabled = process.env.ASEPRITE_MCP_TEST_LIVE === "1" && hasAseprite();
const run = enabled ? describe : describe.skip;

run("live editor bridge", () => {
  let c: TestClient;
  let gui: ChildProcess;
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await c.call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return r;
  };

  beforeAll(async () => {
    c = await startClient({ ASEPRITE_MCP_LIVE_PORT: "41832", ASEPRITE_MCP_PROFILE: "core,legacy" });
    await ok("aseprite_live", { action: "install_extension" });
    await ok("aseprite_create", { path: "live.aseprite", width: 16, height: 16, palette: "pico-8" });
    const exe = process.env.ASEPRITE_PATH ?? firstExisting(candidateExecutables())!;
    gui = spawn(exe, [path.join(c.workdir, "live.aseprite")], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if ((await c.call("aseprite_live", { action: "status" })).json?.connected) return;
    }
    throw new Error("the editor did not connect within 20s");
  });

  afterAll(async () => {
    gui?.kill();
    await c?.close();
  });

  it("sees the open document", async () => {
    const r = await ok("aseprite_live", { action: "list_open" });
    expect(r.json.sprites[0].file).toContain("live.aseprite");
    const s = await ok("aseprite_live", { action: "status" });
    expect(s.json.extension).toBe("1.0.0");
  });

  it("edits as one undoable transaction, with palette indices intact", async () => {
    await ok("aseprite_edit", { live: true, ops: [
      { op: "rect", x: 2, y: 2, width: 12, height: 12, color: 8, filled: true },
      { op: "ellipse", x: 4, y: 4, width: 8, height: 8, color: "#ffec27", filled: true },
      { op: "outline", color: "#000000" },
    ] });
    const g = (await ok("aseprite_read_pixels", { live: true })).json;
    expect(Object.values(g.legend).sort()).toEqual(["#000000", "#ff004d", "#ffec27"]);
    await ok("aseprite_history", { live: true, action: "undo" });
    expect((await ok("aseprite_read_pixels", { live: true })).json.colorCount).toBe(0);
    await ok("aseprite_history", { live: true, action: "redo" });
    expect((await ok("aseprite_read_pixels", { live: true })).json.colorCount).toBe(3);
  });

  it("rolls back a failing batch inside the editor", async () => {
    const before = (await ok("aseprite_read_pixels", { live: true })).json.rows;
    const r = await c.call("aseprite_edit", { live: true, ops: [
      { op: "clear" },
      { op: "delete_tag", tag: "missing" },
    ] });
    expect(r.isError).toBe(true);
    expect((await ok("aseprite_read_pixels", { live: true })).json.rows).toEqual(before);
  });

  it("previews, exports and saves the live document", async () => {
    expect((await ok("aseprite_preview", { live: true })).images).toHaveLength(1);
    expect((await ok("aseprite_export", { live: true, output: "live.png" })).json.files).toEqual(["live.png"]);
    await ok("aseprite_live", { action: "save" });
    const fromDisk = (await ok("aseprite_read_pixels", { path: "live.aseprite" })).json;
    expect(fromDisk.colorCount).toBe(3);
  });
});
