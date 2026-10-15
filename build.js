'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const output = path.join(root, 'dist');
const staticExtensions = new Set([
  '.css',
  '.html',
  '.jpeg',
  '.jpg',
  '.js',
  '.mp4',
  '.png',
  '.svg',
  '.webp',
]);
const serverOnlyFiles = new Set(['build.js', 'server.js', 'supabase-config.js']);

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isFile() || serverOnlyFiles.has(entry.name)) continue;
  if (!staticExtensions.has(path.extname(entry.name).toLowerCase())) continue;
  fs.copyFileSync(path.join(root, entry.name), path.join(output, entry.name));
}

console.log('Static site files copied to dist/.');
