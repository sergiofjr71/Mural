'use strict';

/**
 * Cliente Supabase com device_id anônimo (sem login).
 * Credenciais e device_id ficam no localStorage do dispositivo.
 */
window.SupabaseClient = (function () {
  const DEVICE_ID_KEY  = 'mural_device_id';
  const SB_URL_KEY     = 'mural_sb_url';
  const SB_KEY_KEY     = 'mural_sb_anon_key';

  // ── device_id ──────────────────────────────────────────────────────────────
  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }

  // ── credenciais ────────────────────────────────────────────────────────────
  function getConfig() {
    return {
      url:    localStorage.getItem(SB_URL_KEY)  || '',
      anonKey: localStorage.getItem(SB_KEY_KEY) || '',
    };
  }

  function saveConfig(url, anonKey) {
    localStorage.setItem(SB_URL_KEY,  url.trim());
    localStorage.setItem(SB_KEY_KEY,  anonKey.trim());
  }

  function isConfigured() {
    const { url, anonKey } = getConfig();
    return url.startsWith('https://') && anonKey.length > 10;
  }

  // ── fetch genérico ─────────────────────────────────────────────────────────
  async function request(path, { method = 'GET', body, extraHeaders = {} } = {}) {
    const { url, anonKey } = getConfig();
    if (!url) throw new Error('Supabase não configurado');

    const headers = {
      'apikey':        anonKey,
      'Authorization': `Bearer ${anonKey}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
      'X-Device-Id':   getDeviceId(),
      ...extraHeaders,
    };

    const res = await fetch(`${url}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // ── REST helpers ───────────────────────────────────────────────────────────
  function from(table) {
    const base = `/rest/v1/${table}`;
    return {
      select: (cols = '*', params = '') =>
        request(`${base}?select=${cols}${params ? '&' + params : ''}`),

      insert: (data, { upsert = false, onConflict = '' } = {}) =>
        request(`${base}${upsert ? `?on_conflict=${onConflict}` : ''}`, {
          method: upsert ? 'POST' : 'POST',
          extraHeaders: upsert ? { 'Prefer': `resolution=merge-duplicates,return=representation` } : {},
          body: data,
        }),

      upsert: (data, onConflict = '') =>
        request(`${base}?on_conflict=${onConflict}`, {
          method: 'POST',
          extraHeaders: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: data,
        }),

      update: (data, filter = '') =>
        request(`${base}?${filter}`, { method: 'PATCH', body: data }),

      delete: (filter = '') =>
        request(`${base}?${filter}`, { method: 'DELETE' }),
    };
  }

  // ── Edge Functions ─────────────────────────────────────────────────────────
  async function callFunction(name, payload) {
    const { url, anonKey } = getConfig();
    if (!url) throw new Error('Supabase não configurado');

    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${anonKey}`,
        'Content-Type':  'application/json',
        'X-Device-Id':   getDeviceId(),
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ── test connection ────────────────────────────────────────────────────────
  async function testConnection() {
    try {
      await request('/rest/v1/?select=1', { extraHeaders: { 'Prefer': '' } });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { getDeviceId, getConfig, saveConfig, isConfigured, from, callFunction, testConnection };
})();
