/**
 * Engine-neutral asset model. Every engine adapter consumes this, so the engine
 * integrations share one interpretation of frames, timing, tags, pivots and tiles.
 */

/** Subset of Aseprite's `--format json-array` sprite sheet data. */
export interface SheetData {
  frames: Array<{
    filename: string;
    frame: { x: number; y: number; w: number; h: number };
    trimmed?: boolean;
    spriteSourceSize: { x: number; y: number; w: number; h: number };
    sourceSize: { w: number; h: number };
    duration: number;
  }>;
  meta: {
    image: string;
    size: { w: number; h: number };
    frameTags?: Array<{ name: string; from: number; to: number; direction: string; repeat?: string }>;
    slices?: Array<{ name: string; keys: Array<{ frame: number; bounds: { x: number; y: number; w: number; h: number }; pivot?: { x: number; y: number } }> }>;
  };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ModelFrame {
  index: number;
  name: string;
  rect: Rect;
  /** Where the trimmed rect sits inside the original canvas. */
  source: Rect;
  trimmed: boolean;
  durationMs: number;
}

export interface ModelAnimation {
  name: string;
  /** Playback order (tag direction already expanded), indices into frames. */
  sequence: number[];
  durationsMs: number[];
  /** Frames in the tag, in file order. */
  frames: number[];
  direction: "forward" | "reverse" | "pingpong" | "pingpong_reverse";
  loop: boolean;
  repeats: number;
}

export interface AssetModel {
  name: string;
  /** Sheet image file name (relative to the output directory). */
  image: string;
  atlas: { w: number; h: number };
  canvas: { w: number; h: number };
  frames: ModelFrame[];
  animations: ModelAnimation[];
  /** Pivot in canvas pixels (default: bottom center). */
  pivot: { x: number; y: number };
  pivotSource: "document" | "default";
  slices: Array<{ name: string; rect: Rect; pivot?: { x: number; y: number } }>;
}

export interface TilesetModel {
  name: string;
  image: string;
  atlas: { w: number; h: number };
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  spacing: number;
  tiles: Array<{ tile: number; col: number; row: number; collision?: { shape: string; polygon?: Array<{ x: number; y: number }>; oneWay?: boolean; layer?: number } }>;
}

export interface TileMapModel {
  layer: string;
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  /** [x, y, tile(1-based), flipX, flipY, diagonal] */
  cells: Array<[number, number, number, number, number, number]>;
}

const INTERNAL_TAG = /^mcp:/;

/** Expand a tag into its playback sequence. */
export function playback(from: number, to: number, direction: string): number[] {
  const forward: number[] = [];
  for (let i = from; i <= to; i++) forward.push(i);
  const inner = forward.slice(1, -1);
  switch (direction) {
    case "reverse":
      return [...forward].reverse();
    case "pingpong":
      return [...forward, ...[...inner].reverse()];
    case "pingpong_reverse":
      return [...[...forward].reverse(), ...inner];
    default:
      return forward;
  }
}

export function buildModel(data: SheetData, opts: { name: string; pivot?: { x: number; y: number } | null }): AssetModel {
  const frames: ModelFrame[] = data.frames.map((f, i) => ({
    index: i,
    name: f.filename,
    rect: { ...f.frame },
    source: { ...f.spriteSourceSize },
    trimmed: f.spriteSourceSize.x !== 0 || f.spriteSourceSize.y !== 0 || f.spriteSourceSize.w !== f.sourceSize.w || f.spriteSourceSize.h !== f.sourceSize.h,
    durationMs: f.duration,
  }));
  const canvas = data.frames[0] ? { w: data.frames[0].sourceSize.w, h: data.frames[0].sourceSize.h } : { w: 0, h: 0 };
  const tags = (data.meta.frameTags ?? []).filter((t) => !INTERNAL_TAG.test(t.name));
  const animations: ModelAnimation[] =
    tags.length === 0
      ? [{ name: "default", sequence: frames.map((f) => f.index), durationsMs: frames.map((f) => f.durationMs), frames: frames.map((f) => f.index), direction: "forward", loop: true, repeats: 0 }]
      : tags.map((t) => {
          const dir = (["forward", "reverse", "pingpong", "pingpong_reverse"].includes(t.direction) ? t.direction : "forward") as ModelAnimation["direction"];
          const sequence = playback(t.from, t.to, dir);
          const repeats = t.repeat ? Number(t.repeat) : 0;
          const tagFrames: number[] = [];
          for (let i = t.from; i <= t.to; i++) tagFrames.push(i);
          return { name: t.name, sequence, durationsMs: sequence.map((i) => frames[i]?.durationMs ?? 100), frames: tagFrames, direction: dir, loop: !(repeats > 0), repeats };
        });
  const pivot = opts.pivot ?? { x: Math.floor(canvas.w / 2), y: canvas.h };
  return {
    name: opts.name,
    image: data.meta.image.split(/[\\/]/).pop()!,
    atlas: { ...data.meta.size },
    canvas,
    frames,
    animations,
    pivot,
    pivotSource: opts.pivot ? "document" : "default",
    slices: (data.meta.slices ?? []).map((s) => {
      const k = s.keys[0]!;
      return { name: s.name, rect: { ...k.bounds }, pivot: k.pivot };
    }),
  };
}

/** Basic consistency checks shared by every adapter (export fidelity). */
export function validateModel(m: AssetModel): string[] {
  const errors: string[] = [];
  for (const f of m.frames) {
    if (f.rect.x < 0 || f.rect.y < 0 || f.rect.x + f.rect.w > m.atlas.w || f.rect.y + f.rect.h > m.atlas.h) errors.push(`frame ${f.index} lies outside the ${m.atlas.w}x${m.atlas.h} atlas`);
    if (f.durationMs <= 0) errors.push(`frame ${f.index} has a non-positive duration`);
  }
  for (const a of m.animations) {
    for (const i of a.sequence) if (!m.frames[i]) errors.push(`animation '${a.name}' references missing frame ${i}`);
  }
  return errors;
}

/** Greatest common divisor of durations: lets engines that need one fps keep exact timing. */
export function gcdMs(values: number[]): number {
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
  return values.reduce((acc, v) => g(acc, Math.round(v)), 0) || 100;
}
