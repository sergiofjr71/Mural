'use strict';

/**
 * Gerencia pessoas identificadas nas fotos.
 * Dados ficam no localStorage (e opcionalmente sincronizados ao Supabase).
 */
window.PeopleService = (function () {
  const PEOPLE_KEY = 'mural_people';
  const ASSOC_KEY  = 'mural_photo_people'; // Map photoIdentifier → [personId, ...]

  // ── CRUD local ────────────────────────────────────────────────────────────
  function getAll() {
    try { return JSON.parse(localStorage.getItem(PEOPLE_KEY) || '[]'); }
    catch { return []; }
  }
  function _save(people) {
    try { localStorage.setItem(PEOPLE_KEY, JSON.stringify(people)); } catch { /* quota */ }
  }

  function getById(id) {
    return getAll().find((p) => p.id === id) || null;
  }

  function create({ displayName, alias, birthDate, notes } = {}) {
    const people = getAll();
    const count  = people.length + 1;
    const person = {
      id:          crypto.randomUUID(),
      displayName: displayName || `Pessoa ${count}`,
      alias:       alias       || null,
      birthDate:   birthDate   || null,
      notes:       notes       || null,
      confirmed:   false,
      createdAt:   new Date().toISOString(),
      updatedAt:   new Date().toISOString(),
    };
    people.push(person);
    _save(people);
    _syncPersonToSupabase(person).catch(() => {});
    return person;
  }

  function update(id, fields) {
    const people = getAll();
    const idx    = people.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    Object.assign(people[idx], fields, { updatedAt: new Date().toISOString() });
    _save(people);
    _syncPersonToSupabase(people[idx]).catch(() => {});
    return people[idx];
  }

  function remove(id) {
    const people = getAll().filter((p) => p.id !== id);
    _save(people);
  }

  // ── associação foto ↔ pessoas ─────────────────────────────────────────────
  function getAssociations() {
    try { return JSON.parse(localStorage.getItem(ASSOC_KEY) || '{}'); }
    catch { return {}; }
  }
  function _saveAssociations(assoc) {
    try { localStorage.setItem(ASSOC_KEY, JSON.stringify(assoc)); } catch { /* quota */ }
  }

  function getPeopleForPhoto(identifier) {
    const assoc = getAssociations();
    const ids   = assoc[identifier] || [];
    return ids.map((id) => getById(id)).filter(Boolean);
  }

  function associatePersonToPhoto(identifier, personId, { confirmed = false } = {}) {
    const assoc = getAssociations();
    if (!assoc[identifier]) assoc[identifier] = [];
    if (!assoc[identifier].includes(personId)) {
      assoc[identifier].push(personId);
      _saveAssociations(assoc);
    }
  }

  function removePersonFromPhoto(identifier, personId) {
    const assoc = getAssociations();
    if (assoc[identifier]) {
      assoc[identifier] = assoc[identifier].filter((id) => id !== personId);
      _saveAssociations(assoc);
    }
  }

  function getPhotosForPerson(personId) {
    const assoc = getAssociations();
    return Object.entries(assoc)
      .filter(([, ids]) => ids.includes(personId))
      .map(([identifier]) => identifier);
  }

  // ── criação automática baseada na análise de IA ───────────────────────────
  // Quando a IA detecta N pessoas, cria slots "Pessoa X" se ainda não existem.
  function ensurePeopleFromAnalysis(identifier, peopleCount) {
    if (!peopleCount || peopleCount <= 0) return [];
    const existing = getPeopleForPhoto(identifier);
    if (existing.length >= peopleCount) return existing;

    const created = [];
    for (let i = existing.length; i < peopleCount; i++) {
      const p = create();
      associatePersonToPhoto(identifier, p.id);
      created.push(p);
    }
    return [...existing, ...created];
  }

  // ── Supabase sync ─────────────────────────────────────────────────────────
  async function _syncPersonToSupabase(person) {
    if (!window.SupabaseClient?.isConfigured()) return;
    const sb = window.SupabaseClient;
    await sb.from('people').upsert({
      id:           person.id,
      device_id:    sb.getDeviceId(),
      display_name: person.displayName,
      alias:        person.alias,
      birth_date:   person.birthDate,
      notes:        person.notes,
      confirmed:    person.confirmed,
    }, 'id');
  }

  // ── renderização ──────────────────────────────────────────────────────────
  function renderPeopleList(container) {
    const people = getAll();
    container.innerHTML = '';

    if (!people.length) {
      container.innerHTML = '<p class="settings-hint" id="people-empty">Nenhuma pessoa identificada ainda. Execute a análise de fotos primeiro.</p>';
      return;
    }

    people.forEach((person) => {
      const photoCount = getPhotosForPerson(person.id).length;
      const card = document.createElement('div');
      card.className = 'person-card';
      card.dataset.personId = person.id;
      card.innerHTML = `
        <div class="person-avatar">👤</div>
        <div class="person-info">
          <div class="person-name">${_esc(person.displayName)}</div>
          <div class="person-meta">${person.birthDate ? '🎂 ' + _formatBirthDate(person.birthDate) : 'Sem aniversário'}${person.alias ? ' · ' + _esc(person.alias) : ''}</div>
        </div>
        <div class="person-photo-count">${photoCount} foto${photoCount !== 1 ? 's' : ''}</div>
      `;
      card.addEventListener('click', () => openEditModal(person.id));
      container.appendChild(card);
    });
  }

  function openEditModal(personId) {
    const person = getById(personId);
    if (!person) return;

    const overlay = document.createElement('div');
    overlay.className = 'person-modal-overlay';
    overlay.innerHTML = `
      <div class="person-modal">
        <h3>Editar pessoa</h3>
        <label class="settings-label" for="pm-name">Nome</label>
        <input type="text" id="pm-name" class="settings-input" value="${_esc(person.displayName)}" placeholder="Nome da pessoa">
        <label class="settings-label" for="pm-alias">Apelido</label>
        <input type="text" id="pm-alias" class="settings-input" value="${_esc(person.alias || '')}" placeholder="Apelido (opcional)">
        <label class="settings-label" for="pm-birth">Data de aniversário</label>
        <input type="date" id="pm-birth" class="settings-input" value="${person.birthDate || ''}">
        <label class="settings-label" for="pm-notes">Observações</label>
        <input type="text" id="pm-notes" class="settings-input" value="${_esc(person.notes || '')}" placeholder="Observações (opcional)">
        <div class="person-modal-actions">
          <button type="button" class="btn-action btn-action--secondary" id="pm-cancel">Cancelar</button>
          <button type="button" class="btn-action" id="pm-save">Salvar</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector('#pm-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#pm-save').addEventListener('click', () => {
      update(personId, {
        displayName: overlay.querySelector('#pm-name').value.trim() || person.displayName,
        alias:       overlay.querySelector('#pm-alias').value.trim() || null,
        birthDate:   overlay.querySelector('#pm-birth').value || null,
        notes:       overlay.querySelector('#pm-notes').value.trim() || null,
        confirmed:   true,
      });
      overlay.remove();
      const list = document.getElementById('people-list');
      if (list) renderPeopleList(list);
    });
  }

  function _esc(str) {
    return (str || '').replace(/[&<>"']/g, (c) =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]
    );
  }
  function _formatBirthDate(dateStr) {
    if (!dateStr) return '';
    const [, m, d] = dateStr.split('-');
    return `${d}/${m}`;
  }

  return {
    getAll, getById, create, update, remove,
    getPeopleForPhoto, associatePersonToPhoto, removePersonFromPhoto, getPhotosForPerson,
    ensurePeopleFromAnalysis,
    renderPeopleList, openEditModal,
  };
})();
