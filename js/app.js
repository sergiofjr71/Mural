/* ============================================
   SMARTDISPLAY PWA — lógica principal
   ============================================ */

'use strict';

// ─── ESTADO GLOBAL ───────────────────────────
const State = {
  mode: 'clock',
  photos: [],        // [{ name, url }] — usado quando não há pasta vinculada
  folderHandle: null,
  folderName: '',
  sessionFolderFiles: [],
  sessionFolderName: '',
  folderPlaylist: [],
  folderPlaylistDate: '',
  cameras: [],       // [{name, url}]
  slideIndex: 0,
  slideTimer: null,
  slideActive: 'a',
  weatherData: null,
  weatherTimer: null,
  wakeLock: null,
  cfg: {
    city: 'São Paulo',
    lat: null,
    lon: null,
    apiKey: '',
    interval: 10000,
    transition: 'fade',
    format24h: true,
    nightAuto: true,
    nightStart: '22:00',
    nightEnd: '07:00',
    wakelock: true,
  }
};

// ─── PERSISTÊNCIA ────────────────────────────
function saveConfig() {
  try {
    localStorage.setItem('sd_cfg', JSON.stringify(State.cfg));
    localStorage.setItem('sd_cameras', JSON.stringify(State.cameras));
    localStorage.setItem('sd_photos', JSON.stringify(State.photos));
  } catch(e) { console.warn('saveConfig:', e); }
}

function loadConfig() {
  try {
    const c = localStorage.getItem('sd_cfg');
    if (c) Object.assign(State.cfg, JSON.parse(c));
    const cams = localStorage.getItem('sd_cameras');
    if (cams) State.cameras = JSON.parse(cams);
    const photos = localStorage.getItem('sd_photos');
    if (photos) State.photos = parsePhotoLinks(JSON.parse(photos));
  } catch(e) { console.warn('loadConfig:', e); }
}

// ─── FOTOS (pasta vinculada ou URLs) ─────────
const IMAGE_FILE_RE = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i;
const PHOTO_DB_NAME = 'SmartDisplay';
const PHOTO_DB_VERSION = 2;
let photoDbPromise = null;
let clockPhotoObjectUrl = null;
let slidePhotoObjectUrls = { a: null, b: null };
let midnightRescanTimer = null;
let lastMidnightCheckDate = '';
let folderPickInProgress = false;
const previewObjectUrls = new Set();

