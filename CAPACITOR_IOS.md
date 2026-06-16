# Migração Mural → Capacitor iOS

Este documento descreve a migração do PWA Mural para um app iOS nativo via Capacitor, preservando layout, relógio, clima e slideshow.

## Arquitetura

| Camada | Responsabilidade |
|--------|------------------|
| **Front-end** (`index.html`, `css/`, `js/app.js`) | UI existente — relógio, clima, configurações, slideshow |
| **PhotoLibraryService** (`js/services/photo-library-service.js`) | Acesso à biblioteca iOS, cache de IDs, atualização diária |
| **PhotoShuffleService** (`js/services/photo-shuffle-service.js`) | Fisher-Yates + evita repetir foto ao reembaralhar |
| **SlideshowService** (`js/services/slideshow-service.js`) | Efeitos de transição (fade, slide, zoom, blur, ken burns, aleatório) |
| **PhotoLibraryPlugin** (`plugins/photo-library/`) | Plugin Capacitor em Swift — `PHPhotoLibrary` |

## Plugin nativo (`PhotoLibraryPlugin`)

Métodos expostos ao JavaScript:

- `requestPermission()` — solicita acesso ReadWrite à biblioteca
- `checkPermission()` — verifica autorização existente
- `getAllPhotos()` — retorna metadados de todas as imagens (`id`, `creationDate`, `width`, `height`)
- `getPhoto({ id, maxWidth, maxHeight, quality })` — carrega **uma** foto redimensionada para cache temporário
- `releasePhoto({ id })` — libera arquivo em cache
- `releaseAllPhotos()` — limpa cache de imagens

**Importante:** não usa o plugin Camera. O acesso é direto via Photos Framework.

## Persistência local

No app iOS, via `@capacitor/preferences`:

```json
{
  "mural_photo_ids": ["..."],
  "mural_shuffled_ids": ["..."],
  "mural_last_library_refresh": "2026-06-15",
  "mural_shuffle_enabled": "true"
}
```

Configurações de exibição (`interval`, `transition`, etc.) continuam em `localStorage` (`sd_cfg`) como na PWA.

## Fluxo de fotos

### Primeira execução
1. Solicita permissão da biblioteca
2. `getAllPhotos()` → lista de IDs
3. Embaralha com Fisher-Yates
4. Inicia slideshow / painel de foto do relógio

### Execuções seguintes
1. Carrega IDs persistidos
2. Inicia exibição imediatamente
3. Atualiza biblioteca à meia-noite ou via botão **Atualizar Biblioteca**

### Performance
- Apenas foto atual + próxima ficam em cache
- Imagens redimensionadas (máx. 2048px) em JPEG
- Cache em `Caches/mural-photo-cache/` no iOS

## Pré-requisitos

- macOS com Xcode 15+
- Node.js 20+
- CocoaPods (`sudo gem install cocoapods`)
- Conta Apple Developer (para instalar no iPad)

## Instalação e build

```bash
# 1. Instalar dependências
npm install

# 2. Sincronizar web assets para www/
npm run sync:www

# 3. Adicionar plataforma iOS (primeira vez)
npx cap add ios

# 4. Sincronizar plugin e assets (obrigatório após alterar js/, css/ ou index.html)
npm run cap:sync

# 5. Abrir no Xcode, rebuild e reinstalar no iPad
npm run cap:open
```

**Se as fotos pararem de aparecer no iPad:** rode `npm run cap:sync`, rebuild no Xcode e reinstale. No app, abra Config → **Atualizar Biblioteca** ou confirme permissão de Fotos em Ajustes do iOS.

## Configuração iOS obrigatória

No Xcode, em `App/App/Info.plist`, adicionar:

```xml
<key>NSPhotoLibraryUsageDescription</key>
<string>O Mural exibe suas fotos como um porta-retrato digital.</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>O Mural precisa de acesso à biblioteca de fotos para exibir o slideshow.</string>
```

Em `Signing & Capabilities`, selecione seu Team e Bundle ID (`com.sergiofjr71.mural`).

## Etapas da migração

| Etapa | Status | Descrição |
|-------|--------|-----------|
| 1 | ✅ | Capacitor configurado, app roda no iPad com UI atual |
| 2 | ✅ | Plugin nativo + PhotoLibraryService substituem seleção manual no iOS |
| 3 | ✅ | Efeitos avançados (blur), embaralhamento inteligente |
| 4 | ✅ | Cache de 2 fotos, scan incremental, suporte a milhares de IDs |

## PWA vs Capacitor

| Recurso | PWA (GitHub Pages) | Capacitor iOS |
|---------|-------------------|---------------|
| Fotos | Seleção manual / IndexedDB | Biblioteca completa do iPad |
| Service Worker | Ativo | Desativado no app nativo |
| Clima | Open-Meteo (inalterado) | Open-Meteo (inalterado) |
| Relógio | Inalterado | Inalterado |

## Desenvolvimento web local

**Use sempre o servidor de desenvolvimento do projeto** — não sirva a pasta `www/` no navegador.

```bash
npm install
npm run dev
# Abra: http://localhost:3001
```

Confirme que está na versão certa:
- Barra verde no topo: `DEV · project-root · git … · css m…`
- Canto inferior esquerdo: `mural 20260617-live`
- Diagnóstico: `npm run dev:doctor` ou http://localhost:3001/__mural__/dev-status.json

| Comando | Uso |
|---------|-----|
| `npm run dev` | Desenvolvimento no browser (serve a **raiz**) |
| `npm run sync:www` | Copia raiz → `www/` (só para Capacitor) |
| `npm run cap:sync` | Sincroniza `www/` + plugins para Xcode |

**Não use** `python3 -m http.server` dentro de `www/` — essa pasta é cópia estática para iOS.

No navegador, o plugin nativo não está disponível — o fluxo de pastas/galeria manual permanece.

## Critérios de aceitação

1. ✅ App iOS via Capacitor
2. ✅ Design equivalente à versão atual
3. ✅ Relógio inalterado
4. ✅ Clima com API atual (Open-Meteo)
5. ✅ Todas as fotos da biblioteca utilizáveis
6. ✅ Atualização manual (**Atualizar Biblioteca**)
7. ✅ Atualização automática diária (meia-noite)
8. ✅ Exibição aleatória com reembaralhamento
9. ✅ Escolha de efeito de transição (incluindo blur e aleatório)
10. ✅ Sem backend, banco remoto ou armazenamento externo de imagens
