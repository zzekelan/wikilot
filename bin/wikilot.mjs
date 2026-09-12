#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const vitePackagePath = require.resolve("vite/package.json");
const vitePackage = JSON.parse(readFileSync(vitePackagePath, "utf8"));
const viteBin = resolve(dirname(vitePackagePath), vitePackage.bin.vite);

// Resolve the app from its installed location, even when launched elsewhere.
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
process.argv = [process.execPath, viteBin, "--open", ...process.argv.slice(2)];
await import(pathToFileURL(viteBin).href);
