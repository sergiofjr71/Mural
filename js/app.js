/* ============================================
   SMARTDISPLAY PWA — lógica principal
   ============================================ */

'use strict';

// ─── ESTADO GLOBAL ───────────────────────────
const State = {
  mode: 'clock',
  photos: [],        // [{ name, url }] — usado quando não há pasta vinculada
  linkedFolders: [], // [{ id, name, handle?, files? }]
  folderPlaylist: [],
  folderPlaylistDate: '',
  hiddenFolderPhotos: new Set(),
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
    nightStart: '19:00',
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
const PHOTO_DB_VERSION = 4;
const GALLERY_FOLDERS_KEY = 'sd_gallery_folders';
let photoDbPromise = null;
let clockPhotoObjectUrl = null;
let slidePhotoObjectUrls = { a: null, b: null };
let midnightRescanTimer = null;
let lastMidnightCheckDate = '';
let folderPickInProgress = false;
let folderRescanInProgress = false;
let photoPlaylistListVisible = false;
let photoPlaylistRenderGen = 0;
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
        if (!db.objectStoreNames.contains('gallery')) {
          db.createObjectStore('gallery');
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

function idbTransactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function generateFolderId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function usesFolderSource() {
  return State.linkedFolders.length > 0;
}

function usesNativePhotoLibrary() {
  return typeof PhotoLibraryService !== 'undefined'
    && PhotoLibraryService.isEnabled()
    && PhotoLibraryService.getCount() > 0;
}

function isNativePhotoLibraryMode() {
  return typeof PhotoLibraryService !== 'undefined' && PhotoLibraryService.isEnabled();
}

function findLinkedFolderByName(name) {
  return State.linkedFolders.find((folder) => folder.name === name);
}

function getUniqueFolderName(name) {
  const base = String(name || 'Pasta').trim() || 'Pasta';
  if (!findLinkedFolderByName(base)) return base;
  let i = 2;
  while (findLinkedFolderByName(`${base} (${i})`)) i += 1;
  return `${base} (${i})`;
}

async function findLinkedFolderByHandle(handle) {
  if (!handle) return null;
  for (const folder of State.linkedFolders) {
    if (!folder.handle) continue;
    if (folder.handle === handle) return folder;
    if (typeof handle.isSameEntry === 'function' && typeof folder.handle.isSameEntry === 'function') {
      try {
        if (await handle.isSameEntry(folder.handle)) return folder;
      } catch {}
    }
  }
  return null;
}

async function persistLinkedFolderHandles() {
  const folders = State.linkedFolders
    .filter((folder) => folder.handle)
    .map((folder) => ({ id: folder.id, name: folder.name, handle: folder.handle }));

  const db = await openPhotoDB();
  const tx = db.transaction('folder', 'readwrite');
  tx.objectStore('folder').put({ folders }, 'linked');
  await idbTransactionDone(tx);

  saveLinkedFoldersMeta();
  return folders.length;
}

async function queryHandleReadPermission(handle) {
  if (!handle) return 'granted';
  try {
    return await handle.queryPermission({ mode: 'read' });
  } catch (e) {
    console.warn('queryHandleReadPermission:', e);
    return 'denied';
  }
}

async function queryFolderReadPermission(folder) {
  return queryHandleReadPermission(folder?.handle);
}

async function verifyHandleAccess(handle) {
  if (!handle) return true;
  try {
    const iter = handle.values();
    await iter.next();
    return true;
  } catch {
    return false;
  }
}

async function verifyFolderHandleAccess(folder) {
  return verifyHandleAccess(folder?.handle);
}

const FOLDER_PERMISSIONS_KEY = 'sd_folder_permissions';
let folderPermissionPromptBound = false;

function loadFolderPermissionsMap() {
  try {
    const raw = localStorage.getItem(FOLDER_PERMISSIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function markFolderPermissionGranted(folderId) {
  if (!folderId) return;
  try {
    const map = loadFolderPermissionsMap();
    map[folderId] = Date.now();
    localStorage.setItem(FOLDER_PERMISSIONS_KEY, JSON.stringify(map));
    sessionStorage.setItem('sd_folder_perm_done', '1');
  } catch {}
}

function clearFolderPermissionGranted(folderId) {
  if (!folderId) return;
  try {
    const map = loadFolderPermissionsMap();
    delete map[folderId];
    localStorage.setItem(FOLDER_PERMISSIONS_KEY, JSON.stringify(map));
  } catch {}
}

async function requestHandleReadPermission(handle) {
  if (!handle) return true;
  try {
    const current = await queryHandleReadPermission(handle);
    if (current === 'granted') return true;
    if (current === 'denied') return false;

    const result = await handle.requestPermission({ mode: 'read' });
    if (result !== 'granted') return false;
    return verifyHandleAccess(handle);
  } catch (e) {
    console.warn('requestHandleReadPermission:', e);
    return false;
  }
}

async function requestFolderReadPermission(folder) {
  if (!folder?.handle) return true;
  return requestHandleReadPermission(folder.handle);
}

async function folderHasReadAccess(folder) {
  if (!folder?.handle) return true;

  const state = await queryFolderReadPermission(folder);
  if (state === 'granted') {
    markFolderPermissionGranted(folder.id);
    return true;
  }
  if (state === 'denied') return false;

  if (await verifyFolderHandleAccess(folder)) {
    markFolderPermissionGranted(folder.id);
    return true;
  }

  return false;
}

async function ensureFolderReadPermission(folder, { interactive = false } = {}) {
  if (!folder?.handle) return true;
  if (await folderHasReadAccess(folder)) return true;
  if (!interactive) return false;

  const granted = await requestFolderReadPermission(folder);
  if (granted) markFolderPermissionGranted(folder.id);
  return granted;
}

async function syncPersistedFolderPermissions() {
  for (const folder of State.linkedFolders) {
    if (!folder.handle) continue;
    const state = await queryFolderReadPermission(folder);
    if (state === 'granted') markFolderPermissionGranted(folder.id);
  }
}

function setupDeferredFolderPermissionGrant() {
  if (folderPermissionPromptBound) return;
  if (sessionStorage.getItem('sd_folder_perm_done') === '1') return;

  folderPermissionPromptBound = true;
  const run = async () => {
    const needs = await getFoldersNeedingPermission();
    if (!needs.length) {
      document.removeEventListener('pointerdown', run, true);
      return;
    }

    document.removeEventListener('pointerdown', run, true);
    const ok = await grantAllFolderAccess();
    if (ok) sessionStorage.setItem('sd_folder_perm_done', '1');
  };

  document.addEventListener('pointerdown', run, true);
}

async function getFoldersNeedingPermission() {
  const needs = [];
  for (const folder of State.linkedFolders) {
    if (!folder.handle) continue;
    if (!(await folderHasReadAccess(folder))) needs.push(folder);
  }
  return needs;
}

async function ensureAllLinkedFolderPermissions({ interactive = false } = {}) {
  const denied = [];
  for (const folder of State.linkedFolders) {
    if (!folder.handle) continue;
    const ok = await ensureFolderReadPermission(folder, { interactive });
    if (!ok) denied.push(folder);
  }
  return { ok: denied.length === 0, denied };
}

async function updateFolderPermissionBanner() {
  const banner = document.getElementById('folder-permission-banner');
  if (!banner) return;

  if (isAppleMobileDevice()) {
    banner.classList.add('hidden');
    return;
  }

  const hasPersistedFolders = State.linkedFolders.some((folder) => folder.handle);
  if (!usesFolderSource() || !hasPersistedFolders) {
    banner.classList.add('hidden');
    return;
  }

  const needs = await getFoldersNeedingPermission();
  banner.classList.toggle('hidden', needs.length === 0);
}

async function grantAllFolderAccess() {
  const { ok, denied } = await ensureAllLinkedFolderPermissions({ interactive: true });
  await updateFolderPermissionBanner();
  void updateLinkedFoldersPermissionLabels();

  if (ok) {
    showToast('Acesso às pastas autorizado');
    await rescanLinkedFolders({ notify: true, resetIndex: false });
    if (photoPlaylistListVisible) await renderPhotoPlaylistList();
    return true;
  }

  const names = denied.map((folder) => folder.name).join(', ');
  showToast(names
    ? `Acesso negado para: ${names}`
    : 'Permissão de leitura negada');
  return false;
}

async function updateLinkedFoldersPermissionLabels() {
  const list = document.getElementById('linked-folders-list');
  if (!list) return;

  for (const item of list.querySelectorAll('.linked-folder-item')) {
    const folderId = item.getAttribute('data-folder-id');
    const folder = State.linkedFolders.find((entry) => entry.id === folderId);
    const kindEl = item.querySelector('.linked-folder-kind');
    if (!folder || !kindEl) continue;

    if (!folder.handle) {
      kindEl.textContent = folder.gallerySource ? 'salva neste dispositivo' : 'somente nesta sessão';
      kindEl.classList.remove('linked-folder-kind--pending');
      continue;
    }

    const hasAccess = await folderHasReadAccess(folder);
    kindEl.textContent = hasAccess ? 'salva neste dispositivo' : 'autorização pendente';
    kindEl.classList.toggle('linked-folder-kind--pending', !hasAccess);
  }
}

function saveLinkedFoldersMeta() {
  try {
    localStorage.setItem('sd_folder_names', JSON.stringify(
      State.linkedFolders.map((folder) => folder.name)
    ));
    localStorage.setItem('sd_linked_folders_meta', JSON.stringify(
      State.linkedFolders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        persisted: Boolean(folder.handle || folder.gallerySource),
        gallerySource: Boolean(folder.gallerySource),
      }))
    ));
  } catch {}
}

async function migrateLegacyFolderRecord(store) {
  const legacy = await idbRequestToPromise(store.get('primary'));
  if (!legacy?.handle) return null;
  const migrated = {
    folders: [{ id: generateFolderId(), name: legacy.name || 'Pasta', handle: legacy.handle }],
  };
  await idbRequestToPromise(store.put(migrated, 'linked'));
  await idbRequestToPromise(store.delete('primary'));
  return migrated;
}

async function loadStoredFolderHandles() {
  try {
    const db = await openPhotoDB();
    let record = await idbRequestToPromise(
      db.transaction('folder', 'readonly').objectStore('folder').get('linked')
    );

    if (!record?.folders?.length) {
      const tx = db.transaction('folder', 'readwrite');
      const store = tx.objectStore('folder');
      record = await migrateLegacyFolderRecord(store);
      await idbTransactionDone(tx);
    }

    if (!record?.folders?.length) return false;

    const loaded = [];
    for (const folder of record.folders) {
      if (!folder?.handle) continue;
      loaded.push({
        id: folder.id || generateFolderId(),
        name: folder.name || 'Pasta',
        handle: folder.handle,
      });
    }

    State.linkedFolders = loaded;
    if (loaded.length) saveLinkedFoldersMeta();
    return loaded.length > 0;
  } catch (e) {
    console.warn('loadStoredFolderHandles:', e);
    return false;
  }
}

function galleryFileIdentity(file) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

async function persistGalleryFolderToIdb(folder) {
  if (!folder?.id || !folder.files?.length) return;
  const records = await Promise.all(folder.files.map(async (file) => ({
    name: file.name,
    type: file.type || '',
    lastModified: file.lastModified || Date.now(),
    data: await file.arrayBuffer(),
  })));
  const db = await openPhotoDB();
  const tx = db.transaction('gallery', 'readwrite');
  tx.objectStore('gallery').put({ files: records }, folder.id);
  await idbTransactionDone(tx);

  try {
    const meta = JSON.parse(localStorage.getItem(GALLERY_FOLDERS_KEY) || '[]');
    if (!meta.some((entry) => entry.id === folder.id)) {
      meta.push({ id: folder.id, name: folder.name });
      localStorage.setItem(GALLERY_FOLDERS_KEY, JSON.stringify(meta));
    }
  } catch {}
}

async function loadGalleryFolderFromIdb(folderId) {
  const db = await openPhotoDB();
  const record = await idbRequestToPromise(
    db.transaction('gallery', 'readonly').objectStore('gallery').get(folderId)
  );
  if (!record?.files?.length) return [];
  return record.files.map((item) => new File([item.data], item.name, {
    type: item.type || 'image/jpeg',
    lastModified: item.lastModified || Date.now(),
  }));
}

async function deleteGalleryFolderFromIdb(folderId) {
  try {
    const db = await openPhotoDB();
    const tx = db.transaction('gallery', 'readwrite');
    tx.objectStore('gallery').delete(folderId);
    await idbTransactionDone(tx);
  } catch (e) {
    console.warn('deleteGalleryFolderFromIdb:', e);
  }

  try {
    const meta = JSON.parse(localStorage.getItem(GALLERY_FOLDERS_KEY) || '[]');
    localStorage.setItem(
      GALLERY_FOLDERS_KEY,
      JSON.stringify(meta.filter((entry) => entry.id !== folderId))
    );
  } catch {}
}

async function loadStoredGalleryFolders() {
  try {
    const meta = JSON.parse(localStorage.getItem(GALLERY_FOLDERS_KEY) || '[]');
    if (!meta.length) return false;

    let loadedAny = false;
    for (const entry of meta) {
      if (!entry?.id || State.linkedFolders.some((folder) => folder.id === entry.id)) continue;
      const files = await loadGalleryFolderFromIdb(entry.id);
      if (!files.length) continue;
      State.linkedFolders.push({
        id: entry.id,
        name: entry.name || 'Galeria de Fotos',
        files,
        gallerySource: true,
      });
      loadedAny = true;
    }

    if (loadedAny) saveLinkedFoldersMeta();
    return loadedAny;
  } catch (e) {
    console.warn('loadStoredGalleryFolders:', e);
    return false;
  }
}

async function appendToGalleryFolder(folderId, newFiles) {
  const folder = State.linkedFolders.find((item) => item.id === folderId);
  if (!folder) return 0;

  const existing = new Set((folder.files || []).map(galleryFileIdentity));
  const merged = [...(folder.files || [])];
  let added = 0;

  for (const file of newFiles) {
    if (!isDisplayableImageFile(file)) continue;
    const identity = galleryFileIdentity(file);
    if (existing.has(identity)) continue;
    existing.add(identity);
    merged.push(file);
    added += 1;
  }

  folder.files = merged;
  if (folder.gallerySource) {
    await persistGalleryFolderToIdb(folder);
  }
  saveLinkedFoldersMeta();
  return added;
}

async function clearAllLinkedFolders() {
  State.linkedFolders = [];
  clearFolderPhotoState();
  try {
    localStorage.removeItem('sd_folder_names');
    localStorage.removeItem('sd_folder_name');
    localStorage.removeItem('sd_linked_folders_meta');
    localStorage.removeItem(GALLERY_FOLDERS_KEY);
    const db = await openPhotoDB();
    const tx = db.transaction(['folder', 'gallery'], 'readwrite');
    tx.objectStore('folder').delete('linked');
    tx.objectStore('folder').delete('primary');
    tx.objectStore('gallery').clear();
    await idbTransactionDone(tx);
  } catch (e) {
    console.warn('clearAllLinkedFolders:', e);
  }
}

async function removeLinkedFolder(folderId) {
  const removed = State.linkedFolders.find((folder) => folder.id === folderId);
  clearFolderPermissionGranted(folderId);
  clearHiddenFolderPhotosForFolder(folderId);
  if (removed?.gallerySource) {
    await deleteGalleryFolderFromIdb(folderId);
  }
  State.linkedFolders = State.linkedFolders.filter((folder) => folder.id !== folderId);
  if (!State.linkedFolders.some((folder) => folder.handle)) {
    try {
      const db = await openPhotoDB();
      const tx = db.transaction('folder', 'readwrite');
      tx.objectStore('folder').delete('linked');
      await idbTransactionDone(tx);
    } catch {}
  } else {
    await persistLinkedFolderHandles();
  }

  if (!usesFolderSource()) {
    clearFolderPhotoState();
    return;
  }

  saveLinkedFoldersMeta();
  await refreshFolderPlaylist({ notify: false, resetIndex: true });
}

async function addLinkedFolderHandle(handle, name) {
  const existing = await findLinkedFolderByHandle(handle);
  if (existing) {
    showToast(`Esta pasta já está na lista como "${existing.name}"`);
    return false;
  }

  const uniqueName = getUniqueFolderName(name);
  State.linkedFolders.push({
    id: generateFolderId(),
    name: uniqueName,
    handle,
  });
  renderLinkedFoldersList();
  updatePhotoActionButtons();

  try {
    await persistLinkedFolderHandles();
  } catch (e) {
    console.warn('persistLinkedFolderHandles:', e);
    showToast('Pasta incluída, mas não foi possível salvar permanentemente');
  }
  return true;
}

async function addLinkedSessionFolder(name, files, { gallerySource = false } = {}) {
  const uniqueName = getUniqueFolderName(name);
  const folder = {
    id: generateFolderId(),
    name: uniqueName,
    files,
  };
  if (gallerySource) folder.gallerySource = true;
  State.linkedFolders.push(folder);
  renderLinkedFoldersList();
  updatePhotoActionButtons();
  saveLinkedFoldersMeta();
  if (gallerySource) {
    try {
      await persistGalleryFolderToIdb(folder);
    } catch (e) {
      console.warn('persistGalleryFolderToIdb:', e);
      showToast('Fotos incluídas, mas não foi possível salvar neste dispositivo');
    }
  }
  return true;
}

function isImageFileName(name) {
  return IMAGE_FILE_RE.test(name || '');
}

function isDisplayableImageFile(file) {
  if (!file) return false;
  if (isImageFileName(file.name)) return true;
  return (file.type || '').startsWith('image/');
}

const HEIC_FILE_RE = /\.(heic|heif)$/i;

function isHeicFile(file) {
  if (!file) return false;
  const name = file.name || '';
  const type = (file.type || '').toLowerCase();
  return HEIC_FILE_RE.test(name) || type.includes('heic') || type.includes('heif');
}

let heic2anyLoadPromise = null;

const HEIC2ANY_SCRIPT_URLS = [
  'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
  new URL('js/heic2any.min.js', window.location.href).href,
];

function heic2anyAvailable() {
  return typeof heic2any === 'function';
}

function loadExternalScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`script load failed: ${url}`));
    document.head.appendChild(script);
  });
}

