'use strict';

window.PeopleService = (function () {
  const PEOPLE_KEY    = 'mural_people';
  const ASSOC_KEY     = 'mural_photo_people';
  const DISMISSED_KEY = 'mural_dismissed_count'; // Map identifier → count descartado

  // ── CRUD local ────────────────────────────────────────────────────────────
  function getAll() {
    try { return JSON.parse(localStorage.getItem(PEOPLE_KEY) || '[]'); }
    catch { return []; }
  }
  function _save(people) {
    try { localStorage.setItem(PEOPLE_KEY, JSON.stringify(people)); } catch { }
  }

  function getById(id) {
    return getAll().find((p) => p.id === id) || null;
  }

  function create({ displayName, alias, birthDate, notes, thumbnailUrl } = {}) {
    const people = getAll();
    const count  = people.filter((p) => !p.dismissed).length + 1;
    const person = {
      id:           crypto.randomUUID(),
      displayName:  displayName  || `Pessoa ${count}`,
      alias:        alias        || null,
      birthDate:    birthDate    || null,
      notes:        notes        || null,
      thumbnailUrl: thumbnailUrl || null,
      confirmed:    false,
      dismissed:    false,
      createdAt:    new Date().toISOString(),
      updatedAt:    new Date().toISOString(),
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
    _save(getAll().filter((p) => p.id !== id));
    const assoc = getAssociations();
    Object.keys(assoc).forEach((k) => { assoc[k] = assoc[k].filter((pid) => pid !== id); });
    _saveAssociations(assoc);
  }

  // ── associações foto ↔ pessoas ────────────────────────────────────────────
  function getAssociations() {
    try { return JSON.parse(localStorage.getItem(ASSOC_KEY) || '{}'); }
    catch { return {}; }
  }
  function _saveAssociations(assoc) {
    try { localStorage.setItem(ASSOC_KEY, JSON.stringify(assoc)); } catch { }
  }

  function getPeopleForPhoto(identifier) {
    const ids = (getAssociations()[identifier] || []);
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
      .map(([id]) => id);
  }

  // ── contagem de descartados por foto ──────────────────────────────────────
  function _getDismissedCounts() {
    try { return JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}'); }
    catch { return {}; }
  }
  function _saveDismissedCounts(d) {
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(d)); } catch { }
  }

  // ── criação automática via análise de IA ──────────────────────────────────
  function ensurePeopleFromAnalysis(identifier, peopleCount) {
    if (!peopleCount || peopleCount <= 0) return [];

    // Filtra apenas os não descartados associados a esta foto
    const existing   = getPeopleForPhoto(identifier).filter((p) => !p.dismissed);
    const dismissed  = (_getDismissedCounts()[identifier] || 0);
    if (existing.length + dismissed >= peopleCount) return existing;

    // Pega thumbnail desta foto para salvar nos novos registros
    const thumb = window.nativeThumbCache?.get(identifier) || null;

    const created = [];
    const toCreate = peopleCount - existing.length - dismissed;
    for (let i = 0; i < toCreate; i++) {
      const p = create({ thumbnailUrl: thumb });
      associatePersonToPhoto(identifier, p.id);
      created.push(p);
    }
    return [...existing, ...created];
  }

  // ── descarte (marca como dismissed, não deleta) ───────────────────────────
  function dismissPersonFromPhoto(identifier, personId) {
    // Marca a pessoa como descartada
    update(personId, { dismissed: true, confirmed: false });
    // Remove associação com a foto
    removePersonFromPhoto(identifier, personId);
    // Registra +1 descartado para esta foto
    const d = _getDismissedCounts();
    d[identifier] = (d[identifier] || 0) + 1;
    _saveDismissedCounts(d);
  }

  function dismissPersonGlobally(personId) {
    update(personId, { dismissed: true, confirmed: false });
  }

  function restorePerson(personId) {
    update(personId, { dismissed: false });
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
  function _avatarHtml(person) {
    // Prioridade: thumbnail salvo no registro → nativeThumbCache → ícone
    const thumb = person.thumbnailUrl
      || (window.nativeThumbCache
        ? (() => { const ph = getPhotosForPerson(person.id); for (const id of ph) { if (window.nativeThumbCache.has(id)) return window.nativeThumbCache.get(id); } return null; })()
        : null);
    return thumb
      ? `<img class="person-avatar" src="${thumb}" alt="${_esc(person.displayName)}">`
      : `<div class="person-avatar person-avatar--empty">👤</div>`;
  }

  function _buildCard(person, container) {
    const photoCount = getPhotosForPerson(person.id).length;
    const card = document.createElement('div');
    card.className = 'person-card' + (person.confirmed ? ' person-card--confirmed' : '');
    card.dataset.personId = person.id;
    card.innerHTML = `
      ${_avatarHtml(person)}
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
      dismissPersonGlobally(person.id);
      renderPeopleList(container);
    });
    return card;
  }

  function _buildDismissedCard(person, container) {
    const card = document.createElement('div');
    card.className = 'person-card person-card--dismissed';
    card.dataset.personId = person.id;
    card.innerHTML = `
      ${_avatarHtml(person)}
      <div class="person-info">
        <div class="person-name">${_esc(person.displayName)}</div>
        <div class="person-meta">Descartada</div>
      </div>
      <div class="person-actions">
        <button type="button" class="btn-person-restore" title="Restaurar">↩</button>
        <button type="button" class="btn-person-delete" title="Excluir definitivamente">🗑</button>
      </div>
    `;
    card.querySelector('.btn-person-restore').addEventListener('click', (e) => {
      e.stopPropagation();
      restorePerson(person.id);
      renderPeopleList(container);
    });
    card.querySelector('.btn-person-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Excluir "${person.displayName}" definitivamente?`)) {
        remove(person.id);
        renderPeopleList(container);
      }
    });
    return card;
  }

  function renderPeopleList(container) {
    const all       = getAll();
    const active    = all.filter((p) => !p.dismissed);
    const dismissed = all.filter((p) => p.dismissed);
    container.innerHTML = '';

    // Cabeçalho com botão atualizar
    const header = document.createElement('div');
    header.className = 'people-list-header';
    header.innerHTML = `<span class="people-list-count">${active.length} pessoa${active.length !== 1 ? 's' : ''}</span><button type="button" class="btn-people-refresh" title="Atualizar lista">↻ Atualizar</button>`;
    header.querySelector('.btn-people-refresh').addEventListener('click', () => renderPeopleList(container));
    container.appendChild(header);

    if (!active.length) {
      const empty = document.createElement('p');
      empty.className = 'settings-hint';
      empty.textContent = 'Nenhuma pessoa identificada ainda. As pessoas são detectadas automaticamente conforme as fotos aparecem no slideshow.';
      container.appendChild(empty);
    } else {
      active.forEach((person) => container.appendChild(_buildCard(person, container)));
    }

    // Seção de descartados (colapsável)
    if (dismissed.length) {
      const section = document.createElement('div');
      section.className = 'people-dismissed-section';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'people-dismissed-toggle';
      toggle.textContent = `▶ Descartadas (${dismissed.length})`;
      const list = document.createElement('div');
      list.className = 'people-dismissed-list hidden';
      toggle.addEventListener('click', () => {
        const open = list.classList.toggle('hidden');
        toggle.textContent = (open ? '▶' : '▼') + ` Descartadas (${dismissed.length})`;
      });
      dismissed.forEach((person) => list.appendChild(_buildDismissedCard(person, container)));
      section.appendChild(toggle);
      section.appendChild(list);
      container.appendChild(section);
    }
  }

  function openEditModal(personId, onSave) {
    const person = getById(personId);
    if (!person) return;

    const overlay = document.createElement('div');
    overlay.className = 'person-modal-overlay';
    const thumbHtml = _avatarHtml(person);
    overlay.innerHTML = `
      <div class="person-modal">
        <div class="person-modal-avatar">${thumbHtml}</div>
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
      update(personId, {
        displayName: overlay.querySelector('#pm-name').value.trim() || person.displayName,
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
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }

  return {
    getAll, getById, create, update, remove,
    getPeopleForPhoto, associatePersonToPhoto, removePersonFromPhoto, getPhotosForPerson,
    ensurePeopleFromAnalysis, dismissPersonFromPhoto, dismissPersonGlobally, restorePerson,
    renderPeopleList, openEditModal,
  };
})();
