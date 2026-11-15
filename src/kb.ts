import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { LUA_DIR } from "./aseprite.js";

/**
 * Pixel-art knowledge base: the craft rulebook (rules/*.md, vendored from
 * with-pebbly/aseprite-ai-artist, MIT — see rules/LICENSE), its drawable
 * ```grid templates, and this server's own workflow skills (skills/<name>/SKILL.md).
 *
 * One source of truth on disk, served three ways: Claude Code reads skills/ and
 * agents/ from the plugin; every MCP client reads rules:// and skill:// resources
 * and prompts; the kb.* operations expose the same content as tools.
 */

const ROOT = path.resolve(LUA_DIR, "..");
export const RULES_DIR = path.join(ROOT, "rules");
export const SKILLS_DIR = path.join(ROOT, "skills");

export interface Rule {
  name: string;
  title: string;
  body: string;
}

export interface Template {
  name: string;
  rule: string;
  width: number;
  height: number;
  /** char -> "#rrggbb" ('.' is transparent and is never in the legend) */
  legend: Record<string, string>;
  /** char -> role ("outline", "skin-light", ...) */
  roles: Record<string, string>;
  rows: string[];
}

export interface Skill {
  name: string;
  title: string;
  description: string;
  body: string;
}

/**
 * The rulebook was written against aseprite-ai-artist's tool names. This maps
 * them to Pro Max operations; it is prepended to rules://index and referenced
 * from every rule served.
 */
export const GLOSSARY = `## Tool names in this rulebook -> Aseprite MCP Pro Max

The rules were written for aseprite-ai-artist. Translate its tool names:

| Rulebook says | Use in Pro Max |
|---|---|
| \`preflight\`, \`sprite_info\` | \`capabilities\`, \`inspect\` (detail "full") |
| \`look\` op \`preview\` (\`scale: 1\` = the 1x read) | \`preview\` tool (view "frames", \`scale\`) |
| \`look\` op \`ascii\` | \`run_op pixels.read\` (char grid + legend; same format as draw.pixel_map) |
| \`look\` op \`compare\` | \`preview\` view "compare", \`ref.compare\` |
| \`look\` op \`filmstrip\` / \`onion\` / \`diff\` | \`preview\` view "contact_sheet" / \`onion: true\` / \`changes\` with \`against\` |
| \`validate\` | \`check.craft\` (art tells) + \`check.lint\` (mechanics) + \`check.brief\`, \`check.jitter\`, \`check.timing\` |
| \`draw\` op \`grid\` | \`draw.pixel_map\` (rows + legend). NOTE: here '.' KEEPS existing pixels; map a char to "transparent" to erase |
| \`draw\` ops \`pixels\` \`line\` \`rect\` \`ellipse\` \`fill\` \`polygon\` \`text\` | \`draw.pixels\` \`draw.line\` \`draw.rect\` \`draw.ellipse\` \`draw.fill\` \`draw.polygon\` \`draw.text\` |
| \`draw\` op \`dither\` / \`gradient\` / \`blit\` | \`draw.dither_fill\` / \`draw.gradient\` / \`xf.copy_region\`, \`pattern.stamp\` |
| \`palette\` op \`ramp\` / \`get\` / \`analyze\` / \`extract\` | \`pal.ramp\` / \`pal.extract\` / \`pal.contrast\` + \`check.craft\` / \`pal.reduce\` |
| \`recolor\` op \`shade\` | \`draw.shade\` (hue-shifted step to the next palette colour) |
| \`recolor\` op \`snap\` / \`replace\` | \`pal.quantize\` / \`pal.replace_color\`, \`pal.remap\` |
| \`transform\` op \`outline\` / \`flip\` / \`rotate\` / \`scale\` | \`draw.outline\`, \`clean.outline\` / \`xf.flip\` / \`xf.rotate\` / \`doc.scale\` |
| \`select\` | \`sel.*\` (then \`inSelection: true\` on draw ops) |
| \`reference\` op \`import\` / \`sample_palette\` / \`remove\` | \`ref.add_layer\` / \`ref.extract_palette\` / \`layer.delete\` |
| \`sprite_manage\`, \`export\` | \`doc.create\`, \`doc.save_as\` / \`export.png\`, \`sheet.export\`, \`view.gif\`, \`engine.*\` |
| \`paletteLock\`, \`allowLossy\` | no switch: keep colours in the palette and prove it with \`check.palette\` |
| \`aseprite:<skill>\`, \`skill://<skill>\` | \`skill://<skill>\` resources / prompts served by this server |
| \`\`\`grid <name>\`\`\` templates | \`run_op kb.template {name}\` returns ready draw.pixel_map args |
`;

function titleOf(body: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? fallback;
}

