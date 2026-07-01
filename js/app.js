/* ============================================
   SMARTDISPLAY PWA — lógica principal
   ============================================ */

'use strict';

// ─── CAPACITOR ───────────────────────────────
const isCapacitor = () => !!(window.Capacitor?.isNativePlatform?.());

function capacitorPlugin(name) {
  return window.Capacitor?.Plugins?.[name] || null;
}

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
    kenburns: false,
    format24h: true,
    nightMode: false,
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
const PHOTO_SOURCE_PREF_KEY = 'sd_photo_source_pref'; // 'gallery' | 'album'
const PHOTO_INDEX_KEY = 'sd_photo_index';
// Cache de object URLs para fotos nativas — evita re-carregar a mesma foto
const nativePhotoCache = new Map(); // identifier → object URL (full quality)
const nativeThumbCache = new Map(); // identifier → data URL (thumbnail fallback do getMedias)
// Cache de metadados para fotos nativas
const nativeMetaCache = new Map(); // identifier → { location, date, time }

// Diagnóstico de fotos nativas — mostra toast na tela após 30 tentativas
const _nativeDiagCounts = {};
let _nativeDiagTotal = 0;
let _nativeDiagShown = false;
let _nativeIdentifierErrors = 0;   // contador de erros de identifier inválido
let _nativeReindexTriggered = false; // bloqueia auto-reindex (resetado só pelo botão manual)
let _nativeGalleryLoading = false;   // guard de concorrência para loadFullGalleryNative
function _nativeDiag(status, identifier, detail) {
  _nativeDiagCounts[status] = (_nativeDiagCounts[status] || 0) + 1;
  _nativeDiagTotal++;
  // Após 30 tentativas, mostra relatório na tela uma única vez
  if (_nativeDiagTotal === 30 && !_nativeDiagShown) {
    _nativeDiagShown = true;
    const ok = _nativeDiagCounts['OK'] || 0;
    const errs = Object.entries(_nativeDiagCounts)
      .filter(([k]) => k !== 'OK')
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    showToast(`Diagnóstico fotos — OK:${ok} | ${errs || 'sem erros'}`, 8000);
  }
}

let photoDbPromise = null;
let clockPhotoObjectUrl = null;
let clockPhotoActive = 'a'; // controla qual img está visível (A/B swap)
let clockPhotoObjectUrls = { a: null, b: null };
let slidePhotoObjectUrls = { a: null, b: null };
let midnightRescanTimer = null;
let lastMidnightCheckDate = '';
// Estabilização do modo noturno
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
    const iter = typeof handle.entries === 'function'
      ? handle.entries()
      : typeof handle.values === 'function'
        ? handle.values()
        : null;
    if (!iter) return false;
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
    localStorage.setItem('sd_folder_perm_done', String(Date.now()));
  } catch {}
}

