# Cocos Creator / Cocos2d-x sample

`assets/hero.plist` + `assets/hero.png` is a TexturePacker-style atlas (plist format 3), which both Cocos Creator and Cocos2d-x import as a SpriteAtlas.

1. Copy `assets/` into your project's `assets/` folder; the editor imports the plist as a SpriteAtlas.
2. `assets/hero.anims.json` lists each tag's SpriteFrame names, loop flag and timing. Build AnimationClips from it with `AnimationClip.createWithSpriteFrames(frames, fps)`, or in the Animation editor.

A Cocos project is not generated, because the editor creates its own project metadata.