function openPhotoDB() {
  if (!photoDbPromise) {
    photoDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(PHOTO_DB_NAME, PHOTO_DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('folder')) {
          db.createObjectStore('folder');
        }
        if (db.objectStoreNames.contains('photos')) {
          db.deleteObjectStore('photos');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return photoDbPromise;
}

function idbRequestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveFolderHandle(handle, name) {
  const db = await openPhotoDB();
  const tx = db.transaction('folder', 'readwrite');
  tx.objectStore('folder').put({ handle, name }, 'primary');
  await idbRequestToPromise(tx);
  State.folderHandle = handle;
  State.folderName = name;
  try {
    localStorage.setItem('sd_folder_name', name);
  } catch {}
}

async function loadStoredFolderHandle() {
  try {
    const db = await openPhotoDB();
    const record = await idbRequestToPromise(db.transaction('folder', 'readonly').objectStore('folder').get('primary'));
    if (!record?.handle) return false;

    const permission = await record.handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted') {
      const requested = await record.handle.requestPermission({ mode: 'read' });
      if (requested !== 'granted') return false;
    }

    State.folderHandle = record.handle;
    State.folderName = record.name || localStorage.getItem('sd_folder_name') || 'Pasta';
    return true;
  } catch (e) {
    console.warn('loadStoredFolderHandle:', e);
    return false;
  }
}

async function clearStoredFolderHandle() {
  State.folderHandle = null;
  State.folderName = '';
  State.sessionFolderFiles = [];
  State.sessionFolderName = '';
  clearFolderPlaylist();
  try {
    localStorage.removeItem('sd_folder_name');
    const db = await openPhotoDB();
    const tx = db.transaction('folder', 'readwrite');
    tx.objectStore('folder').delete('primary');
    await idbRequestToPromise(tx);
  } catch (e) {
    console.warn('clearStoredFolderHandle:', e);
  }
}

function isImageFileName(name) {
  return IMAGE_FILE_RE.test(name || '');
}

function revokeObjectUrl(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

function revokeClockPhotoObjectUrl() {
  if (clockPhotoObjectUrl) {
    revokeObjectUrl(clockPhotoObjectUrl);
    clockPhotoObjectUrl = null;
  }
}

function revokePreviewObjectUrls() {
  previewObjectUrls.forEach((url) => revokeObjectUrl(url));
  previewObjectUrls.clear();
}

async function collectImageEntries(dirHandle, basePath = '') {
  const entries = [];
  for await (const entry of dirHandle.values()) {
    const entryPath = `${basePath}${entry.name}`;
    if (entry.kind === 'file' && isImageFileName(entry.name)) {
      entries.push({ path: entryPath, getFile: () => entry.getFile() });
    } else if (entry.kind === 'directory') {
      entries.push(...await collectImageEntries(entry, `${entryPath}/`));
    }
  }
  return entries;
}

async function getFolderImageEntries() {
  if (State.sessionFolderFiles.length) {
    return State.sessionFolderFiles
      .filter((file) => isImageFileName(file.name))
      .map((file) => ({
        path: file.webkitRelativePath || file.name,
        getFile: async () => file,
      }));
  }

  if (!State.folderHandle) return [];
  const entries = await collectImageEntries(State.folderHandle);
  entries.sort((a, b) => a.path.localeCompare(b.path, 'pt-BR', { numeric: true }));
  return entries;
}

async function listFolderImageEntries() {
  const entries = await getFolderImageEntries();
  return entries.map((entry) => ({
    kind: 'file',
    name: entry.path.split('/').pop() || entry.path,
    path: entry.path,
    getFile: entry.getFile,
  }));
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shuffleArray(items) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function saveFolderPlaylist() {
  try {
    localStorage.setItem('sd_folder_playlist', JSON.stringify({
      date: State.folderPlaylistDate,
      names: State.folderPlaylist,
    }));
  } catch (e) {
    console.warn('saveFolderPlaylist:', e);
  }
}

function loadFolderPlaylist() {
  try {
    const raw = localStorage.getItem('sd_folder_playlist');
    if (!raw) return;
    const data = JSON.parse(raw);
    State.folderPlaylistDate = typeof data.date === 'string' ? data.date : '';
    State.folderPlaylist = Array.isArray(data.names) ? data.names : [];
  } catch (e) {
    console.warn('loadFolderPlaylist:', e);
  }
}

function clearFolderPlaylist() {
  State.folderPlaylist = [];
  State.folderPlaylistDate = '';
  try {
    localStorage.removeItem('sd_folder_playlist');
  } catch {}
}

async function syncFolderPlaylistWithDisk() {
  const entries = await getFolderImageEntries();
  const onDisk = new Set(entries.map((entry) => entry.path));
  const kept = State.folderPlaylist.filter((path) => onDisk.has(path));
  const known = new Set(kept);
  const added = entries.map((entry) => entry.path).filter((path) => !known.has(path));
  if (added.length || kept.length !== State.folderPlaylist.length) {
    State.folderPlaylist = [...kept, ...shuffleArray(added)];
    saveFolderPlaylist();
  }
}

async function refreshFolderPlaylist({ notify = true, resetIndex = true } = {}) {
  if (!usesFolderSource()) {
    clearFolderPlaylist();
    return 0;
  }

  const entries = await getFolderImageEntries();
  const paths = entries.map((entry) => entry.path);
  State.folderPlaylist = shuffleArray(paths);
  State.folderPlaylistDate = getTodayKey();
  saveFolderPlaylist();

  if (resetIndex) {
    clockPhotoIndex = 0;
    State.slideIndex = 0;
  }

  if (notify) {
    const label = State.folderName ? `Pasta "${State.folderName}": ` : '';
    showToast(`${label}${paths.length} foto${paths.length === 1 ? '' : 's'} em ordem aleatória`);
  }

  return paths.length;
}

async function ensureFolderPlaylistForToday() {
  if (!usesFolderSource()) return;

  const today = getTodayKey();
  if (State.folderPlaylistDate !== today || !State.folderPlaylist.length) {
    await refreshFolderPlaylist({ notify: false, resetIndex: false });
    return;
  }

  await syncFolderPlaylistWithDisk();
}

async function getFolderPlaylistNames() {
  await ensureFolderPlaylistForToday();
  return [...State.folderPlaylist];
}

async function readFolderImageAtIndex(index, retry = 0) {
  const names = await getFolderPlaylistNames();
  if (!names.length) return { src: null, total: 0, name: '' };

  const path = names[index % names.length];
  const entries = await getFolderImageEntries();
  const match = entries.find((entry) => entry.path === path);
  if (!match) {
    if (retry > 1) return { src: null, total: names.length, name: '' };
    await syncFolderPlaylistWithDisk();
    return readFolderImageAtIndex(index, retry + 1);
  }

  const file = await match.getFile();
  return {
    src: URL.createObjectURL(file),
    total: names.length,
    name: match.path.split('/').pop() || match.path,
  };
}

function usesFolderSource() {
  return Boolean(State.folderHandle) || State.sessionFolderFiles.length > 0;
}

function supportsDirectoryPicker() {
  return (
    'showDirectoryPicker' in window &&
    window.isSecureContext &&
    window.self === window.top
  );
}

async function bindFolderHandle(dir) {
  State.sessionFolderFiles = [];
  State.sessionFolderName = '';
  await saveFolderHandle(dir, dir.name);
  await refreshFolderPlaylist({ notify: true, resetIndex: true });
  syncPhotoFolderInput();
  renderFolderInfo();
  await refreshPhotoViews();
}

function openFolderPicker() {
  if (supportsDirectoryPicker()) {
    void pickPhotoFolderNative();
    return;
  }
  document.getElementById('cfg-photo-folder-fallback')?.click();
}

async function pickPhotoFolderNative() {
  if (folderPickInProgress) return;
  folderPickInProgress = true;
  try {
    showToast('Navegue até a pasta e clique em Abrir');
    const dir = await window.showDirectoryPicker({ mode: 'read' });
    await bindFolderHandle(dir);
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.warn('showDirectoryPicker:', e);
      showToast('Não foi possível vincular a pasta');
    }
  } finally {
    folderPickInProgress = false;
  }
}

async function handleFolderFallbackInput(input) {
  if (folderPickInProgress) return;
  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length) return;

  folderPickInProgress = true;
  try {
    const ok = await applySessionFolder(files);
    if (ok && !supportsDirectoryPicker()) {
      showToast('Pasta vinculada nesta sessão — use Chrome/Edge em https para manter após fechar');
    }
  } finally {
    folderPickInProgress = false;
  }
}

function setupFolderPickerUi() {
  const nativeBtn = document.getElementById('btn-choose-photo-folder');
  const fallbackLabel = document.getElementById('btn-choose-photo-folder-fallback');
  const input = document.getElementById('cfg-photo-folder-fallback');
  if (!nativeBtn || !fallbackLabel || !input) return;

  if (supportsDirectoryPicker()) {
    nativeBtn.hidden = false;
    fallbackLabel.hidden = true;
  } else {
    nativeBtn.hidden = true;
    fallbackLabel.hidden = false;
  }

  input.addEventListener('change', () => {
    void handleFolderFallbackInput(input);
  });
}

async function applySessionFolder(files) {
  const imageFiles = files
    .filter((file) => isImageFileName(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));

  if (!imageFiles.length) {
    showToast('Nenhuma imagem encontrada na pasta (jpg, png, gif, webp, heic…)');
    return false;
  }

  const root = imageFiles[0].webkitRelativePath?.split('/')[0] || 'Pasta';
  State.folderHandle = null;
  State.sessionFolderFiles = imageFiles;
  State.sessionFolderName = root;
  State.folderName = root;

  try {
    localStorage.setItem('sd_folder_name', root);
    const db = await openPhotoDB();
    const tx = db.transaction('folder', 'readwrite');
    tx.objectStore('folder').delete('primary');
    await idbRequestToPromise(tx);
  } catch {}

  await refreshFolderPlaylist({ notify: true, resetIndex: true });
  syncPhotoFolderInput();
  renderFolderInfo();
  await refreshPhotoViews();
  return true;
}

async function getPhotoSourceCount() {
  if (usesFolderSource()) {
    await ensureFolderPlaylistForToday();
    return State.folderPlaylist.length;
  }
  return State.photos.length;
}

async function hasPhotoSources() {
  return (await getPhotoSourceCount()) > 0;
}

async function resolvePhotoAtIndex(index) {
  if (usesFolderSource()) {
    const { src, total } = await readFolderImageAtIndex(index);
    return { src, total };
  }

  if (!State.photos.length) return { src: null, total: 0 };
  const photo = State.photos[index % State.photos.length];
  return { src: photo.url, total: State.photos.length };
}

function scheduleMidnightFolderRescan() {
  if (midnightRescanTimer) clearTimeout(midnightRescanTimer);

  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const delay = Math.max(1000, next.getTime() - now.getTime());

  midnightRescanTimer = setTimeout(() => {
    void (async () => {
      if (usesFolderSource()) {
        await refreshFolderPlaylist({ notify: true, resetIndex: true });
        await refreshPhotoViews();
      }
      scheduleMidnightFolderRescan();
    })();
  }, delay);
}

function checkMidnightPlaylistRefresh() {
  const today = getTodayKey();
  if (!lastMidnightCheckDate) {
    lastMidnightCheckDate = today;
    return;
  }
  if (today === lastMidnightCheckDate) return;

  lastMidnightCheckDate = today;
  if (usesFolderSource() && State.folderPlaylistDate !== today) {
    void refreshFolderPlaylist({ notify: false, resetIndex: true }).then(() => refreshPhotoViews());
  }
}

function syncPhotoFolderInput() {
  const input = document.getElementById('cfg-photo-url');
  if (!input) return;
  input.value = usesFolderSource() ? State.folderName : '';
}

function renderFolderInfo() {
  const el = document.getElementById('folder-source-info');
  if (!el) return;

  syncPhotoFolderInput();

  if (!usesFolderSource()) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <div class="folder-source-meta">
      <small id="folder-photo-count" style="color:var(--text-dim)">Carregando...</small>
      <div class="folder-source-actions">
        <button type="button" class="btn-action btn-action--compact" id="btn-refresh-folder-photos">Releitura das fotos</button>
        <button type="button" id="btn-clear-folder" title="Desvincular pasta">✕</button>
      </div>
    </div>
  `;

  document.getElementById('btn-refresh-folder-photos')?.addEventListener('click', () => {
    void (async () => {
      await refreshFolderPlaylist({ notify: true, resetIndex: true });
      await refreshPhotoViews();
    })();
  });

  document.getElementById('btn-clear-folder')?.addEventListener('click', async () => {
    if (!confirm('Desvincular esta pasta?')) return;
    await clearStoredFolderHandle();
    revokeClockPhotoObjectUrl();
    revokePreviewObjectUrls();
    syncPhotoFolderInput();
    renderFolderInfo();
    await refreshPhotoViews();
    showToast('Pasta desvinculada');
  });
}

async function renderFolderPhotoCount() {
  const countEl = document.getElementById('folder-photo-count');
  if (!countEl || !usesFolderSource()) return;
  await ensureFolderPlaylistForToday();
  const count = State.folderPlaylist.length;
  const shuffledAt = State.folderPlaylistDate
    ? `Lista aleatória de ${State.folderPlaylistDate}`
    : 'Lista ainda não gerada';
  countEl.textContent = `${count} foto${count === 1 ? '' : 's'} — ${shuffledAt}. Releitura automática à meia-noite.`;
}

function isDisplayablePhotoUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

function normalizePhotoEntry(entry) {
  if (typeof entry === 'string') {
    const url = entry.trim();
    return isDisplayablePhotoUrl(url) ? { name: '', url } : null;
  }
  if (entry && typeof entry.url === 'string') {
    const url = entry.url.trim();
    if (!isDisplayablePhotoUrl(url)) return null;
    return { name: (entry.name || '').trim(), url };
  }
  return null;
}

function parsePhotoLinks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizePhotoEntry).filter(Boolean);
}

function savePhotoLinks() {
  try {
    localStorage.setItem('sd_photos', JSON.stringify(State.photos));
  } catch (e) {
    console.warn('savePhotoLinks:', e);
  }
}

function getDisplayablePhotos() {
  return State.photos.map((photo) => photo.url);
}

async function clearLegacyPhotoStorage() {
  // Mantido para compatibilidade: o upgrade do IndexedDB remove o store antigo de fotos.
  try {
    await openPhotoDB();
  } catch {}
}

function addPhotoLink(name, url) {
  const trimmedUrl = url.trim();
  if (!isDisplayablePhotoUrl(trimmedUrl)) {
    return { ok: false, message: 'Informe uma URL HTTP ou HTTPS válida' };
  }
  if (State.photos.some((photo) => photo.url === trimmedUrl)) {
    return { ok: false, message: 'Esta URL já foi adicionada' };
  }
  State.photos.push({ name: name.trim(), url: trimmedUrl });
  savePhotoLinks();
  return { ok: true };
}

function removePhotoLink(index) {
  State.photos.splice(index, 1);
  savePhotoLinks();
}

function renderPhotosList() {
  const list = document.getElementById('photos-list');
  if (!list) return;
  list.innerHTML = '';

  if (usesFolderSource()) {
    list.innerHTML = '<p class="settings-hint">Usando pasta vinculada. URLs abaixo são ignoradas enquanto a pasta estiver ativa.</p>';
    return;
  }

  if (!State.photos.length) {
    list.innerHTML = '<p class="settings-hint">Nenhuma URL adicionada.</p>';
    return;
  }

  State.photos.forEach((photo, index) => {
    const row = document.createElement('div');
    row.className = 'cam-list-item';
    const label = photo.name || `Foto ${index + 1}`;
    row.innerHTML = `<span><strong>${label}</strong> — <small style="color:var(--text-dim)">${photo.url.substring(0, 48)}${photo.url.length > 48 ? '…' : ''}</small></span>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '✕';
    btn.title = 'Remover foto';
    btn.addEventListener('click', () => {
      removePhotoLink(index);
      void refreshPhotoViews();
    });
    row.appendChild(btn);
    list.appendChild(row);
  });
}

