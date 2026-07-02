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

  // photoIdentifier: referência à foto (para buscar no nativeThumbCache ao renderizar)
  function create({ displayName, alias, birthDate, notes, photoIdentifier } = {}) {
    const people = getAll();
    const count  = people.filter((p) => !p.dismissed).length + 1;
    const person = {
      id:              crypto.randomUUID(),
      displayName:     displayName     || `Pessoa ${count}`,
      alias:           alias           || null,
      birthDate:       birthDate       || null,
      notes:           notes           || null,
      photoIdentifier: photoIdentifier || null, // identifier da foto de origem
      confirmed:       false,
      dismissed:       false,
      createdAt:       new Date().toISOString(),
      updatedAt:       new Date().toISOString(),
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

  // ── merge: une duplicata com pessoa já identificada ───────────────────────
  function mergeInto(sourceId, targetId) {
    if (sourceId === targetId) return;
    // Move todas as associações de sourceId para targetId
    const assoc = getAssociations();
    Object.keys(assoc).forEach((identifier) => {
      if (assoc[identifier].includes(sourceId)) {
        assoc[identifier] = assoc[identifier].filter((id) => id !== sourceId);
        if (!assoc[identifier].includes(targetId)) assoc[identifier].push(targetId);
      }
    });
    _saveAssociations(assoc);
    // Se o target não tem photoIdentifier ainda, herda do source
    const source = getById(sourceId);
    const target = getById(targetId);
    if (source && target && !target.photoIdentifier && source.photoIdentifier) {
      update(targetId, { photoIdentifier: source.photoIdentifier });
    }
    // Remove a duplicata
    remove(sourceId);
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

  // ── mini-avatar 48×48 a partir de um dataUrl base64 ─────────────────────
  function _makeMiniAvatar(dataUrl) {
    return new Promise((resolve) => {
      if (!dataUrl) { resolve(null); return; }
      const img = new Image();
      img.onload = () => {
        const SIZE = 48;
        const canvas = document.createElement('canvas');
        canvas.width  = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        // Recorte central (crop quadrado)
        const side = Math.min(img.width, img.height);
        const sx = (img.width  - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  // ── criação automática via análise de IA ──────────────────────────────────
  function ensurePeopleFromAnalysis(identifier, peopleCount) {
    if (!peopleCount || peopleCount <= 0) return [];
    const existing  = getPeopleForPhoto(identifier).filter((p) => !p.dismissed);
    const dismissed = (_getDismissedCounts()[identifier] || 0);
    if (existing.length + dismissed >= peopleCount) return existing;

    // Tenta gerar mini-avatar da foto atual
    const thumbDataUrl = window.nativeThumbCache?.get(identifier) || null;

    const created = [];
    const toCreate = peopleCount - existing.length - dismissed;
    for (let i = 0; i < toCreate; i++) {
      const p = create({ photoIdentifier: identifier });
      associatePersonToPhoto(identifier, p.id);
      created.push(p);
      // Gera e salva mini-avatar em background (48×48, ~2KB)
      if (thumbDataUrl) {
        _makeMiniAvatar(thumbDataUrl).then((avatar) => {
          if (avatar) update(p.id, { avatarDataUrl: avatar });
        });
      }
    }
    return [...existing, ...created];
  }

  // ── descarte ──────────────────────────────────────────────────────────────
  function dismissPersonFromPhoto(identifier, personId) {
    update(personId, { dismissed: true, confirmed: false });
    removePersonFromPhoto(identifier, personId);
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

  // Atualiza avatarDataUrl de pessoas associadas a uma foto se ainda não têm avatar
  function refreshAvatarsForPhoto(identifier) {
    const thumb = window.nativeThumbCache?.get(identifier);
    if (!thumb) return;
    const people = getPeopleForPhoto(identifier).filter((p) => !p.avatarDataUrl && !p.dismissed);
    people.forEach((p) => {
      _makeMiniAvatar(thumb).then((avatar) => {
        if (avatar) update(p.id, { avatarDataUrl: avatar });
      });
    });
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

  // ── thumbnail ─────────────────────────────────────────────────────────────
  function _getThumb(person) {
    // 1. Mini-avatar salvo diretamente no registro (sempre disponível)
    if (person.avatarDataUrl) return person.avatarDataUrl;
    // 2. nativeThumbCache (disponível enquanto o app está em execução)
    const cache = window.nativeThumbCache;
    if (cache) {
      if (person.photoIdentifier && cache.has(person.photoIdentifier)) {
        return cache.get(person.photoIdentifier);
      }
      for (const id of getPhotosForPerson(person.id)) {
        if (cache.has(id)) return cache.get(id);
      }
    }
    return null;
  }

  function _avatarHtml(person, size = 40) {
    const thumb = _getThumb(person);
    const style = size !== 40 ? ` style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px"` : '';
    return thumb
      ? `<img class="person-avatar" src="${thumb}" alt="${_esc(person.displayName)}"${style}>`
      : `<div class="person-avatar person-avatar--empty"${style}>👤</div>`;
  }

  // ── renderização ──────────────────────────────────────────────────────────
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

    // Cabeçalho
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
      active.forEach((p) => container.appendChild(_buildCard(p, container)));
    }

    // Seção descartados
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
        const nowHidden = list.classList.toggle('hidden');
        toggle.textContent = (nowHidden ? '▶' : '▼') + ` Descartadas (${dismissed.length})`;
      });
      dismissed.forEach((p) => list.appendChild(_buildDismissedCard(p, container)));
      section.appendChild(toggle);
      section.appendChild(list);
      container.appendChild(section);
    }
  }

  function openEditModal(personId, onSave) {
    const person = getById(personId);
    if (!person) return;

    // Lista de pessoas confirmadas para merge (exceto ela mesma)
    const confirmed = getAll().filter((p) => p.confirmed && p.id !== personId && !p.dismissed);

    const mergeOptions = confirmed.length
      ? `<label class="settings-label" for="pm-merge">É a mesma pessoa que…</label>
         <select id="pm-merge" class="settings-select">
           <option value="">— Nenhuma (manter separado) —</option>
           ${confirmed.map((p) => `<option value="${p.id}">${_esc(p.displayName)}${p.alias ? ' (' + _esc(p.alias) + ')' : ''}</option>`).join('')}
         </select>`
      : '';

    const overlay = document.createElement('div');
    overlay.className = 'person-modal-overlay';
    overlay.innerHTML = `
      <div class="person-modal">
        <div class="person-modal-avatar">${_avatarHtml(person, 64)}</div>
        <h3>Identificar pessoa</h3>
        <label class="settings-label" for="pm-name">Nome</label>
        <input type="text" id="pm-name" class="settings-input" value="${_esc(person.displayName)}" placeholder="Nome da pessoa">
        <label class="settings-label" for="pm-alias">Apelido</label>
        <input type="text" id="pm-alias" class="settings-input" value="${_esc(person.alias || '')}" placeholder="Apelido (opcional)">
        <label class="settings-label" for="pm-birth">Data de aniversário</label>
        <input type="date" id="pm-birth" class="settings-input" value="${person.birthDate || ''}">
        <label class="settings-label" for="pm-notes">Observações</label>
        <input type="text" id="pm-notes" class="settings-input" value="${_esc(person.notes || '')}" placeholder="Observações (opcional)">
        ${mergeOptions}
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
      const mergeTarget = overlay.querySelector('#pm-merge')?.value;
      if (mergeTarget) {
        // Merge: une fotos desta pessoa com a pessoa já identificada
        mergeInto(personId, mergeTarget);
      } else {
        update(personId, {
          displayName: overlay.querySelector('#pm-name').value.trim() || person.displayName,
          alias:       overlay.querySelector('#pm-alias').value.trim() || null,
          birthDate:   overlay.querySelector('#pm-birth').value || null,
          notes:       overlay.querySelector('#pm-notes').value.trim() || null,
          confirmed:   true,
        });
      }
      overlay.remove();
      if (onSave) onSave();
    });
  }

  function _esc(str) {
    return (str || '').replace(/[&<>"']/g, (c) =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }

  return {
    getAll, getById, create, update, remove, mergeInto,
    getPeopleForPhoto, associatePersonToPhoto, removePersonFromPhoto, getPhotosForPerson,
    ensurePeopleFromAnalysis, dismissPersonFromPhoto, dismissPersonGlobally, restorePerson,
    refreshAvatarsForPhoto,
    renderPeopleList, openEditModal,
  };
})();
