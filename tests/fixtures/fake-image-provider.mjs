// Test double for ASEPRITE_MCP_IMAGE_PROVIDER=command.
// Usage: node fake-image-provider.mjs <source.png> <output.png> <prompt>
import { copyFileSync, writeFileSync } from "node:fs";
const [src, out, prompt] = process.argv.slice(2);
copyFileSync(src, out);
writeFileSync(out + ".prompt.txt", prompt ?? "");
