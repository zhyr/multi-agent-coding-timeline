#!/usr/bin/env node
/** Copy non-TS runtime assets (the web UI) into dist after tsc build. */
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src', 'web', 'ui.html');
const destDir = path.join(root, 'dist', 'web');
const dest = path.join(destDir, 'ui.html');

await mkdir(destDir, { recursive: true });
await copyFile(src, dest);
console.log(`copied ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
