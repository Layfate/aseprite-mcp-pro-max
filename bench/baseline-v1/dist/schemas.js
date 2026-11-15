import { z } from "zod";
// Integers via multipleOf(1): .int() would emit +/-2^53 bounds into every field.
const int = () => z.number().multipleOf(1);
const coord = () => int();
const size = () => int().min(1);
const pos = () => int().min(1);
// Shared fields carry no per-field descriptions: the conventions are explained
// once in OPS_DESCRIPTION to keep the tool schema small.
export const Color = z.union([z.string(), int().min(0).max(255)]);
const layer = z.string().optional();
const frame = pos().optional();
const frameRange = {
    frame: frame,
    frames: z.array(pos()).optional(),
    fromFrame: pos().optional(),
    toFrame: pos().optional(),
    tag: z.string().optional(),
};
const point = z.object({ x: coord(), y: coord() });
const blendMode = z.enum([
    "normal", "multiply", "screen", "overlay", "darken", "lighten", "color_dodge", "color_burn", "hard_light",
    "soft_light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "addition", "subtract", "divide",
]);
const direction = z.enum(["forward", "reverse", "pingpong", "pingpong_reverse"]);
const layerPlacement = {
    parent: z.string().optional().describe("Group to place the layer in"),
    above: z.string().optional().describe("Place directly above this layer"),
    below: z.string().optional().describe("Place directly below this layer"),
    toTop: z.boolean().optional(),
    toBottom: z.boolean().optional(),
};
const op = (name, description, shape) => z.object({ op: z.literal(name), ...shape }).describe(description);
export const Ops = [
    // Drawing
    op("pixel_map", "Draw a character grid. Each char maps through `legend` to a color; '.' and ' ' leave pixels unchanged. Best way to draw sprites.", {
        layer, frame,
        x: coord().optional().describe("Left of the grid (default 0)"),
        y: coord().optional().describe("Top of the grid (default 0)"),
        rows: z.array(z.string().max(1024)).min(1).max(1024),
        legend: z.record(z.string().length(1), Color).describe('e.g. {"K":"#000000","o":"#f4a460","w":"transparent"}'),
    }),
    op("set_pixels", "Set individual pixels.", {
        layer, frame,
        pixels: z.array(z.object({ x: coord(), y: coord(), color: Color })).min(1).max(65536),
    }),
    op("line", "Draw a 1px line between two points, or a polyline through `points`.", {
        layer, frame, color: Color,
        x1: coord().optional(), y1: coord().optional(), x2: coord().optional(), y2: coord().optional(),
        points: z.array(point).min(2).max(1024).optional(),
        closed: z.boolean().optional().describe("Connect last point to first (polygon outline)"),
    }),
    op("rect", "Draw a rectangle outline or filled rectangle.", {
        layer, frame, color: Color, x: coord(), y: coord(), width: size(), height: size(), filled: z.boolean().optional(),
    }),
    op("ellipse", "Draw a pixel-perfect ellipse inscribed in the box.", {
        layer, frame, color: Color, x: coord(), y: coord(), width: size(), height: size(), filled: z.boolean().optional(),
    }),
    op("fill", "Flood fill (bucket) from a seed pixel.", {
        layer, frame, color: Color, x: coord(), y: coord(),
        tolerance: int().min(0).max(255).optional(),
        contiguous: z.boolean().optional().describe("false = replace every matching pixel in the cel"),
        diagonal: z.boolean().optional().describe("8-way connectivity"),
    }),
    op("gradient", "Fill a rectangle with an ordered-dither (Bayer 4x4) gradient between color stops.", {
        layer, frame,
        colors: z.array(Color).min(2).max(16),
        x: coord().optional(), y: coord().optional(), width: size().optional(), height: size().optional(),
        direction: z.enum(["vertical", "horizontal"]).optional(),
        dither: z.boolean().optional().describe("false = hard bands"),
    }),
    op("text", "Draw text with the built-in 3x5 pixel font (A-Z, 0-9, punctuation; lowercase renders as uppercase).", {
        layer, frame, color: Color, x: coord(), y: coord(),
        text: z.string().min(1).max(500),
        scale: pos().max(16).optional(),
        spacing: int().min(0).max(8).optional(),
        lineSpacing: int().min(0).max(16).optional(),
    }),
    op("clear", "Erase a rectangle, or delete whole cels when no rectangle is given.", {
        layer, ...frameRange,
        x: coord().optional(), y: coord().optional(), width: size().optional(), height: size().optional(),
    }),
    // Recolor / effects
    op("replace_color", "Replace one color with another (all image layers/frames unless restricted).", {
        fromColor: Color, toColor: Color, tolerance: int().min(0).max(255).optional(),
        layer, ...frameRange,
    }),
    op("adjust_color", "Shift hue/saturation/lightness. Indexed sprites adjust the palette instead.", {
        hue: z.number().min(-360).max(360).optional().describe("degrees"),
        saturation: z.number().min(-100).max(100).optional(),
        lightness: z.number().min(-100).max(100).optional(),
        layer, ...frameRange,
    }),
    op("quantize", "Snap every pixel to the nearest color of `colors` (or the sprite palette).", {
        colors: z.array(Color).max(256).optional(),
        alphaThreshold: pos().max(255).optional().describe("Make alpha binary: >= threshold opaque, else transparent"),
        layer, ...frameRange,
    }),
    op("outline", "Add a 1px outline around opaque pixels (outside), or recolor the edge pixels (inside).", {
        layer, ...frameRange, color: Color.optional(),
        place: z.enum(["outside", "inside"]).optional(),
        matrix: z.enum(["circle", "square"]).optional().describe("circle = 4-neighbour (default), square = 8-neighbour"),
    }),
    // Transform
    op("flip", "Mirror a cel across the canvas.", { layer, ...frameRange, direction: z.enum(["horizontal", "vertical"]) }),
    op("rotate", "Rotate cel pixels around the canvas center.", { layer, ...frameRange, angle: z.union([z.literal(90), z.literal(180), z.literal(270)]) }),
    op("shift", "Shift cel pixels, optionally wrapping around the edges.", { layer, ...frameRange, dx: coord().optional(), dy: coord().optional(), wrap: z.boolean().optional() }),
    op("move", "Move whole cels (changes cel position, no pixel loss).", { layer, ...frameRange, dx: coord().optional(), dy: coord().optional() }),
    op("copy_region", "Copy (or cut) a rectangle to another position/layer/frame. Transparent pixels are skipped unless `opaque`.", {
        layer, frame, x: coord(), y: coord(), width: size(), height: size(),
        toX: coord(), toY: coord(), toLayer: z.string().optional(), toFrame: pos().optional(),
        cut: z.boolean().optional(), opaque: z.boolean().optional(),
    }),
    op("import_image", "Paste a PNG file onto a cel (use aseprite_import_image for cleanup/downscaling).", {
        layer, frame, file: z.string().describe("Image path inside the workspace"), x: coord().optional(), y: coord().optional(),
    }),
    // Cels / animation
    op("copy_cel", "Copy a cel to another frame (or frame range) and/or layer.", {
        fromLayer: z.string().optional(), layer, fromFrame: pos(),
        toLayer: z.string().optional(), toFrame: pos(), toFrameEnd: pos().optional(),
    }),
    op("set_cel", "Set cel opacity, position or z-index.", {
        layer, ...frameRange, opacity: int().min(0).max(255).optional(), x: coord().optional(), y: coord().optional(), zIndex: int().min(-999).max(999).optional(),
    }),
    op("tween", "Animate a cel: copy the fromFrame cel across the range with an eased offset (and optional opacity fade). additive=true offsets existing cels instead.", {
        layer, fromFrame: pos(), toFrame: pos(),
        dx: coord().optional(), dy: coord().optional(),
        easing: z.enum(["linear", "ease_in", "ease_out", "ease_in_out"]).optional(),
        fromOpacity: int().min(0).max(255).optional(), toOpacity: int().min(0).max(255).optional(),
        additive: z.boolean().optional(),
    }),
    // Layers
    op("add_layer", "Add an image layer or group.", {
        name: z.string().min(1).max(256), group: z.boolean().optional(), ...layerPlacement,
        opacity: int().min(0).max(255).optional(), blendMode: blendMode.optional(), visible: z.boolean().optional(),
        allowDuplicate: z.boolean().optional(),
    }),
    op("set_layer", "Rename a layer or change visibility, lock, opacity, blend mode.", {
        layer: z.string(), name: z.string().min(1).max(256).optional(), visible: z.boolean().optional(),
        locked: z.boolean().optional(), opacity: int().min(0).max(255).optional(), blendMode: blendMode.optional(),
    }),
    op("delete_layer", "Delete a layer or group.", { layer: z.string() }),
    op("move_layer", "Reorder a layer.", { layer: z.string(), ...layerPlacement }),
    op("duplicate_layer", "Duplicate a layer with all its cels.", { layer: z.string(), name: z.string().optional() }),
    op("merge_down", "Merge a layer into the layer below it.", { layer: z.string() }),
    op("flatten", "Flatten all layers into one.", {}),
    // Frames / tags
    op("add_frames", "Insert frames (empty, or copies of `copyFrom`).", {
        count: pos().max(256).optional(),
        after: int().min(0).max(9999).optional().describe("Insert after this frame (0 = at the start, default = at the end)"),
        copyFrom: pos().optional(),
        durationMs: pos().max(65535).optional(),
    }),
    op("delete_frames", "Delete a frame or range.", { from: pos(), to: pos().optional() }),
    op("set_frame_duration", "Set frame duration in ms (all frames when no range is given).", { durationMs: pos().max(65535), ...frameRange }),
    op("reverse_frames", "Reverse the order of a frame range.", { from: pos(), to: pos() }),
    op("add_tag", "Create an animation tag over a frame range.", {
        name: z.string().min(1).max(256), from: pos(), to: pos(), direction: direction.optional(), repeats: int().min(0).max(65535).optional(),
    }),
    op("set_tag", "Modify an animation tag.", {
        tag: z.string(), name: z.string().optional(), from: pos().optional(), to: pos().optional(), direction: direction.optional(), repeats: int().min(0).max(65535).optional(),
    }),
    op("delete_tag", "Delete an animation tag.", { tag: z.string() }),
    // Slices
    op("add_slice", "Add a named slice (hitbox, 9-patch, pivot).", {
        name: z.string().min(1), x: coord(), y: coord(), width: size(), height: size(),
        pivot: point.optional(), center: z.object({ x: coord(), y: coord(), width: size(), height: size() }).optional(),
    }),
    op("delete_slice", "Delete a slice.", { name: z.string() }),
    // Palette / sprite
    op("set_palette", "Replace the palette with `colors` or a built-in `preset`. remap=true also snaps existing pixels to it.", {
        colors: z.array(Color).min(1).max(256).optional(), preset: z.string().optional(), remap: z.boolean().optional(),
    }),
    op("set_palette_color", "Set one palette entry.", { index: int().min(0).max(255), color: Color }),
    op("resize_canvas", "Change canvas size without scaling pixels.", {
        width: size(), height: size(),
        anchor: z.enum(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]).optional(),
    }),
    op("crop", "Crop the canvas to a rectangle.", { x: coord(), y: coord(), width: size(), height: size() }),
    op("scale", "Scale the whole sprite with nearest-neighbour.", { factor: z.number().positive().max(64).optional(), width: size().optional(), height: size().optional() }),
    op("set_color_mode", "Convert color mode.", { mode: z.enum(["rgb", "gray", "indexed"]), dithering: z.enum(["none", "ordered", "old"]).optional() }),
];
export const OPS_DESCRIPTION = [
    "Edit operations, applied in order. Shared fields:",
    "layer = layer name or 'Group/Child' path (optional when the sprite has exactly one image layer);",
    "frame = 1-based frame (default 1); frames/fromFrame/toFrame/tag select several frames where supported;",
    "colors = '#rrggbb', '#rrggbbaa', '#rgb', 'transparent' or a palette index; x/y are pixels from the top-left.",
].join(" ");
export const Op = z.discriminatedUnion("op", Ops);
export const OP_NAMES = Ops.map((o) => o.shape.op.value);
export const ValidationRules = z
    .object({
    maxColors: pos().max(65536).optional(),
    paletteOnly: z.boolean().optional().describe("Every pixel must be a palette color"),
    palette: z.union([z.string(), z.array(Color)]).optional().describe("Preset name or colors every pixel must come from"),
    allowSemiTransparency: z.boolean().optional(),
    strayPixels: z.boolean().optional().describe("Report isolated pixels (default true)"),
    requireTags: z.boolean().optional(),
    width: size().optional(),
    height: size().optional(),
    maxFrames: pos().optional(),
    colorMode: z.enum(["rgb", "gray", "indexed"]).optional(),
    baselineTolerance: int().min(0).max(64).optional(),
})
    .describe("Validation rules");
//# sourceMappingURL=schemas.js.map