async function renderPhotosPreviews() {
  const preview = document.getElementById('photos-preview');
  if (!preview) return;
  preview.innerHTML = '';
  revokePreviewObjectUrls();

  if (!usesFolderSource()) {
    preview.innerHTML = '<p class="settings-hint">Vincule uma pasta para exibir fotos.</p>';
    return;
  }

  await ensureFolderPlaylistForToday();
  preview.innerHTML = `<p class="settings-hint">${State.folderPlaylist.length} foto${State.folderPlaylist.length === 1 ? '' : 's'} na ordem aleatória atual. Nada é importado.</p>`;
}

async function refreshPhotoViews() {
  renderFolderInfo();
  await renderFolderPhotoCount();
  await renderPhotosPreviews();
  if (State.mode === 'slideshow') await startSlideshow();
  await startClockPhoto();
}

// ─── RELÓGIO ─────────────────────────────────
const DIAS = ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

function pad(n) { return String(n).padStart(2, '0'); }

function formatTime(date) {
  const h = pad(State.cfg.format24h ? date.getHours() : (date.getHours() % 12 || 12));
  const m = pad(date.getMinutes());
  return `${h}:${m}`;
}

function formatDate(date) {
  return `${DIAS[date.getDay()]}, ${date.getDate()} de ${MESES[date.getMonth()]}`;
}