function isFolderPermDoneRecently() {
  try {
    const ts = Number(localStorage.getItem('sd_folder_perm_done') || '0');
    return Date.now() - ts < 24 * 60 * 60 * 1000;
  } catch { return false; }
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

async function* iterateDirectoryEntries(dirHandle) {
  if (!dirHandle) return;
  if (typeof dirHandle.entries === 'function') {
    for await (const [, entry] of dirHandle.entries()) {
      yield entry;
    }
    return;
  }
  if (typeof dirHandle.values === 'function') {
    for await (const entry of dirHandle.values()) {
      yield entry;
    }
    return;
  }
  throw new Error('Directory iterator unavailable');
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
  if (isFolderPermDoneRecently()) return;

  folderPermissionPromptBound = true;
  const run = async () => {
    const needs = await getFoldersNeedingPermission();
    if (!needs.length) {
      document.removeEventListener('pointerdown', run, true);
      return;
    }

    document.removeEventListener('pointerdown', run, true);
    const ok = await grantAllFolderAccess();
    if (ok) localStorage.setItem('sd_folder_perm_done', String(Date.now()));
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
  if (shouldSkipBmpImages() && isBmpFileName(name)) return false;
  return IMAGE_FILE_RE.test(name || '');
}

function isBmpFileName(name) {
  return /\.bmp$/i.test(name || '');
}

function isBmpImageFile(file) {
  if (!file) return false;
  const name = file.name || '';
  const type = (file.type || '').toLowerCase();
  return isBmpFileName(name) || type === 'image/bmp' || type === 'image/x-ms-bmp' || type.includes('bmp');
}

function shouldSkipBmpImages() {
  return isEmbeddedDesktopBrowser();
}

function isDisplayableImageFile(file) {
  if (!file) return false;
  if (shouldSkipBmpImages() && isBmpImageFile(file)) return false;
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

  // Galeria nativa Capacitor — URL já pronta, sem conversão
  if (file._nativeUrl) return file._nativeUrl;

  // Galeria nativa Capacitor — getMediaByIdentifier retorna path de arquivo
  if (file._nativeIdentifier) {
    const cached = nativePhotoCache.get(file._nativeIdentifier);
    if (cached) return cached;
    const Media = capacitorPlugin('Media');
    if (!Media) { _nativeDiag('NO_PLUGIN', file._nativeIdentifier, null); return null; }
    try {
      const result = await Media.getMediaByIdentifier({ identifier: file._nativeIdentifier });
      if (!result?.path) {
        _nativeDiag('NO_PATH', file._nativeIdentifier, null);
        console.warn('native: sem path para', file._nativeIdentifier);
        return null;
      }

      // Normaliza path — convertFileSrc precisa de file:// no iOS
      let nativePath = result.path;
      if (!nativePath.startsWith('file://') && nativePath.startsWith('/')) {
        nativePath = 'file://' + nativePath;
      }
      const webUrl = window.Capacitor?.convertFileSrc
        ? window.Capacitor.convertFileSrc(nativePath)
        : nativePath;

      // Usa URL direta capacitor:// — WKWebView no iOS 15 não renderiza blob HEIC
      // mas renderiza HEIC via Capacitor file server sem problemas
      _nativeDiag('OK', file._nativeIdentifier, webUrl);
      nativePhotoCache.set(file._nativeIdentifier, webUrl);
      return webUrl;
    } catch (e) {
      _nativeDiag('IDENTIFIER_ERR', file._nativeIdentifier, String(e));
      console.warn('createDisplayObjectUrlFromFile native:', e);
      const msg = e?.errorMessage || e?.message || String(e);
      if (msg.includes('Failed to get image data') || e?.code === 'argumentError') {
        // Tenta thumbnail do cache como fallback (populado pelo getMedias)
        const thumb = nativeThumbCache.get(file._nativeIdentifier);
        if (thumb) {
          nativePhotoCache.set(file._nativeIdentifier, thumb);
          return thumb;
        }
        // Sem fallback: conta o erro e dispara re-indexação uma única vez
        _nativeIdentifierErrors++;
        if (_nativeIdentifierErrors >= 3 && !_nativeReindexTriggered && !_nativeGalleryLoading) {
          _nativeReindexTriggered = true;
          console.warn('Identificadores inválidos — re-indexando galeria automaticamente');
          showToast('Galeria desatualizada — re-indexando…');
          setTimeout(() => void loadFullGalleryNative(), 500);
        }
      }
      return null;
    }
  }

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

function revokeClockPhotoInactive() {
  const inactiveKey = clockPhotoActive === 'a' ? 'b' : 'a';
  if (clockPhotoObjectUrls[inactiveKey]) {
    revokeObjectUrl(clockPhotoObjectUrls[inactiveKey]);
    clockPhotoObjectUrls[inactiveKey] = null;
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

// Rate limiter: Nominatim exige no máximo 1 req/s
let _geocodeLastCall = 0;
async function _geocodeRateLimit() {
  const now = Date.now();
  const wait = 1100 - (now - _geocodeLastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _geocodeLastCall = Date.now();
}

async function reverseGeocodePhoto(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (photoGeocodeCache.has(key)) return photoGeocodeCache.get(key);

  try {
    await _geocodeRateLimit();
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=json&zoom=14&addressdetails=1&accept-language=pt-BR,pt`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'pt-BR,pt' } });
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data.address || {};
    const suburb = addr.suburb || addr.neighbourhood || addr.quarter || addr.hamlet;
    const city = addr.city || addr.town || addr.village || addr.municipality || addr.county;
    const state = addr.state || addr.region;
    const parts = [suburb, city, state].filter(Boolean);
    const label = parts.length
      ? parts.join(', ')
      : data.display_name?.split(',').slice(0, 3).map((p) => p.trim()).filter(Boolean).join(', ') || null;
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
    const geocoded = await reverseGeocodePhoto(lat, lon);
    if (geocoded) return geocoded;
    // Geocoding falhou (rate limit, rede) — tenta campos de texto do EXIF
  }

  return pickExifLocationLabel(parsed);
}

function isUsableImageSrc(src) {
  return typeof src === 'string'
    && src.length > 0
    && src !== 'undefined'
    && (src.startsWith('blob:') || src.startsWith('data:image/')
      || /^https?:/i.test(src) || src.startsWith('capacitor://'));
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

  // Galeria nativa Capacitor — lazy load via plugin (identifier PHAsset)
  if (folder.nativeGallerySource) {
    const item = folder.items?.find((i) => i.identifier === parsed.relPath);
    if (!item?.identifier) return null;
    return {
      _nativeIdentifier: item.identifier,
      _nativeLat: item.lat ?? null,
      _nativeLon: item.lon ?? null,
      _nativeDate: item.creationDate ?? null,
      name: item.name || 'foto.jpg',
      type: 'image/jpeg',
    };
  }

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
      for await (const entry of iterateDirectoryEntries(dir)) {
        const entryPath = `${basePath}${entry.name}`;
        if (entry.kind === 'file' && isImageFileName(entry.name)) {
          entries.push(`${folderId}::${entryPath}`);
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
    // Galeria nativa Capacitor — apenas referências, sem copiar dados
    if (folder.nativeGallerySource && folder.items?.length) {
      for (const item of folder.items) {
        entries.push(`${folder.id}::${item.identifier}`);
      }
      if (onProgress) onProgress(entries.length);
      continue;
    }

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
      entries.push(`${folder.id}::${rel}`);
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

function shuffleArrayInPlace(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function shuffleArray(items) {
  return shuffleArrayInPlace([...items]);
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
    const onDisk = new Set(entries);
    const kept = State.folderPlaylist.filter((path) => onDisk.has(path));
    const known = new Set(kept);
    const added = entries.filter((path) => !known.has(path));
    if (added.length || kept.length !== State.folderPlaylist.length) {
      const merged = [...kept, ...added];
      shuffleArrayInPlace(merged);
      State.folderPlaylist = merged;
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

  const paths = [...entries];
  shuffleArrayInPlace(paths);
  pruneHiddenFolderPhotos(paths);
  State.folderPlaylist = paths;
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
  if (isCapacitor()) {
    rescanBtn.textContent = busy ? 'Reconectando galeria…' : 'Reconectar galeria';
  } else {
    rescanBtn.textContent = busy ? 'Lendo pastas…' : 'Releitura das pastas';
  }
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
  showGalleryBuildProgress('Lendo pasta… 0%');

  const totalKnown = State.linkedFolders.reduce((sum, f) => {
    if (f.files?.length) return sum + f.files.length;
    if (f.items?.length) return sum + f.items.length;
    return -1; // pasta do disco — total desconhecido
  }, 0);

  try {
    const count = await refreshFolderPlaylist({
      notify,
      resetIndex,
      onProgress: (found) => {
        if (totalKnown > 0) {
          const pct = Math.min(99, Math.round((found / totalKnown) * 100));
          showGalleryBuildProgress(`Organizando fotos… ${pct}%`);
        } else {
          showGalleryBuildProgress(`Lendo pasta… ${found} foto${found === 1 ? '' : 's'}`);
        }
      },
    });
    await refreshPhotoViews();
    return count;
  } finally {
    showGalleryBuildProgress('');
    folderRescanInProgress = false;
    setRescanButtonBusy(false);
  }
}

function updatePhotoActionButtons() {
  const hasFolders = usesFolderSource();
  const listBtn = document.getElementById('btn-show-photo-list');
  if (listBtn) {
    listBtn.disabled = !hasFolders;
    if (!hasFolders) {
      photoPlaylistListVisible = false;
      listBtn.classList.remove('is-active');
    }
  }
  // Atualiza label e estado do botão de rescan (texto depende da plataforma)
  setRescanButtonBusy(false);
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
    // Não chama syncFolderPlaylistWithDisk aqui — é caro para playlists grandes
    // e bloqueia clockPhotoNavBusy. updateClockPhoto já avança para a próxima foto.
    return { src: null, total: names.length, name: '' };
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

function isEmbeddedDesktopBrowser() {
  const ua = navigator.userAgent || '';
  if (/Electron|Codex/i.test(ua)) return true;
  return Boolean(window.process?.versions?.electron);
}

function isLocalDevelopmentOrigin() {
  const host = window.location.hostname || '';
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function supportsDirectoryPicker() {
  // Em Electron/localhost, o picker nativo falha neste fluxo; o input webkitdirectory é mais confiável.
  if (isAppleMobileDevice()) return false;
  if (isEmbeddedDesktopBrowser()) return false;
  if (isLocalDevelopmentOrigin()) return false;
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
  if (!nativeBtn || !fallbackLabel) return;

  const onAppleMobile = isAppleMobileDevice();
  document.documentElement.classList.toggle('platform-ios', onAppleMobile);

  if (onAppleMobile) {
    nativeBtn.hidden = true;
    fallbackLabel.hidden = true;
    if (galleryLabel) {
      // No Capacitor, sempre esconde o botão — galeria é gerenciada automaticamente
      if (isCapacitor()) {
        galleryLabel.hidden = true;
        document.querySelectorAll('.settings-hint--ios-picker, .settings-hint--ios').forEach((el) => { el.hidden = true; });
        const emptyMsg = document.getElementById('linked-folders-empty');
        if (emptyMsg) emptyMsg.hidden = true;
      } else {
        const hasNativeGallery = State.linkedFolders.some((f) => f.nativeGallerySource);
        galleryLabel.hidden = hasNativeGallery;
        if (!hasNativeGallery) {
          const hasGallery = State.linkedFolders.some((folder) => folder.gallerySource);
          galleryLabel.textContent = hasGallery ? 'Substituir galeria' : 'Selecionar galeria';
        }
      }
    }
    return;
  }

  if (galleryLabel) galleryLabel.hidden = true;
  const hasFolder = State.linkedFolders.some((f) => !f.gallerySource);
  nativeBtn.textContent = hasFolder ? 'Substituir pasta' : 'Selecionar pasta';
  const useNative = supportsDirectoryPicker();
  nativeBtn.hidden = !useNative;
  fallbackLabel.hidden = useNative;
}

function getPhotoSourcePref() {
  return localStorage.getItem(PHOTO_SOURCE_PREF_KEY) || null;
}

function setPhotoSourcePref(pref) {
  localStorage.setItem(PHOTO_SOURCE_PREF_KEY, pref);
}

function clearPhotoSourcePref() {
  localStorage.removeItem(PHOTO_SOURCE_PREF_KEY);
}

function openGalleryPickerDirect() {
  const input = getGalleryPickerInput();
  if (!input) { showToast('Seletor de fotos indisponível neste dispositivo'); return; }
  input.click();
}

function openGalleryPicker() {
  // No Capacitor sempre conecta diretamente com a galeria completa — sem modal
  if (isCapacitor()) {
    void loadFullGalleryNative({ manual: true });
    return;
  }
  const pref = getPhotoSourcePref();
  if (pref) {
    openGalleryPickerDirect();
    return;
  }
  showPhotoSourceModal();
}

const NATIVE_GALLERY_KEY = 'sd_native_gallery';

function saveNativeGalleryIdentifiers(id, items) {
  try {
    localStorage.setItem(NATIVE_GALLERY_KEY, JSON.stringify({ id, items }));
  } catch(e) { console.warn('saveNativeGalleryIdentifiers:', e); }
}

function loadNativeGalleryIdentifiers() {
  try {
    return JSON.parse(localStorage.getItem(NATIVE_GALLERY_KEY) || 'null');
  } catch { return null; }
}

function initNativeGalleryFolder() {
  const saved = loadNativeGalleryIdentifiers();
  if (!saved?.id || !saved?.items?.length) return false;
  if (State.linkedFolders.some((f) => f.id === saved.id)) return true;
  State.linkedFolders.push({
    id: saved.id,
    name: 'Galeria completa',
    nativeGallerySource: true,
    items: saved.items,
  });
  return true;
}

async function loadFullGalleryNative({ manual = false } = {}) {
  // Guard: impede execuções concorrentes que destroem o estado do slideshow
  if (_nativeGalleryLoading) return;
  _nativeGalleryLoading = true;
  _nativeReindexTriggered = true;  // bloqueia auto-triggers enquanto carrega
  _nativeIdentifierErrors = 0;

  setRescanButtonBusy(true);

  const Media = capacitorPlugin('Media');
  if (!Media) {
    _nativeGalleryLoading = false;
    setRescanButtonBusy(false);
    showToast('Plugin de mídia indisponível');
    return;
  }

  showToast('Indexando galeria...');
  try {
    // thumbnailQuality: 60 — qualidade mínima utilizável como fallback de exibição
    // quando getMediaByIdentifier não está disponível (ex: primeira versão do plugin)
    const { medias } = await Media.getMedias({ types: 'photos', quantity: 99999, thumbnailQuality: 60 });
    if (!medias?.length) { showToast('Nenhuma foto encontrada na galeria'); return; }

    const items = medias
      .filter((m) => m.identifier)
      .map((m) => ({
        identifier: m.identifier,
        name: m.name || `foto_${m.identifier.replace(/[^a-z0-9]/gi, '_')}`,
        creationDate: m.creationDate || null,
        lat: Number.isFinite(m.location?.latitude) ? m.location.latitude : null,
        lon: Number.isFinite(m.location?.longitude) ? m.location.longitude : null,
      }));

    // Popula cache de thumbnails como fallback quando getMediaByIdentifier falha
    nativeThumbCache.clear();
    medias.forEach((m) => {
      if (m.identifier && m.data) {
        nativeThumbCache.set(m.identifier, `data:image/jpeg;base64,${m.data}`);
      }
    });

    // Fonte única: remove qualquer galeria nativa anterior
    State.linkedFolders = State.linkedFolders.filter((f) => !f.nativeGallerySource);
    nativePhotoCache.clear();
    nativeMetaCache.clear();

    const folderId = crypto.randomUUID();
    saveNativeGalleryIdentifiers(folderId, items);
    State.linkedFolders.push({
      id: folderId,
      name: 'Galeria completa',
      nativeGallerySource: true,
      items,
    });

    await afterFolderAdded({ notify: false });
    showToast(`${items.length} fotos indexadas — pronto!`);
  } catch (e) {
    console.warn('loadFullGalleryNative:', e);
    showToast('Erro ao acessar galeria');
  } finally {
    _nativeGalleryLoading = false;
    // Auto-trigger permanece bloqueado após conclusão para evitar loop infinito.
    // Botão manual reseta para permitir nova tentativa.
    if (manual) _nativeReindexTriggered = false;
    setRescanButtonBusy(false);
  }
}

function showPhotoSourceModal() {
  if (isCapacitor()) return; // No Capacitor nunca mostra modal — galeria é automática
  const overlay = document.getElementById('photo-source-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

function hidePhotoSourceModal() {
  const overlay = document.getElementById('photo-source-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function setupPhotoSourceModal() {
  document.getElementById('btn-photo-source-gallery')?.addEventListener('click', () => {
    setPhotoSourcePref('gallery');
    hidePhotoSourceModal();
    if (isCapacitor()) {
      void loadFullGalleryNative();
    } else {
      openGalleryPickerDirect();
    }
  });

  document.getElementById('btn-photo-source-album')?.addEventListener('click', () => {
    setPhotoSourcePref('album');
    hidePhotoSourceModal();
    openGalleryPickerDirect();
  });

  document.getElementById('btn-photo-source-cancel')?.addEventListener('click', hidePhotoSourceModal);

  document.getElementById('photo-source-overlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('photo-source-overlay')) hidePhotoSourceModal();
  });

}

function openFolderPickerFallback() {
  const input = getFolderPickerInput();
  if (!input) {
    showToast('Seletor de pasta indisponível neste navegador');
    return;
  }
  if (typeof input.showPicker === 'function') {
    try {
      input.showPicker();
      return;
    } catch (e) {
      console.warn('openFolderPickerFallback.showPicker:', e);
    }
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

function showGalleryBuildProgress(text) {
  const el = document.getElementById('gallery-build-progress');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

async function afterFolderAdded({ notify = true } = {}) {
  renderLinkedFoldersList();
  renderFolderInfo();
  updateFolderPickerButtons();
  updatePhotoActionButtons();

  const totalFiles = State.linkedFolders.reduce((sum, f) => {
    if (f.files?.length) return sum + f.files.length;
    if (f.items?.length) return sum + f.items.length;
    return sum + 0;
  }, 0);

  showGalleryBuildProgress('Preparando lista… 0%');

  let count = 0;
  try {
    count = await refreshFolderPlaylist({
      notify: false,
      resetIndex: true,
      onProgress: (found) => {
        if (totalFiles > 0) {
          const pct = Math.min(99, Math.round((found / totalFiles) * 100));
          showGalleryBuildProgress(`Organizando fotos… ${pct}%`);
        } else {
          showGalleryBuildProgress(`Organizando fotos… ${found} encontrada${found === 1 ? '' : 's'}`);
        }
      },
    });
  } catch (e) {
    console.warn('afterFolderAdded playlist:', e);
  } finally {
    showGalleryBuildProgress('');
    await refreshPhotoViews();
  }

  if (notify) {
    const isGallery = State.linkedFolders.some((f) => f.gallerySource);
    const savedNote = isGallery ? ' — salva neste dispositivo' : (State.linkedFolders.some((f) => f.handle) ? ' — salva neste dispositivo' : '');
    showToast(count
      ? `${count} foto${count === 1 ? '' : 's'} em ordem aleatória${savedNote}`
      : 'Nenhuma imagem compatível encontrada');
  }
}

async function bindFolderHandle(dir) {
  folderPickInProgress = true;
  try {
    const granted = await requestHandleReadPermission(dir);
    if (!granted) {
      console.warn('bindFolderHandle: permission request did not confirm read access, continuing');
    }

    const added = await addLinkedFolderHandle(dir, dir.name);
    if (!added) return;
    const folder = State.linkedFolders.find((f) => f.handle === dir);
    if (folder) {
      await folderHasReadAccess(folder);
    }
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

  const files = [];
  for (const file of input.files || []) {
    if (isDisplayableImageFile(file)) files.push(file);
  }
  input.value = '';
  if (!files.length) {
    showToast('Nenhuma foto selecionada');
    return;
  }

  // Sempre substitui a galeria anterior — modo galeria única
  const existingGallery = State.linkedFolders.find((folder) => folder.gallerySource);
  if (existingGallery) {
    folderPickInProgress = true;
    try {
      await removeLinkedFolder(existingGallery.id);
      saveLinkedFoldersMeta();
    } catch (e) {
      console.warn('handleGalleryPickerInput removeLinkedFolder:', e);
    } finally {
      folderPickInProgress = false;
    }
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

  const files = [];
  for (const file of input.files || []) {
    if (isDisplayableImageFile(file)) files.push(file);
  }
  input.value = '';
  if (!files.length) {
    showToast('Nenhuma imagem compatível selecionada');
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
  const allFiles = Array.isArray(files) ? files : Array.from(files);
  if (!allFiles.length) return false;

  const imageFiles = allFiles.filter((file) => isDisplayableImageFile(file));
  if (!imageFiles.length) {
    showToast('Nenhuma imagem compatível selecionada');
    return false;
  }

  const root = name
    || imageFiles[0].webkitRelativePath?.split('/')[0]
    || imageFiles[0].name
    || 'Pasta';

  folderPickInProgress = true;
  try {
    const added = await addLinkedSessionFolder(root, imageFiles, { gallerySource });
    if (!added) return false;

    await afterFolderAdded({ notify: true });

    if (gallerySource) {
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

async function clearOldGalleryData() {
  // No Capacitor, remove dados de galeria do IndexedDB (gravados via web file picker)
  // para evitar que conflitem com a galeria nativa.
  try {
    const meta = JSON.parse(localStorage.getItem(GALLERY_FOLDERS_KEY) || '[]');
    for (const entry of meta) {
      if (entry?.id) await deleteGalleryFolderFromIdb(entry.id);
    }
    localStorage.removeItem(GALLERY_FOLDERS_KEY);
    // Remove folders com gallerySource=true (web picker) do estado em memória
    State.linkedFolders = State.linkedFolders.filter((f) => !f.gallerySource);
  } catch (e) {
    console.warn('clearOldGalleryData:', e);
  }
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

  // Fotos da galeria nativa iOS
  if (file._nativeIdentifier) {
    // Retorna do cache se já processado
    if (nativeMetaCache.has(file._nativeIdentifier)) {
      return nativeMetaCache.get(file._nativeIdentifier);
    }

    // 1ª opção: metadados retornados pelo plugin em getMedias()
    if (file._nativeDate) {
      const dt = new Date(file._nativeDate);
      if (!Number.isNaN(dt.getTime())) {
        meta.date = formatPhotoDate(dt);
        meta.time = formatPhotoTime(dt);
      }
    }
    if (Number.isFinite(file._nativeLat) && Number.isFinite(file._nativeLon)) {
      meta.location = await reverseGeocodePhoto(file._nativeLat, file._nativeLon) || null;
    }

    // 2ª opção: lê EXIF do blob já em cache (carregado para exibição)
    if (!meta.date || !meta.location) {
      const objUrl = nativePhotoCache.get(file._nativeIdentifier);
      if (objUrl) {
        try {
          await loadExifrLibrary();
          if (exifrAvailable()) {
            const resp = await fetch(objUrl);
            const blob = await resp.blob();
            const parsed = await exifr.parse(blob, {
              gps: true, tiff: true, exif: true, ifd0: true, iptc: true, mergeOutput: true,
            });
            if (!meta.date) {
              const dt = parsed?.DateTimeOriginal || parsed?.CreateDate || parsed?.ModifyDate;
              if (dt instanceof Date && !Number.isNaN(dt.getTime())) {
                meta.date = formatPhotoDate(dt);
                meta.time = formatPhotoTime(dt);
              }
            }
            if (!meta.location) {
              meta.location = await resolvePhotoLocation(blob, parsed);
            }
          }
        } catch (e) {
          console.warn('extractPhotoMetadata native EXIF:', e);
        }
      }
    }

    nativeMetaCache.set(file._nativeIdentifier, meta);
    return meta;
  }

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

const META_FADE_MS = 350;

function hideClockPhotoMeta() {
  const overlay = document.getElementById('clock-photo-meta');
  if (!overlay) return;
  overlay.classList.remove('visible');
  overlay.classList.add('no-photos');
  overlay.style.left = '';
  overlay.style.maxWidth = '';
}

function fadeOutClockPhotoMeta(durationMs = META_FADE_MS) {
  const overlay = document.getElementById('clock-photo-meta');
  if (!overlay) return;
  overlay.style.transition = `opacity ${durationMs}ms ease`;
  overlay.classList.remove('visible');
}

function fadeInClockPhotoMeta() {
  const overlay = document.getElementById('clock-photo-meta');
  if (!overlay) return;
  overlay.classList.remove('no-photos');
  overlay.style.transition = `opacity ${META_FADE_MS}ms ease`;
  requestAnimationFrame(() => {
    overlay.classList.add('visible');
    requestAnimationFrame(syncClockPhotoMetaLayout);
  });
}

function applyClockPhotoMetaContent(meta, photoIndex, total) {
  const locLine  = document.getElementById('clock-photo-meta-location');
  const locValue = document.getElementById('clock-photo-meta-location-value');
  const dateLine = document.getElementById('clock-photo-meta-date');
  const timeLine = document.getElementById('clock-photo-meta-time');
  const timeVal  = document.getElementById('clock-photo-meta-time-value');
  const indexLine = document.getElementById('clock-photo-meta-index');

  if (locLine) {
    locLine.hidden = false;
    if (locValue) locValue.textContent = meta?.location || PHOTO_META_UNKNOWN;
  }
  if (dateLine) { dateLine.textContent = meta?.date || PHOTO_META_UNKNOWN; dateLine.hidden = false; }
  if (timeLine) {
    if (timeVal) timeVal.textContent = meta?.time || PHOTO_META_UNKNOWN;
    else timeLine.textContent = meta?.time || PHOTO_META_UNKNOWN;
    timeLine.hidden = false;
  }
  if (indexLine) {
    indexLine.textContent = total > 0 ? `${photoIndex + 1} / ${total}` : '';
    indexLine.hidden = total <= 0;
  }
}

async function prefetchClockPhotoMeta(photoIndex) {
  const file  = await getPhotoFileAtIndex(photoIndex);
  const meta  = await extractPhotoMetadata(file);
  const total = await getPhotoSourceCount();
  return { meta, total };
}

function syncClockPhotoMetaLayout() {
  const overlay = document.getElementById('clock-photo-meta');
  const leftCol = document.getElementById('clock-left-col');
  if (!overlay || !leftCol || overlay.classList.contains('no-photos')) return;

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

  if (State.weatherData?.hourly) {
    const hourlyStamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (tickClock._hourlyStamp !== hourlyStamp) {
      tickClock._hourlyStamp = hourlyStamp;
      renderHourlyForecast(State.weatherData.hourly);
    }
  }
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
let clockPhotoIndex = (() => {
  try { return parseInt(localStorage.getItem(PHOTO_INDEX_KEY) || '0', 10) || 0; } catch { return 0; }
})();
let clockPhotoTimer = null;
let clockPhotoTimerGen = 0;

function savePhotoIndex(index) {
  try { localStorage.setItem(PHOTO_INDEX_KEY, String(index)); } catch {}
}

let clockPhotoNavBusy = false;

async function rescheduleClockPhotoTimer() {
  clearInterval(clockPhotoTimer);
  clockPhotoTimer = null;
  const gen = ++clockPhotoTimerGen;
  const count = await getPhotoSourceCount();
  // Se outra chamada de reschedule chegou enquanto aguardávamos, descarta esta.
  if (gen !== clockPhotoTimerGen) return;
  if (count > 1) {
    clockPhotoTimer = setInterval(() => {
      if (clockPhotoNavBusy) return;
      void navigateClockPhoto(1, false);
    }, State.cfg.interval);
  }
}

async function startClockPhoto() {
  await updateClockPhoto();
  await rescheduleClockPhotoTimer();
}

async function navigateClockPhoto(delta, restartTimer = true) {
  if (clockPhotoNavBusy) return;
  clockPhotoNavBusy = true;
  try {
    const count = await getPhotoSourceCount();
    if (count <= 1) return;

    clockPhotoIndex = (clockPhotoIndex + delta + count) % count;
    savePhotoIndex(clockPhotoIndex);
    await updateClockPhoto();

    if (restartTimer) {
      await rescheduleClockPhotoTimer();
    }
  } finally {
    clockPhotoNavBusy = false;
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

async function updateClockPhoto() {
  const imgA = document.getElementById('clock-photo-img-a');
  const imgB = document.getElementById('clock-photo-img-b');
  const frame = document.getElementById('clock-photo-frame');
  const empty = document.getElementById('clock-photo-empty');
  if (!imgA || !imgB) return;

  const count = await getPhotoSourceCount();
  if (!count) {
    [imgA, imgB].forEach(i => { i.removeAttribute('src'); i.className = 'clock-photo-img'; });
    if (frame) frame.className = '';
    if (empty) empty.style.display = 'flex';
    hideClockPhotoMeta();
    await updateClockPhotoNav();
    return;
  }

  if (clockPhotoIndex >= count) clockPhotoIndex = 0;

  // No Capacitor, erros de identifier são sistêmicos — tenta só 1 foto para não
  // acumular contadores rapidamente e disparar re-indexação em loop.
  // No desktop, tenta até 3 para pular arquivos pontualmente inacessíveis.
  const MAX_RESOLVE_TRIES = Math.min(isCapacitor() ? 1 : 3, count);
  let src = null;
  let resolvedIndex = clockPhotoIndex;
  for (let attempt = 0; attempt < MAX_RESOLVE_TRIES; attempt++) {
    const idx = (clockPhotoIndex + attempt) % count;
    const result = await resolvePhotoAtIndex(idx);
    if (isUsableImageSrc(result.src)) {
      src = result.src;
      resolvedIndex = idx;
      if (attempt > 0) {
        clockPhotoIndex = resolvedIndex;
        savePhotoIndex(clockPhotoIndex);
      }
      break;
    }
  }

  if (!src) {
    [imgA, imgB].forEach(i => { i.removeAttribute('src'); i.className = 'clock-photo-img'; });
    if (frame) frame.className = '';
    if (empty) empty.style.display = 'flex';
    hideClockPhotoMeta();
    await updateClockPhotoNav();
    // Se Capacitor e galeria existe mas foto não carrega, pode ser permissão revogada
    if (isCapacitor() && State.linkedFolders.some((f) => f.nativeGallerySource)) {
      console.warn('updateClockPhoto: foto não resolvida no índice', clockPhotoIndex,
        '— verifique permissão da galeria ou pressione Atualizar galeria');
    }
    return;
  }

  const EFFECTS = ['fade', 'slide', 'zoom'];
  let effect = State.cfg.transition || 'fade';
  if (effect === 'random') effect = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
  const kenburnsEnabled = !!State.cfg.kenburns;

  const KB_VARIANTS = 8;
  let lastKbVariant = -1;
  function applyKenBurns(el) {
    // Sorteia variante diferente da anterior
    let v;
    do { v = Math.floor(Math.random() * KB_VARIANTS) + 1; } while (v === lastKbVariant && KB_VARIANTS > 1);
    lastKbVariant = v;
    // Ciclo fixo de 10s, repete indefinidamente dentro do tempo de exibição
    el.style.animation = `fx-kb-${v} 10000ms ease-in-out infinite alternate`;
  }

  const incomingKey = clockPhotoActive === 'a' ? 'b' : 'a';
  const incoming = incomingKey === 'a' ? imgA : imgB;
  const outgoing  = clockPhotoActive === 'a' ? imgA : imgB;
  const capturedIndex = resolvedIndex;

  // Pré-busca metadados em paralelo com o carregamento da imagem
  const metaReqId = ++clockPhotoMetaRequest;
  const metaPromise = prefetchClockPhotoMeta(capturedIndex);

  // Revoga blob da imagem que vai entrar (incoming, não mais necessário)
  if (clockPhotoObjectUrls[incomingKey]) {
    revokeObjectUrl(clockPhotoObjectUrls[incomingKey]);
    clockPhotoObjectUrls[incomingKey] = null;
  }
  if (src.startsWith('blob:')) clockPhotoObjectUrls[incomingKey] = src;

  // Após a transição da foto terminar, mostra os metadados sincronizados
  function scheduleMetaIn(delayMs) {
    setTimeout(() => {
      if (metaReqId !== clockPhotoMetaRequest) return;
      metaPromise.then(({ meta, total }) => {
        if (metaReqId !== clockPhotoMetaRequest) return;
        applyClockPhotoMetaContent(meta, capturedIndex, total);
        fadeInClockPhotoMeta();
      }).catch(() => {});
    }, delayMs);
  }

  const loader = new Image();
  loader.onload = () => {
    if (empty) empty.style.display = 'none';

    incoming.src = src;
    incoming.className = 'clock-photo-img';
    incoming.style.animation = '';
    incoming.style.transform = '';
    incoming.getAnimations().forEach(a => a.cancel());
    outgoing.className = 'clock-photo-img active';

    clockPhotoActive = incomingKey;
    savePhotoIndex(capturedIndex);

    const capturedOutKey = incomingKey === 'a' ? 'b' : 'a';

    // Captura o transform atual da foto que sai (mid-kenburns) para evitar tranco
    const outgoingTransform = getComputedStyle(outgoing).transform || 'none';
    if (kenburnsEnabled) {
      outgoing.getAnimations().forEach(a => a.cancel());
      outgoing.style.transform = outgoingTransform;
    }

    if (effect === 'none') {
      fadeOutClockPhotoMeta(0);
      incoming.classList.add('active');
      outgoing.classList.remove('active');
      outgoing.style.transform = '';
      if (frame) frame.className = '';
      if (kenburnsEnabled) applyKenBurns(incoming);
      scheduleMetaIn(0);
      return;
    }

    if (effect === 'fade') {
      const FADE_MS = 2500;
      fadeOutClockPhotoMeta(FADE_MS);
      incoming.classList.add('active');
      incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease', fill: 'none' });
      outgoing.classList.remove('active');
      outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease', fill: 'none' });
      setTimeout(() => {
        outgoing.style.transform = '';
        outgoing.style.animation = '';
        if (frame) frame.className = '';
        if (kenburnsEnabled) applyKenBurns(incoming);
        if (clockPhotoObjectUrls[capturedOutKey]) {
          revokeObjectUrl(clockPhotoObjectUrls[capturedOutKey]);
          clockPhotoObjectUrls[capturedOutKey] = null;
        }
      }, FADE_MS + 100);
      scheduleMetaIn(FADE_MS);
      return;
    }

    // Zoom sequencial: zoom out da foto atual, depois zoom in da nova
    if (effect === 'zoom') {
      const ZOOM_MS = 1500;
      fadeOutClockPhotoMeta(ZOOM_MS);
      if (frame) frame.className = 'fx-zoom';
      requestAnimationFrame(() => {
        outgoing.animate(
          [{ transform: outgoingTransform, opacity: 1 }, { transform: 'scale(0.9)', opacity: 0 }],
          { duration: ZOOM_MS, easing: 'ease', fill: 'forwards' }
        );
        setTimeout(() => {
          outgoing.style.transform = '';
          outgoing.style.animation = '';
          outgoing.getAnimations().forEach(a => a.cancel());
          outgoing.classList.remove('active');
          incoming.classList.add('active', 'cp-in');
          setTimeout(() => {
            incoming.classList.remove('cp-in');
            if (frame) frame.className = '';
            if (kenburnsEnabled) applyKenBurns(incoming);
            if (clockPhotoObjectUrls[capturedOutKey]) {
              revokeObjectUrl(clockPhotoObjectUrls[capturedOutKey]);
              clockPhotoObjectUrls[capturedOutKey] = null;
            }
          }, ZOOM_MS);
        }, ZOOM_MS);
      });
      scheduleMetaIn(ZOOM_MS * 2);
      return;
    }

    // Slide: randomiza direção a cada transição
    const SLIDE_MS = 1500;
    fadeOutClockPhotoMeta(SLIDE_MS);
    const SLIDE_DIRS = ['right', 'left', 'up', 'down'];
    const slideDir = SLIDE_DIRS[Math.floor(Math.random() * SLIDE_DIRS.length)];
    const frameClass = `fx-slide-${slideDir}`;
    const slideEndTransform = { right: 'translateX(-100%)', left: 'translateX(100%)', up: 'translateY(100%)', down: 'translateY(-100%)' }[slideDir];
    if (frame) frame.className = frameClass;

    requestAnimationFrame(() => {
      incoming.classList.add('active', 'cp-in');
      outgoing.animate(
        [{ transform: outgoingTransform }, { transform: slideEndTransform }],
        { duration: SLIDE_MS, easing: 'ease', fill: 'forwards' }
      );

      setTimeout(() => {
        outgoing.style.transform = '';
        outgoing.style.animation = '';
        outgoing.getAnimations().forEach(a => a.cancel());
        outgoing.classList.remove('active');
        incoming.classList.remove('cp-in');
        if (frame) frame.className = '';
        if (kenburnsEnabled) applyKenBurns(incoming);
        if (clockPhotoObjectUrls[capturedOutKey]) {
          revokeObjectUrl(clockPhotoObjectUrls[capturedOutKey]);
          clockPhotoObjectUrls[capturedOutKey] = null;
        }
      }, SLIDE_MS);
    });
    scheduleMetaIn(SLIDE_MS);
  };
  loader.onerror = () => {
    console.warn('clock photo img render failed, advancing');
    hideClockPhotoMeta();
    // Avança via navigateClockPhoto para respeitar o busy flag e não criar race condition
    if (!clockPhotoNavBusy) {
      setTimeout(() => void navigateClockPhoto(1, false), 300);
    }
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

  const EFFECTS = ['fade', 'slide', 'zoom'];
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

    const duration = 700;
    setTimeout(() => {
      outgoing.classList.remove('active', 'slide-out');
      incoming.classList.remove('slide-in');
      container.className = '';
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
  document.getElementById('cfg-kenburns').checked = !!cfg.kenburns;
  document.getElementById('cfg-24h').checked = cfg.format24h;
  document.getElementById('cfg-night-mode').checked = !!cfg.nightMode;
  document.getElementById('cfg-wakelock').checked = cfg.wakelock;

  renderSettingsCitiesList();
  renderFolderInfo();
  updateFolderPickerButtons();
  void (async () => {
    await refreshStoredFolderAccess();
    if (photoPlaylistListVisible) await renderPhotosPreviews();
  })();
  renderCamerasList();

  const saveSlideshowBtn = document.getElementById('btn-save-slideshow-settings');
  if (saveSlideshowBtn) saveSlideshowBtn.disabled = true;

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

    // Use saved state if available; otherwise keep HTML default (collapsed class already set or absent)
    if (id in saved) {
      applyCollapsed(saved[id] === false);
    } else {
      // Sync aria-expanded with actual DOM state
      toggle.setAttribute('aria-expanded', section.classList.contains('collapsed') ? 'false' : 'true');
    }

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
  State.cfg.nightMode = document.getElementById('cfg-night-mode').checked;
  State.cfg.wakelock = document.getElementById('cfg-wakelock').checked;
  applyNightMode();
  State.cfg.interval = parseInt(document.getElementById('cfg-interval').value);
  State.cfg.transition = document.getElementById('cfg-transition').value;
  State.cfg.kenburns = document.getElementById('cfg-kenburns').checked;
  saveConfig();
  if (State.mode === 'clock') {
    void rescheduleClockPhotoTimer();
  }
  if (State.cfg.wakelock) requestWakeLock();
  else releaseWakeLock();
}

// ─── WAKELOCK ────────────────────────────────
async function requestWakeLock() {
  const keepAwake = capacitorPlugin('KeepAwake');
  if (keepAwake) {
    try { await keepAwake.keepAwake(); } catch(e) { console.warn('KeepAwake:', e); }
    return;
  }
  if (!('wakeLock' in navigator)) return;
  try {
    State.wakeLock = await navigator.wakeLock.request('screen');
    State.wakeLock.addEventListener('release', () => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && State.cfg.wakelock) requestWakeLock();
      }, { once: true });
    });
  } catch(e) { console.warn('wakeLock:', e); }
}

async function releaseWakeLock() {
  const keepAwake = capacitorPlugin('KeepAwake');
  if (keepAwake) {
    try { await keepAwake.allowSleep(); } catch(e) { console.warn('allowSleep:', e); }
    return;
  }
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
  // No Capacitor no iPad usamos pseudo-fullscreen + StatusBar hide em vez do fullscreen nativo
  if (isCapacitor()) return false;
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
  setupPhotoSourceModal();

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
    if (isCapacitor()) {
      // No Capacitor, re-indexa a galeria do zero (limpa cache e lista)
      void loadFullGalleryNative({ manual: true }).then(() => {
        if (photoPlaylistListVisible) void renderPhotoPlaylistList();
      });
    } else {
      void rescanLinkedFolders({ notify: true, resetIndex: true, interactive: false }).then(() => {
        if (photoPlaylistListVisible) void renderPhotoPlaylistList();
      });
    }
  });

  const saveSlideshowBtn = document.getElementById('btn-save-slideshow-settings');

  function markSlideshowDirty() {
    if (saveSlideshowBtn) saveSlideshowBtn.disabled = false;
  }

  document.getElementById('cfg-interval').addEventListener('change', markSlideshowDirty);

  document.getElementById('cfg-transition').addEventListener('change', markSlideshowDirty);

  document.getElementById('cfg-kenburns').addEventListener('change', markSlideshowDirty);

  saveSlideshowBtn?.addEventListener('click', () => {
    State.cfg.interval = parseInt(document.getElementById('cfg-interval').value);
    State.cfg.transition = document.getElementById('cfg-transition').value;
    State.cfg.kenburns = document.getElementById('cfg-kenburns').checked;
    saveConfig();
    if (State.mode === 'clock') void rescheduleClockPhotoTimer();
    saveSlideshowBtn.disabled = true;
    showToast('Configurações do slideshow gravadas');
  });

  document.getElementById('cfg-night-mode').addEventListener('change', e => {
    State.cfg.nightMode = e.target.checked;
    // Remove filter inline ao desligar para devolver controle ao CSS
    if (!e.target.checked) document.getElementById('app').style.filter = '';
    applyNightMode();
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
  document.getElementById('btn-fullscreen')?.addEventListener('click', toggleFullscreen);
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

// ─── BOOT ────────────────────────────────────
async function initCapacitor() {
  if (!isCapacitor()) return;

  const StatusBar = capacitorPlugin('StatusBar');
  if (StatusBar) {
    try {
      await StatusBar.setOverlaysWebView({ overlay: true });
      await StatusBar.hide();
    } catch(e) { console.warn('StatusBar:', e); }
  }

  const NavigationBar = capacitorPlugin('NavigationBar');
  if (NavigationBar) {
    try { await NavigationBar.hide(); } catch(e) {}
  }

  if (State.cfg.wakelock) {
    const keepAwake = capacitorPlugin('KeepAwake');
    if (keepAwake) {
      try { await keepAwake.keepAwake(); } catch(e) {}
    }
  }
}

async function init() {
  try {
    await initCapacitor();
    loadConfig();
    initCitiesFromStorage();
    if (isCapacitor()) initNativeGalleryFolder();
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
      await clearLegacyPhotoStorage();
      if (isCapacitor()) {
        await clearOldGalleryData();
        // Primeira execução: nenhuma galeria salva → solicita acesso automaticamente
        const hasNativeGallery = State.linkedFolders.some((f) => f.nativeGallerySource);
        if (!hasNativeGallery) {
          void loadFullGalleryNative();
        }
      } else if (isAppleMobileDevice()) {
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
    } catch (e) {
      console.warn('init folder photos:', e);
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

    applyNightMode();
    initAmbientLightSensor();
    verifyBrowserStyles();
    initAISettings();
  } catch (e) {
    console.error('init falhou:', e);
    showToast('Erro ao iniciar — recarregue com Cmd+Shift+R');
  }
}

function verifyBrowserStyles() {
  const host = location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return;
  const sheet = document.getElementById('app-stylesheet');
  if (!sheet || sheet.sheet) return;
  document.documentElement.classList.add('css-missing');
}

// ─── MODO NOTURNO ─────────────────────────────
let _nightStream        = null;
let _nightVideo         = null;
let _nightCanvas        = null;
let _nightCtx           = null;
let _nightTimer         = null;
let _nightWakeLockTimer = null;

function applyNightMode() {
  const enabled = !!State.cfg.nightMode;
  document.body.classList.toggle('night-mode', enabled);
  if (enabled) {
    _startAmbientCamera();
  } else {
    _stopAmbientCamera();
    const app = document.getElementById('app');
    if (app) app.style.filter = '';
  }
}

async function _startAmbientCamera() {
  if (_nightStream) return;
  // No browser de desktop o sensor de câmera não existe — não escurecer o app inteiro
  if (!isCapacitor() && !isAppleMobileDevice()) return;
  try {
    _nightStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 32 }, height: { ideal: 32 } },
      audio: false
    });

    // Vídeo precisa estar no DOM para receber frames no iOS
    _nightVideo = document.createElement('video');
    _nightVideo.srcObject = _nightStream;
    _nightVideo.playsInline = true;
    _nightVideo.muted = true;
    _nightVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:-9999px';
    document.body.appendChild(_nightVideo);

    await new Promise((resolve, reject) => {
      _nightVideo.oncanplay = resolve;
      _nightVideo.onerror = reject;
      _nightVideo.play().catch(reject);
      setTimeout(reject, 5000); // timeout 5s
    });

    _nightCanvas = document.createElement('canvas');
    _nightCanvas.width = 16;
    _nightCanvas.height = 16;
    _nightCtx = _nightCanvas.getContext('2d', { willReadFrequently: true });

    _sampleAmbientLight();
    // Amostra luz a cada 3s + re-solicita WakeLock a cada 30s (câmera pode liberar o lock)
    _nightTimer = setInterval(() => {
      _sampleAmbientLight();
    }, 3000);
    _nightWakeLockTimer = setInterval(() => {
      if (State.cfg.wakelock) requestWakeLock();
    }, 30000);
    // Re-solicita imediatamente após câmera iniciar (iOS pode ter liberado o lock)
    if (State.cfg.wakelock) setTimeout(() => requestWakeLock(), 500);
  } catch (e) {
    console.warn('Câmera indisponível para sensor de luz:', e.message);
    if (isCapacitor() || isAppleMobileDevice()) {
      const app = document.getElementById('app');
      if (app) app.style.filter = 'brightness(0.5)';
    }
  }
}

function _stopAmbientCamera() {
  if (_nightTimer) { clearInterval(_nightTimer); _nightTimer = null; }
  if (_nightWakeLockTimer) { clearInterval(_nightWakeLockTimer); _nightWakeLockTimer = null; }
  if (_nightStream) { _nightStream.getTracks().forEach(t => t.stop()); _nightStream = null; }
  if (_nightVideo && _nightVideo.parentNode) _nightVideo.parentNode.removeChild(_nightVideo);
  _nightVideo = null;
  _nightCanvas = null;
  _nightCtx = null;
}

function _sampleAmbientLight() {
  if (!State.cfg.nightMode || !_nightCtx || !_nightVideo) return;
  try {
    _nightCtx.drawImage(_nightVideo, 0, 0, 16, 16);
    const pixels = _nightCtx.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      sum += pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
    }
    const avgLum = sum / (16 * 16); // 0–255
    // escuro (0) → brightness 0.08 ; claro (80+) → brightness 0.65
    const t = Math.min(1, avgLum / 80);
    const brightness = (0.08 + t * 0.57).toFixed(2);
    const app = document.getElementById('app');
    if (app) app.style.filter = `brightness(${brightness})`;
  } catch (e) { /* frame ainda não disponível */ }
}

function initAmbientLightSensor() { /* sensor arranca ao ligar o modo noturno */ }

// ─── IA — CONFIGURAÇÕES & ANÁLISE ────────────────────────────────────────────
function initAISettings() {
  // Carrega valores salvos nos campos
  const cfg = window.AIConfigService?.getConfig() || {};
  const sb  = window.SupabaseClient?.getConfig()   || {};

  const $ = (id) => document.getElementById(id);

  const providerSel = $('cfg-ai-provider');
  const modelInput  = $('cfg-ai-model');
  const keyInput    = $('cfg-ai-key');
  const rateSel     = $('cfg-ai-rate');
  const batchSel    = $('cfg-ai-batch');
  const sbUrlInput  = $('cfg-sb-url');
  const sbKeyInput  = $('cfg-sb-key');

  if (!providerSel) return; // painel de IA não está no DOM

  // Preenche campos salvos
  if (cfg.provider)  providerSel.value = cfg.provider;
  if (cfg.model)     modelInput.value  = cfg.model;
  if (cfg.apiKey)    keyInput.value    = cfg.apiKey;
  if (cfg.rateLimit !== undefined) rateSel.value  = String(cfg.rateLimit);
  if (cfg.batchSize !== undefined) batchSel.value = String(cfg.batchSize);
  if (sb.url)     sbUrlInput.value = sb.url;
  if (sb.anonKey) sbKeyInput.value = sb.anonKey;

  // Modelo padrão ao trocar provedor
  providerSel.addEventListener('change', () => {
    if (!modelInput.value) {
      modelInput.value = window.AIConfigService?.getDefaultModel(providerSel.value) || '';
    }
  });

  // Mostrar/ocultar chave AI
  $('btn-ai-key-toggle')?.addEventListener('click', () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
  });

  // Mostrar/ocultar chave Supabase
  $('btn-sb-key-toggle')?.addEventListener('click', () => {
    sbKeyInput.type = sbKeyInput.type === 'password' ? 'text' : 'password';
  });

  // Salvar configuração AI
  $('btn-ai-save')?.addEventListener('click', () => {
    const provider  = providerSel.value;
    const model     = modelInput.value.trim();
    const apiKey    = keyInput.value.trim();
    const rateLimit = parseInt(rateSel.value, 10);
    const batchSize = parseInt(batchSel.value, 10);

    if (!provider) { _aiStatus('Selecione um provedor.', false); return; }
    if (!apiKey)   { _aiStatus('Informe a chave de API.', false); return; }

    window.AIConfigService?.saveConfig({ provider, model, apiKey, rateLimit, batchSize });
    _aiStatus('Configuração salva!', true);
    _updateAIStartButton();
  });

  // Salvar Supabase
  $('btn-sb-save')?.addEventListener('click', async () => {
    const url    = sbUrlInput.value.trim();
    const anonKey = sbKeyInput.value.trim();
    if (!url || !anonKey) { _sbStatus('Preencha URL e chave.', false); return; }

    window.SupabaseClient?.saveConfig(url, anonKey);
    _sbStatus('Testando conexão…', true);

    const result = await window.SupabaseClient?.testConnection();
    if (result?.ok) {
      _sbStatus('Supabase conectado!', true);
    } else {
      _sbStatus(`Erro: ${result?.error || 'falha na conexão'}`, false);
    }
  });

  // Botão Analisar fotos
  $('btn-ai-start')?.addEventListener('click', () => {
    if (window.PhotoAnalysisService?.isRunning()) {
      window.PhotoAnalysisService.pause();
      _updateAIStartButton();
      return;
    }
    _startPhotoAnalysis();
  });

  $('btn-ai-stop')?.addEventListener('click', () => {
    window.PhotoAnalysisService?.pause();
    _updateAIStartButton();
  });

  // Lista de pessoas
  const peopleList = $('people-list');
  if (peopleList) window.PeopleService?.renderPeopleList(peopleList);

  _updateAIStartButton();
}

function _aiStatus(msg, ok) {
  const el = document.getElementById('ai-config-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? 'var(--accent)' : '#ff6b6b';
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}

function _sbStatus(msg, ok) {
  const el = document.getElementById('sb-config-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? 'var(--accent)' : '#ff6b6b';
  el.hidden = false;
}

function _updateAIStartButton() {
  const startBtn = document.getElementById('btn-ai-start');
  const stopBtn  = document.getElementById('btn-ai-stop');
  if (!startBtn) return;

  const isConfigured = window.AIConfigService?.isConfigured();
  const hasPhotos    = (State.folderPlaylist?.length || 0) > 0;

  startBtn.disabled = !isConfigured || !hasPhotos;

  const running = window.PhotoAnalysisService?.isRunning();
  startBtn.textContent = running ? 'Pausar análise' : 'Analisar fotos';
  if (stopBtn) stopBtn.classList.toggle('hidden', !running);
}

function _startPhotoAnalysis() {
  const identifiers = (State.folderPlaylist || [])
    .map((path) => {
      const parts = path.split('::');
      return parts.length > 1 ? parts[1] : null;
    })
    .filter(Boolean);

  if (!identifiers.length) {
    showToast('Nenhuma foto na lista para analisar.');
    return;
  }

  const progressEl = document.getElementById('ai-progress');
  const fillEl     = document.getElementById('ai-progress-fill');
  const labelEl    = document.getElementById('ai-progress-label');
  if (progressEl) progressEl.classList.remove('hidden');

  window.PhotoAnalysisService?.start(identifiers, {
    onProgress(done, total) {
      if (!total) return;
      const pct = Math.round((done / total) * 100);
      if (fillEl)  fillEl.style.width = `${pct}%`;
      if (labelEl) labelEl.textContent = `${done} / ${total} analisadas (${pct}%)`;
      if (done >= total && progressEl) {
        setTimeout(() => progressEl.classList.add('hidden'), 3000);
      }
      _updateAIStartButton();
    },
    onResult(identifier, result) {
      // Atualiza etiqueta da foto atual se for a mesma
      if (clockPhotoPlaylist?.[clockPhotoIndex]?.includes(identifier)) {
        _enrichCurrentPhotoMeta(identifier);
      }
      // Atualiza lista de pessoas se IA detectou pessoas
      if (result.people_count > 0) {
        window.PeopleService?.ensurePeopleFromAnalysis(identifier, result.people_count);
        const peopleList = document.getElementById('people-list');
        if (peopleList) window.PeopleService?.renderPeopleList(peopleList);
      }
    },
  });
  _updateAIStartButton();
}

// Enriquece a etiqueta atual com dados da IA (chamado quando foto muda)
function _enrichCurrentPhotoMeta(identifier) {
  if (!identifier || !window.PhotoAnalysisService) return;
  const result = window.PhotoAnalysisService.getResultFor(identifier);
  if (!result) return;

  // Notifica o sistema de metadados para re-renderizar com dados da IA
  const overlay = document.getElementById('clock-photo-meta');
  if (!overlay) return;

  // Injeta subtítulo de IA se não houver localização EXIF
  const existing = overlay.querySelector('.meta-location, .meta-desc');
  if (!existing) {
    const aiMeta = overlay.querySelector('.meta-ai') || document.createElement('div');
    aiMeta.className = 'meta-ai';
    const parts = [];
    if (result.occasion) parts.push(`Possível ${result.occasion.toLowerCase()}`);
    if (result.scene)    parts.push(result.scene);
    const people = window.PeopleService?.getPeopleForPhoto(identifier) || [];
    if (people.length)   parts.push(people.map((p) => p.displayName).join(', '));
    aiMeta.textContent = parts.join(' · ');
    if (parts.length) overlay.appendChild(aiMeta);
  }
}

// ─── SERVICE WORKER ───────────────────────────
function shouldUseServiceWorker() {
  if (isCapacitor()) return false;
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return false;
  if (host.endsWith('.github.dev')) return false;
  return host.endsWith('.github.io');
}

async function purgePwaCaches() {
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((reg) => reg.unregister()));
  }
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (!shouldUseServiceWorker()) {
      purgePwaCaches().catch((e) => console.warn('cache purge:', e));
      return;
    }
    navigator.serviceWorker.register(new URL('sw.js', window.location.href))
      .then((registration) => {
        console.log('SW registrado');
        registration.update();
      })
      .catch((e) => console.warn('SW erro:', e));
  });
}

document.addEventListener('DOMContentLoaded', init);
