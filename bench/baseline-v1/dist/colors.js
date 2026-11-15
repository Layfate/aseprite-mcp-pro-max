import { McpToolError } from "./errors.js";
function isNormalized(v) {
    if (!v || typeof v !== "object")
        return false;
    const o = v;
    return typeof o.index === "number" || (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number" && typeof o.a === "number");
}
export function parseColor(input) {
    if (isNormalized(input))
        return input;
    if (typeof input === "number") {
        if (!Number.isInteger(input) || input < 0 || input > 255) {
            throw new McpToolError("INVALID_INPUT", `palette index must be an integer 0-255, got ${input}`);
        }
        return { index: input };
    }
    const s = input.trim().toLowerCase();
    if (s === "transparent" || s === "none")
        return { r: 0, g: 0, b: 0, a: 0 };
    const m = /^#?([0-9a-f]+)$/.exec(s);
    const h = m?.[1];
    if (h && (h.length === 3 || h.length === 4)) {
        const [r, g, b, a = "f"] = h.split("");
        return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16), a: parseInt(a + a, 16) };
    }
    if (h && (h.length === 6 || h.length === 8)) {
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
            a: h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
        };
    }
    const idx = /^(?:idx|index):?(\d{1,3})$/.exec(s);
    if (idx)
        return parseColor(Number(idx[1]));
    throw new McpToolError("INVALID_INPUT", `invalid color '${input}'`, `Use "#rrggbb", "#rrggbbaa", "transparent", or a palette index number.`);
}
const COLOR_KEYS = new Set(["color", "fromColor", "toColor"]);
/** Deep-copy an op/request, converting every color-bearing field to NormalizedColor. */
export function normalizeColors(value) {
    return walk(value, undefined);
}
function walk(value, key) {
    if (key !== undefined && COLOR_KEYS.has(key) && (typeof value === "string" || typeof value === "number")) {
        return parseColor(value);
    }
    if (Array.isArray(value)) {
        if (key === "colors" || key === "palette")
            return value.map((c) => parseColor(c));
        return value.map((v) => walk(v, undefined));
    }
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (k === "legend" && v && typeof v === "object") {
                out[k] = Object.fromEntries(Object.entries(v).map(([ch, c]) => [ch, parseColor(c)]));
            }
            else {
                out[k] = walk(v, k);
            }
        }
        return out;
    }
    return value;
}
//# sourceMappingURL=colors.js.map