function tickClock() {
  const now = new Date();
  const timeStr = formatTime(now);
  const dateStr = formatDate(now);
  const secStr = pad(now.getSeconds());

  // modo relógio
  const el = document.getElementById('clock-time');
  if (el) el.textContent = timeStr;
  const elSec = document.getElementById('clock-seconds');
  if (elSec) elSec.textContent = secStr;
  const elDate = document.getElementById('clock-date');
  if (elDate) elDate.textContent = dateStr;

  // slideshow overlay
  const sc = document.getElementById('slide-clock');
  if (sc) sc.textContent = timeStr;
  const sd = document.getElementById('slide-date');
  if (sd) sd.textContent = dateStr;

  // cameras bar
  const ct = document.getElementById('cam-time');
  if (ct) ct.textContent = timeStr;

  // modo noturno
  checkNightMode(now);
}

function checkNightMode(now) {
  if (!State.cfg.nightAuto) { document.body.classList.remove('night-mode'); return; }
  const hm = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = State.cfg.nightStart.split(':').map(Number);
  const [eh, em] = State.cfg.nightEnd.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const isNight = start > end
    ? (hm >= start || hm < end)
    : (hm >= start && hm < end);
  document.body.classList.toggle('night-mode', isNight);
}

// ─── CLIMA ───────────────────────────────────
const WMO_ICONS = {
  0:'☀️', 1:'🌤', 2:'⛅', 3:'☁️',
  45:'🌫', 48:'🌫',
  51:'🌦', 53:'🌦', 55:'🌧',
  61:'🌧', 63:'🌧', 65:'🌧',
  71:'❄️', 73:'❄️', 75:'❄️', 77:'❄️',
  80:'🌦', 81:'🌧', 82:'⛈',
  85:'❄️', 86:'❄️',
  95:'⛈', 96:'⛈', 99:'⛈',
};
const WMO_DESC = {
  0:'Céu limpo', 1:'Predominante limpo', 2:'Parcialmente nublado', 3:'Nublado',
  45:'Névoa', 48:'Névoa com geada',
  51:'Chuvisco fraco', 53:'Chuvisco', 55:'Chuvisco intenso',
  61:'Chuva fraca', 63:'Chuva', 65:'Chuva intensa',
  71:'Neve fraca', 73:'Neve', 75:'Neve intensa', 77:'Granizo',
  80:'Pancadas fracas', 81:'Pancadas', 82:'Pancadas intensas',
  85:'Neve em pancadas', 86:'Neve intensa',
  95:'Trovoada', 96:'Trovoada c/ granizo', 99:'Trovoada intensa',
};
const DIAS_CURTOS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

async function geocodeCity(cityName) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'pt-BR' } });
  const data = await res.json();
  if (!data.length) throw new Error('cidade não encontrada');
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function fetchWeather() {
  const { city, apiKey } = State.cfg;
  if (!city) {
    updateWeatherUI({ icon:'🌡', temp:'--°', city:'(sem cidade)', desc:'selecione uma cidade', feels:'--°', humidity:'--%' });
    return;
  }

  try {
    let lat = State.cfg.lat;
    let lon = State.cfg.lon;

    // Se tem API key OpenWeatherMap, usa ele para obter lat/lon e dados
    if (apiKey) {
      const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=metric&lang=pt_br&appid=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const d = await res.json();
      lat = d.coord.lat; lon = d.coord.lon;
      State.cfg.lat = lat; State.cfg.lon = lon;
      saveConfig();
    }

    // Se ainda sem coordenadas, geocodifica via Nominatim
    if (!lat || !lon) {
      const coords = await geocodeCity(city);
      lat = coords.lat; lon = coords.lon;
      State.cfg.lat = lat; State.cfg.lon = lon;
      saveConfig();
    }

    // Busca dados no Open-Meteo (sempre, com ou sem API key)
    const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
      `&hourly=temperature_2m,weather_code` +
      `&timezone=auto&forecast_days=5`;
    const omRes = await fetch(omUrl);
    if (!omRes.ok) throw new Error('open-meteo ' + omRes.status);
    const om = await omRes.json();

    const cur = om.current;
    const code = cur.weather_code;
    State.weatherData = {
      icon: WMO_ICONS[code] || '🌡',
      temp: Math.round(cur.temperature_2m) + '°',
      feels: Math.round(cur.apparent_temperature) + '°',
      city: city.split(',')[0],
      desc: WMO_DESC[code] || 'Clima',
      humidity: cur.relative_humidity_2m + '%',
      daily: om.daily,
      hourly: om.hourly,
      hourlyOffset: om.current.time,
    };
    updateWeatherUI(State.weatherData);
  } catch(e) {
    console.warn('weather error:', e);
    updateWeatherUI({ icon:'⚠️', temp:'--°', city: city.split(',')[0], desc:'erro ao buscar clima', feels:'--°', humidity:'--%' });
  }
}

function updateWeatherUI(w) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('weather-icon-big', w.icon);
  set('weather-temp-big', w.temp);
  set('weather-city-name', w.city);
  set('weather-desc-main', w.desc);
  set('weather-feels', w.feels || '--°');
  set('weather-humidity', w.humidity || '--%');
  set('slide-weather', `${w.icon} ${w.temp}`);
  set('cam-weather', `${w.icon} ${w.temp}`);

  renderDailyForecast(w.daily);
  renderHourlyForecast(w.hourly, w.hourlyOffset);
  updateCityNav();
  // re-sincroniza após o clima renderizar (layout muda de tamanho)
  requestAnimationFrame(syncPhotoColHeight);
}

function renderDailyForecast(daily) {
  const el = document.getElementById('weather-daily');
  if (!el || !daily) return;
  el.innerHTML = '';
  const days = daily.time.slice(0, 5);
  days.forEach((dateStr, i) => {
    const d = new Date(dateStr + 'T12:00:00');
    const code = daily.weather_code[i];
    const max = Math.round(daily.temperature_2m_max[i]);
    const min = Math.round(daily.temperature_2m_min[i]);
    const col = document.createElement('div');
    col.className = 'forecast-col' + (i === 0 ? ' forecast-today' : '');
    col.innerHTML = `
      <span class="fc-day">${i === 0 ? 'Hoje' : DIAS_CURTOS[d.getDay()]}</span>
      <span class="fc-icon">${WMO_ICONS[code] || '🌡'}</span>
      <span class="fc-max">${max}°</span>
      <span class="fc-min">${min}°</span>
    `;
    el.appendChild(col);
  });
}

