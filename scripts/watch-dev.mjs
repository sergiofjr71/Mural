import { spawn, execSync } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

function syncWww() {
  execSync('node scripts/sync-www.mjs', { cwd: root, stdio: 'inherit' });
}

function startServer() {
  const child = spawn('python3', ['scripts/dev-server.py'], {
    cwd: root,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  return child;
}

console.log('Mural dev — fonte: raiz do projeto (NÃO use a pasta www/ no navegador)');
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
