import { spawn, execSync } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { DEV_PORT, devOrigin } from './dev-port.mjs';

const root = new URL('..', import.meta.url).pathname;

function syncWww() {
  execSync('node scripts/sync-www.mjs', { cwd: root, stdio: 'inherit' });
}

function startServer() {
  const child = spawn('python3', ['scripts/dev-server.py'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PORT: DEV_PORT },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  return child;
}

console.log(`Mural dev → ${devOrigin()} (fonte: raiz do projeto, NÃO use www/ no navegador)`);
syncWww();
startServer();

const watchTargets = [
  join(root, 'index.html'),
  join(root, 'css'),
  join(root, 'js'),
  join(root, 'manifest.json'),
];

for (const target of watchTargets) {
  watch(target, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    console.log(`[watch] alterado: ${filename}`);
    syncWww();
  });
}
