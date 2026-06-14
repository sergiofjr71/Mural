/* ============================================
   SMARTDISPLAY PWA — lógica principal
   ============================================ */

'use strict';

// ─── ESTADO GLOBAL ───────────────────────────
const State = {
  mode: 'clock',
  photos: [],        // array de dataURLs
  cameras: [],       // [{name, url}]
  slideIndex: 0,
  slideTimer: null,
  slideActive: 'a',
  weatherData: null,
  weatherTimer: null,
  wakeLock: null,
  cfg: {
    city: 'São Paulo',
    apiKey: '',
    interval: 10000,
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
    // fotos ficam em IndexedDB (ver abaixo)
  } catch(e) { console.warn('saveConfig:', e); }
}

function loadConfig() {
  try {
    const c = localStorage.getItem('sd_cfg');
    if (c) Object.assign(State.cfg, JSON.parse(c));
    const cams = localStorage.getItem('sd_cameras');
    if (cams) State.cameras = JSON.parse(cams);
  } catch(e) { console.warn('loadConfig:', e); }
}

// ─── INDEXEDDB PARA FOTOS ────────────────────
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('SmartDisplay', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('photos', { autoIncrement: true });
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = reject;
  });
}

function savePhotos(dataURLs) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readwrite');
    const store = tx.objectStore('photos');
    store.clear();
    dataURLs.forEach(url => store.put(url));
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

function loadPhotos() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readonly');
    const store = tx.objectStore('photos');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = reject;
  });
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
const WEATHER_ICONS = {
  '01d':'☀️','01n':'🌙',
  '02d':'⛅','02n':'⛅',
  '03d':'☁️','03n':'☁️',
  '04d':'☁️','04n':'☁️',
  '09d':'🌧','09n':'🌧',
  '10d':'🌦','10n':'🌦',
  '11d':'⛈','11n':'⛈',
  '13d':'❄️','13n':'❄️',
  '50d':'🌫','50n':'🌫',
};

async function fetchWeather() {
  const { city, apiKey } = State.cfg;
  if (!city || !apiKey) {
    updateWeatherUI({ icon:'🌡', temp:'--', city: city || '(sem cidade)', desc:'configure a API key', humidity:'--' });
    return;
  }
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=metric&lang=pt_br&appid=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    State.weatherData = {
      icon: WEATHER_ICONS[d.weather[0].icon] || '🌡',
      temp: Math.round(d.main.temp) + '°',
      city: d.name,
      desc: d.weather[0].description,
      humidity: d.main.humidity + '%',
    };
    updateWeatherUI(State.weatherData);
  } catch(e) {
    console.warn('weather error:', e);
    updateWeatherUI({ icon:'⚠️', temp:'--', city: city, desc:'erro ao buscar clima', humidity:'--' });
  }
}

function updateWeatherUI(w) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('weather-icon-big', w.icon);
  set('weather-temp-big', w.temp);
  set('weather-city-name', w.city);
  set('weather-desc-main', w.desc);
  set('weather-humidity', `Umidade: ${w.humidity}`);
  set('slide-weather', `${w.icon} ${w.temp}`);
  set('cam-weather', `${w.icon} ${w.temp}`);
}

function startWeatherTimer() {
  clearInterval(State.weatherTimer);
  fetchWeather();
  State.weatherTimer = setInterval(fetchWeather, 10 * 60 * 1000); // cada 10 min
}

// ─── SLIDESHOW ───────────────────────────────
function renderSlideshowEmpty() {
  const el = document.getElementById('slide-empty');
  const overlay = document.getElementById('slideshow-overlay');
  if (State.photos.length === 0) {
    el.classList.add('visible');
    overlay.style.display = 'none';
  } else {
    el.classList.remove('visible');
    overlay.style.display = '';
  }
}

function startSlideshow() {
  clearInterval(State.slideTimer);
  renderSlideshowEmpty();
  if (State.photos.length === 0) return;

  State.slideIndex = 0;
  showSlide(0);
  State.slideTimer = setInterval(() => {
    State.slideIndex = (State.slideIndex + 1) % State.photos.length;
    showSlide(State.slideIndex);
  }, State.cfg.interval);
}

