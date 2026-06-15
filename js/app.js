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
const PHOTO_DB_VERSION = 3;
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

async function queryFolderReadPermission(folder) {
  if (!folder?.handle) return 'granted';
  try {
    return await folder.handle.queryPermission({ mode: 'read' });
  } catch (e) {
    console.warn('queryFolderReadPermission:', e);
    return 'denied';
  }
}

const FOLDER_PERMISSIONS_KEY = 'sd_folder_permissions';

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

async function verifyFolderHandleAccess(folder) {
  if (!folder?.handle) return true;
  try {
    const iter = folder.handle.values();
    await iter.next();
    return true;
  } catch {
    return false;
  }
}

async function folderHasReadAccess(folder) {
  if (!folder?.handle) return true;

  if (await verifyFolderHandleAccess(folder)) {
    markFolderPermissionGranted(folder.id);
    return true;
  }

  const state = await queryFolderReadPermission(folder);
  if (state === 'granted') {
    markFolderPermissionGranted(folder.id);
    return true;
  }

  return false;
}

async function requestFolderReadPermission(folder) {
  if (!folder?.handle) return true;
  try {
    const current = await folder.handle.queryPermission({ mode: 'read' });
    if (current === 'granted') return true;
    const result = await folder.handle.requestPermission({ mode: 'read' });
    if (result !== 'granted') return false;
    return verifyFolderHandleAccess(folder);
  } catch (e) {
    console.warn('requestFolderReadPermission:', e);
    return false;
  }
}

async function ensureFolderReadPermission(folder, { interactive = false } = {}) {
  if (!folder?.handle) return true;
  if (await folderHasReadAccess(folder)) return true;
  if (!interactive) return false;

  const granted = await requestFolderReadPermission(folder);
  if (granted) markFolderPermissionGranted(folder.id);
  return granted;
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
      kindEl.textContent = 'somente nesta sessão';
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
        persisted: Boolean(folder.handle),
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

async function clearAllLinkedFolders() {
  State.linkedFolders = [];
  clearFolderPhotoState();
  try {
    localStorage.removeItem('sd_folder_names');
    localStorage.removeItem('sd_folder_name');
    localStorage.removeItem('sd_linked_folders_meta');
    const db = await openPhotoDB();
    const tx = db.transaction('folder', 'readwrite');
    const store = tx.objectStore('folder');
    store.delete('linked');
    store.delete('primary');
    await idbTransactionDone(tx);
  } catch (e) {
    console.warn('clearAllLinkedFolders:', e);
  }
}

async function removeLinkedFolder(folderId) {
  clearFolderPermissionGranted(folderId);
  clearHiddenFolderPhotosForFolder(folderId);
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

async function addLinkedSessionFolder(name, files) {
  const uniqueName = getUniqueFolderName(name);
  State.linkedFolders.push({
    id: generateFolderId(),
    name: uniqueName,
    files,
  });
  renderLinkedFoldersList();
  updatePhotoActionButtons();
  saveLinkedFoldersMeta();
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

function isUsableImageSrc(src) {
  return typeof src === 'string'
    && src.length > 0
    && src !== 'undefined'
    && (src.startsWith('blob:') || src.startsWith('data:image/') || /^https?:/i.test(src));
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
  const listBtn = document.getElementById('btn-show-photo-list');
  const rescanBtn = document.getElementById('btn-rescan-folders');
  if (listBtn) {
    listBtn.disabled = !hasFolders;
    if (!hasFolders) {
      photoPlaylistListVisible = false;
      listBtn.classList.remove('is-active');
    }
  }
  if (rescanBtn) rescanBtn.disabled = !hasFolders;
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

function isAppleMobileDevice() {
  return document.documentElement.classList.contains('platform-ios');
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
  if (!nativeBtn || !fallbackLabel) return;

  document.documentElement.classList.toggle('platform-ios', isAppleMobileDevice());

  if (isAppleMobileDevice()) {
    nativeBtn.hidden = true;
    fallbackLabel.hidden = true;
    if (galleryLabel) galleryLabel.hidden = false;
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
    const granted = await requestFolderReadPermission({ handle: dir, name: dir.name });
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

  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length) {
    showToast('Nenhuma foto selecionada');
    return;
  }

  void applySessionFolder(files, { name: 'Galeria de Fotos' });
}

async function handleFolderFallbackInput(input) {
  if (folderPickInProgress) {
    showToast('Aguarde o processamento da pasta anterior');
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
}

async function applySessionFolder(files, { name } = {}) {
  const allFiles = Array.from(files);
  if (!allFiles.length) return false;

  const root = name
    || allFiles[0].webkitRelativePath?.split('/')[0]
    || allFiles[0].name
    || 'Pasta';

  const imageFiles = allFiles.filter((file) => isDisplayableImageFile(file));

  folderPickInProgress = true;
  try {
    const added = await addLinkedSessionFolder(root, allFiles);
    if (!added) return false;

    await afterFolderAdded({ notify: true });

    if (!imageFiles.length) {
      showToast('Nenhuma imagem compatível selecionada (jpg, png, gif, webp, heic)');
    } else if (isAppleMobileDevice()) {
      showToast('Fotos da galeria incluídas — válidas nesta sessão');
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
    const kind = folder.handle ? 'salva neste dispositivo' : 'somente nesta sessão';
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

  if (skipAttempts >= count) {
    revokeClockPhotoObjectUrl();
    img.removeAttribute('src');
    img.style.opacity = '0';
    if (empty) empty.style.display = 'flex';
    await updateClockPhotoNav();
    return;
  }

  if (clockPhotoIndex >= count) clockPhotoIndex = 0;
  const { src } = await resolvePhotoAtIndex(clockPhotoIndex % count);
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
    if (empty) empty.style.display = 'none';
  };
  loader.onerror = () => {
    console.warn('clock photo failed to load');
    revokeClockPhotoObjectUrl();
    img.removeAttribute('src');
    img.style.opacity = '0';
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
async function refreshStoredFolderAccess() {
  await updateFolderPermissionBanner();
  void updateLinkedFoldersPermissionLabels();
}

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
  document.getElementById('btn-settings-fab')?.addEventListener('click', openSettings);
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

  document.getElementById('cfg-transition').addEventListener('change', e => {
    State.cfg.transition = e.target.value;
    saveConfig();
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
async function init() {
  loadConfig();
  loadFolderPlaylist();
  loadHiddenFolderPhotos();
  lastMidnightCheckDate = getTodayKey();

  bindEvents();
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
    await loadStoredFolderHandles();
    if (usesFolderSource()) {
      await refreshStoredFolderAccess();
      const access = await ensureAllLinkedFolderPermissions({ interactive: false });
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
}

// ─── SERVICE WORKER ───────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', window.location.href))
      .then((registration) => {
        console.log('SW registrado');
        registration.update();
      })
      .catch((e) => console.warn('SW erro:', e));
  });
}

document.addEventListener('DOMContentLoaded', init);
