import { z } from "zod";
import { McpToolError } from "../errors.js";
import { allTemplates, getRule, loadRules, loadSkills, searchKb } from "../kb.js";
import { Color, coord, layer } from "./common.js";
import { op, type OpDef } from "./types.js";

const A = "action" as const;

/** One "## heading" section of a markdown document (case-insensitive prefix match). */
function section(md: string, heading: string): string | undefined {
  const parts = md.split(/^(?=## )/m);
  const want = heading.toLowerCase();
  return parts.find((p) => p.slice(3).toLowerCase().startsWith(want));
}

export const KB_OPS: OpDef[] = [
  op("kb.rules", "production", A, "Pixel-art rulebook: list the 62 craft rules and skills, or search rules and templates",
    { query: z.string().max(200).optional() },
    { args: { query: "walk cycle" }, noDoc: true },
    {
      doc: "none",
      requires: [],
      keywords: ["knowledge", "rules", "craft", "how to draw", "best practices", "templates", "skills"],
      run: async (a) => {
        if (a.query) return { data: searchKb(String(a.query)) };
        return {
          data: {
            rules: loadRules().map((r) => `${r.name}: ${r.title}`),
            skills: loadSkills().map((s) => `${s.name}: ${s.description}`),
            read: "kb.rule {name, section?}; templates: kb.template {name}; the same text is served as rules://<name> and skill://<name> resources",
          },
        };
      },
    }),
  op("kb.rule", "production", A, "Read one rulebook file (or one '## section' of it) or one workflow skill",
    { name: z.string().min(1).max(80), section: z.string().max(120).optional() },
    { args: { name: "02-shading-and-light", section: "Hue-shift" }, noDoc: true },
    {
      doc: "none",
      requires: [],
      keywords: ["read rule", "skill", "shading rules", "proportions"],
      run: async (a) => {
        const name = String(a.name);
        const skill = loadSkills().find((s) => s.name === name || `skill://${s.name}` === name);
        const rule = skill ? undefined : getRule(name.replace(/^rules:\/\//, ""));
        if (!skill && !rule) {
          throw new McpToolError("NOT_FOUND", `no rule or skill '${name}'`, "kb.rules lists them (rules look like '02-shading-and-light', skills like 'draw').");
        }
        const body = skill ? skill.body : rule!.body;
        let text = body;
        if (a.section) {
          const s = section(body, String(a.section));
          if (!s) throw new McpToolError("NOT_FOUND", `no section '${a.section}'`, `Sections: ${[...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]).join(" | ")}`);
          text = s;
        }
        return { data: { name: skill ? `skill://${skill.name}` : `rules://${rule!.name}`, text } };
      },
    }),
  op("kb.template", "production", A, "A rulebook grid template as ready draw.pixel_map args (recolourable, placeable)",
    {
      name: z.string().min(1).max(120),
      x: coord().optional(), y: coord().optional(), layer,
      colors: z.record(z.string().length(1), Color).optional(),
      erase: z.boolean().optional(),
    },
    { args: { name: "tells-sphere-lit", x: 4, y: 4 }, noDoc: true },
    {
      doc: "none",
      requires: [],
      keywords: ["template", "grid", "stamp shape", "starting point", "example sprite"],
      notes: "Transcribe, then adapt to the pose: a template is a starting point, not the answer. colors maps a template char to a sprite palette colour. erase:true maps '.' to transparent (otherwise '.' keeps existing pixels).",
      run: async (a) => {
        const t = allTemplates().get(String(a.name));
        if (!t) {
          const near = [...allTemplates().keys()].filter((n) => n.includes(String(a.name).split("-")[0] ?? "")).slice(0, 12);
          throw new McpToolError("NOT_FOUND", `no template '${a.name}'`, near.length ? `Similar: ${near.join(", ")}` : "kb.rules {query} finds templates.");
        }
        const legend: Record<string, string | number> = { ...t.legend, ...((a.colors as Record<string, string | number>) ?? {}) };
        let rows = t.rows;
        if (a.erase) {
          legend["~"] = "transparent";
          rows = rows.map((r) => r.replaceAll(".", "~"));
        }
        const draw: Record<string, unknown> = { op: "draw.pixel_map", rows, legend };
        if (a.x !== undefined) draw.x = a.x;
        if (a.y !== undefined) draw.y = a.y;
        if (a.layer) draw.layer = a.layer;
        return { data: { name: t.name, rule: `rules://${t.rule}`, width: t.width, height: t.height, roles: t.roles, draw } };
      },
    }),
];
