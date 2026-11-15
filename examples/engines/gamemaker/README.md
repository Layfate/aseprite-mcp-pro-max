# GameMaker sample

`sprites/` holds one horizontal strip per animation tag (`hero_<tag>_stripN.png`). GameMaker reads the `_stripN` suffix as the frame count when you import a strip.

1. In GameMaker, create a sprite and use **Sprite Editor > Import** on each `hero_*_strip*.png`.
2. Set the origin and playback speed from `sprites/hero.gamemaker.json` (`origin` is in pixels; `fps` is per strip, speed type "frames per second").

GameMaker projects (`.yyp`) are not generated, because their format changes between IDE releases.
