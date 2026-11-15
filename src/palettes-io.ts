import { McpToolError } from "./errors.js";

/** Parse GIMP .gpl, JASC .pal, Paint.NET .txt and .hex palette files into "#rrggbb" colors. */
export function parsePaletteFile(text: string, ext: string): { name?: string; colors: string[] } {
  const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
  const lines = text.replace(/\r/g, "").split("\n");
  const colors: string[] = [];
  let name: string | undefined;
  switch (ext) {
    case ".gpl": {
      if (!/^GIMP Palette/.test(lines[0] ?? "")) throw new McpToolError("INVALID_INPUT", "not a GIMP palette (missing 'GIMP Palette' header)");
      for (const l of lines.slice(1)) {
        const n = /^Name:\s*(.*)$/.exec(l);
        if (n) name = n[1]!.trim();
        const m = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(l);
        if (m) colors.push(hex(+m[1]!, +m[2]!, +m[3]!));
      }
      break;
    }
    case ".pal": {
      if (lines[0]?.trim() !== "JASC-PAL") throw new McpToolError("INVALID_INPUT", "only JASC-PAL .pal files are supported");
      for (const l of lines.slice(3)) {
        const m = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(l);
        if (m) colors.push(hex(+m[1]!, +m[2]!, +m[3]!));
      }
      break;
    }
    case ".txt":
    case ".hex": {
      for (const l of lines) {
        const t = l.trim();
        if (!t || t.startsWith(";")) continue;
        const m = /^#?(?:ff)?([0-9a-f]{6})$/i.exec(t.length === 8 ? t : t);
        if (m) colors.push("#" + m[1]!.toLowerCase());
      }
      break;
    }
    default:
      throw new McpToolError("INVALID_INPUT", `unsupported palette format '${ext}' (use .gpl, .pal, .hex or .txt)`);
  }
  if (colors.length === 0) throw new McpToolError("INVALID_INPUT", "no colors found in the palette file");
  if (colors.length > 256) throw new McpToolError("LIMIT", `palette has ${colors.length} colors (max 256)`);
  return { name, colors };
}

export function formatPaletteFile(colors: string[], ext: string, name = "aseprite-mcp"): string {
  const rgb = colors.filter((c) => c !== "transparent").map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number]);
  switch (ext) {
    case ".gpl":
      return ["GIMP Palette", `Name: ${name}`, `Columns: ${Math.min(16, rgb.length)}`, "#", ...rgb.map(([r, g, b], i) => `${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}\tcolor ${i}`)].join("\n") + "\n";
    case ".pal":
      return ["JASC-PAL", "0100", String(rgb.length), ...rgb.map((c) => c.join(" "))].join("\r\n") + "\r\n";
    case ".hex":
      return rgb.map((c) => c.map((v) => v.toString(16).padStart(2, "0")).join("")).join("\n") + "\n";
    case ".txt":
      return ["; paint.net palette", ...rgb.map((c) => "FF" + c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase())].join("\n") + "\n";
    default:
      throw new McpToolError("INVALID_INPUT", `unsupported palette format '${ext}'`);
  }
}