function loadHeic2anyLibrary() {
  if (heic2anyAvailable()) return Promise.resolve();
  if (!heic2anyLoadPromise) {
    heic2anyLoadPromise = (async () => {
      for (const url of HEIC2ANY_SCRIPT_URLS) {
        try {
          await loadExternalScript(url);
          if (heic2anyAvailable()) return;
        } catch (e) {
          console.warn('loadHeic2anyLibrary:', url, e);
        }
      }
      throw new Error('heic2any indisponível');
    })();
  }
  return heic2anyLoadPromise;
}

async function convertHeicToDisplayBlob(file, { thumbnail = false } = {}) {
  const result = await heic2any({
    blob: file,
    toType: 'image/jpeg',
    quality: thumbnail ? 0.65 : 0.85,
  });
  const blob = Array.isArray(result) ? result[0] : result;
  if (!blob) throw new Error('Falha ao converter HEIC/HEIF');
  return blob;
}

async function createDisplayObjectUrlFromFile(file, { thumbnail = false } = {}) {
  if (!file) return null;

  if (isHeicFile(file)) {
    try {
      await loadHeic2anyLibrary();
    } catch (e) {
      console.warn('loadHeic2anyLibrary:', e);
      return null;
    }
    if (!heic2anyAvailable()) {
      console.warn('heic2any não carregado');
      return null;
    }
    try {
      const blob = await convertHeicToDisplayBlob(file, { thumbnail });
      return URL.createObjectURL(blob);
    } catch (e) {
      console.warn('createDisplayObjectUrlFromFile:', e);
      return null;
    }
  }

  return URL.createObjectURL(file);
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

let exifrLoadPromise = null;
const EXIFR_SCRIPT_URLS = [
  'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.umd.js',
  'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.umd.js',
];

function exifrAvailable() {
  return typeof exifr !== 'undefined' && typeof exifr.parse === 'function';
}

function loadExifrLibrary() {
  if (exifrAvailable()) return Promise.resolve();
  if (!exifrLoadPromise) {
    exifrLoadPromise = (async () => {
      for (const url of EXIFR_SCRIPT_URLS) {
        try {
          await loadExternalScript(url);
          if (exifrAvailable()) return;
        } catch (e) {
          console.warn('loadExifrLibrary:', url, e);
        }
      }
      throw new Error('exifr indisponível');
    })();
  }
  return exifrLoadPromise;
}

const photoGeocodeCache = new Map();

async function reverseGeocodePhoto(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (photoGeocodeCache.has(key)) return photoGeocodeCache.get(key);

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=json&accept-language=pt`;
    const res = await fetch(url, {
      headers: {
        'Accept-Language': 'pt-BR,pt',
        'User-Agent': 'SmartDisplay-Mural/1.0 (photo metadata)',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || addr.municipality || addr.suburb;
    const region = addr.state || addr.region;
    const label = [city, region].filter(Boolean).join(', ')
      || data.display_name?.split(',').slice(0, 2).map((part) => part.trim()).filter(Boolean).join(', ')
      || null;
    if (label) photoGeocodeCache.set(key, label);
    return label;
  } catch (e) {
    console.warn('reverseGeocodePhoto:', e);
    return null;
  }
}

function uniqueTruthyLocationParts(values) {
  const seen = new Set();
  const parts = [];
  values.forEach((value) => {
    const text = value == null ? '' : String(value).trim();
    if (!text || seen.has(text.toLowerCase())) return;
    seen.add(text.toLowerCase());
    parts.push(text);
  });
  return parts;
}

function normalizeLocationText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text.length < 2 || text.length > 120) return null;
  return text;
}

function pickExifLocationLabel(parsed) {
  if (!parsed) return null;

  const textFields = [
    parsed.LocationName,
    parsed.Location,
    parsed.ImageDescription,
    parsed.UserComment,
    parsed.XPTitle,
    parsed.XPSubject,
    parsed.XPKeywords,
    parsed?.iptc?.City,
    parsed?.xmp?.City,
  ];
  for (const field of textFields) {
    const text = normalizeLocationText(field);
    if (text) return text;
  }

  const parts = uniqueTruthyLocationParts([
    parsed.SubLocation || parsed['Sub-location'],
    parsed.City || parsed?.iptc?.City || parsed?.xmp?.City,
    parsed.ProvinceState || parsed.State || parsed?.iptc?.ProvinceState,
    parsed.Country || parsed.CountryCode || parsed?.iptc?.Country,
  ]);

  return parts.length ? parts.join(', ') : null;
}

async function resolvePhotoLocation(file, parsed) {
  let lat = parsed?.latitude;
  let lon = parsed?.longitude;

  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && exifrAvailable()) {
    try {
      const gps = await exifr.gps(file);
      if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
        lat = gps.latitude;
        lon = gps.longitude;
      }
    } catch (e) {
      console.warn('exifr.gps:', e);
    }
  }

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return (await reverseGeocodePhoto(lat, lon)) || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  }

  return pickExifLocationLabel(parsed);
}

function isUsableImageSrc(src) {
  return typeof src === 'string'
    && src.length > 0
    && src !== 'undefined'
    && (
      src.startsWith('blob:')
      || src.startsWith('data:image/')
      || /^https?:/i.test(src)
      || src.includes('_capacitor_file_')
      || src.startsWith('capacitor://')
    );
}

function revokePreviewObjectUrls() {
  previewObjectUrls.forEach((url) => revokeObjectUrl(url));
  previewObjectUrls.clear();
}

function parsePlaylistPath(path) {
  const splitAt = path.indexOf('::');
  if (splitAt === -1) return null;
  return {
    folderId: path.slice(0, splitAt),
    relPath: path.slice(splitAt + 2),
  };
}

async function getFileForPlaylistPath(path) {
  const parsed = parsePlaylistPath(path);
  if (!parsed?.relPath) return null;

  const folder = State.linkedFolders.find((item) => item.id === parsed.folderId);
  if (!folder) return null;

  if (folder.files?.length) {
    return folder.files.find((file) => {
      const rel = file.webkitRelativePath || file.name;
      return rel === parsed.relPath;
    }) || null;
  }

  if (!folder.handle) return null;
  if (!(await ensureFolderReadPermission(folder))) return null;

  const segments = parsed.relPath.split('/').filter(Boolean);
  if (!segments.length) return null;

  let dir = folder.handle;
  for (let i = 0; i < segments.length - 1; i += 1) {
    dir = await dir.getDirectoryHandle(segments[i]);
  }
  const fileHandle = await dir.getFileHandle(segments[segments.length - 1]);
  return fileHandle.getFile();
}

function formatFolderReadError(error) {
  const name = error?.name || '';
  const message = error?.message || String(error || 'Erro desconhecido');
  if (name === 'NotAllowedError' || message.includes('permission')) {
    return 'Permissão de leitura negada. Clique em Releitura das pastas e autorize o acesso.';
  }
  if (name === 'SecurityError') {
    return 'O navegador bloqueou o acesso à pasta. Abra o app numa aba própria (não no preview embutido).';
  }
  if (message.includes('Maximum call stack')) {
    return 'Pasta muito grande para processar de uma vez. Tente uma subpasta com menos fotos.';
  }
  return message;
}

async function collectImageEntries(dirHandle, folderId, onProgress) {
  const entries = [];
  const dirs = [{ dir: dirHandle, basePath: '' }];

  while (dirs.length) {
    const { dir, basePath } = dirs.pop();
    try {
      for await (const entry of dir.values()) {
        const entryPath = `${basePath}${entry.name}`;
        if (entry.kind === 'file' && isImageFileName(entry.name)) {
          entries.push({
            path: `${folderId}::${entryPath}`,
            getFile: () => entry.getFile(),
          });
          if (onProgress && entries.length % 100 === 0) {
            onProgress(entries.length);
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        } else if (entry.kind === 'directory') {
          dirs.push({ dir: entry, basePath: `${entryPath}/` });
        }
      }
    } catch (e) {
      console.warn('collectImageEntries:', basePath || '/', e);
    }
  }

  return entries;
}

async function getFolderImageEntries(onProgress) {
  const entries = [];
  const errors = [];

  for (const folder of State.linkedFolders) {
    if (folder.handle) {
      if (!(await ensureFolderReadPermission(folder))) {
        errors.push(`Sem permissão para ler "${folder.name}".`);
        continue;
      }
      try {
        const found = await collectImageEntries(folder.handle, folder.id, onProgress);
        for (const item of found) entries.push(item);
      } catch (e) {
        console.warn('getFolderImageEntries:', folder.name, e);
        errors.push(formatFolderReadError(e));
      }
      continue;
    }

    if (!folder.files?.length) {
      errors.push(`Pasta "${folder.name}" sem arquivos nesta sessão. Inclua a pasta novamente.`);
      continue;
    }
    for (const file of folder.files) {
      if (!isDisplayableImageFile(file)) continue;
      const rel = file.webkitRelativePath || file.name;
      entries.push({
        path: `${folder.id}::${rel}`,
        getFile: async () => file,
      });
    }
    if (onProgress) onProgress(entries.length);
  }

  if (!entries.length && errors.length) {
    throw new Error(errors.join(' '));
  }

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

const HIDDEN_FOLDER_PHOTOS_KEY = 'sd_folder_hidden_photos';

function loadHiddenFolderPhotos() {
  try {
    const raw = localStorage.getItem(HIDDEN_FOLDER_PHOTOS_KEY);
    if (!raw) {
      State.hiddenFolderPhotos = new Set();
      return;
    }
    const data = JSON.parse(raw);
    State.hiddenFolderPhotos = new Set(Array.isArray(data) ? data : []);
  } catch {
    State.hiddenFolderPhotos = new Set();
  }
}

function saveHiddenFolderPhotos() {
  try {
    localStorage.setItem(HIDDEN_FOLDER_PHOTOS_KEY, JSON.stringify([...State.hiddenFolderPhotos]));
  } catch (e) {
    console.warn('saveHiddenFolderPhotos:', e);
  }
}

function isPhotoHidden(path) {
  return State.hiddenFolderPhotos.has(path);
}

function setPhotoHidden(path, hidden) {
  if (!path) return;
  if (hidden) State.hiddenFolderPhotos.add(path);
  else State.hiddenFolderPhotos.delete(path);
  saveHiddenFolderPhotos();
}

function getVisibleFolderPlaylist() {
  return State.folderPlaylist.filter((path) => !isPhotoHidden(path));
}

function pruneHiddenFolderPhotos(validPaths) {
  const onDisk = new Set(validPaths);
  let changed = false;
  for (const path of State.hiddenFolderPhotos) {
    if (!onDisk.has(path)) {
      State.hiddenFolderPhotos.delete(path);
      changed = true;
    }
  }
  if (changed) saveHiddenFolderPhotos();
}

function clearHiddenFolderPhotosForFolder(folderId) {
  let changed = false;
  const prefix = `${folderId}::`;
  for (const path of State.hiddenFolderPhotos) {
    if (path.startsWith(prefix)) {
      State.hiddenFolderPhotos.delete(path);
      changed = true;
    }
  }
  if (changed) saveHiddenFolderPhotos();
}

function clearAllHiddenFolderPhotos() {
  State.hiddenFolderPhotos.clear();
  try {
    localStorage.removeItem(HIDDEN_FOLDER_PHOTOS_KEY);
  } catch {}
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

function clearFolderPhotoState() {
  clearFolderPlaylist();
  clearAllHiddenFolderPhotos();
}

async function syncFolderPlaylistWithDisk() {
  try {
    const entries = await getFolderImageEntries();
    const onDisk = new Set(entries.map((entry) => entry.path));
    const kept = State.folderPlaylist.filter((path) => onDisk.has(path));
    const known = new Set(kept);
    const added = entries.map((entry) => entry.path).filter((path) => !known.has(path));
    if (added.length || kept.length !== State.folderPlaylist.length) {
      State.folderPlaylist = [...kept, ...shuffleArray(added)];
      saveFolderPlaylist();
    }
    pruneHiddenFolderPhotos([...onDisk]);
  } catch (e) {
    console.warn('syncFolderPlaylistWithDisk:', e);
  }
}

async function refreshFolderPlaylist({ notify = true, resetIndex = true, onProgress } = {}) {
  if (!usesFolderSource()) {
    clearFolderPhotoState();
    updatePhotoActionButtons();
    return 0;
  }

  let entries;
  try {
    entries = await getFolderImageEntries(onProgress);
  } catch (e) {
    console.warn('refreshFolderPlaylist:', e);
    if (notify) showToast(formatFolderReadError(e));
    return 0;
  }

  const paths = entries.map((entry) => entry.path);
  pruneHiddenFolderPhotos(paths);
  State.folderPlaylist = shuffleArray(paths);
  State.folderPlaylistDate = getTodayKey();
  saveFolderPlaylist();

  if (resetIndex) {
    clockPhotoIndex = 0;
    State.slideIndex = 0;
  }

  if (notify) {
    const folderCount = State.linkedFolders.length;
    const folderLabel = folderCount === 1
      ? `Pasta "${State.linkedFolders[0].name}"`
      : `${folderCount} pastas`;
    showToast(paths.length
      ? `${folderLabel}: ${paths.length} foto${paths.length === 1 ? '' : 's'} em ordem aleatória`
      : `${folderLabel}: nenhuma imagem compatível encontrada`);
  }

  updatePhotoActionButtons();
  return paths.length;
}

function setRescanButtonBusy(busy) {
  const rescanBtn = document.getElementById('btn-rescan-folders');
  if (!rescanBtn) return;
  rescanBtn.disabled = busy || !usesFolderSource();
  rescanBtn.classList.toggle('is-busy', busy);
  rescanBtn.textContent = busy ? 'Lendo pastas…' : 'Releitura das pastas';
}

async function rescanLinkedFolders({ notify = true, resetIndex = true, interactive = false } = {}) {
  if (folderRescanInProgress) return 0;
  if (!usesFolderSource()) {
    if (notify) showToast('Nenhuma pasta vinculada');
    updatePhotoActionButtons();
    return 0;
  }

  const access = await ensureAllLinkedFolderPermissions({ interactive });
  await updateFolderPermissionBanner();
  void updateLinkedFoldersPermissionLabels();
  if (!access.ok) {
    if (notify) {
      showToast(interactive
        ? 'Permita o acesso às pastas no diálogo do navegador'
        : 'Autorize o acesso às pastas nas configurações');
    }
    return 0;
  }

  folderRescanInProgress = true;
  setRescanButtonBusy(true);
  try {
    const count = await refreshFolderPlaylist({ notify, resetIndex });
    await refreshPhotoViews();
    return count;
  } finally {
    folderRescanInProgress = false;
    setRescanButtonBusy(false);
  }
}

function updatePhotoActionButtons() {
  const hasFolders = usesFolderSource();
  const hasNativeLibrary = usesNativePhotoLibrary();
  const listBtn = document.getElementById('btn-show-photo-list');
  const rescanBtn = document.getElementById('btn-rescan-folders');
  const refreshBtn = document.getElementById('btn-refresh-photo-library');
  if (listBtn) {
    listBtn.disabled = !hasFolders;
    if (!hasFolders) {
      photoPlaylistListVisible = false;
      listBtn.classList.remove('is-active');
    }
  }
  if (rescanBtn) rescanBtn.disabled = !hasFolders || isNativePhotoLibraryMode();
  if (refreshBtn) refreshBtn.disabled = !isNativePhotoLibraryMode();
}

function formatPlaylistPath(path) {
  const splitAt = path.indexOf('::');
  if (splitAt === -1) return path;
  const folderId = path.slice(0, splitAt);
  const rel = path.slice(splitAt + 2);
  const folder = State.linkedFolders.find((item) => item.id === folderId);
  const folderName = folder?.name || 'Pasta';
  return rel ? `${folderName}/${rel}` : folderName;
}

function createPlaylistThumbPlaceholder(loading = false) {
  const el = document.createElement('span');
  el.className = `photo-playlist-thumb photo-playlist-thumb--empty${loading ? ' photo-playlist-thumb--loading' : ''}`;
  el.textContent = loading ? '…' : '?';
  return el;
}

async function fillPlaylistThumbnails(panel, playlist, renderGen) {
  const items = panel.querySelectorAll('.photo-playlist-item');
  const batchSize = 8;

  for (let start = 0; start < playlist.length; start += batchSize) {
    if (renderGen !== photoPlaylistRenderGen) return;

    const end = Math.min(start + batchSize, playlist.length);
    await Promise.all(Array.from({ length: end - start }, async (_, offset) => {
      const index = start + offset;
      const path = playlist[index];
      const slot = items[index]?.querySelector('.photo-playlist-thumb-slot');
      if (!slot || renderGen !== photoPlaylistRenderGen) return;

      try {
        const file = await getFileForPlaylistPath(path);
        if (!file || renderGen !== photoPlaylistRenderGen) {
          slot.replaceWith(createPlaylistThumbPlaceholder(false));
          return;
        }
        const thumbSrc = await createDisplayObjectUrlFromFile(file, { thumbnail: true });
        if (!thumbSrc || renderGen !== photoPlaylistRenderGen) {
          slot.replaceWith(createPlaylistThumbPlaceholder(false));
          return;
        }
        previewObjectUrls.add(thumbSrc);
        const img = document.createElement('img');
        img.className = 'photo-playlist-thumb';
        img.src = thumbSrc;
        img.alt = '';
        img.loading = 'lazy';
        slot.replaceWith(img);
      } catch (e) {
        console.warn('fillPlaylistThumbnails:', e);
        slot.replaceWith(createPlaylistThumbPlaceholder(false));
      }
    }));

    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

function renderPlaylistPanelList(panel, playlist) {
  const visibleCount = playlist.filter((path) => !isPhotoHidden(path)).length;
  panel.innerHTML = `
    <div class="photo-playlist-header">Ordem de exibição — ${visibleCount} de ${playlist.length} foto${playlist.length === 1 ? '' : 's'}</div>
    <div class="photo-playlist-row photo-playlist-row--head" aria-hidden="true">
      <span>Posição</span>
      <span>Foto</span>
      <span>Endereço</span>
      <span>Exibir</span>
    </div>
    <ul class="photo-playlist-list">
      ${playlist.map((path, index) => {
        const displayPath = formatPlaylistPath(path);
        const hidden = isPhotoHidden(path);
        return `
        <li class="photo-playlist-item${hidden ? ' photo-playlist-item--hidden' : ''}" data-path="${escapeHtml(path)}">
          <span class="photo-playlist-pos">${index + 1}</span>
          <span class="photo-playlist-thumb-slot">${createPlaylistThumbPlaceholder(true).outerHTML}</span>
          <span class="photo-playlist-path" title="${escapeHtml(displayPath)}">${escapeHtml(displayPath)}</span>
          <button type="button" class="photo-playlist-hide-btn${hidden ? ' is-hidden' : ''}" data-path="${escapeHtml(path)}" aria-pressed="${hidden ? 'true' : 'false'}" title="${hidden ? 'Voltar a exibir esta foto' : 'Não mostrar esta foto'}">${hidden ? 'Mostrar' : 'Ocultar'}</button>
        </li>
      `;
      }).join('')}
    </ul>
  `;
  bindPlaylistHideControls(panel);
}

function bindPlaylistHideControls(panel) {
  panel.querySelectorAll('.photo-playlist-hide-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const path = btn.getAttribute('data-path');
      if (!path) return;
      const hide = !isPhotoHidden(path);
      setPhotoHidden(path, hide);
      void refreshPhotoViews();
      void renderPhotoPlaylistList();
    });
  });
}

async function renderPhotoPlaylistList() {
  const panel = document.getElementById('photo-playlist-panel');
  const toggleBtn = document.getElementById('btn-show-photo-list');
  if (!panel) return;

  if (!photoPlaylistListVisible) {
    photoPlaylistRenderGen += 1;
    panel.classList.add('hidden');
    panel.innerHTML = '';
    toggleBtn?.classList.remove('is-active');
    return;
  }

  const renderGen = ++photoPlaylistRenderGen;
  toggleBtn?.classList.add('is-active');
  panel.classList.remove('hidden');

  if (!usesFolderSource()) {
    panel.innerHTML = '<p class="settings-hint">Nenhuma pasta vinculada.</p>';
    return;
  }

  const today = getTodayKey();
  const needsBuild = !State.folderPlaylist.length || State.folderPlaylistDate !== today;

  if (needsBuild) {
    panel.innerHTML = '<p class="settings-hint">Lendo imagens da pasta…</p>';
    try {
      await refreshFolderPlaylist({
        notify: false,
        resetIndex: false,
        onProgress: (count) => {
          if (renderGen !== photoPlaylistRenderGen) return;
          panel.innerHTML = `<p class="settings-hint">Lendo imagens da pasta… ${count} encontrada${count === 1 ? '' : 's'}</p>`;
        },
      });
    } catch (e) {
      console.warn('renderPhotoPlaylistList build:', e);
      if (renderGen === photoPlaylistRenderGen) {
        const detail = formatFolderReadError(e);
        panel.innerHTML = `<p class="settings-hint">${escapeHtml(detail)}</p>`;
      }
      return;
    }
  }

  if (renderGen !== photoPlaylistRenderGen) return;

  const playlist = [...State.folderPlaylist];
  if (!playlist.length) {
    panel.innerHTML = '<p class="settings-hint">Nenhuma imagem na ordem de exibição. Use Releitura das pastas.</p>';
    return;
  }

  revokePreviewObjectUrls();
  renderPlaylistPanelList(panel, playlist);
  void fillPlaylistThumbnails(panel, playlist, renderGen);
}

function togglePhotoPlaylistList() {
  if (!usesFolderSource()) {
    showToast('Nenhuma pasta vinculada');
    return;
  }

  photoPlaylistListVisible = !photoPlaylistListVisible;
  const btn = document.getElementById('btn-show-photo-list');
  btn?.classList.toggle('is-active', photoPlaylistListVisible);

  void (async () => {
    if (photoPlaylistListVisible) {
      const access = await ensureAllLinkedFolderPermissions({ interactive: false });
      await updateFolderPermissionBanner();
      void updateLinkedFoldersPermissionLabels();
      if (!access.ok) {
        photoPlaylistListVisible = false;
        btn?.classList.remove('is-active');
        showToast('Clique em "Autorizar acesso às pastas" abaixo');
        return;
      }
    }
    await renderPhotoPlaylistList();
  })();
}

async function ensureFolderPlaylistForToday() {
  if (!usesFolderSource()) return;

  const access = await ensureAllLinkedFolderPermissions({ interactive: false });
  if (!access.ok) return;

  const today = getTodayKey();
  if (State.folderPlaylistDate !== today || !State.folderPlaylist.length) {
    await refreshFolderPlaylist({ notify: false, resetIndex: false });
  }
}

async function getFolderPlaylistNames() {
  await ensureFolderPlaylistForToday();
  return getVisibleFolderPlaylist();
}

async function readFolderImageAtIndex(index, retry = 0) {
  const names = await getFolderPlaylistNames();
  if (!names.length) return { src: null, total: 0, name: '' };

  const path = names[index % names.length];
  try {
    const file = await getFileForPlaylistPath(path);
    if (!file) throw new Error('missing file');
    const src = await createDisplayObjectUrlFromFile(file);
    if (!src) throw new Error('display url failed');
    return {
      src,
      total: names.length,
      name: file.name || path.split('/').pop() || path,
    };
  } catch (e) {
    if (retry > 1) return { src: null, total: names.length, name: '' };
    await syncFolderPlaylistWithDisk();
    return readFolderImageAtIndex(index, retry + 1);
  }
}

function detectAppleMobilePlatform() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPod|iPad/i.test(ua)) return true;
  const platform = navigator.platform || '';
  if (/iPad/i.test(platform)) return true;
  if (navigator.maxTouchPoints > 1 && (/Macintosh|MacIntel/i.test(ua) || platform === 'MacIntel')) {
    return true;
  }
  return false;
}

function isAppleMobileDevice() {
  return detectAppleMobilePlatform();
}

function supportsDirectoryPicker() {
  if (isAppleMobileDevice()) return false;
  return (
    'showDirectoryPicker' in window &&
    window.isSecureContext &&
    window.self === window.top
  );
}

function getFolderPickerInput() {
  return document.getElementById('cfg-photo-folder-fallback');
}

function getGalleryPickerInput() {
  return document.getElementById('cfg-photo-gallery-ios');
}

function updateFolderPickerButtons() {
  const nativeBtn = document.getElementById('btn-add-photo-folder-native');
  const fallbackLabel = document.getElementById('btn-add-photo-folder-fallback');
  const galleryLabel = document.getElementById('btn-add-photo-gallery-ios');
  const nativeLibraryPanel = document.getElementById('native-photo-library-panel');
  const folderRow = document.getElementById('photo-folder-row');
  if (!nativeBtn || !fallbackLabel) return;

  const onAppleMobile = isAppleMobileDevice();
  const onCapacitorIOS = typeof MuralPlatform !== 'undefined' && MuralPlatform.isNativeIOS();
  document.documentElement.classList.toggle('platform-ios', onAppleMobile || onCapacitorIOS);
  document.documentElement.classList.toggle('platform-capacitor-ios', onCapacitorIOS);

  if (onCapacitorIOS) {
    nativeBtn.hidden = true;
    fallbackLabel.hidden = true;
    if (galleryLabel) galleryLabel.hidden = true;
    if (folderRow) folderRow.hidden = true;
    if (nativeLibraryPanel) nativeLibraryPanel.hidden = false;
    return;
  }

  if (nativeLibraryPanel) nativeLibraryPanel.hidden = true;
  if (folderRow) folderRow.hidden = false;

  if (onAppleMobile) {
    nativeBtn.hidden = true;
    fallbackLabel.hidden = true;
    if (galleryLabel) {
      galleryLabel.hidden = false;
      const hasGallery = State.linkedFolders.some((folder) => folder.gallerySource);
      galleryLabel.textContent = hasGallery ? 'Adicionar mais fotos' : 'Incluir fotos da galeria';
    }
    return;
  }

  if (galleryLabel) galleryLabel.hidden = true;
  nativeBtn.textContent = 'Incluir pasta';
  const useNative = supportsDirectoryPicker();
  nativeBtn.hidden = !useNative;
  fallbackLabel.hidden = useNative;
}

function openGalleryPicker() {
  const input = getGalleryPickerInput();
  if (!input) {
    showToast('Seletor de fotos indisponível neste dispositivo');
    return;
  }
  input.click();
}

function openFolderPickerFallback() {
  const input = getFolderPickerInput();
  if (!input) {
    showToast('Seletor de pasta indisponível neste navegador');
    return;
  }
  input.click();
}

function openFolderPicker() {
  if (isAppleMobileDevice()) {
    openGalleryPicker();
    return;
  }
  if (supportsDirectoryPicker()) {
    void pickPhotoFolderNative();
    return;
  }
  openFolderPickerFallback();
}

async function afterFolderAdded({ notify = true } = {}) {
  renderLinkedFoldersList();
  renderFolderInfo();
  updateFolderPickerButtons();
  updatePhotoActionButtons();

  let count = 0;
  if (notify) showToast('Lendo imagens da pasta…');
  try {
    count = await refreshFolderPlaylist({ notify: false, resetIndex: true });
  } catch (e) {
    console.warn('afterFolderAdded playlist:', e);
  } finally {
    await refreshPhotoViews();
  }

  if (notify) {
    const names = State.linkedFolders.map((folder) => `"${folder.name}"`).join(', ');
    const persisted = State.linkedFolders.some((folder) => folder.handle);
    const savedNote = persisted ? ' — salva neste dispositivo' : '';
    showToast(count
      ? `Pasta incluída: ${names} — ${count} foto${count === 1 ? '' : 's'} em ordem aleatória${savedNote}`
      : `Pasta incluída: ${names} — nenhuma imagem compatível encontrada${savedNote}`);
  }
}

async function bindFolderHandle(dir) {
  folderPickInProgress = true;
  try {
    const granted = await requestHandleReadPermission(dir);
    if (!granted) {
      showToast('Permissão de leitura da pasta negada');
      return;
    }

    const added = await addLinkedFolderHandle(dir, dir.name);
    if (!added) return;
    const folder = State.linkedFolders.find((f) => f.handle === dir);
    if (folder) markFolderPermissionGranted(folder.id);
    await updateFolderPermissionBanner();
    void updateLinkedFoldersPermissionLabels();
    await afterFolderAdded({ notify: true });
  } catch (e) {
    console.warn('bindFolderHandle:', e);
    showToast('Erro ao incluir a pasta');
  } finally {
    folderPickInProgress = false;
  }
}

async function pickPhotoFolderNative() {
  if (folderPickInProgress) {
    showToast('Aguarde o processamento da pasta anterior');
    return;
  }

  folderPickInProgress = true;
  let dir;
  try {
    showToast('Navegue até a pasta e clique em Abrir');
    dir = await window.showDirectoryPicker({ mode: 'read' });
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.warn('showDirectoryPicker:', e);
    showToast('Abrindo seletor alternativo…');
    openFolderPickerFallback();
    return;
  } finally {
    folderPickInProgress = false;
  }

  await bindFolderHandle(dir);
}

async function handleGalleryPickerInput(input) {
  if (folderPickInProgress) {
    showToast('Aguarde o processamento da pasta anterior');
    return;
  }

  const files = Array.from(input.files || []).filter((file) => isDisplayableImageFile(file));
  input.value = '';
  if (!files.length) {
    showToast('Nenhuma foto selecionada');
    return;
  }

  const existingGallery = State.linkedFolders.find((folder) => folder.gallerySource);
  if (existingGallery) {
    folderPickInProgress = true;
    try {
      const added = await appendToGalleryFolder(existingGallery.id, files);
      await afterFolderAdded({ notify: false });
      const total = existingGallery.files?.length || 0;
      showToast(added
        ? `${added} foto${added === 1 ? '' : 's'} adicionada${added === 1 ? '' : 's'} — ${total} no total`
        : `Nenhuma foto nova — ${total} já incluída${total === 1 ? '' : 's'}`);
    } catch (e) {
      console.warn('appendToGalleryFolder:', e);
      showToast('Erro ao adicionar fotos da galeria');
    } finally {
      folderPickInProgress = false;
    }
    return;
  }

  void applySessionFolder(files, { name: 'Galeria de Fotos', gallerySource: true });
}

async function handleFolderFallbackInput(input) {
  if (folderPickInProgress) {
    showToast('Aguarde o processamento da pasta anterior');
    return;
  }

  if (isAppleMobileDevice()) {
    void handleGalleryPickerInput(input);
    return;
  }

  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length) {
    showToast('Nenhum arquivo selecionado');
    return;
  }

  void applySessionFolder(files);
}

function setupFolderPickerUi() {
  const input = getFolderPickerInput();
  const galleryInput = getGalleryPickerInput();
  if (!input && !galleryInput) return;

  updateFolderPickerButtons();

  if (input && !input.dataset.bound) {
    input.dataset.bound = '1';
    input.addEventListener('change', () => {
      void handleFolderFallbackInput(input);
    });
  }

  if (galleryInput && !galleryInput.dataset.bound) {
    galleryInput.dataset.bound = '1';
    galleryInput.addEventListener('change', () => {
      void handleGalleryPickerInput(galleryInput);
    });
  }

  const nativeBtn = document.getElementById('btn-add-photo-folder-native');
  if (nativeBtn && !nativeBtn.dataset.bound) {
    nativeBtn.dataset.bound = '1';
    nativeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openFolderPicker();
    });
  }

  const fallbackLabel = document.getElementById('btn-add-photo-folder-fallback');
  if (fallbackLabel && !fallbackLabel.dataset.bound) {
    fallbackLabel.dataset.bound = '1';
    fallbackLabel.addEventListener('click', (e) => {
      e.preventDefault();
      openFolderPicker();
    });
  }

  const galleryLabel = document.getElementById('btn-add-photo-gallery-ios');
  if (galleryLabel && !galleryLabel.dataset.bound) {
    galleryLabel.dataset.bound = '1';
    galleryLabel.addEventListener('click', (e) => {
      e.preventDefault();
      openGalleryPicker();
    });
  }
}

async function applySessionFolder(files, { name, gallerySource = false } = {}) {
  const allFiles = Array.from(files);
  if (!allFiles.length) return false;

  const root = name
    || allFiles[0].webkitRelativePath?.split('/')[0]
    || allFiles[0].name
    || 'Pasta';

  const imageFiles = allFiles.filter((file) => isDisplayableImageFile(file));

  folderPickInProgress = true;
  try {
    const added = await addLinkedSessionFolder(root, allFiles, { gallerySource });
    if (!added) return false;

    await afterFolderAdded({ notify: true });

    if (!imageFiles.length) {
      showToast('Nenhuma imagem compatível selecionada (jpg, png, gif, webp, heic)');
    } else if (gallerySource) {
      showToast(`${imageFiles.length} foto${imageFiles.length === 1 ? '' : 's'} da galeria salva${imageFiles.length === 1 ? '' : 's'} neste dispositivo`);
    } else if (!supportsDirectoryPicker()) {
      showToast('Pasta válida só nesta sessão — abra em Chrome/Edge (https) para salvar');
    }
    return true;
  } catch (e) {
    console.warn('applySessionFolder:', e);
    showToast('Erro ao incluir a pasta');
    return false;
  } finally {
    folderPickInProgress = false;
  }
}

async function getPhotoSourceCount() {
  if (usesNativePhotoLibrary()) {
    return PhotoLibraryService.getCount();
  }
  if (usesFolderSource()) {
    await ensureFolderPlaylistForToday();
    return getVisibleFolderPlaylist().length;
  }
  return State.photos.length;
}

async function hasPhotoSources() {
  return (await getPhotoSourceCount()) > 0;
}

async function resolvePhotoAtIndex(index) {
  if (usesNativePhotoLibrary()) {
    PhotoLibraryService.setCurrentIndex(index);
    return PhotoLibraryService.resolvePhotoAtIndex(index, 2048);
  }
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
      if (isNativePhotoLibraryMode()) {
        try {
          await PhotoLibraryService.scanLibrary({ reshuffle: true });
          clockPhotoIndex = 0;
          State.slideIndex = 0;
          await refreshPhotoViews();
          showToast('Biblioteca de fotos atualizada à meia-noite');
        } catch (e) {
          console.warn('midnight native library scan:', e);
        }
      } else if (usesFolderSource()) {
        await rescanLinkedFolders({ notify: true, resetIndex: true, interactive: false });
        if (photoPlaylistListVisible) void renderPhotoPlaylistList();
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
  if (isNativePhotoLibraryMode() && PhotoLibraryService.needsDailyRefresh()) {
    void PhotoLibraryService.scanLibrary({ reshuffle: true }).then(() => {
      clockPhotoIndex = 0;
      State.slideIndex = 0;
      return refreshPhotoViews();
    }).catch((e) => console.warn('daily native library refresh:', e));
    return;
  }
  if (usesFolderSource() && State.folderPlaylistDate !== today) {
    void ensureAllLinkedFolderPermissions({ interactive: false }).then((access) => {
      if (!access.ok) {
        void updateFolderPermissionBanner();
        return;
      }
      void rescanLinkedFolders({ notify: false, resetIndex: true, interactive: false }).then(() => {
        if (photoPlaylistListVisible) void renderPhotoPlaylistList();
      });
    });
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLinkedFoldersList() {
  const list = document.getElementById('linked-folders-list');
  const empty = document.getElementById('linked-folders-empty');
  const panel = document.getElementById('linked-folders-panel');
  if (!list || !empty) return;

  updatePhotoActionButtons();

  if (!State.linkedFolders.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    list.classList.add('hidden');
    if (panel) panel.classList.remove('has-folders');
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');
  if (panel) panel.classList.add('has-folders');

  list.innerHTML = State.linkedFolders.map((folder) => {
    const safeName = escapeHtml(folder.name);
    const kind = folder.gallerySource
      ? 'salva neste dispositivo'
      : (folder.handle ? 'salva neste dispositivo' : 'somente nesta sessão');
    return `
    <li class="linked-folder-item" data-folder-id="${folder.id}">
      <span class="linked-folder-name" title="${safeName}">📁 ${safeName}</span>
      <span class="linked-folder-kind">${kind}</span>
      <button type="button" class="linked-folder-remove" data-folder-id="${folder.id}" title="Remover pasta" aria-label="Remover pasta ${safeName}">✕</button>
    </li>
  `;
  }).join('');

  list.querySelectorAll('.linked-folder-remove').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const folderId = btn.getAttribute('data-folder-id');
      const folder = State.linkedFolders.find((item) => item.id === folderId);
      if (!folder) return;
      if (!confirm(`Remover a pasta "${folder.name}"?`)) return;

      await removeLinkedFolder(folderId);
      revokeClockPhotoObjectUrl();
      revokePreviewObjectUrls();
      renderLinkedFoldersList();
      renderFolderInfo();
      await refreshPhotoViews();
      await updateFolderPermissionBanner();
      showToast(`Pasta "${folder.name}" removida`);
    });
  });

  void updateLinkedFoldersPermissionLabels();
  void updateFolderPermissionBanner();
}

function renderFolderInfo() {
  renderLinkedFoldersList();
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
    list.innerHTML = '<p class="settings-hint">Usando pastas vinculadas. URLs abaixo são ignoradas enquanto houver pastas ativas.</p>';
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
  if (photoPlaylistListVisible && usesFolderSource()) {
    await renderPhotoPlaylistList();
  }
}

async function refreshPhotoViews() {
  try {
    renderFolderInfo();
    await renderPhotosPreviews();
    if (State.mode === 'slideshow') await startSlideshow();
    await startClockPhoto();
  } catch (e) {
    console.warn('refreshPhotoViews:', e);
  }
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

function formatPhotoDate(date) {
  return `${DIAS[date.getDay()]}, ${date.getDate()} de ${MESES[date.getMonth()]} de ${date.getFullYear()}`;
}

function formatPhotoTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

let clockPhotoMetaRequest = 0;
const PHOTO_META_UNKNOWN = 'Não Identificado';

async function getPhotoFileAtIndex(index) {
  if (usesFolderSource()) {
    const names = await getFolderPlaylistNames();
    if (!names.length) return null;
    return getFileForPlaylistPath(names[index % names.length]);
  }

  if (!State.photos.length) return null;
  const photo = State.photos[index % State.photos.length];
  const url = photo?.url;
  if (!url || (!url.startsWith('blob:') && !url.startsWith('data:'))) return null;

  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return new File([blob], photo.name || 'photo.jpg', { type: blob.type || 'image/jpeg' });
  } catch (e) {
    console.warn('getPhotoFileAtIndex:', e);
    return null;
  }
}

async function extractPhotoMetadata(file) {
  if (!file) return null;

  const meta = { location: null, date: null, time: null };

  try {
    await loadExifrLibrary();
    if (exifrAvailable()) {
      const parsed = await exifr.parse(file, {
        gps: true,
        tiff: true,
        exif: true,
        ifd0: true,
        iptc: true,
        xmp: true,
        mergeOutput: true,
      });

      const dt = parsed?.DateTimeOriginal || parsed?.CreateDate || parsed?.ModifyDate;
      if (dt instanceof Date && !Number.isNaN(dt.getTime())) {
        meta.date = formatPhotoDate(dt);
        meta.time = formatPhotoTime(dt);
      }

      meta.location = await resolvePhotoLocation(file, parsed);
    }
  } catch (e) {
    console.warn('extractPhotoMetadata:', e);
  }

  if (!meta.date && file.lastModified) {
    const fallback = new Date(file.lastModified);
    if (!Number.isNaN(fallback.getTime())) {
      meta.date = formatPhotoDate(fallback);
      meta.time = formatPhotoTime(fallback);
    }
  }

  return meta;
}

function hideClockPhotoMeta() {
  const overlay = document.getElementById('clock-photo-meta');
  overlay?.classList.add('hidden');
  if (overlay) {
    overlay.style.left = '';
    overlay.style.maxWidth = '';
  }
}

function syncClockPhotoMetaLayout() {
  const overlay = document.getElementById('clock-photo-meta');
  const leftCol = document.getElementById('clock-left-col');
  if (!overlay || !leftCol || overlay.classList.contains('hidden')) return;

  const colRect = leftCol.getBoundingClientRect();
  overlay.style.maxWidth = `${Math.min(380, Math.max(120, colRect.width - 16))}px`;

  const overlayWidth = overlay.offsetWidth;
  const left = colRect.left + (colRect.width / 2) - (overlayWidth / 2);
  overlay.style.left = `${left}px`;
}

let clockPhotoMetaLayoutBound = false;

function bindClockPhotoMetaLayoutSync() {
  if (clockPhotoMetaLayoutBound) return;
  clockPhotoMetaLayoutBound = true;

  window.addEventListener('resize', syncClockPhotoMetaLayout);
  const leftCol = document.getElementById('clock-left-col');
  if (leftCol && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => syncClockPhotoMetaLayout()).observe(leftCol);
  }
}

async function updateClockPhotoMeta(photoIndex) {
  const overlay = document.getElementById('clock-photo-meta');
  if (!overlay) return;

  const requestId = ++clockPhotoMetaRequest;
  const file = await getPhotoFileAtIndex(photoIndex);
  if (requestId !== clockPhotoMetaRequest) return;

  const meta = await extractPhotoMetadata(file);
  if (requestId !== clockPhotoMetaRequest) return;

  const locLine = document.getElementById('clock-photo-meta-location');
  const locValue = document.getElementById('clock-photo-meta-location-value');
  const dateLine = document.getElementById('clock-photo-meta-date');
  const timeLine = document.getElementById('clock-photo-meta-time');

  overlay.classList.remove('hidden');
  if (locLine) {
    locLine.hidden = false;
    if (locValue) locValue.textContent = meta?.location || PHOTO_META_UNKNOWN;
  }
  if (dateLine) {
    dateLine.textContent = meta?.date || PHOTO_META_UNKNOWN;
    dateLine.hidden = false;
  }
  if (timeLine) {
    timeLine.textContent = meta?.time || PHOTO_META_UNKNOWN;
    timeLine.hidden = false;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(syncClockPhotoMetaLayout);
  });
}

function updateClockGlassElement(el, text) {
  if (!el) return;
  el.dataset.text = text;
  const layers = el.querySelectorAll('.clock-glass-shadow, .clock-glass-face');
  if (layers.length) {
    layers.forEach((node) => {
      node.textContent = text;
    });
    return;
  }
  el.textContent = text;
}

let clockToneCanvas = null;
let clockToneCtx = null;
let lastClockTone = '';

function ensureClockToneCanvas() {
  if (!clockToneCanvas) {
    clockToneCanvas = document.createElement('canvas');
    clockToneCtx = clockToneCanvas.getContext('2d', { willReadFrequently: true });
  }
  return clockToneCtx;
}

function setClockTone(tone) {
  const next = tone === 'light' || tone === 'dark' ? tone : 'neutral';
  if (lastClockTone === next) return;
  lastClockTone = next;
  if (next === 'neutral') {
    document.documentElement.removeAttribute('data-clock-tone');
    return;
  }
  document.documentElement.dataset.clockTone = next;
}

function sampleClockRegionLuminance(image, region) {
  const ctx = ensureClockToneCanvas();
  if (!ctx || !image?.naturalWidth || !image?.naturalHeight) return null;

  const sampleW = 48;
  const sampleH = 32;
  clockToneCanvas.width = sampleW;
  clockToneCanvas.height = sampleH;

  const sx = Math.max(0, Math.round(region.x * image.naturalWidth));
  const sy = Math.max(0, Math.round(region.y * image.naturalHeight));
  const sw = Math.max(1, Math.round(region.w * image.naturalWidth));
  const sh = Math.max(1, Math.round(region.h * image.naturalHeight));

  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sampleW, sampleH);
  const { data } = ctx.getImageData(0, 0, sampleW, sampleH);

  let total = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    total += (0.2126 * data[i]) + (0.7152 * data[i + 1]) + (0.0722 * data[i + 2]);
  }
  return total / pixels;
}

function updateClockToneFromImage(img) {
  if (!img?.complete || !img.naturalWidth) {
    setClockTone('neutral');
    return;
  }

  const clockEl = document.getElementById('clock-time');
  const mode = document.getElementById('mode-clock');
  if (!clockEl || !mode) {
    setClockTone('neutral');
    return;
  }

  const modeRect = mode.getBoundingClientRect();
  const clockRect = clockEl.getBoundingClientRect();
  if (!modeRect.width || !modeRect.height || !clockRect.width) {
    setClockTone('neutral');
    return;
  }

  const luminance = sampleClockRegionLuminance(img, {
    x: (clockRect.left - modeRect.left) / modeRect.width,
    y: (clockRect.top - modeRect.top) / modeRect.height,
    w: clockRect.width / modeRect.width,
    h: clockRect.height / modeRect.height,
  });

  if (luminance == null) {
    setClockTone('neutral');
    return;
  }

  if (luminance >= 168) setClockTone('light');
  else if (luminance <= 92) setClockTone('dark');
  else setClockTone('neutral');
}

function tickClock() {
  const now = new Date();
  const timeStr = formatTime(now);
  const dateStr = formatDate(now);
  const secStr = pad(now.getSeconds());

  // modo relógio
  updateClockGlassElement(document.getElementById('clock-time'), timeStr);
  updateClockGlassElement(document.getElementById('clock-seconds'), secStr);
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

  if (State.weatherData?.hourly) {
    const hourlyStamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (tickClock._hourlyStamp !== hourlyStamp) {
      tickClock._hourlyStamp = hourlyStamp;
      renderHourlyForecast(State.weatherData.hourly);
    }
  }
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

async function geocodeCityOpenMeteo(cityName) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=5&language=pt&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocoding ${res.status}`);
  const data = await res.json();
  const results = data.results || [];
  if (!results.length) throw new Error('cidade não encontrada');
  const pick = results[0];
  return {
    lat: pick.latitude,
    lon: pick.longitude,
    label: pick.name,
  };
}