function renderHourlyForecast(hourly, currentTime) {
  const el = document.getElementById('weather-hourly');
  if (!el || !hourly) return;
  el.innerHTML = '';
  const TARGET_HOURS = [15, 18, 21, 0, 3, 6, 9, 12];
  const slots = TARGET_HOURS.map(h => hourly.time.findIndex(t => {
    const th = parseInt(t.substring(11, 13));
    return th === h;
  })).filter(i => i >= 0);
  slots.forEach((idx) => {
    const timeStr = hourly.time[idx] || '';
    const h = timeStr.substring(11, 16);
    const code = hourly.weather_code[idx];
    const temp = Math.round(hourly.temperature_2m[idx]);
    const col = document.createElement('div');
    col.className = 'forecast-col';
    col.innerHTML = `
      <span class="fc-day">${h}</span>
      <span class="fc-icon">${WMO_ICONS[code] || '🌡'}</span>
      <span class="fc-max">${temp}°</span>
    `;
    el.appendChild(col);
  });
}

function startWeatherTimer() {
  clearInterval(State.weatherTimer);
  fetchWeather();
  State.weatherTimer = setInterval(fetchWeather, 10 * 60 * 1000);
}

// ─── MINI FOTO (painel direito do relógio) ───
let clockPhotoIndex = 0;
let clockPhotoTimer = null;

async function startClockPhoto() {
  clearInterval(clockPhotoTimer);
  await updateClockPhoto();
  const count = await getPhotoSourceCount();
  if (count > 1) {
    clockPhotoTimer = setInterval(() => {
      void navigateClockPhoto(1, false);
    }, State.cfg.interval);
  }
}

async function navigateClockPhoto(delta, restartTimer = true) {
  const count = await getPhotoSourceCount();
  if (count <= 1) return;

  clockPhotoIndex = (clockPhotoIndex + delta + count) % count;
  await updateClockPhoto();

  if (restartTimer) {
    await startClockPhoto();
  }
}

async function updateClockPhotoNav() {
  const enabled = (await getPhotoSourceCount()) > 1;
  const prev = document.getElementById('clock-photo-prev');
  const next = document.getElementById('clock-photo-next');
  if (prev) {
    prev.disabled = !enabled;
    prev.classList.remove('is-active');
  }
  if (next) {
    next.disabled = !enabled;
    next.classList.remove('is-active');
  }
}

function bindClockPhotoNavHighlight() {
  document.querySelectorAll('.clock-photo-nav').forEach((btn) => {
    const activate = () => {
      if (!btn.disabled) btn.classList.add('is-active');
    };
    const deactivate = () => btn.classList.remove('is-active');

    btn.addEventListener('mouseenter', activate);
    btn.addEventListener('mouseleave', deactivate);
    btn.addEventListener('focus', activate);
    btn.addEventListener('blur', deactivate);
    btn.addEventListener('touchstart', activate, { passive: true });
    btn.addEventListener('touchend', deactivate);
  });
}

async function updateClockPhoto() {
  const img = document.getElementById('clock-photo-img');
  const empty = document.getElementById('clock-photo-empty');
  if (!img) return;

  const count = await getPhotoSourceCount();
  if (!count) {
    revokeClockPhotoObjectUrl();
    img.removeAttribute('src');
    img.style.opacity = '0';
    if (empty) empty.style.display = 'flex';
    await updateClockPhotoNav();
    return;
  }

  if (clockPhotoIndex >= count) clockPhotoIndex = 0;
  const { src } = await resolvePhotoAtIndex(clockPhotoIndex % count);
  if (!src) {
    revokeClockPhotoObjectUrl();
    img.removeAttribute('src');
    img.style.opacity = '0';
    if (empty) empty.style.display = 'flex';
    await updateClockPhotoNav();
    return;
  }

  if (empty) empty.style.display = 'none';

  revokeClockPhotoObjectUrl();
  if (src.startsWith('blob:')) {
    clockPhotoObjectUrl = src;
  }

  img.style.opacity = '0';
  const loader = new Image();
  loader.onload = () => {
    img.src = src;
    img.style.opacity = '1';
  };
  loader.onerror = () => {
    console.warn('clock photo failed to load');
    revokeClockPhotoObjectUrl();
    img.removeAttribute('src');
    img.style.opacity = '0';
    if (empty) empty.style.display = 'flex';
  };
  loader.src = src;
  await updateClockPhotoNav();
}

// ─── SLIDESHOW ───────────────────────────────
async function renderSlideshowEmpty() {
  const el = document.getElementById('slide-empty');
  const overlay = document.getElementById('slideshow-overlay');
  const empty = !(await hasPhotoSources());
  if (empty) {
    el.classList.add('visible');
    overlay.style.display = 'none';
  } else {
    el.classList.remove('visible');
    overlay.style.display = '';
  }
}

async function startSlideshow() {
  clearInterval(State.slideTimer);
  await renderSlideshowEmpty();
  const count = await getPhotoSourceCount();
  if (count === 0) return;

  State.slideIndex = 0;
  await showSlideAsync(0);
  State.slideTimer = setInterval(() => {
    void (async () => {
      const total = await getPhotoSourceCount();
      if (!total) return;
      State.slideIndex = (State.slideIndex + 1) % total;
      await showSlideAsync(State.slideIndex);
    })();
  }, State.cfg.interval);
}

function stopSlideshow() {
  clearInterval(State.slideTimer);
}

async function showSlideAsync(index) {
  const total = await getPhotoSourceCount();
  if (!total) return;
  const normalizedIndex = ((index % total) + total) % total;
  const { src } = await resolvePhotoAtIndex(normalizedIndex);
  if (!src) return;
  showSlideWithSrc(normalizedIndex, src, total);
}

function showSlideWithSrc(index, src, total) {
  const imgA = document.getElementById('slide-img-a');
  const imgB = document.getElementById('slide-img-b');
  const counter = document.getElementById('slide-counter');
  const container = document.getElementById('slideshow-container');
  if (!imgA || !imgB) return;

  const incomingKey = State.slideActive === 'a' ? 'b' : 'a';
  const incoming = incomingKey === 'a' ? imgA : imgB;
  const outgoing  = State.slideActive === 'a' ? imgA : imgB;

  if (slidePhotoObjectUrls[incomingKey]) {
    revokeObjectUrl(slidePhotoObjectUrls[incomingKey]);
  }
  if (src.startsWith('blob:')) {
    slidePhotoObjectUrls[incomingKey] = src;
  } else {
    slidePhotoObjectUrls[incomingKey] = null;
  }

  const EFFECTS = ['fade', 'slide', 'zoom', 'kenburns'];
  let effect = State.cfg.transition || 'fade';
  if (effect === 'random') effect = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
  if (effect === 'none') {
    incoming.src = src;
    incoming.classList.add('active');
    outgoing.classList.remove('active');
    State.slideActive = incomingKey;
    if (counter) counter.textContent = `${index + 1} / ${total}`;
    return;
  }

  container.className = '';
  incoming.className = 'slide-img';
  outgoing.className = 'slide-img active';
  incoming.src = src;

  requestAnimationFrame(() => {
    container.classList.add(`fx-${effect}`);
    incoming.classList.add('active', 'slide-in');
    outgoing.classList.add('slide-out');

    const duration = effect === 'kenburns' ? 1000 : 700;
    setTimeout(() => {
      outgoing.classList.remove('active', 'slide-out');
      incoming.classList.remove('slide-in');
      container.className = effect === 'kenburns' ? 'fx-kenburns' : '';
    }, duration);
  });

  State.slideActive = incomingKey;
  if (counter) counter.textContent = `${index + 1} / ${total}`;
}

