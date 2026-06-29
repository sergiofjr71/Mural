import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const iosApp = join(root, 'ios', 'App');

function hasPod() {
  return spawnSync('which', ['pod'], { encoding: 'utf8' }).status === 0;
}

function printInstallHelp() {
  console.error('\n❌ CocoaPods não está instalado (obrigatório para build iOS/iPad).\n');
  console.error('No Mac, instale com UM destes comandos:\n');
  console.error('  brew install cocoapods        ← recomendado');
  console.error('  sudo gem install cocoapods    ← alternativa\n');
  console.error('Guia oficial:');
  console.error('  https://capacitorjs.com/docs/getting-started/environment-setup#homebrew\n');
  console.error('Depois de instalar, rode:\n');
  console.error('  npm run ios:pods');
  console.error('  npm run cap:sync\n');
}

if (!existsSync(iosApp)) {
  console.error('Pasta ios/App não encontrada. Rode primeiro: npx cap add ios');
  process.exit(1);
}

if (!hasPod()) {
  printInstallHelp();
  process.exit(1);
}

console.log('Instalando pods em ios/App…');
const result = spawnSync('pod', ['install'], { cwd: iosApp, stdio: 'inherit' });
if (result.status === 0) {
  console.log('✅ CocoaPods OK');
}
process.exit(result.status ?? 1);
