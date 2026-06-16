/* global Preferences, PhotoShuffleService, MuralPlatform */
'use strict';

window.PhotoLibraryService = (function () {
  const PREFS_PHOTO_IDS = 'mural_photo_ids';
  const PREFS_SHUFFLED_IDS = 'mural_shuffled_ids';
  const PREFS_LAST_REFRESH = 'mural_last_library_refresh';
  const PREFS_SHUFFLE_ENABLED = 'mural_shuffle_enabled';

  const state = {
    ready: false,
    authorized: false,
    photoIds: [],
    shuffledIds: [],
    currentIndex: 0,
    lastLibraryRefresh: '',
    shuffleEnabled: true,
    cache: {
      currentId: null,
      currentSrc: null,
      nextId: null,
      nextSrc: null,
    },
  };

  function getPlugin() {
    return MuralPlatform.getPhotoLibraryPlugin();
  }

  async function getPreferences() {
    if (typeof Preferences !== 'undefined' && Preferences.get) {
      return Preferences;
    }
    const cap = MuralPlatform.getCapacitor();
    if (cap && cap.Plugins && cap.Plugins.Preferences) {
      return cap.Plugins.Preferences;
    }
    return null;
  }

  async function prefGet(key) {
    const prefs = await getPreferences();
    if (!prefs) {
      try {
        return { value: localStorage.getItem(key) };
      } catch {
        return { value: null };
      }
    }
    return prefs.get({ key });
  }

  async function prefSet(key, value) {
    const prefs = await getPreferences();
    if (!prefs) {
      try {
        localStorage.setItem(key, value);
      } catch (e) {
        console.warn('prefSet fallback:', e);
      }
      return;
    }
    await prefs.set({ key, value });
  }

  function todayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function isEnabled() {
    return MuralPlatform.isNativeIOS() && !!getPlugin();
  }

  async function loadPersistedState() {
    const [idsRaw, shuffledRaw, refreshRaw, shuffleRaw] = await Promise.all([
      prefGet(PREFS_PHOTO_IDS),
      prefGet(PREFS_SHUFFLED_IDS),
      prefGet(PREFS_LAST_REFRESH),
      prefGet(PREFS_SHUFFLE_ENABLED),
    ]);

    try {
      state.photoIds = idsRaw.value ? JSON.parse(idsRaw.value) : [];
    } catch {
      state.photoIds = [];
    }

    try {
      state.shuffledIds = shuffledRaw.value ? JSON.parse(shuffledRaw.value) : [];
    } catch {
      state.shuffledIds = [];
    }

    state.lastLibraryRefresh = refreshRaw.value || '';
    state.shuffleEnabled = shuffleRaw.value !== 'false';
    state.ready = true;
  }

  async function persistState() {
    await Promise.all([
      prefSet(PREFS_PHOTO_IDS, JSON.stringify(state.photoIds)),
      prefSet(PREFS_SHUFFLED_IDS, JSON.stringify(state.shuffledIds)),
      prefSet(PREFS_LAST_REFRESH, state.lastLibraryRefresh),
      prefSet(PREFS_SHUFFLE_ENABLED, state.shuffleEnabled ? 'true' : 'false'),
    ]);
  }

  async function ensurePermission(interactive) {
    const plugin = getPlugin();
    if (!plugin) return { granted: false, status: 'unavailable' };

    const current = await plugin.checkPermission();
    if (current.granted) {
      state.authorized = true;
      return current;
    }

    if (!interactive) return current;
    const requested = await plugin.requestPermission();
    state.authorized = !!requested.granted;
    return requested;
  }

  async function scanLibrary({ reshuffle = true } = {}) {
    const plugin = getPlugin();
    if (!plugin) throw new Error('PhotoLibrary plugin unavailable');

    const permission = await ensurePermission(true);
    if (!permission.granted) {
      throw new Error('Permissão da biblioteca de fotos negada');
    }

    const result = await plugin.getAllPhotos();
    const ids = (result.photos || []).map((photo) => photo.id);
    const previousLast = state.shuffledIds.length
      ? state.shuffledIds[state.shuffledIds.length - 1]
      : null;

    state.photoIds = ids;
    state.lastLibraryRefresh = todayKey();

    if (reshuffle) {
      state.shuffledIds = PhotoShuffleService.shuffleAvoidImmediateRepeat(ids, previousLast);
      state.currentIndex = 0;
    } else if (!state.shuffledIds.length) {
      state.shuffledIds = PhotoShuffleService.shuffleAvoidImmediateRepeat(ids, previousLast);
      state.currentIndex = 0;
    } else {
      const valid = new Set(ids);
      state.shuffledIds = state.shuffledIds.filter((id) => valid.has(id));
      const missing = ids.filter((id) => !state.shuffledIds.includes(id));
      if (missing.length) {
        state.shuffledIds = state.shuffledIds.concat(PhotoShuffleService.fisherYates(missing));
      }
      if (!state.shuffledIds.length) {
        state.shuffledIds = PhotoShuffleService.shuffleAvoidImmediateRepeat(ids, previousLast);
      }
      if (state.currentIndex >= state.shuffledIds.length) {
        state.currentIndex = 0;
      }
    }

    await clearImageCache();
    await persistState();
    return {
      total: state.photoIds.length,
      shuffled: state.shuffledIds.length,
      lastLibraryRefresh: state.lastLibraryRefresh,
    };
  }

  function getCount() {
    return state.shuffledIds.length;
  }

  function getPhotoIdAt(index) {
    if (!state.shuffledIds.length) return null;
    const normalized = ((index % state.shuffledIds.length) + state.shuffledIds.length) % state.shuffledIds.length;
    return state.shuffledIds[normalized];
  }

  async function loadPhotoById(id, maxWidth) {
    const plugin = getPlugin();
    if (!plugin || !id) return null;

    try {
      const result = await plugin.getPhoto({
        id,
        maxWidth: maxWidth || 2048,
        maxHeight: maxWidth || 2048,
        quality: 0.82,
      });

      const webPath = result?.webPath || result?.path;
      if (!webPath) return null;

      return {
        id,
        src: MuralPlatform.convertFileSrc(webPath),
        width: result.width,
        height: result.height,
      };
    } catch (e) {
      console.warn('loadPhotoById:', id, e);
      return null;
    }
  }

  async function releaseCachedId(id) {
    const plugin = getPlugin();
    if (!plugin || !id) return;
    try {
      await plugin.releasePhoto({ id });
    } catch (e) {
      console.warn('releasePhoto:', e);
    }
  }

  async function clearImageCache() {
    const plugin = getPlugin();
    if (plugin && plugin.releaseAllPhotos) {
      try {
        await plugin.releaseAllPhotos();
      } catch (e) {
        console.warn('releaseAllPhotos:', e);
      }
    }
    state.cache = {
      currentId: null,
      currentSrc: null,
      nextId: null,
      nextSrc: null,
    };
  }

  async function resolvePhotoAtIndex(index, maxWidth) {
    const id = getPhotoIdAt(index);
    if (!id) return { src: null, total: 0, id: null };

    if (state.cache.currentId === id && state.cache.currentSrc) {
      return { src: state.cache.currentSrc, total: state.shuffledIds.length, id };
    }

    const loaded = await loadPhotoById(id, maxWidth);
    if (!loaded) return { src: null, total: state.shuffledIds.length, id };

    if (state.cache.currentId && state.cache.currentId !== id) {
      await releaseCachedId(state.cache.currentId);
    }

    state.cache.currentId = id;
    state.cache.currentSrc = loaded.src;

    const nextIndex = PhotoShuffleService.nextIndex(index, state.shuffledIds.length);
    const nextId = getPhotoIdAt(nextIndex);
    if (nextId && nextId !== id && state.cache.nextId !== nextId) {
      if (state.cache.nextId) {
        await releaseCachedId(state.cache.nextId);
      }
      try {
        const nextLoaded = await loadPhotoById(nextId, maxWidth);
        state.cache.nextId = nextId;
        state.cache.nextSrc = nextLoaded ? nextLoaded.src : null;
      } catch (e) {
        console.warn('preload next photo:', e);
      }
    }

    return { src: loaded.src, total: state.shuffledIds.length, id };
  }

  function advanceIndex() {
    if (!state.shuffledIds.length) return 0;
    const atEnd = state.currentIndex >= state.shuffledIds.length - 1;
    if (atEnd) {
      const previousLast = state.shuffledIds[state.shuffledIds.length - 1];
      state.shuffledIds = PhotoShuffleService.shuffleAvoidImmediateRepeat(state.photoIds, previousLast);
      state.currentIndex = 0;
      void persistState();
      return 0;
    }
    state.currentIndex += 1;
    return state.currentIndex;
  }

  function getCurrentIndex() {
    return state.currentIndex;
  }

  function setCurrentIndex(index) {
    if (!state.shuffledIds.length) {
      state.currentIndex = 0;
      return;
    }
    state.currentIndex = ((index % state.shuffledIds.length) + state.shuffledIds.length) % state.shuffledIds.length;
  }

  function needsDailyRefresh() {
    return state.lastLibraryRefresh !== todayKey();
  }

  return {
    isEnabled,
    loadPersistedState,
    persistState,
    ensurePermission,
    scanLibrary,
    getCount,
    getPhotoIdAt,
    resolvePhotoAtIndex,
    clearImageCache,
    advanceIndex,
    getCurrentIndex,
    setCurrentIndex,
    needsDailyRefresh,
    getState: () => state,
  };
})();