// ─── CÂMERAS ─────────────────────────────────
function renderCameras() {
  const grid = document.getElementById('cameras-grid');
  if (!grid) return;
  grid.innerHTML = '';

  if (State.cameras.length === 0) {
    grid.innerHTML = '<div class="cam-empty"><div style="font-size:40px;opacity:.3">📹</div><p style="font-size:15px;color:var(--text-dim)">Nenhuma câmera configurada</p><p style="font-size:12px;color:var(--text-dim)">Adicione URLs nas configurações</p></div>';
    return;
  }

  State.cameras.forEach((cam, i) => {
    const tile = document.createElement('div');
    tile.className = 'cam-tile';
    tile.dataset.index = i;

    const isMjpeg = cam.url.match(/\.(mjpg|mjpeg)/i) || cam.url.includes('axis-cgi');
    const isImage = cam.url.match(/\.(jpg|jpeg|png|gif)/i);

    if (isImage || isMjpeg) {
      const img = document.createElement('img');
      img.alt = cam.name;
      img.src = cam.url;
      if (isMjpeg) {
        // reload periódico para MJPEG estático
        img.dataset.refresh = 'true';
        setInterval(() => {
          img.src = cam.url + (cam.url.includes('?') ? '&' : '?') + '_t=' + Date.now();
        }, 3000);
      }
      tile.appendChild(img);
    } else {
      // tenta iframe para streams HLS / páginas de câmera
      const ifr = document.createElement('iframe');
      ifr.src = cam.url;
      ifr.sandbox = 'allow-scripts allow-same-origin';
      ifr.allowFullscreen = true;
      tile.appendChild(ifr);
    }

    const label = document.createElement('div');
    label.className = 'cam-tile-label';
    label.innerHTML = `<span>${cam.name}</span><span class="cam-live-badge"><span class="cam-live-dot"></span>AO VIVO</span>`;
    tile.appendChild(label);

    tile.addEventListener('click', () => openCamExpanded(i));
    grid.appendChild(tile);
  });
}

function openCamExpanded(i) {
  const cam = State.cameras[i];
  if (!cam) return;
  const panel = document.getElementById('cam-expanded');
  const frame = document.getElementById('cam-frame');
  const img = document.getElementById('cam-img');
  const name = document.getElementById('cam-expanded-name');

  name.textContent = cam.name;

  const isImage = cam.url.match(/\.(jpg|jpeg|png|gif|mjpg|mjpeg)/i);
  if (isImage) {
    frame.style.display = 'none';
    img.style.display = 'block';
    img.src = cam.url;
  } else {
    img.style.display = 'none';
    frame.style.display = 'block';
    frame.src = cam.url;
  }

  panel.classList.remove('hidden');
}

function closeCamExpanded() {
  const panel = document.getElementById('cam-expanded');
  panel.classList.add('hidden');
  document.getElementById('cam-frame').src = '';
  document.getElementById('cam-img').src = '';
}

function renderCamerasList() {
  const list = document.getElementById('cameras-list');
  if (!list) return;
  list.innerHTML = '';
  State.cameras.forEach((cam, i) => {
    const row = document.createElement('div');
    row.className = 'cam-list-item';
    row.innerHTML = `<span><strong>${cam.name}</strong> — <small style="color:var(--text-dim)">${cam.url.substring(0,40)}${cam.url.length>40?'…':''}</small></span>`;
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.title = 'Remover câmera';
    btn.addEventListener('click', () => {
      State.cameras.splice(i, 1);
      saveConfig();
      renderCamerasList();
      renderCameras();
    });
    row.appendChild(btn);
    list.appendChild(row);
  });
}

// ─── MODOS ───────────────────────────────────
function switchMode(mode) {
  if (State.mode === 'slideshow') stopSlideshow();

  State.mode = mode;
  document.querySelectorAll('.mode').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));

  const modeEl = document.getElementById(`mode-${mode}`);
  if (modeEl) modeEl.classList.add('active');

  const navBtn = document.querySelector(`[data-mode="${mode}"]`);
  if (navBtn) navBtn.classList.add('active');

  if (mode === 'slideshow') void startSlideshow();
  if (mode === 'cameras') renderCameras();
}

// ─── CONFIGURAÇÕES UI ─────────────────────────
function openSettings() {
  const cfg = State.cfg;
  document.getElementById('cfg-city').value = cfg.city;
  document.getElementById('cfg-api-key').value = cfg.apiKey;
  updateSaveWeatherBtn();
  document.getElementById('cfg-interval').value = cfg.interval;
  document.getElementById('cfg-transition').value = cfg.transition || 'fade';
  document.getElementById('cfg-24h').checked = cfg.format24h;
  document.getElementById('cfg-night-auto').checked = cfg.nightAuto;
  document.getElementById('cfg-night-start').value = cfg.nightStart;
  document.getElementById('cfg-night-end').value = cfg.nightEnd;
  document.getElementById('cfg-wakelock').checked = cfg.wakelock;

  renderFolderInfo();
  void (async () => {
    await renderFolderPhotoCount();
    await renderPhotosPreviews();
  })();
  renderCamerasList();

  document.getElementById('settings-panel').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-panel').classList.add('hidden');
}

function updateSaveWeatherBtn() {
  const btn = document.getElementById('btn-save-weather');
  if (!btn) return;
  const cityChanged = document.getElementById('cfg-city').value.trim() !== State.cfg.city;
  const keyChanged = document.getElementById('cfg-api-key').value.trim() !== State.cfg.apiKey;
  const changed = cityChanged || keyChanged;
  btn.disabled = !changed;
  btn.style.opacity = changed ? '1' : '0.4';
  btn.style.cursor = changed ? 'pointer' : 'not-allowed';
}