async function geocodeCityNominatim(cityName) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'pt-BR' } });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const data = await res.json();
  if (!data.length) throw new Error('cidade não encontrada');
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    label: cityName.split(',')[0],
  };
}

async function geocodeCity(cityName) {
  try {
    return await geocodeCityOpenMeteo(cityName);
  } catch (e) {
    console.warn('geocode open-meteo:', e);
    return geocodeCityNominatim(cityName);
  }
}

function hasValidCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

async function tryOpenWeatherCoords(city, apiKey) {
  if (!apiKey) return null;
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=metric&lang=pt_br&appid=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('OpenWeatherMap:', res.status);
      return null;
    }
    const d = await res.json();
    if (!d?.coord) return null;
    return { lat: d.coord.lat, lon: d.coord.lon };
  } catch (e) {
    console.warn('OpenWeatherMap:', e);
    return null;
  }
}

async function fetchOpenMeteoForecast(lat, lon) {
  const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
    `&hourly=temperature_2m,weather_code` +
    `&timezone=auto&forecast_days=5`;
  const omRes = await fetch(omUrl);
  if (!omRes.ok) throw new Error(`open-meteo ${omRes.status}`);
  return omRes.json();
}

async function fetchWeather(isRetry = false) {
  const { city, apiKey } = State.cfg;
  if (!city) {
    updateWeatherUI({ icon:'🌡', temp:'--°', city:'(sem cidade)', desc:'selecione uma cidade', feels:'--°', humidity:'--%', daily: null, hourly: null });
    return;
  }

  try {
    let lat = State.cfg.lat;
    let lon = State.cfg.lon;
    let displayCity = city.split(',')[0];

    if (!hasValidCoords(lat, lon)) {
      const owm = await tryOpenWeatherCoords(city, apiKey);
      if (owm) {
        lat = owm.lat;
        lon = owm.lon;
      } else {
        const coords = await geocodeCity(city);
        lat = coords.lat;
        lon = coords.lon;
        if (coords.label) displayCity = coords.label;
      }
      State.cfg.lat = lat;
      State.cfg.lon = lon;
      saveConfig();
    }

    const om = await fetchOpenMeteoForecast(lat, lon);
    const cur = om.current;
    if (!cur) throw new Error('open-meteo sem dados atuais');

    const code = cur.weather_code;
    State.weatherData = {
      icon: WMO_ICONS[code] || '🌡',
      temp: Math.round(cur.temperature_2m) + '°',
      feels: Math.round(cur.apparent_temperature) + '°',
      city: displayCity,
      desc: WMO_DESC[code] || 'Clima',
      humidity: cur.relative_humidity_2m + '%',
      daily: om.daily,
      hourly: om.hourly,
      hourlyOffset: om.current.time,
    };
    updateWeatherUI(State.weatherData);
  } catch (e) {
    console.warn('weather error:', e);
    if (!isRetry) {
      State.cfg.lat = null;
      State.cfg.lon = null;
      saveConfig();
      return fetchWeather(true);
    }
    updateWeatherUI({
      icon: '⚠️',
      temp: '--°',
      city: city.split(',')[0],
      desc: 'erro ao buscar clima',
      feels: '--°',
      humidity: '--%',
      daily: null,
      hourly: null,
    });
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
  renderHourlyForecast(w.hourly);
  updateCityNav();
}

function renderDailyForecast(daily) {
  const el = document.getElementById('weather-daily');
  if (!el) return;
  if (!daily) {
    el.innerHTML = '';
    return;
  }
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

const HOURLY_SLOT_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
const HOURLY_SLOT_COUNT = 8;

function getUpcoming3HourSlots(count = HOURLY_SLOT_COUNT, now = new Date()) {
  const slots = [];
  for (let dayOffset = 0; dayOffset < 3 && slots.length < count; dayOffset += 1) {
    for (const hour of HOURLY_SLOT_HOURS) {
      const slot = new Date(now);
      slot.setDate(slot.getDate() + dayOffset);
      slot.setHours(hour, 0, 0, 0);
      if (slot.getTime() > now.getTime()) {
        slots.push(slot);
        if (slots.length >= count) break;
      }
    }
  }
  return slots;
}

function findHourlyIndexForTime(hourly, when) {
  const target = when.getTime();
  for (let i = 0; i < hourly.time.length; i += 1) {
    const ts = new Date(hourly.time[i]).getTime();
    if (ts === target) return i;
  }
  for (let i = 0; i < hourly.time.length; i += 1) {
    const ts = new Date(hourly.time[i]).getTime();
    if (ts >= target) return i;
  }
  return -1;
}

function formatHourlyLabel(isoTime) {
  if (!isoTime) return '--:--';
  const h = parseInt(isoTime.substring(11, 13), 10);
  const m = isoTime.substring(14, 16);
  return `${String(h).padStart(2, '0')}:${m}`;
}

function formatHourlyLabelFromDate(date) {
  return `${String(date.getHours()).padStart(2, '0')}:00`;
}

function renderHourlyForecast(hourly) {
  const el = document.getElementById('weather-hourly');
  if (!el) return;
  if (!hourly) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = '';

  const now = new Date();
  const upcoming = getUpcoming3HourSlots(HOURLY_SLOT_COUNT, now);

  while (upcoming.length < HOURLY_SLOT_COUNT) {
    const last = upcoming[upcoming.length - 1] || now;
    const next = new Date(last);
    next.setHours(next.getHours() + 3, 0, 0, 0);
    upcoming.push(next);
  }

  upcoming.slice(0, HOURLY_SLOT_COUNT).forEach((slotWhen) => {
    const idx = findHourlyIndexForTime(hourly, slotWhen);
    const hasData = idx >= 0;
    const timeStr = hasData ? hourly.time[idx] : '';
    const code = hasData ? hourly.weather_code[idx] : null;
    const temp = hasData ? Math.round(hourly.temperature_2m[idx]) : null;
    const col = document.createElement('div');
    col.className = 'forecast-col';
    col.innerHTML = `
      <span class="fc-day">${hasData ? formatHourlyLabel(timeStr) : formatHourlyLabelFromDate(slotWhen)}</span>
      <span class="fc-icon">${WMO_ICONS[code] || '🌡'}</span>
      <span class="fc-max">${temp != null ? `${temp}°` : '--°'}</span>
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

  if (usesNativePhotoLibrary()) {
    const current = PhotoLibraryService.getCurrentIndex();
    const next = (current + delta + count) % count;
    PhotoLibraryService.setCurrentIndex(next);
    clockPhotoIndex = next;
  } else {
    clockPhotoIndex = (clockPhotoIndex + delta + count) % count;
  }
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

let clockNavHideTimer = null;
const CLOCK_NAV_HIDE_MS = 3500;

function showClockNavArrows() {
  document.body.classList.add('clock-nav-visible');
  clearTimeout(clockNavHideTimer);
  clockNavHideTimer = setTimeout(() => {
    document.body.classList.remove('clock-nav-visible');
  }, CLOCK_NAV_HIDE_MS);
}

function setupClockNavAutoReveal() {
  const clockMode = document.getElementById('mode-clock');
  if (!clockMode) return;

  clockMode.addEventListener('mousemove', showClockNavArrows);
  clockMode.addEventListener('touchstart', showClockNavArrows, { passive: true });
}

async function updateClockPhoto(skipAttempts = 0) {
  const img = document.getElementById('clock-photo-img');
  const empty = document.getElementById('clock-photo-empty');
  const frame = document.getElementById('clock-photo-frame');
  if (!img) return;

  const count = await getPhotoSourceCount();
  if (!count) {
    revokeClockPhotoObjectUrl();
    img.removeAttribute('src');
    img.style.opacity = '0';
    frame?.classList.remove('has-photo');
    if (empty) empty.style.display = 'flex';
    hideClockPhotoMeta();
    setClockTone('neutral');
    await updateClockPhotoNav();
    return;
  }

  if (skipAttempts >= count) {
    revokeClockPhotoObjectUrl();
    img.removeAttribute('src');
    img.style.opacity = '0';
    frame?.classList.remove('has-photo');
    if (empty) empty.style.display = 'flex';
    hideClockPhotoMeta();
    setClockTone('neutral');
    await updateClockPhotoNav();
    return;
  }

  if (clockPhotoIndex >= count) clockPhotoIndex = 0;
  const currentIndex = clockPhotoIndex % count;
  const { src } = await resolvePhotoAtIndex(currentIndex);
  if (!isUsableImageSrc(src)) {
    clockPhotoIndex = (clockPhotoIndex + 1) % count;
    return updateClockPhoto(skipAttempts + 1);
  }

  revokeClockPhotoObjectUrl();
  if (src.startsWith('blob:')) {
    clockPhotoObjectUrl = src;
  }

  img.style.opacity = '0';
  const loader = new Image();
  loader.onload = () => {
    img.src = src;
    img.style.opacity = '1';
    frame?.classList.add('has-photo');
    if (empty) empty.style.display = 'none';
    updateClockToneFromImage(img);
    void updateClockPhotoMeta(currentIndex);
  };
  loader.onerror = () => {
    console.warn('clock photo failed to load');
    revokeClockPhotoObjectUrl();
    img.removeAttribute('src');
    img.style.opacity = '0';
    hideClockPhotoMeta();
    setClockTone('neutral');
    clockPhotoIndex = (clockPhotoIndex + 1) % count;
    void updateClockPhoto(skipAttempts + 1);
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
  if (!isUsableImageSrc(src)) return;
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

  const effect = typeof SlideshowService !== 'undefined'
    ? SlideshowService.pickEffect(State.cfg.transition || 'fade')
    : (State.cfg.transition || 'fade');

  if (typeof SlideshowService !== 'undefined') {
    SlideshowService.applyTransition({
      container,
      incoming,
      outgoing,
      src,
      effectName: effect,
      onComplete: () => {
        State.slideActive = incomingKey;
        if (counter) counter.textContent = `${index + 1} / ${total}`;
      },
    });
    if (effect === 'none') {
      State.slideActive = incomingKey;
      if (counter) counter.textContent = `${index + 1} / ${total}`;
    }
    return;
  }

  const EFFECTS = ['fade', 'slide', 'zoom', 'kenburns'];
  let legacyEffect = State.cfg.transition || 'fade';
  if (legacyEffect === 'random') legacyEffect = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
  if (legacyEffect === 'none') {
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
    container.classList.add(`fx-${legacyEffect}`);
    incoming.classList.add('active', 'slide-in');
    outgoing.classList.add('slide-out');

    const duration = legacyEffect === 'kenburns' ? 1000 : 700;
    setTimeout(() => {
      outgoing.classList.remove('active', 'slide-out');
      incoming.classList.remove('slide-in');
      container.className = legacyEffect === 'kenburns' ? 'fx-kenburns' : '';
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

  const modeEl = document.getElementById(`mode-${mode}`);
  if (modeEl) modeEl.classList.add('active');

  if (mode === 'slideshow') void startSlideshow();
  if (mode === 'cameras') renderCameras();
}

// ─── CONFIGURAÇÕES UI ─────────────────────────
async function refreshStoredFolderAccess() {
  await syncPersistedFolderPermissions();
  const needs = await getFoldersNeedingPermission();
  if (needs.length > 0) {
    await grantAllFolderAccess();
  }
  await updateFolderPermissionBanner();
  void updateLinkedFoldersPermissionLabels();
}

function openSettings() {
  const cfg = State.cfg;
  document.getElementById('cfg-interval').value = cfg.interval;
  document.getElementById('cfg-transition').value = cfg.transition || 'fade';
  document.getElementById('cfg-24h').checked = cfg.format24h;
  document.getElementById('cfg-night-auto').checked = cfg.nightAuto;
  document.getElementById('cfg-night-start').value = cfg.nightStart;
  document.getElementById('cfg-night-end').value = cfg.nightEnd;
  document.getElementById('cfg-wakelock').checked = cfg.wakelock;

  renderSettingsCitiesList();
  renderFolderInfo();
  updateFolderPickerButtons();
  void (async () => {
    await refreshStoredFolderAccess();
    if (photoPlaylistListVisible) await renderPhotosPreviews();
  })();
  renderCamerasList();

  document.getElementById('settings-panel').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-panel').classList.add('hidden');
}

function loadSettingsSectionsState() {
  try {
    const raw = localStorage.getItem('sd_settings_sections');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSettingsSectionsState(state) {
  try {
    localStorage.setItem('sd_settings_sections', JSON.stringify(state));
  } catch {}
}

function initSettingsSections() {
  const saved = loadSettingsSectionsState();

  document.querySelectorAll('.settings-section[data-section]').forEach((section) => {
    const id = section.dataset.section;
    const toggle = section.querySelector('.settings-section-toggle');
    if (!toggle) return;

    const applyCollapsed = (collapsed) => {
      section.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };

    applyCollapsed(saved[id] === false);

    toggle.addEventListener('click', () => {
      const collapsed = !section.classList.contains('collapsed');
      applyCollapsed(collapsed);
      saved[id] = !collapsed;
      saveSettingsSectionsState(saved);
    });
  });
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
const PSEUDO_FULLSCREEN_CLASS = 'pseudo-fullscreen';
const PSEUDO_FULLSCREEN_KEY = 'sd_pseudo_fs';

function isStandaloneDisplay() {
  return window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches;
}

function nativeFullscreenActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function isPseudoFullscreen() {
  return document.body.classList.contains(PSEUDO_FULLSCREEN_CLASS);
}

function isFullscreen() {
  return nativeFullscreenActive() || isPseudoFullscreen();
}

function supportsNativeFullscreen() {
  const candidates = [document.documentElement, document.getElementById('app'), document.body];
  return candidates.some((el) => el && (el.requestFullscreen || el.webkitRequestFullscreen));
}

function shouldUseNativeFullscreen() {
  // iPadOS Safari shows a mandatory system "X" exit control in native fullscreen.
  return !isAppleMobileDevice();
}

function enterPseudoFullscreen() {
  document.body.classList.add(PSEUDO_FULLSCREEN_CLASS);
  try { sessionStorage.setItem(PSEUDO_FULLSCREEN_KEY, '1'); } catch {}
  if (isAppleMobileDevice() && !isStandaloneDisplay()) {
    window.scrollTo(0, 1);
    setTimeout(() => window.scrollTo(0, 0), 100);
  }
}

function exitPseudoFullscreen() {
  document.body.classList.remove(PSEUDO_FULLSCREEN_CLASS);
  try { sessionStorage.removeItem(PSEUDO_FULLSCREEN_KEY); } catch {}
}

function restorePseudoFullscreen() {
  try {
    if (sessionStorage.getItem(PSEUDO_FULLSCREEN_KEY) === '1') {
      document.body.classList.add(PSEUDO_FULLSCREEN_CLASS);
    }
  } catch {}
}

async function enterNativeFullscreen() {
  const candidates = [document.documentElement, document.getElementById('app'), document.body]
    .filter(Boolean);

  for (const el of candidates) {
    if (typeof el.requestFullscreen === 'function') {
      try {
        await el.requestFullscreen();
        if (nativeFullscreenActive()) return true;
      } catch (e) {
        console.warn('requestFullscreen:', e);
      }
    }

    if (typeof el.webkitRequestFullscreen === 'function') {
      try {
        const keyboardFlag = (typeof Element !== 'undefined' && Element.ALLOW_KEYBOARD_INPUT) || 1;
        const result = el.webkitRequestFullscreen(keyboardFlag);
        if (result && typeof result.then === 'function') await result;
        if (nativeFullscreenActive()) return true;
      } catch (e) {
        console.warn('webkitRequestFullscreen:', e);
      }
    }
  }

  return nativeFullscreenActive();
}

async function exitNativeFullscreen() {
  if (!nativeFullscreenActive()) return;

  try {
    if (typeof document.exitFullscreen === 'function') {
      await document.exitFullscreen();
      return;
    }
    if (typeof document.webkitExitFullscreen === 'function') {
      await document.webkitExitFullscreen();
    }
  } catch (e) {
    console.warn('exitFullscreen:', e);
  }
}

function updateFullscreenFab() {
  const btn = document.getElementById('btn-fullscreen-fab');
  if (!btn) return;
  const fs = isFullscreen();
  btn.querySelector('.fab-icon-enter')?.classList.toggle('hidden', fs);
  btn.querySelector('.fab-icon-exit')?.classList.toggle('hidden', !fs);
  const label = fs ? 'Sair da tela cheia' : 'Tela cheia';
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
}

async function toggleFullscreen() {
  if (isFullscreen()) {
    exitPseudoFullscreen();
    await exitNativeFullscreen();
    updateFullscreenFab();
    return;
  }

  let nativeEntered = false;
  if (shouldUseNativeFullscreen() && supportsNativeFullscreen()) {
    try {
      nativeEntered = await enterNativeFullscreen();
    } catch (e) {
      console.warn('toggleFullscreen native:', e);
    }
  }

  if (!nativeEntered) {
    enterPseudoFullscreen();
  }

  updateFullscreenFab();
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
function loadSavedCities() {
  try {
    return JSON.parse(localStorage.getItem('sd_saved_cities') || '[]');
  } catch { return []; }
}

function saveSavedCities(cities) {
  localStorage.setItem('sd_saved_cities', JSON.stringify(cities));
}

function getFavoriteCity() {
  const cities = loadSavedCities();
  return cities.find((city) => city.favorite) || cities[0] || null;
}

function setFavoriteCity(query) {
  const cities = loadSavedCities();
  let found = false;
  cities.forEach((city) => {
    const isFavorite = city.query === query;
    city.favorite = isFavorite;
    if (isFavorite) found = true;
  });
  if (!found) return null;
  saveSavedCities(cities);
  const favorite = cities.find((city) => city.query === query);
  if (favorite) applyCity(favorite, { refreshLists: false });
  renderSettingsCitiesList();
  renderSavedCities();
  updateCityNav();
  return favorite;
}

function addSavedCity(name, query, lat, lon, { favorite = false } = {}) {
  const cities = loadSavedCities();
  const existing = cities.findIndex((city) => city.query === query);
  const wasFavorite = existing !== -1 && cities[existing]?.favorite;

  if (existing !== -1) cities.splice(existing, 1);

  const entry = {
    name,
    query,
    lat: lat ?? null,
    lon: lon ?? null,
    favorite: favorite || wasFavorite || cities.length === 0,
  };

  if (entry.favorite) {
    cities.forEach((city) => { city.favorite = false; });
  }

  cities.unshift(entry);
  saveSavedCities(cities.slice(0, 10));
  return entry;
}

function deleteSavedCity(index) {
  const cities = loadSavedCities();
  const removed = cities[index];
  if (!removed) return;

  cities.splice(index, 1);

  if (removed.favorite && cities.length > 0) {
    cities[0].favorite = true;
  }

  saveSavedCities(cities);

  if (removed.query === State.cfg.city) {
    const next = getFavoriteCity();
    if (next) applyCity(next);
    else {
      State.cfg.city = '';
      State.cfg.lat = null;
      State.cfg.lon = null;
      saveConfig();
      startWeatherTimer();
    }
  }

  renderSettingsCitiesList();
  renderSavedCities();
  updateCityNav();
}

function initCitiesFromStorage() {
  let cities = loadSavedCities();
  const currentQuery = (State.cfg.city || '').trim();

  if (!cities.length && currentQuery) {
    addSavedCity(
      currentQuery.split(',')[0],
      currentQuery,
      State.cfg.lat,
      State.cfg.lon,
      { favorite: true }
    );
    return;
  }

  const favorite = getFavoriteCity();
  if (favorite && favorite.query !== State.cfg.city) {
    applyCity(favorite, { refreshLists: false, silent: true });
  } else if (!favorite && cities.length > 0) {
    cities[0].favorite = true;
    saveSavedCities(cities);
    applyCity(cities[0], { refreshLists: false, silent: true });
  }
}

function renderSettingsCitiesList() {
  const list = document.getElementById('settings-cities-list');
  const empty = document.getElementById('settings-cities-empty');
  if (!list || !empty) return;

  const cities = loadSavedCities();
  if (!cities.length) {
    list.innerHTML = '';
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = cities.map((city, index) => {
    const safeName = escapeHtml(city.name || city.query);
    const isFavorite = Boolean(city.favorite);
    return `
      <li class="settings-city-item${isFavorite ? ' is-favorite' : ''}" data-index="${index}">
        <button type="button" class="city-fav-btn${isFavorite ? ' is-favorite' : ''}" data-index="${index}" aria-label="${isFavorite ? 'Cidade favorita' : 'Favoritar cidade'}" title="${isFavorite ? 'Cidade favorita' : 'Favoritar'}">★</button>
        <span class="settings-city-name" title="${safeName}">${safeName}</span>
        <button type="button" class="settings-city-remove" data-index="${index}" aria-label="Remover ${safeName}" title="Remover">✕</button>
      </li>
    `;
  }).join('');

  list.querySelectorAll('.city-fav-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = Number(btn.getAttribute('data-index'));
      const city = loadSavedCities()[index];
      if (!city || city.favorite) return;
      setFavoriteCity(city.query);
      showToast(`Favorita: ${city.name || city.query}`);
    });
  });

  list.querySelectorAll('.settings-city-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = Number(btn.getAttribute('data-index'));
      const city = loadSavedCities()[index];
      if (!city) return;
      if (!confirm(`Remover "${city.name || city.query}"?`)) return;
      deleteSavedCity(index);
      showToast(`Cidade removida`);
    });
  });
}

function getCityNavList() {
  return loadSavedCities();
}

function findCurrentCityIndex(list) {
  const idx = list.findIndex((city) => city.query === State.cfg.city);
  return idx >= 0 ? idx : 0;
}

function applyCity(city, { refreshLists = true, silent = false } = {}) {
  if (!city?.query) return;
  State.cfg.city = city.query;
  State.cfg.lat = city.lat ?? null;
  State.cfg.lon = city.lon ?? null;
  saveConfig();
  startWeatherTimer();
  if (refreshLists) {
    renderSettingsCitiesList();
    renderSavedCities();
    updateCityNav();
  }
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

function renderSavedCities() {
  const list = document.getElementById('city-saved-list');
  const section = document.getElementById('city-saved-section');
  if (!list) return;
  const cities = loadSavedCities();
  if (cities.length === 0) {
    if (section) section.style.display = 'none';
    return;
  }
  if (section) section.style.display = '';
  list.innerHTML = '';
  cities.forEach((city, i) => {
    const item = document.createElement('div');
    item.className = 'city-saved-item';
    const isActive = city.query === State.cfg.city;
    if (isActive) item.classList.add('active');
    const coords = (city.lat != null && city.lon != null)
      ? `${Number(city.lat).toFixed(4)}, ${Number(city.lon).toFixed(4)}`
      : 'sem coordenadas';
    const favMark = city.favorite ? ' ★' : '';
    item.innerHTML = `
      <div class="city-saved-info">
        <span class="city-saved-name">${escapeHtml(city.name)}${favMark}</span>
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
      deleteSavedCity(i);
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
    let cities = [];

    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=pt&format=json`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        cities = (data.results || []).map((r) => ({
          name: r.name,
          state: r.admin1 || '',
          country: r.country || '',
          query: r.admin1 ? `${r.name}, ${r.admin1}` : r.name,
          lat: r.latitude,
          lon: r.longitude,
        }));
      }
    } catch (e) {
      console.warn('city search open-meteo:', e);
    }

    if (!cities.length && apiKey) {
      const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(query)}&limit=8&appid=${apiKey}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        cities = data.map((c) => ({
          name: c.name,
          state: c.state,
          country: c.country,
          query: `${c.name},${c.country}`,
          lat: c.lat,
          lon: c.lon,
        }));
      }
    }

    if (!cities.length) {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=8&featuretype=city&addressdetails=1`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'pt-BR,pt;q=0.9' } });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      cities = data.map((c) => ({
        name: c.address?.city || c.address?.town || c.address?.village || c.name,
        state: c.address?.state || '',
        country: c.address?.country || '',
        query: c.address?.city || c.address?.town || c.address?.village || c.name,
        lat: parseFloat(c.lat),
        lon: parseFloat(c.lon),
      }));
    }

    results.innerHTML = '';

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
        const entry = addSavedCity(city.name, city.query, city.lat, city.lon);
        applyCity(entry);
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
  // settings
  document.getElementById('btn-settings-fab')?.addEventListener('click', openSettings);
  document.getElementById('clock-photo-empty')?.addEventListener('click', openSettings);
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    saveDisplayConfig();
    closeSettings();
    if (State.mode === 'slideshow') void startSlideshow();
  });

  // clima
  document.getElementById('btn-add-city-settings')?.addEventListener('click', openCitySearch);

  // fotos
  document.getElementById('clock-photo-prev')?.addEventListener('click', () => {
    void navigateClockPhoto(-1);
  });
  document.getElementById('clock-photo-next')?.addEventListener('click', () => {
    void navigateClockPhoto(1);
  });
  bindClockPhotoNavHighlight();
  setupClockNavAutoReveal();

  document.getElementById('btn-show-photo-list')?.addEventListener('click', () => {
    togglePhotoPlaylistList();
  });

  document.getElementById('btn-grant-folder-access')?.addEventListener('click', () => {
    void grantAllFolderAccess();
  });

  document.getElementById('btn-rescan-folders')?.addEventListener('click', () => {
    void rescanLinkedFolders({ notify: true, resetIndex: true, interactive: false }).then(() => {
      if (photoPlaylistListVisible) void renderPhotoPlaylistList();
    });
  });

  document.getElementById('btn-refresh-photo-library')?.addEventListener('click', () => {
    void refreshNativePhotoLibrary({ notify: true, reshuffle: true });
  });

  document.getElementById('btn-request-photo-permission')?.addEventListener('click', () => {
    void PhotoLibraryService.ensurePermission(true).then((permission) => {
      if (permission.granted) {
        void refreshNativePhotoLibrary({ notify: true, reshuffle: true });
      } else {
        showToast('Permissão da biblioteca de fotos negada');
      }
    });
  });

  document.getElementById('cfg-transition').addEventListener('change', e => {
    State.cfg.transition = e.target.value;
    saveConfig();
  });

  // câmeras
  document.getElementById('btn-add-cam')?.addEventListener('click', () => {
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
  document.getElementById('btn-fullscreen-fab')?.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', updateFullscreenFab);
  document.addEventListener('webkitfullscreenchange', updateFullscreenFab);
  updateFullscreenFab();

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
}

async function refreshNativePhotoLibrary({ notify = true, reshuffle = true } = {}) {
  if (!isNativePhotoLibraryMode()) return 0;
  try {
    const result = await PhotoLibraryService.scanLibrary({ reshuffle });
    clockPhotoIndex = 0;
    State.slideIndex = 0;
    renderNativePhotoLibraryInfo(result);
    updatePhotoActionButtons();
    await refreshPhotoViews();
    if (notify) {
      showToast(`Biblioteca atualizada — ${result.total} foto${result.total === 1 ? '' : 's'}`);
    }
    return result.total;
  } catch (e) {
    console.warn('refreshNativePhotoLibrary:', e);
    if (notify) showToast('Não foi possível atualizar a biblioteca de fotos');
    return 0;
  }
}

function renderNativePhotoLibraryInfo(result) {
  const info = document.getElementById('native-photo-library-info');
  if (!info) return;
  const total = result?.total ?? PhotoLibraryService.getCount();
  const refresh = result?.lastLibraryRefresh
    || PhotoLibraryService.getState().lastLibraryRefresh
    || '—';
  info.textContent = `${total} foto${total === 1 ? '' : 's'} na biblioteca · última atualização: ${refresh}`;
}

async function bootstrapNativePhotoLibrary() {
  if (!isNativePhotoLibraryMode()) return;

  await PhotoLibraryService.loadPersistedState();
  renderNativePhotoLibraryInfo();
  updateFolderPickerButtons();
  updatePhotoActionButtons();

  const hasPersistedPhotos = PhotoLibraryService.getCount() > 0;
  if (hasPersistedPhotos) {
    clockPhotoIndex = PhotoLibraryService.getCurrentIndex();
    await refreshPhotoViews();
  }

  try {
    const permission = await PhotoLibraryService.ensurePermission(!hasPersistedPhotos);
    if (!permission.granted) {
      showToast('Permita o acesso à biblioteca de fotos nas Configurações do iOS');
      return;
    }

    if (!hasPersistedPhotos || PhotoLibraryService.needsDailyRefresh()) {
      await refreshNativePhotoLibrary({
        notify: !hasPersistedPhotos,
        reshuffle: true,
      });
      return;
    }

    if (!hasPersistedPhotos) {
      showToast('Nenhuma foto encontrada na biblioteca');
    }
  } catch (e) {
    console.warn('bootstrapNativePhotoLibrary:', e);
  }
}

// ─── BOOT ────────────────────────────────────
async function init() {
  loadConfig();
  initCitiesFromStorage();
  loadFolderPlaylist();
  loadHiddenFolderPhotos();
  lastMidnightCheckDate = getTodayKey();

  bindEvents();
  bindClockPhotoMetaLayoutSync();
  restorePseudoFullscreen();
  if (isAppleMobileDevice() && nativeFullscreenActive()) {
    void exitNativeFullscreen();
  }
  updateFullscreenFab();
  initSettingsSections();
  setupFolderPickerUi();
  updateCityNav();
  switchMode('clock');

  const photoCol = document.getElementById('clock-photo-col');
  if (photoCol) {
    photoCol.style.height = '';
    photoCol.style.marginLeft = '';
  }

  tickClock();
  setInterval(tickClock, 1000);

  try {
    if (isNativePhotoLibraryMode()) {
      await bootstrapNativePhotoLibrary();
    } else {
      await clearLegacyPhotoStorage();
      if (isAppleMobileDevice()) {
        await loadStoredGalleryFolders();
      } else {
        await loadStoredFolderHandles();
      }
      if (usesFolderSource()) {
        await syncPersistedFolderPermissions();
        const access = await ensureAllLinkedFolderPermissions({ interactive: false });
        if (!access.ok) {
          setupDeferredFolderPermissionGrant();
        }
        if (access.ok) {
          await ensureFolderPlaylistForToday();
        }
      }
      updatePhotoActionButtons();
      await refreshPhotoViews();
    }
  } catch (e) {
    console.warn('init photos:', e);
    void updateFolderPermissionBanner();
  }

  scheduleMidnightFolderRescan();
  setInterval(checkMidnightPlaylistRefresh, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkMidnightPlaylistRefresh();
      void updateFolderPermissionBanner();
      void updateLinkedFoldersPermissionLabels();
    }
  });

  startWeatherTimer();

  if (State.cfg.wakelock) requestWakeLock();
}

// ─── SERVICE WORKER ───────────────────────────
if ('serviceWorker' in navigator && !(typeof MuralPlatform !== 'undefined' && MuralPlatform.isNativePlatform())) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js?v=120', window.location.href))
      .then((registration) => {
        console.log('SW registrado');
        registration.update();
        if (registration.waiting) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      })
      .catch((e) => console.warn('SW erro:', e));

    if ('caches' in window) {
      caches.keys().then((keys) => Promise.all(
        keys.filter((key) => key !== 'smartdisplay-v120').map((key) => caches.delete(key))
      )).catch((e) => console.warn('cache cleanup:', e));
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