let rulesCache: Rule[] | undefined;
export function loadRules(): Rule[] {
  if (rulesCache) return rulesCache;
  if (!existsSync(RULES_DIR)) return (rulesCache = []);
  rulesCache = readdirSync(RULES_DIR)
    .filter((f) => /^\d\d-.+\.md$/.test(f))
    .sort()
    .map((f) => {
      const body = readFileSync(path.join(RULES_DIR, f), "utf8");
      const name = f.replace(/\.md$/, "");
      return { name, title: titleOf(body, name), body };
    });
  return rulesCache;
}

export function getRule(name: string): Rule | undefined {
  const rules = loadRules();
  return rules.find((r) => r.name === name) ?? rules.find((r) => r.name.slice(3) === name || r.name.startsWith(`${name}-`));
}

/** Parse the ```grid <name> blocks of one rule file. */
export function parseTemplates(md: string, rule = ""): Template[] {
  const out: Template[] = [];
  const re = /^```grid[ \t]+(\S+)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    const name = m[1]!;
    const lines = m[2]!.replace(/\r/g, "").split("\n").filter((l) => l.length > 0);
    const sep = lines.indexOf("---");
    if (sep < 0) throw new Error(`template '${name}' has no '---' separator`);
    const legend: Record<string, string> = {};
    const roles: Record<string, string> = {};
    for (const l of lines.slice(0, sep)) {
      const lm = /^(\S)\s*=\s*(.*?)\s*(#[0-9a-fA-F]{6})\s*$/.exec(l);
      if (!lm) throw new Error(`template '${name}': bad legend line '${l}'`);
      legend[lm[1]!] = lm[3]!.toLowerCase();
      roles[lm[1]!] = lm[2]!.trim();
    }
    const rows = lines.slice(sep + 1);
    out.push({ name, rule, width: Math.max(0, ...rows.map((r) => r.length)), height: rows.length, legend, roles, rows });
  }
  return out;
}

let templateCache: Map<string, Template> | undefined;
export function allTemplates(): Map<string, Template> {
  if (templateCache) return templateCache;
  templateCache = new Map();
  for (const r of loadRules()) for (const t of parseTemplates(r.body, r.name)) templateCache.set(t.name, t);
  return templateCache;
}

/** Rule index: one line per rule, with the glossary. */
export function rulesIndex(): string {
  const lines = loadRules().map((r) => `- rules://${r.name} — ${r.title} (${parseTemplates(r.body).length} templates)`);
  return [
    "# Pixel-art rulebook",
    "",
    "Vendored from with-pebbly/aseprite-ai-artist (MIT, see rules/LICENSE). Read 2-3 files for the subject you draw; never all of them.",
    "Start with rules://00-core-principles; before calling anything done read rules://92-generated-art-tells and rules://07-review-checklist.",
    "",
    ...lines,
    "",
    GLOSSARY,
  ].join("\n");
}

/** A rule as served: the body plus a one-line pointer to the glossary. */
export function ruleText(r: Rule): string {
  return `> Tool names below come from aseprite-ai-artist; rules://index maps them to Pro Max ops (e.g. look ascii -> pixels.read, validate -> check.craft, draw grid -> draw.pixel_map).\n\n${r.body}`;
}

function frontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

let skillCache: Skill[] | undefined;
export function loadSkills(): Skill[] {
  if (skillCache) return skillCache;
  if (!existsSync(SKILLS_DIR)) return (skillCache = []);
  skillCache = readdirSync(SKILLS_DIR)
    .filter((d) => existsSync(path.join(SKILLS_DIR, d, "SKILL.md")) && statSync(path.join(SKILLS_DIR, d)).isDirectory())
    .sort()
    .map((d) => {
      const { meta, body } = frontmatter(readFileSync(path.join(SKILLS_DIR, d, "SKILL.md"), "utf8"));
      return { name: meta.name ?? d, title: titleOf(body, meta.name ?? d), description: meta.description ?? "", body };
    });
  return skillCache;
}

/** Word search over rule titles/bodies and template names. */
export function searchKb(query: string, limit = 12): { rules: Array<{ name: string; title: string; hits: number }>; templates: string[] } {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  const rules = loadRules()
    .map((r) => {
      const hay = r.body.toLowerCase();
      const title = `${r.name} ${r.title}`.toLowerCase();
      let hits = 0;
      for (const w of words) {
        if (title.includes(w)) hits += 20;
        hits += Math.min(10, hay.split(w).length - 1);
      }
      return { name: r.name, title: r.title, hits };
    })
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit);
  const templates = [...allTemplates().keys()].filter((n) => words.some((w) => n.includes(w))).slice(0, 40);
  return { rules, templates };
}
