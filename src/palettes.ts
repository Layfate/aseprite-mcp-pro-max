import { McpToolError } from "./errors.js";

export interface PalettePreset {
  name: string;
  description: string;
  colors: string[];
}

const p = (s: string) => s.split(" ").map((h) => `#${h}`);

/** Popular public palettes (see lospec.com for sources and authors). */
export const PALETTES: Record<string, PalettePreset> = {
  "pico-8": {
    name: "PICO-8",
    description: "16 colors of the PICO-8 fantasy console",
    colors: p("000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8 ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa"),
  },
  "sweetie-16": {
    name: "Sweetie 16",
    description: "Versatile 16-color palette by GrafxKid",
    colors: p("1a1c2c 5d275d b13e53 ef7d57 ffcd75 a7f070 38b764 257179 29366f 3b5dc9 41a6f6 73eff7 f4f4f4 94b0c2 566c86 333c57"),
  },
  "endesga-32": {
    name: "Endesga 32",
    description: "32-color palette by Endesga, great for characters and environments",
    colors: p(
      "be4a2f d77643 ead4aa e4a672 b86f50 733e39 3e2731 a22633 e43b44 f77622 feae34 fee761 63c74d 3e8948 265c42 193c3e 124e89 0099db 2ce8f5 ffffff c0cbdc 8b9bb4 5a6988 3a4466 262b44 181425 ff0044 68386c b55088 f6757a e8b796 c28569",
    ),
  },
  "db16": {
    name: "DawnBringer 16",
    description: "Classic 16-color palette by DawnBringer",
    colors: p("140c1c 442434 30346d 4e4a4e 854c30 346524 d04648 757161 597dce d27d2c 8595a1 6daa2c d2aa99 6dc2ca dad45e deeed6"),
  },
  "db32": {
    name: "DawnBringer 32",
    description: "Classic 32-color palette by DawnBringer (Aseprite's default)",
    colors: p(
      "000000 222034 45283c 663931 8f563b df7126 d9a066 eec39a fbf236 99e550 6abe30 37946e 4b692f 524b24 323c39 3f3f74 306082 5b6ee1 639bff 5fcde4 cbdbfc ffffff 9badb7 847e87 696a6a 595652 76428a ac3232 d95763 d77bba 8f974a 8a6f30",
    ),
  },
  "slso8": {
    name: "SLSO8",
    description: "Moody 8-color palette by Luis Miguel Maldonado",
    colors: p("0d2b45 203c56 544e68 8d697a d08159 ffaa5e ffd4a3 ffecd6"),
  },
  "gameboy": {
    name: "Game Boy (DMG)",
    description: "4 greens of the original Game Boy",
    colors: p("0f380f 306230 8bac0f 9bbc0f"),
  },
  "c64": {
    name: "Commodore 64",
    description: "16 colors of the Commodore 64 (Pepto)",
    colors: p("000000 ffffff 68372b 70a4b2 6f3d86 588d43 352879 b8c76f 6f4f25 433900 9a6759 444444 6c6c6c 9ad284 6c5eb5 959595"),
  },
  "cga": {
    name: "CGA 16",
    description: "Full 16-color IBM CGA palette",
    colors: p("000000 0000aa 00aa00 00aaaa aa0000 aa00aa aa5500 aaaaaa 555555 5555ff 55ff55 55ffff ff5555 ff55ff ffff55 ffffff"),
  },
  "grayscale-4": {
    name: "Grayscale 4",
    description: "4 evenly spaced grays",
    colors: p("000000 555555 aaaaaa ffffff"),
  },
  "1bit": {
    name: "1-bit",
    description: "Black and white",
    colors: p("000000 ffffff"),
  },
};

export function getPreset(name: string): PalettePreset {
  const key = name.toLowerCase().replace(/[\s_]+/g, "-");
  const preset = PALETTES[key] ?? PALETTES[key.replace(/-/g, "")];
  if (!preset) {
    throw new McpToolError("INVALID_INPUT", `unknown palette preset '${name}'`, `Available: ${Object.keys(PALETTES).join(", ")}`);
  }
  return preset;
}

// ---------------------------------------------------------------------------
// Color ramps
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [(h * 60 + 360) % 360, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * Build a hue-shifted shading ramp around a base color, darkest to lightest.
 * Shadows shift hue toward blue/purple (~240°), highlights toward yellow (~60°),
 * the way pixel artists usually shade instead of just darkening.
 */
export function colorRamp(base: string, steps = 5, hueShift = 20, saturationShift = 0.1): string[] {
  if (steps < 2 || steps > 16) throw new McpToolError("INVALID_INPUT", "steps must be between 2 and 16");
  const [h, s, v] = rgbToHsv(...hexToRgb(base));
  const mid = (steps - 1) / 2;
  const out: string[] = [];
  const toward = (from: number, target: number, amount: number) => {
    let d = ((target - from + 540) % 360) - 180;
    if (Math.abs(d) < amount) return target;
    return from + Math.sign(d) * amount;
  };
  for (let i = 0; i < steps; i++) {
    const t = (i - mid) / (mid || 1); // -1 (darkest) .. +1 (lightest)
    const hue = t < 0 ? toward(h, 240, hueShift * -t) : toward(h, 60, hueShift * t);
    const sat = Math.min(1, Math.max(0, s + (t < 0 ? saturationShift * -t : -saturationShift * t * 1.5)));
    const val = Math.min(1, Math.max(0.05, t < 0 ? v * (1 + 0.65 * t) : v + (1 - v) * 0.8 * t));
    out.push(rgbToHex(...hsvToRgb(hue, sat, val)));
  }
  return out;
}
