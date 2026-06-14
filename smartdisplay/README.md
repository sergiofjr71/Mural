# SmartDisplay PWA

App de quadro inteligente para iPad antigo — relógio, clima, slideshow de fotos e câmeras ao vivo.

---

## Como instalar no iPad

### Opção A — hospedagem gratuita via GitHub Pages (recomendado)

1. Crie uma conta gratuita em [github.com](https://github.com)
2. Crie um repositório público chamado `smartdisplay`
3. Faça upload de todos os arquivos desta pasta para o repositório
4. Acesse **Settings → Pages → Source: main branch → Save**
5. Seu app ficará disponível em `https://SEU-USUARIO.github.io/smartdisplay/`
6. No iPad, abra este endereço no Safari
7. Toque em **Compartilhar → Adicionar à tela de início**
8. Pronto — o app abre em tela cheia sem barra do Safari

### Opção B — servidor local na sua rede

Se você tem um computador sempre ligado na mesma rede Wi-Fi:

```bash
# Na pasta do projeto, execute:
python3 -m http.server 8080
# Acesse no iPad: http://IP-DO-SEU-COMPUTADOR:8080
```

**Atenção:** Service Worker (modo offline) só funciona via HTTPS ou localhost. Para uso local, use a Opção A.

---

## Configuração inicial

1. Abra o app e toque em **⚙️ Config** na barra inferior
2. **Clima:** informe sua cidade e cole a chave da API
   - Chave gratuita: [openweathermap.org/api](https://openweathermap.org/api) → plano "Free"
   - Limite gratuito: 60 chamadas/minuto — mais do que suficiente
3. **Fotos:** toque em "Escolher arquivos" e selecione as fotos da galeria
4. **Câmeras:** adicione URLs de streams públicos (veja sugestões abaixo)
5. Feche as configurações com o ✕ — as mudanças são salvas automaticamente

---

## Sugestões de câmeras públicas

### São Paulo
- CET-SP fornece imagens de câmeras de trânsito em formato JPG estático
  - Acesse [cetsp.com.br](https://www.cetsp.com.br) e copie a URL das câmeras
- Linha Amarela do Metrô tem câmeras públicas

### Câmeras internacionais (exemplos de uso)
- [EarthCam](https://www.earthcam.com) — câmeras ao redor do mundo
- Busque por "webcam ao vivo [cidade]" para encontrar streams públicos

### Formatos suportados
| Formato | Compatibilidade |
|---------|----------------|
| Imagem JPG estática (atualiza a cada 3s) | ✅ Excelente |
| MJPEG stream | ✅ Bom |
| Página web com câmera incorporada | ✅ via iframe |
| HLS (.m3u8) | ⚠️ Depende do browser |
| RTSP | ❌ Não suportado em browsers |

---

## Estrutura do projeto

```
smartdisplay/
├── index.html       — estrutura do app
├── manifest.json    — configuração PWA
├── sw.js            — service worker (cache offline)
├── css/
│   └── style.css    — todos os estilos
├── js/
│   └── app.js       — lógica completa
└── icons/
    ├── icon-180.png — ícone para iOS
    ├── icon-192.png — ícone Android/PWA
    └── icon-512.png — ícone splash screen
```

---

## Recursos

- **Relógio** com segundos, data completa em português
- **Clima** via OpenWeatherMap com ícone, temperatura, descrição e umidade
- **Slideshow** com transição suave, interval configurável, fotos salvas localmente (IndexedDB)
- **Câmeras** ao vivo em grade, toque para expandir
- **Modo noturno** automático por horário com dimmer
- **Wake Lock** — mantém a tela ligada sem tocar
- **Offline** — após primeira carga, funciona sem internet (exceto clima e câmeras)
- **Instalável** — aparece na tela de início como app nativo

---

## Dicas para iPad como display fixo

- Deixe o brilho do iPad em torno de 30-40% para poupar a bateria
- Ative o carregador permanente (iPad de estante não precisa de bateria saudável)
- No iOS: Configurações → Tela e Brilho → Nunca (para não desligar a tela — o Wake Lock do app cuida disso)
- Coloque em modo avião se não quiser notificações, mas mantenha o Wi-Fi ativo
