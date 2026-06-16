import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { DEV_PORT, devOrigin } from './dev-port.mjs';

const root = new URL('..', import.meta.url).pathname;

function statFile(rel) {
  const path = join(root, rel);
  if (!existsSync(path)) return { exists: false };
  const s = statSync(path);
  return { exists: true, mtime: Math.floor(s.mtimeMs / 1000), size: s.size };
}

function gitHead() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

console.log('\n=== Mural Dev Doctor ===\n');

const indexRoot = statFile('index.html');
const indexWww = statFile('www/index.html');
const indexLegacy = statFile('smartdisplay/index.html');
const style = statFile('css/style.css');

console.log(`Raiz do projeto: ${root}`);
console.log(`Git HEAD: ${gitHead()}`);
console.log('');

console.log('Arquivos:');
console.log(`  index.html (raiz)       ${indexRoot.exists ? `${indexRoot.size} bytes, mtime=${indexRoot.mtime}` : 'AUSENTE'}`);
console.log(`  www/index.html          ${indexWww.exists ? `${indexWww.size} bytes, mtime=${indexWww.mtime}` : 'ausente'}`);
console.log(`  smartdisplay/index.html ${indexLegacy.exists ? `${indexLegacy.size} bytes (LEGADO — não use)` : 'ausente'}`);
console.log(`  css/style.css           ${style.exists ? `${style.size} bytes, mtime=${style.mtime}` : 'AUSENTE'}`);
console.log('');

if (indexLegacy.exists && indexLegacy.size < 10000) {
  console.log('⚠️  A pasta smartdisplay/ é uma cópia ANTIGA. Não sirva nem edite essa pasta.');
}

if (indexWww.exists && indexRoot.exists && indexWww.mtime < indexRoot.mtime) {
  console.log('ℹ️  www/ está atrás da raiz — normal até rodar npm run dev ou npm run sync:www.');
}

let serverOk = false;
try {
  const res = await fetch(`${devOrigin()}/__mural__/dev-status.json`, { cache: 'no-store' });
  if (res.ok) {
    const data = await res.json();
    serverOk = data.source === 'project-root';
    console.log(serverOk ? `✅ Servidor dev correto em ${devOrigin()}` : '❌ Servidor respondeu mas não é project-root');
    console.log(`   git=${data.git}  build=${data.build}`);
    for (const [name, info] of Object.entries(data.files || {})) {
      console.log(`   ${name}: mtime=${info.mtime} size=${info.size}`);
    }
  }
} catch {
  console.log(`❌ Nenhum servidor em ${devOrigin()}`);
}

console.log('');
if (!serverOk) {
  console.log('Para corrigir:');
  console.log('  1. cd', root);
  console.log('  2. npm install');
  console.log('  3. npm run dev');
  console.log(`  4. Abra ${devOrigin()} (não www/, não smartdisplay/)`);
  console.log('  5. Confirme barra verde no topo: "DEV · project-root"');
} else {
  console.log(`Abra ${devOrigin()} e confirme a barra verde "DEV · project-root" no topo.`);
}
console.log('');
