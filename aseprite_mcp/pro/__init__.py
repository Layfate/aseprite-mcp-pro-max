"""Aseprite MCP Pro Max: the quality tool set (critique, shading, palettes, animation polish, export).

Importing this package registers every Pro Max tool with the shared server.
"""
from . import critique      # noqa: F401  critique_sprite, view_quality, view_tiled
from . import fixers        # noqa: F401  cleanup_lines, remove_stray_pixels, merge_similar_colors, outline_pro, anti_alias_edges, polish_sprite
from . import checkpoints   # noqa: F401  save/list/restore_checkpoint, compare_versions
from . import shading       # noqa: F401  auto_shade, generate_normal_map
from . import palettes      # noqa: F401  color_ramp_pro, generate_palette_pro, analyze_palette, palette_from_image, quantize_pro
from . import convert       # noqa: F401  image_to_pixel_art, rotsprite_rotate, offset_wrap
from . import anim          # noqa: F401  squash_stretch, add_smear, hit_flash, generate_particles, secondary_motion, critique_animation
from . import exports       # noqa: F401  export_upscaled, export_showcase, export_spritesheet_pro
from . import guide         # noqa: F401  pro_art_guide
