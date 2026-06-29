#!/bin/bash
# Instala/verifica CocoaPods no macOS (necessário para cap sync e Xcode)

set -e

if command -v pod >/dev/null 2>&1; then
  echo "✅ CocoaPods já instalado: $(pod --version)"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ CocoaPods só pode ser instalado no macOS."
  echo "   Use um Mac com Xcode para buildar no iPad."
  exit 1
fi

echo "CocoaPods não encontrado. Instalando…"

if command -v brew >/dev/null 2>&1; then
  echo "→ brew install cocoapods"
  brew install cocoapods
elif command -v gem >/dev/null 2>&1; then
  echo "→ sudo gem install cocoapods"
  sudo gem install cocoapods
else
  echo "❌ Instale Homebrew (https://brew.sh) ou Ruby gem, depois:"
  echo "   brew install cocoapods"
  exit 1
fi

echo "✅ CocoaPods instalado: $(pod --version)"
echo ""
echo "Próximo passo:"
echo "  cd $(cd "$(dirname "$0")/.." && pwd)"
echo "  npm run cap:sync"