function saveWeatherConfig() {
  State.cfg.city = document.getElementById('cfg-city').value.trim();
  State.cfg.apiKey = document.getElementById('cfg-api-key').value.trim();
  saveConfig();
  startWeatherTimer();
  showToast('Clima atualizado!');
}

function saveDisplayConfig() {
  State.cfg.format24h = document.getElementById('cfg-24h').checked;
  State.cfg.nightAuto = document.getElementById('cfg-night-auto').checked;
  State.cfg.nightStart = document.getElementById('cfg-night-start').value;
  State.cfg.nightEnd = document.getElementById('cfg-night-end').value;
  State.cfg.wakelock = document.getElementById('cfg-wakelock').checked;
  State.cfg.interval = parseInt(document.getElementById('cfg-interval').value);
  State.cfg.transition = document.getElementById('cfg-transition').value;
  saveConfig();
  if (State.cfg.wakelock) requestWakeLock();
  else releaseWakeLock();
}

// ─── WAKELOCK ────────────────────────────────
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    State.wakeLock = await navigator.wakeLock.request('screen');
    State.wakeLock.addEventListener('release', () => {
      // re-solicita quando fica ativo de novo
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && State.cfg.wakelock) requestWakeLock();
      }, { once: true });
    });
  } catch(e) { console.warn('wakeLock:', e); }
}

async function releaseWakeLock() {
  if (State.wakeLock) { await State.wakeLock.release(); State.wakeLock = null; }
}

// ─── TELA CHEIA ──────────────────────────────
function toggleFullscreen() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
}

// ─── TOAST ───────────────────────────────────
function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#1a6fff;color:#fff;padding:10px 20px;border-radius:20px;font-size:14px;z-index:999;pointer-events:none;transition:opacity 0.3s;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

// ─── CIDADES SALVAS ──────────────────────────
function getCityNavList() {
  const saved = loadSavedCities();
  const currentQuery = (State.cfg.city || '').trim();
  if (!currentQuery) return saved;

  if (!saved.some((city) => city.query === currentQuery)) {
    return [{
      name: currentQuery.split(',')[0],
      query: currentQuery,
      lat: State.cfg.lat ?? null,
      lon: State.cfg.lon ?? null,
    }, ...saved];
  }

  return saved;
}

function findCurrentCityIndex(list) {
  const idx = list.findIndex((city) => city.query === State.cfg.city);
  return idx >= 0 ? idx : 0;
}

function applyCity(city) {
  if (!city?.query) return;
  State.cfg.city = city.query;
  State.cfg.lat = city.lat ?? null;
  State.cfg.lon = city.lon ?? null;
  saveConfig();
  const cfgCity = document.getElementById('cfg-city');
  if (cfgCity) cfgCity.value = city.query;
  startWeatherTimer();
}

function navigateCity(delta) {
  const list = getCityNavList();
  if (list.length <= 1) return;

  const idx = findCurrentCityIndex(list);
  const next = list[(idx + delta + list.length) % list.length];
  applyCity(next);
  showToast(`Cidade: ${next.name || next.query}`);
}

function updateCityNav() {
  const enabled = getCityNavList().length > 1;
  const prev = document.getElementById('clock-city-prev');
  const next = document.getElementById('clock-city-next');
  if (prev) {
    prev.disabled = !enabled;
    prev.classList.remove('is-active');
  }
  if (next) {
    next.disabled = !enabled;
    next.classList.remove('is-active');
  }
}

function loadSavedCities() {
  try {
    return JSON.parse(localStorage.getItem('sd_saved_cities') || '[]');
  } catch { return []; }
}

function saveSavedCities(cities) {
  localStorage.setItem('sd_saved_cities', JSON.stringify(cities));
}

function addSavedCity(name, query, lat, lon) {
  const cities = loadSavedCities();
  const existing = cities.findIndex(c => c.query === query);
  if (existing !== -1) cities.splice(existing, 1);
  cities.unshift({ name, query, lat: lat ?? null, lon: lon ?? null });
  saveSavedCities(cities.slice(0, 10));
}

function renderSavedCities() {
  const list = document.getElementById('city-saved-list');
  const section = document.getElementById('city-saved-section');
  if (!list) return;
  const cities = loadSavedCities();
  if (cities.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  list.innerHTML = '';
  cities.forEach((city, i) => {
    const item = document.createElement('div');
    item.className = 'city-saved-item';
    const isActive = city.query === State.cfg.city;
    if (isActive) item.classList.add('active');
    const coords = (city.lat != null && city.lon != null)
      ? `${Number(city.lat).toFixed(4)}, ${Number(city.lon).toFixed(4)}`
      : 'sem coordenadas';
    item.innerHTML = `
      <div class="city-saved-info">
        <span class="city-saved-name">${city.name}</span>
        <span class="city-saved-coords">${coords}</span>
      </div>
      <button class="city-saved-del" title="Remover" data-index="${i}">✕</button>
    `;
    item.querySelector('.city-saved-info').addEventListener('click', () => {
      applyCity(city);
      closeCitySearch();
      showToast(`Cidade: ${city.name}`);
    });
    item.querySelector('.city-saved-del').addEventListener('click', e => {
      e.stopPropagation();
      const cities = loadSavedCities();
      cities.splice(i, 1);
      saveSavedCities(cities);
      renderSavedCities();
      updateCityNav();
    });
    list.appendChild(item);
  });
}

// ─── BUSCA DE CIDADE ─────────────────────────
let citySearchTimer = null;

function openCitySearch() {
  const overlay = document.getElementById('city-search-overlay');
  const input = document.getElementById('city-search-input');
  overlay.classList.remove('hidden');
  input.value = '';
  document.getElementById('city-search-results').innerHTML = '';
  renderSavedCities();
  setTimeout(() => input.focus(), 100);
}

function closeCitySearch() {
  document.getElementById('city-search-overlay').classList.add('hidden');
}

async function searchCities(query) {
  const results = document.getElementById('city-search-results');
  if (!query || query.length < 2) {
    results.innerHTML = '';
    return;
  }

  results.innerHTML = '<div class="city-search-status">Buscando...</div>';

  try {
    const { apiKey } = State.cfg;
    let url;
    if (apiKey) {
      url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(query)}&limit=8&appid=${apiKey}`;
    } else {
      // sem API key: usa nominatim (OpenStreetMap) como fallback
      url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=8&featuretype=city&addressdetails=1`;
    }

    const res = await fetch(url, apiKey ? {} : { headers: { 'Accept-Language': 'pt-BR,pt;q=0.9' } });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();

    results.innerHTML = '';

    const cities = apiKey
      ? data.map(c => ({ name: c.name, state: c.state, country: c.country, query: `${c.name},${c.country}`, lat: c.lat, lon: c.lon }))
      : data.map(c => ({
          name: c.address?.city || c.address?.town || c.address?.village || c.name,
          state: c.address?.state || '',
          country: c.address?.country || '',
          query: c.address?.city || c.address?.town || c.address?.village || c.name,
          lat: c.lat,
          lon: c.lon,
        }));

    if (cities.length === 0) {
      results.innerHTML = '<div class="city-search-status">Nenhuma cidade encontrada</div>';
      return;
    }

    cities.forEach(city => {
      const item = document.createElement('div');
      item.className = 'city-result-item';
      const parts = [city.state, city.country].filter(Boolean).join(', ');
      item.innerHTML = `
        <span class="city-result-name">${city.name}</span>
        ${parts ? `<span class="city-result-country">${parts}</span>` : ''}
      `;
      item.addEventListener('click', () => {
        addSavedCity(city.name, city.query, city.lat, city.lon);
        applyCity(city);
        closeCitySearch();
        showToast(`Cidade: ${city.name}`);
      });
      results.appendChild(item);
    });
  } catch(e) {
    console.warn('city search error:', e);
    results.innerHTML = '<div class="city-search-status">Erro ao buscar. Tente novamente.</div>';
  }
}

