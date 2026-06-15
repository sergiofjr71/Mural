import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const www = join(root, 'www');

const copyItems = [
  'index.html',
  'manifest.json',
  'css',
  'js',
  'fonts',
  'icons',
];

if (existsSync(www)) {
  rmSync(www, { recursive: true, force: true });
}
mkdirSync(www, { recursive: true });

for (const item of copyItems) {
  const src = join(root, item);
  if (!existsSync(src)) continue;
  cpSync(src, join(www, item), { recursive: true });
}

console.log('www/ sincronizado a partir da raiz do projeto.');
