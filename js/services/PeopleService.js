'use strict';

/**
 * Gerencia pessoas identificadas nas fotos.
 * Dados ficam no localStorage (e opcionalmente sincronizados ao Supabase).
 */
window.PeopleService = (function () {
  const PEOPLE_KEY    = 'mural_people';
  const ASSOC_KEY     = 'mural_photo_people';    // Map photoIdentifier → [personId, ...]
  const DISMISSED_KEY = 'mural_dismissed_people'; // Map photoIdentifier → count descartado

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
      dismissed:   false,
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
    // Remove person and all their associations
    const people = getAll().filter((p) => p.id !== id);
    _save(people);
    const assoc = getAssociations();
    Object.keys(assoc).forEach((identifier) => {
      assoc[identifier] = assoc[identifier].filter((pid) => pid !== id);
    });
    _saveAssociations(assoc);
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

  function associatePersonToPhoto(identifier, personId) {
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

  // ── descarte por foto ─────────────────────────────────────────────────────
  // Armazena quantas pessoas foram descartadas por foto, para não recriar.
  function getDismissed() {
    try { return JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}'); }
    catch { return {}; }
  }
  function _saveDismissed(d) {
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(d)); } catch { /* quota */ }
  }

  function getDismissedCountForPhoto(identifier) {
    return getDismissed()[identifier] || 0;
  }

  function dismissPersonFromPhoto(identifier, personId) {
    // Remove associação
    removePersonFromPhoto(identifier, personId);
    // Se a pessoa não tem mais fotos e não foi confirmada, remove inteiramente
    const person = getById(personId);
    if (person && !person.confirmed && getPhotosForPerson(personId).length === 0) {
      remove(personId);
    }
    // Incrementa contador de descartados para esta foto
    const d = getDismissed();
    d[identifier] = (d[identifier] || 0) + 1;
    _saveDismissed(d);
  }

  // ── criação automática baseada na análise de IA ───────────────────────────
  function ensurePeopleFromAnalysis(identifier, peopleCount) {
    if (!peopleCount || peopleCount <= 0) return [];
    const existing  = getPeopleForPhoto(identifier);
    const dismissed = getDismissedCountForPhoto(identifier);
    // Total de pessoas "aceitas" = existentes + descartadas ≥ total detectado → não cria mais
    if (existing.length + dismissed >= peopleCount) return existing;

    const created = [];
    const toCreate = peopleCount - existing.length - dismissed;
    for (let i = 0; i < toCreate; i++) {
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
  function _getThumbForPerson(personId) {
    const photos = getPhotosForPerson(personId);
    if (!photos.length) return null;
    const cache = window.nativeThumbCache;
    if (!cache) return null;
    for (const identifier of photos) {
      if (cache.has(identifier)) return cache.get(identifier);
    }
    return null;
  }

  function renderPeopleList(container) {
    const people = getAll();
    container.innerHTML = '';

    if (!people.length) {
      container.innerHTML = '<p class="settings-hint" id="people-empty">Nenhuma pessoa identificada ainda. As pessoas são detectadas automaticamente conforme as fotos aparecem no slideshow.</p>';
      return;
    }

    people.forEach((person) => {
      const photoCount = getPhotosForPerson(person.id).length;
      const thumb = _getThumbForPerson(person.id);
      const avatarHtml = thumb
        ? `<img class="person-avatar" src="${thumb}" alt="${_esc(person.displayName)}">`
        : `<div class="person-avatar person-avatar--empty">👤</div>`;

      const card = document.createElement('div');
      card.className = 'person-card' + (person.confirmed ? ' person-card--confirmed' : '');
      card.dataset.personId = person.id;
      card.innerHTML = `
        ${avatarHtml}
        <div class="person-info">
          <div class="person-name">${_esc(person.displayName)}</div>
          <div class="person-meta">${person.confirmed ? '✔ Confirmado' : 'Aguardando identificação'}${person.alias ? ' · ' + _esc(person.alias) : ''}</div>
        </div>
        <div class="person-actions">
          <span class="person-photo-count">${photoCount} foto${photoCount !== 1 ? 's' : ''}</span>
          <button type="button" class="btn-person-edit" title="Identificar">✏️</button>
          <button type="button" class="btn-person-dismiss" title="Descartar">✕</button>
        </div>
      `;

      card.querySelector('.btn-person-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(person.id, () => renderPeopleList(container));
      });
      card.querySelector('.btn-person-dismiss').addEventListener('click', (e) => {
        e.stopPropagation();
        _confirmDiscard(person, container);
      });

      container.appendChild(card);
    });
  }

  function _confirmDiscard(person, container) {
    const overlay = document.createElement('div');
    overlay.className = 'person-modal-overlay';
    overlay.innerHTML = `
      <div class="person-modal">
        <h3>Descartar pessoa</h3>
        <p class="settings-hint" style="margin:8px 0 16px">O que deseja fazer com <strong>${_esc(person.displayName)}</strong>?</p>
        <div class="person-modal-actions" style="flex-direction:column;gap:8px">
          <button type="button" class="btn-action btn-action--secondary" id="pd-cancel" style="width:100%">Cancelar</button>
          <button type="button" class="btn-action btn-action--secondary" id="pd-remove-all" style="width:100%">Remover de todas as fotos</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#pd-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#pd-remove-all').addEventListener('click', () => {
      remove(person.id);
      overlay.remove();
      renderPeopleList(container);
    });
  }

  function openEditModal(personId, onSave) {
    const person = getById(personId);
    if (!person) return;

    const overlay = document.createElement('div');
    overlay.className = 'person-modal-overlay';
    overlay.innerHTML = `
      <div class="person-modal">
        <h3>Identificar pessoa</h3>
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
      const newName = overlay.querySelector('#pm-name').value.trim();
      update(personId, {
        displayName: newName || person.displayName,
        alias:       overlay.querySelector('#pm-alias').value.trim() || null,
        birthDate:   overlay.querySelector('#pm-birth').value || null,
        notes:       overlay.querySelector('#pm-notes').value.trim() || null,
        confirmed:   true,
      });
      overlay.remove();
      if (onSave) onSave();
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
    ensurePeopleFromAnalysis, dismissPersonFromPhoto,
    renderPeopleList, openEditModal,
  };
})();
