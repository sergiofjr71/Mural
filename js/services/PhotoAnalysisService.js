'use strict';

/**
 * Gerencia a fila de análise de fotos por IA.
 * Processa em background sem bloquear o slideshow.
 * Prioriza a foto atualmente em exibição.
 */
window.PhotoAnalysisService = (function () {
  const QUEUE_KEY    = 'mural_analysis_queue';
  const DONE_KEY     = 'mural_analysis_done';   // Set de identifiers já analisados
  const RESULT_KEY   = 'mural_analysis_results'; // Map identifier → result

  let _running   = false;
  let _paused    = false;
  let _timer     = null;
  let _onProgress = null;  // callback(done, total)
  let _onResult   = null;  // callback(identifier, result)

  // ── persistência leve ─────────────────────────────────────────────────────
  function getDoneSet() {
    try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveDone(set) {
    try { localStorage.setItem(DONE_KEY, JSON.stringify([...set])); } catch { /* quota */ }
  }

  function getResults() {
    try { return JSON.parse(localStorage.getItem(RESULT_KEY) || '{}'); }
    catch { return {}; }
  }
  function saveResult(identifier, result) {
    try {
      const all = getResults();
      all[identifier] = result;
      localStorage.setItem(RESULT_KEY, JSON.stringify(all));
    } catch { /* quota — silent */ }
  }

  function getResultFor(identifier) {
    return getResults()[identifier] || null;
  }

  // ── fila ──────────────────────────────────────────────────────────────────
  function getQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch { return []; }
  }
  function saveQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* quota */ }
  }

  function buildQueue(identifiers) {
    const done = getDoneSet();
    const pending = identifiers.filter((id) => !done.has(id));
    saveQueue(pending);
    return pending;
  }

  // Coloca um identifier no início da fila (foto atual em exibição)
  function prioritize(identifier) {
    let q = getQueue();
    q = [identifier, ...q.filter((id) => id !== identifier)];
    saveQueue(q);
  }

  // ── controle ──────────────────────────────────────────────────────────────
  function start(identifiers, { onProgress, onResult } = {}) {
    if (_running) return;
    _onProgress = onProgress || null;
    _onResult   = onResult   || null;
    _paused     = false;
    _running    = true;

    const pending = buildQueue(identifiers);
    const total   = getDoneSet().size + pending.length;
    _notify(getDoneSet().size, total);

    _scheduleNext();
  }

  function pause()  { _paused = true;  clearTimeout(_timer); }
  function resume() { _paused = false; _scheduleNext(); }
  function stop()   { _paused = true; _running = false; clearTimeout(_timer); }
  function isRunning() { return _running && !_paused; }

  function _notify(done, total) {
    if (_onProgress) _onProgress(done, total);
  }

  function _scheduleNext() {
    if (_paused || !_running) return;
    const { rateLimit } = window.AIConfigService?.getConfig() ?? { rateLimit: 20 };
    // rateLimit = análises/min → intervalo em ms (0 = sem espera mínima, mas ainda async)
    const interval = rateLimit > 0 ? Math.ceil(60000 / rateLimit) : 200;
    _timer = setTimeout(_processNext, interval);
  }

  async function _processNext() {
    if (_paused || !_running) return;

    const q = getQueue();
    if (q.length === 0) {
      _running = false;
      _notify(getDoneSet().size, getDoneSet().size);
      return;
    }

    const identifier = q[0];
    saveQueue(q.slice(1));

    try {
      // 1. Obtém thumbnail base64 da foto
      const imageBase64 = await _getPhotoBase64(identifier);
      if (!imageBase64) throw new Error('Sem dados de imagem');

      // 2. Analisa com IA
      const result = await window.AIConfigService.analyzePhoto(imageBase64);

      // 3. Persiste resultado
      saveResult(identifier, { ...result, analyzedAt: new Date().toISOString() });
      const done = getDoneSet();
      done.add(identifier);
      saveDone(done);

      // 4. Persiste no Supabase se configurado
      if (window.SupabaseClient?.isConfigured()) {
        _syncToSupabase(identifier, result).catch((e) =>
          console.warn('PhotoAnalysisService: sync Supabase falhou', e)
        );
      }

      const total = done.size + getQueue().length;
      _notify(done.size, total);
      if (_onResult) _onResult(identifier, result);

    } catch (e) {
      console.warn('PhotoAnalysisService: erro ao analisar', identifier, e.message);
      // Recoloca no final da fila para tentar mais tarde
      const q2 = getQueue();
      saveQueue([...q2, identifier]);
    }

    _scheduleNext();
  }

  // ── obtém imagem reduzida (512px) ─────────────────────────────────────────
  async function _getPhotoBase64(identifier) {
    // Tenta usar nativeThumbCache (já populado por loadFullGalleryNative)
    if (window.nativeThumbCache?.has(identifier)) {
      const dataUrl = window.nativeThumbCache.get(identifier);
      // dataUrl = "data:image/jpeg;base64,..." → extrai só o base64
      return dataUrl.split(',')[1] || null;
    }

    // Fallback: getMediaByIdentifier → redimensiona no canvas
    const Media = window.capacitorPlugin?.('Media');
    if (Media) {
      try {
        const result = await Media.getMediaByIdentifier({ identifier });
        if (result?.path) {
          return await _pathToBase64(result.path, 512);
        }
      } catch { /* sem imagem disponível */ }
    }

    return null;
  }

  async function _pathToBase64(path, maxSize) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        resolve(dataUrl.split(',')[1]);
      };
      img.onerror = () => resolve(null);
      const src = window.Capacitor?.convertFileSrc
        ? window.Capacitor.convertFileSrc(path.startsWith('file://') ? path : 'file://' + path)
        : path;
      img.src = src;
    });
  }

  // ── sync Supabase ─────────────────────────────────────────────────────────
  async function _syncToSupabase(identifier, result) {
    const deviceId = window.SupabaseClient.getDeviceId();
    const sb = window.SupabaseClient;

    await sb.from('photos').upsert({
      device_id:         deviceId,
      native_identifier: identifier,
      ai_description:    result.description || null,
      ai_scene:          result.scene       || null,
      ai_occasion:       result.occasion    || null,
      ai_people_count:   result.people_count ?? 0,
      analysis_status:   'done',
      analyzed_at:       result.analyzedAt,
    }, 'device_id,native_identifier');

    // Tags
    if (Array.isArray(result.tags) && result.tags.length) {
      // Busca photo_id primeiro
      const photos = await sb.from('photos').select('id',
        `device_id=eq.${deviceId}&native_identifier=eq.${encodeURIComponent(identifier)}`
      );
      const photoId = photos?.[0]?.id;
      if (photoId) {
        await sb.from('photo_tags').delete(
          `photo_id=eq.${photoId}&source=eq.ai`
        );
        for (const tag of result.tags) {
          await sb.from('photo_tags').insert({ photo_id: photoId, tag, source: 'ai' });
        }
      }
    }
  }

  function saveResultLocal(identifier, result) {
    saveResult(identifier, { ...result, analyzedAt: new Date().toISOString() });
    const done = getDoneSet();
    done.add(identifier);
    saveDone(done);
  }

  async function syncToSupabase(identifier, result) {
    return _syncToSupabase(identifier, result);
  }

  return {
    start, pause, resume, stop,
    isRunning,
    prioritize,
    buildQueue,
    getResultFor,
    getQueue,
    getDoneSet,
    saveResultLocal,
    syncToSupabase,
  };
})();