function stopSlideshow() {
  clearInterval(State.slideTimer);
}

function showSlide(index) {
  const imgA = document.getElementById('slide-img-a');
  const imgB = document.getElementById('slide-img-b');
  const counter = document.getElementById('slide-counter');

  const next = State.photos[index];
  if (!next) return;

  const incoming = State.slideActive === 'a' ? imgB : imgA;
  const outgoing  = State.slideActive === 'a' ? imgA : imgB;

  incoming.src = next;
  incoming.classList.add('active');
  outgoing.classList.remove('active');
  State.slideActive = State.slideActive === 'a' ? 'b' : 'a';

  if (counter) counter.textContent = `${index + 1} / ${State.photos.length}`;
}

async function handlePhotoInput(files) {
  const dataURLs = [];
  for (const file of files) {
    const url = await fileToDataURL(file);
    dataURLs.push(url);
  }
  State.photos = [...State.photos, ...dataURLs];
  await savePhotos(State.photos);
  renderPhotosPreviews();
  if (State.mode === 'slideshow') startSlideshow();
}

function fileToDataURL(file) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = e => resolve(e.target.result);
    r.readAsDataURL(file);
  });
}

function renderPhotosPreviews() {
  const preview = document.getElementById('photos-preview');
  if (!preview) return;
  preview.innerHTML = '';
  State.photos.slice(0, 20).forEach(url => {
    const img = document.createElement('img');
    img.src = url;
    img.className = 'photo-thumb';
    preview.appendChild(img);
  });
  if (State.photos.length > 20) {
    const more = document.createElement('span');
    more.style.cssText = 'font-size:12px;color:var(--text-dim);align-self:center;';
    more.textContent = `+${State.photos.length - 20} fotos`;
    preview.appendChild(more);
  }
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

  if (mode === 'slideshow') startSlideshow();
  if (mode === 'cameras') renderCameras();
}

// ─── CONFIGURAÇÕES UI ─────────────────────────
function openSettings() {
  const cfg = State.cfg;
  document.getElementById('cfg-city').value = cfg.city;
  document.getElementById('cfg-api-key').value = cfg.apiKey;
  document.getElementById('cfg-interval').value = cfg.interval;
  document.getElementById('cfg-24h').checked = cfg.format24h;
  document.getElementById('cfg-night-auto').checked = cfg.nightAuto;
  document.getElementById('cfg-night-start').value = cfg.nightStart;
  document.getElementById('cfg-night-end').value = cfg.nightEnd;
  document.getElementById('cfg-wakelock').checked = cfg.wakelock;

  renderPhotosPreviews();
  renderCamerasList();

  document.getElementById('settings-panel').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-panel').classList.add('hidden');
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

// ─── LISTENERS ───────────────────────────────
function bindEvents() {
  // navegação
  document.querySelectorAll('.nav-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  // settings
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    saveDisplayConfig();
    closeSettings();
    if (State.mode === 'slideshow') startSlideshow();
  });

  // clima
  document.getElementById('btn-save-weather').addEventListener('click', saveWeatherConfig);

  // fotos
  document.getElementById('cfg-photos').addEventListener('change', e => {
    handlePhotoInput(Array.from(e.target.files));
  });

  document.getElementById('btn-clear-photos').addEventListener('click', async () => {
    if (!confirm('Remover todas as fotos?')) return;
    State.photos = [];
    await savePhotos([]);
    renderPhotosPreviews();
    renderSlideshowEmpty();
    showToast('Fotos removidas');
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
async function init() {
  loadConfig();

  await openDB();
  State.photos = await loadPhotos();

  bindEvents();
  switchMode('clock');

  // relógio começa imediatamente
  tickClock();
  setInterval(tickClock, 1000);

  // clima
  startWeatherTimer();

  // wakelock
  if (State.cfg.wakelock) requestWakeLock();
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
