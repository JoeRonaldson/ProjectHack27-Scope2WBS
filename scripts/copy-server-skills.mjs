import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const sourceDir = path.resolve("server/skills");
const targetDir = path.resolve("dist-server/skills");

await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, { recursive: true });

console.log(`Copied skills assets to ${targetDir}`);