// ─── LISTENERS ───────────────────────────────
function bindEvents() {
  // navegação
  document.querySelectorAll('.nav-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  // settings
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('clock-photo-empty')?.addEventListener('click', openSettings);
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    saveDisplayConfig();
    closeSettings();
    if (State.mode === 'slideshow') void startSlideshow();
  });

  // clima
  document.getElementById('btn-save-weather').addEventListener('click', saveWeatherConfig);
  document.getElementById('cfg-city').addEventListener('input', updateSaveWeatherBtn);
  document.getElementById('cfg-api-key').addEventListener('input', updateSaveWeatherBtn);

  // fotos
  document.getElementById('clock-photo-prev')?.addEventListener('click', () => {
    void navigateClockPhoto(-1);
  });
  document.getElementById('clock-photo-next')?.addEventListener('click', () => {
    void navigateClockPhoto(1);
  });
  bindClockPhotoNavHighlight();

  document.getElementById('btn-browse-photo-folder')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openFolderPicker();
  });
  document.getElementById('btn-choose-photo-folder')?.addEventListener('click', (e) => {
    e.preventDefault();
    openFolderPicker();
  });
  document.getElementById('photo-folder-picker')?.addEventListener('click', (e) => {
    if (e.target.closest('#btn-browse-photo-folder')) return;
    openFolderPicker();
  });

  document.getElementById('cfg-transition').addEventListener('change', e => {
    State.cfg.transition = e.target.value;
    saveConfig();
  });

  document.getElementById('btn-clear-photos').addEventListener('click', () => {
    void (async () => {
      if (!confirm('Desvincular a pasta de fotos?')) return;
      await clearStoredFolderHandle();
      revokeClockPhotoObjectUrl();
      revokePreviewObjectUrls();
      clockPhotoIndex = 0;
      State.slideIndex = 0;
      renderFolderInfo();
      await refreshPhotoViews();
      await renderSlideshowEmpty();
      showToast('Pasta removida');
    })();
  });

  // câmeras
  document.getElementById('btn-add-cam').addEventListener('click', () => {
    const name = document.getElementById('cfg-cam-name').value.trim();
    const url = document.getElementById('cfg-cam-url').value.trim();
    if (!name || !url) { showToast('Preencha nome e URL'); return; }
    State.cameras.push({ name, url });
    saveConfig();
    document.getElementById('cfg-cam-name').value = '';
    document.getElementById('cfg-cam-url').value = '';
    renderCamerasList();
    renderCameras();
    showToast(`Câmera "${name}" adicionada`);
  });

  // câmera expandida
  document.getElementById('btn-close-cam').addEventListener('click', closeCamExpanded);

  // tela cheia
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);

  // busca de cidade ao clicar no nome
  document.getElementById('clock-city-prev')?.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateCity(-1);
  });
  document.getElementById('clock-city-next')?.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateCity(1);
  });
  document.getElementById('weather-city-name').addEventListener('click', openCitySearch);
  document.getElementById('btn-close-city-search').addEventListener('click', closeCitySearch);
  document.getElementById('city-search-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('city-search-overlay')) closeCitySearch();
  });
  document.getElementById('city-search-input').addEventListener('input', e => {
    clearTimeout(citySearchTimer);
    citySearchTimer = setTimeout(() => searchCities(e.target.value.trim()), 400);
  });

  // nav bar — oculta após 5s sem toque no modo slideshow
  let navTimeout;
  document.addEventListener('touchstart', () => {
    const nav = document.getElementById('nav-bar');
    nav.style.opacity = '1';
    clearTimeout(navTimeout);
    if (State.mode === 'slideshow') {
      navTimeout = setTimeout(() => { nav.style.opacity = '0'; }, 5000);
    }
  });
}

// ─── BOOT ────────────────────────────────────
function syncPhotoColHeight() {
  const wrapper = document.querySelector('.clock-wrapper');
  const col = document.getElementById('clock-photo-col');
  if (!wrapper || !col) return;

  const layoutWidth = wrapper.offsetWidth;
  const visualWidth = wrapper.getBoundingClientRect().width;
  const layoutGap = Math.max(0, Math.round(layoutWidth - visualWidth));

  col.style.marginLeft = layoutGap ? `${-layoutGap}px` : '0';
  col.style.height = `${wrapper.getBoundingClientRect().height}px`;
}

async function init() {
  loadConfig();
  loadFolderPlaylist();
  lastMidnightCheckDate = getTodayKey();
  await clearLegacyPhotoStorage();
  await loadStoredFolderHandle();
  if (usesFolderSource()) await ensureFolderPlaylistForToday();
  await refreshPhotoViews();

  bindEvents();
  setupFolderPickerUi();
  updateCityNav();
  switchMode('clock');
  scheduleMidnightFolderRescan();
  setInterval(checkMidnightPlaylistRefresh, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkMidnightPlaylistRefresh();
  });

  // relógio começa imediatamente
  tickClock();
  setInterval(tickClock, 1000);

  // mini foto
  await startClockPhoto();

  // clima
  startWeatherTimer();

  // wakelock
  if (State.cfg.wakelock) requestWakeLock();

  // sincroniza altura do quadro de foto com o relógio
  syncPhotoColHeight();
  setTimeout(syncPhotoColHeight, 800);
  window.addEventListener('resize', syncPhotoColHeight);
}

// ─── SERVICE WORKER ───────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log('SW registrado'))
      .catch(e => console.warn('SW erro:', e));
  });
}

document.addEventListener('DOMContentLoaded', init);
