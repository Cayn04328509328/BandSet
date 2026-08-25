const app = document.querySelector('#app');
const importInput = document.querySelector('#importFile');

const STORAGE = {
  songs: 'bandset:songs:v1',
  setlist: 'bandset:setlist:v1',
  localSongIds: 'bandset:local-song-ids:v1',
  hiddenSongIds: 'bandset:hidden-song-ids:v1',
  countdownSeconds: 'bandset:countdown-seconds:v1',
  timingMultipliers: 'bandset:timing-multipliers:v1',
  performanceTextSize: 'bandset:performance-text-size:v1',
  setlistCustomized: 'bandset:setlist-customized:v1'
};

// Oude demo-ID's die door eerdere BandSet-versies in localStorage kunnen zijn blijven hangen.
const LEGACY_SONG_IDS = new Set(['yellow-coldplay-demo']);

let state = {
  songs: [],
  setlist: [],
  route: { name: 'setlist', songId: null },
  performance: null,
  wakeLock: null,

  // Koppelt een song-id aan het echte bestand in /songs.
  // Bijvoorbeeld: black-pearl-jam -> black.json
  sourceFiles: new Map()
};

function isMasterEnvironment() {
  const host = window.location.hostname;

  return host === '127.0.0.1' || host === 'localhost';
}

function compareSongsByArtist(a, b) {
  const options = {
    sensitivity: 'base',
    numeric: true
  };

  const artistCompare = String(a?.artist || '')
    .localeCompare(
      String(b?.artist || ''),
      'nl',
      options
    );

  if (artistCompare !== 0) {
    return artistCompare;
  }

  return String(a?.title || '')
    .localeCompare(
      String(b?.title || ''),
      'nl',
      options
    );
}

function getMasterSetlistOrder() {
  return [...state.songs]
    .sort(compareSongsByArtist)
    .map(song => song.id);
}

function hasCustomSetlistOrder() {
  return (
    localStorage.getItem(
      STORAGE.setlistCustomized
    ) === 'true'
  );
}

function markSetlistCustomized() {
  localStorage.setItem(
    STORAGE.setlistCustomized,
    'true'
  );
}

function applySetlistOrder(
  localOrder = state.setlist
) {
  const masterOrder =
    getMasterSetlistOrder();

  /*
   * Op jouw development-pc:
   * altijd de mastervolgorde.
   *
   * Op andere apparaten:
   * mastervolgorde zolang de gebruiker
   * hem niet bewust zelf heeft aangepast.
   */
  if (
    isMasterEnvironment() ||
    !hasCustomSetlistOrder()
  ) {
    state.setlist = masterOrder;
    saveSetlist();
    return;
  }

  /*
   * Een bandlid heeft zelf de volgorde aangepast.
   * Die volgorde blijft lokaal bestaan.
   *
   * Nieuwe nummers die later aan BandSet worden
   * toegevoegd, komen onderaan terecht.
   */
  const validIds = new Set(
    state.songs.map(song => song.id)
  );

  const nextSetlist =
    localOrder.filter(
      id => validIds.has(id)
    );

  for (const id of masterOrder) {
    if (!nextSetlist.includes(id)) {
      nextSetlist.push(id);
    }
  }

  state.setlist = nextSetlist;
  saveSetlist();
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `song-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function boot() {
  let localSongs = readJSON(STORAGE.songs, []);
  let localSetlist = readJSON(STORAGE.setlist, []);
  const bundledSongs = await loadBundledSongs();

  // V3-migratie: verwijder bekende oude demo's die in v1/v2 als lokaal nummer zijn blijven bestaan.
  localSongs = localSongs.filter(song => !LEGACY_SONG_IDS.has(song.id));
  localSetlist = localSetlist.filter(id => !LEGACY_SONG_IDS.has(id));

  const bundledIds = new Set(bundledSongs.map(song => song.id));
  let localSongIds = new Set(readJSON(STORAGE.localSongIds, []).filter(id => !LEGACY_SONG_IDS.has(id)));
  const hiddenSongIds = new Set(readJSON(STORAGE.hiddenSongIds, []).filter(id => !LEGACY_SONG_IDS.has(id)));

  // Migratie vanuit v1: nummers die alleen lokaal bestaan zijn automatisch lokale nummers.
  // Meegeleverde nummers worden voortaan opnieuw uit /songs geladen, tenzij jij ze zelf bewerkt.
  if (!localStorage.getItem(STORAGE.localSongIds)) {
    localSongIds = new Set(localSongs.filter(song => !bundledIds.has(song.id)).map(song => song.id));
    saveLocalSongIds(localSongIds);
  }

  // Begin altijd met de nieuwste zichtbare bestanden uit /songs.
  // Verwijderde bundled songs blijven verborgen totdat ze later bewust worden hersteld.
  const merged = new Map(
    bundledSongs
      .filter(song => !hiddenSongIds.has(song.id))
      .map(song => [song.id, song])
  );

  const bundledById = new Map(
  bundledSongs.map(song => [song.id, song])
);

// Lokale edits mogen tijdelijk de bronversie overschrijven.
//
// Zodra jij de geëxporteerde JSON in /songs hebt gezet en die bron
// hetzelfde is als de lokale edit, is die lokale override niet langer
// nodig. Vanaf dat moment wordt /songs/*.json weer de master.
for (const song of localSongs) {
  const bundledSong = bundledById.get(song.id);

  if (
    bundledSong &&
    localSongIds.has(song.id) &&
    songsAreEquivalent(song, bundledSong)
  ) {
    localSongIds.delete(song.id);
    continue;
  }

  if (localSongIds.has(song.id) || !bundledIds.has(song.id)) {
    merged.set(song.id, song);
    localSongIds.add(song.id);
  }
}

  state.songs = [...merged.values()];
  saveSongs();
  saveLocalSongIds(localSongIds);
  saveHiddenSongIds(hiddenSongIds);

// Mastervolgorde: alfabetisch op artiest,
// daarna alfabetisch op titel.
//
// Alleen op niet-master apparaten mag een
// bewuste lokale reorder voorrang houden.
applySetlistOrder(localSetlist);

  registerServiceWorker();
  render();
}

async function loadBundledSongs() {
  try {
    const indexResponse = await fetch('./songs/index.json', { cache: 'no-store' });
    if (!indexResponse.ok) throw new Error(`index.json: ${indexResponse.status}`);
    const index = await indexResponse.json();

    const songs = await Promise.all(
  index.files.map(
    async file => {
      try {
        const response = await fetch(
          `./songs/${file}`,
          {
            cache: 'no-store'
          }
        );

        if (!response.ok) {
          throw new Error(
            `${file}: ${response.status}`
          );
        }

        const song =
          await response.json();

        if (song?.id) {
          state.sourceFiles.set(
            song.id,
            file
          );
        }

        return song;

      } catch (error) {
        console.warn(
          `Song kon niet worden geladen: ${file}`,
          error
        );

        return null;
      }
    }
  )
);

return songs.filter(Boolean);

  } catch (err) {
    console.warn('Bundled songs konden niet worden geladen.', err);
    return [];
  }
}

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function saveSongs() { localStorage.setItem(STORAGE.songs, JSON.stringify(state.songs)); }
function saveSetlist() { localStorage.setItem(STORAGE.setlist, JSON.stringify(state.setlist)); }
function readLocalSongIds() { return new Set(readJSON(STORAGE.localSongIds, [])); }
function saveLocalSongIds(ids) { localStorage.setItem(STORAGE.localSongIds, JSON.stringify([...ids])); }
function readHiddenSongIds() { return new Set(readJSON(STORAGE.hiddenSongIds, [])); }
function saveHiddenSongIds(ids) { localStorage.setItem(STORAGE.hiddenSongIds, JSON.stringify([...ids])); }
function normalizeForCompare(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeForCompare);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = normalizeForCompare(value[key]);
        return result;
      }, {});
  }

  return value;
}

function songsAreEquivalent(a, b) {
  return JSON.stringify(normalizeForCompare(a)) ===
         JSON.stringify(normalizeForCompare(b));
}

function readTimingMultipliers() {
  return readJSON(STORAGE.timingMultipliers, {});
}

function getPerformanceTextSize() {
  const value = localStorage.getItem(STORAGE.performanceTextSize);
  return ['small', 'normal', 'large'].includes(value) ? value : 'normal';
}

function savePerformanceTextSize(value) {
  if (!['small', 'normal', 'large'].includes(value)) return;
  localStorage.setItem(STORAGE.performanceTextSize, value);
}

function getTimingMultiplier(songId) {
  const value = Number(readTimingMultipliers()[songId]);

  if (!Number.isFinite(value)) return 1;

  return Math.min(1.1, Math.max(.9, value));
}

function saveTimingMultiplier(songId, value) {
  const multipliers = readTimingMultipliers();

  multipliers[songId] = Math.min(
    1.1,
    Math.max(.9, Number(value) || 1)
  );

  localStorage.setItem(
    STORAGE.timingMultipliers,
    JSON.stringify(multipliers)
  );
}

function markSongLocal(id) {
  const ids = readLocalSongIds();
  ids.add(id);
  saveLocalSongIds(ids);
}

function unmarkSongLocal(id) {
  const ids = readLocalSongIds();
  ids.delete(id);
  saveLocalSongIds(ids);
}

function songById(id) { return state.songs.find(s => s.id === id); }
function route(name, songId = null) {
  stopPerformance();
  state.route = { name, songId };
  window.scrollTo({ top: 0, behavior: 'instant' });
  render();
}

function render() {
  if (state.route.name === 'setlist') return renderSetlist();
  if (state.route.name === 'song') return renderSong(songById(state.route.songId));
  if (state.route.name === 'edit') return renderEditor(songById(state.route.songId));
  if (state.route.name === 'performance') return renderPerformance(songById(state.route.songId));
  document
  .querySelectorAll('[data-text-size-option]')
  .forEach(btn =>
    btn.onclick = () =>
      setPerformanceTextSize(btn.dataset.textSizeOption)
  );
}

function shell(content) {
  app.innerHTML = `<main class="app-shell">${content}</main>`;
}

function renderSetlist() {
  const songs = state.setlist.map(songById).filter(Boolean);
  shell(`
    <div class="topbar">
      <div>
        <div class="eyebrow">BandSet</div>
        <h1>Setlist</h1>
      </div>
      <button class="icon-btn" id="importBtn" aria-label="Importeer nummer">＋</button>
    </div>

    <div class="stack" id="setlistStack">
      ${songs.length ? songs.map((song, i) => `
        <div class="song-row" data-row-song="${esc(song.id)}">
          <button class="song-main" data-song="${esc(song.id)}">
            <div class="song-index">${String(i + 1).padStart(2,'0')}</div>
            <div class="song-copy">
              <div class="song-title">${esc(song.title)}</div>
              <div class="song-artist">${esc(song.artist)}</div>
            </div>
            <div class="chevron">›</div>
          </button>

          <button class="drag-handle" data-drag-handle="${esc(song.id)}" aria-label="Versleep ${attr(song.title)}" title="Versleep om de volgorde te wijzigen">≡</button>

          <div class="song-menu-wrap">
            <button class="song-menu-btn" data-song-menu="${esc(song.id)}" aria-label="Opties voor ${attr(song.title)}" aria-expanded="false">⋯</button>
            <div class="song-options-menu" data-menu-for="${esc(song.id)}" hidden>
              <button class="song-option" data-edit-song="${esc(song.id)}">Edit</button>
              <button class="song-option" data-move-song="${esc(song.id)}" data-move-direction="-1" ${i === 0 ? 'disabled' : ''}>Omhoog</button>
               <button class="song-option" data-move-song="${esc(song.id)}" data-move-direction="1" ${i === songs.length - 1 ? 'disabled' : ''}>Omlaag</button>
                <button class="song-option danger-option" data-delete-song="${esc(song.id)}">Verwijder song</button>
            </div>
          </div>
        </div>
      `).join('') : `<div class="card empty">Nog geen nummers. Importeer een .bandsong-bestand.</div>`}
    </div>

    <div class="section-gap btn-row">
      <button class="btn ghost" id="importBtn2">Import song</button>
      <button class="btn ghost" id="newSongBtn">Nieuw leeg nummer</button>
    </div>
  `);

  document.querySelectorAll('[data-song]').forEach(el => el.addEventListener('click', () => route('song', el.dataset.song)));
  document.querySelectorAll('[data-song-menu]').forEach(btn => btn.addEventListener('click', event => {
    event.stopPropagation();
    toggleSongMenu(btn.dataset.songMenu);
  }));
  document.querySelectorAll('[data-edit-song]').forEach(btn => btn.addEventListener('click', event => {
  event.stopPropagation();

  closeSongMenus();

  route('edit', btn.dataset.editSong);
}));
  document.querySelectorAll('[data-delete-song]').forEach(btn => btn.addEventListener('click', event => {
    event.stopPropagation();
    const song = songById(btn.dataset.deleteSong);
    if (song) deleteSong(song);
  }));
  document.querySelectorAll('[data-move-song]').forEach(btn => btn.addEventListener('click', event => {
    event.stopPropagation();
    moveSongInSetlist(btn.dataset.moveSong, Number(btn.dataset.moveDirection));
  }));
  document.querySelectorAll('[data-drag-handle]').forEach(handle => {
    handle.addEventListener('pointerdown', startSetlistDrag);
    handle.addEventListener('pointermove', moveSetlistDrag);
    handle.addEventListener('pointerup', endSetlistDrag);
    handle.addEventListener('pointercancel', cancelSetlistDrag);
  });

  document.querySelector('#importBtn').onclick = () => importInput.click();
  document.querySelector('#importBtn2').onclick = () => importInput.click();
  document.querySelector('#newSongBtn').onclick = createBlankSong;
}

let setlistDrag = null;

function startSetlistDrag(event) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  const handle = event.currentTarget;
  const row = handle.closest('.song-row');
  const stack = document.querySelector('#setlistStack');

  if (!row || !stack) return;

  closeSongMenus();

  const rect = row.getBoundingClientRect();
  const sourceIndex = state.setlist.indexOf(row.dataset.rowSong);
  const withoutSource = state.setlist.filter(
    id => id !== row.dataset.rowSong
  );

  // Maak een visuele kopie die met je vinger/muis meebeweegt.
  const ghost = row.cloneNode(true);
  ghost.classList.add('setlist-drag-ghost');
  ghost.removeAttribute('data-row-song');

  ghost.querySelectorAll('button').forEach(button => {
    button.tabIndex = -1;
    button.setAttribute('aria-hidden', 'true');
  });

  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;

  document.body.appendChild(ghost);

  // Blauwe lijn die aangeeft waar het nummer terechtkomt.
  const indicator = document.createElement('div');
  indicator.className = 'setlist-drop-indicator';
  indicator.setAttribute('aria-hidden', 'true');

  stack.appendChild(indicator);

  setlistDrag = {
    pointerId: event.pointerId,
    songId: row.dataset.rowSong,
    row,
    handle,
    stack,
    ghost,
    indicator,
    pointerOffsetY: event.clientY - rect.top,
    targetIndex: Math.max(
      0,
      Math.min(withoutSource.length, sourceIndex)
    )
  };

  handle.setPointerCapture?.(event.pointerId);

  // Het echte nummer blijft op zijn plek, maar wordt transparanter.
  row.classList.add('drag-source');
  document.body.classList.add('is-reordering');

  updateSetlistDropTarget(event.clientY);
}

function moveSetlistDrag(event) {
  if (
    !setlistDrag ||
    event.pointerId !== setlistDrag.pointerId
  ) return;

  event.preventDefault();

  const { ghost, pointerOffsetY } = setlistDrag;

  // Alleen de kopie beweegt.
  ghost.style.top =
    `${event.clientY - pointerOffsetY}px`;

  updateSetlistDropTarget(event.clientY);
}

function updateSetlistDropTarget(clientY) {
  if (!setlistDrag) return;

  const {
    stack,
    row,
    indicator
  } = setlistDrag;

  const otherRows = [
    ...stack.querySelectorAll('.song-row')
  ].filter(item => item !== row);

  if (!otherRows.length) {
    setlistDrag.targetIndex = 0;
    indicator.hidden = true;
    return;
  }

  indicator.hidden = false;

  let targetIndex = otherRows.length;

  // Zodra je over het midden van een nummer gaat,
  // verschuift de mogelijke drop-positie.
  for (let i = 0; i < otherRows.length; i++) {
    const rect = otherRows[i].getBoundingClientRect();

    if (clientY < rect.top + rect.height / 2) {
      targetIndex = i;
      break;
    }
  }

  setlistDrag.targetIndex = targetIndex;

  const stackRect = stack.getBoundingClientRect();
  let indicatorY;

  if (targetIndex < otherRows.length) {
    const referenceRect =
      otherRows[targetIndex].getBoundingClientRect();

    indicatorY =
      referenceRect.top -
      stackRect.top -
      6;
  } else {
    const lastRect =
      otherRows[
        otherRows.length - 1
      ].getBoundingClientRect();

    indicatorY =
      lastRect.bottom -
      stackRect.top +
      6;
  }

  indicator.style.top = `${indicatorY}px`;
}

function endSetlistDrag(event) {
  if (
    !setlistDrag ||
    event.pointerId !== setlistDrag.pointerId
  ) return;

  const {
    songId,
    targetIndex
  } = setlistDrag;

  // NU pas wordt de echte setlist aangepast.
  const nextSetlist =
    state.setlist.filter(id => id !== songId);

  nextSetlist.splice(
    Math.max(
      0,
      Math.min(nextSetlist.length, targetIndex)
    ),
    0,
    songId
  );

 state.setlist = nextSetlist;

markSetlistCustomized();
saveSetlist();

cleanupSetlistDrag(event.pointerId);
  renderSetlist();
}

function cancelSetlistDrag(event) {
  if (
    !setlistDrag ||
    event.pointerId !== setlistDrag.pointerId
  ) return;

  // Bij annuleren verandert de echte volgorde niet.
  cleanupSetlistDrag(event.pointerId);
}

function cleanupSetlistDrag(pointerId) {
  if (!setlistDrag) return;

  const {
    row,
    handle,
    ghost,
    indicator
  } = setlistDrag;

  try {
    handle.releasePointerCapture?.(pointerId);
  } catch {}

  row.classList.remove('drag-source');

  ghost.remove();
  indicator.remove();

  document.body.classList.remove('is-reordering');

  setlistDrag = null;
}

function moveSongInSetlist(songId, direction) {
  const from = state.setlist.indexOf(songId);
  if (from < 0) return;
  const to = Math.max(0, Math.min(state.setlist.length - 1, from + direction));
  if (to === from) return;

  const [moved] =
  state.setlist.splice(from, 1);

  state.setlist.splice(
    to,
    0,
    moved
  );

markSetlistCustomized();
saveSetlist();
renderSetlist();
}

function toggleSongMenu(songId) {
  const menu = document.querySelector(`[data-menu-for="${CSS.escape(songId)}"]`);
  const button = document.querySelector(`[data-song-menu="${CSS.escape(songId)}"]`);
  if (!menu || !button) return;

  const willOpen = menu.hidden;
  closeSongMenus();
  menu.hidden = !willOpen;
  button.setAttribute('aria-expanded', String(willOpen));
}

function closeSongMenus() {
  document.querySelectorAll('.song-options-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('[data-song-menu]').forEach(btn => btn.setAttribute('aria-expanded', 'false'));
}

document.addEventListener('click', event => {
  if (!event.target.closest('.song-menu-wrap')) closeSongMenus();
});

function renderSong(song) {
  if (!song) return route('setlist');
  const amp = song.amp || {};
  const tabs = collectSongTabs(song);
  shell(`
    <div class="topbar">
      <button class="btn" id="backBtn">‹ Setlist</button>
      <div class="eyebrow">Song overview</div>
    </div>

    <h1>${esc(song.title)}</h1>
    <div class="muted">${esc(song.artist)}</div>

    <div class="meta-grid section-gap">
      ${meta('Capo', song.capo || '—')}
      ${meta('Tuning', song.tuning || 'Standard')}
      ${meta('BPM', song.bpm || '—')}
      ${meta('Duur', formatTime(song.duration || 0))}
    </div>

    <div class="card amp-card">
      <div class="eyebrow">Amp settings</div>
      <div class="amp-lines">
        ${amp.preset ? ampLine('Preset', amp.preset) : ''}
        ${amp.gain ? ampLine('Gain', amp.gain) : ''}
        ${amp.eq ? ampLine('EQ', amp.eq) : ''}
        ${amp.effects ? ampLine('Effects', amp.effects) : ''}
        ${amp.notes ? `<div class="muted" style="margin-top:6px; white-space:pre-wrap">${esc(amp.notes)}</div>` : '<div class="muted">Geen amp-notities.</div>'}
      </div>
    </div>

    <div class="section-gap stack">
      <button class="btn primary block" id="performanceBtn">▶ Performance</button>
      <div class="btn-row">
        <button class="btn ghost" id="editBtn">Edit</button>
        <button class="btn ghost" id="exportBtn">Export</button>
        <button class="btn ghost" id="duplicateBtn">Duplicate</button>
      </div>
    </div>

<div class="section-gap">
  <div class="eyebrow" style="margin-bottom:10px">Secties</div>

  <div class="section-list">
    ${(song.sections || []).map(s =>
      `<div class="section-pill">
        <strong>${esc(s.name)}</strong>
        <span>${formatTime(s.start)}</span>
      </div>`
    ).join('') || '<div class="muted">Geen secties.</div>'}
  </div>
</div>

${tabs.length ? `
  <div class="section-gap song-tabs-section">
    <details class="song-tabs-details">

      <summary>
        <span>Tabs & riffs</span>
        <span class="song-tabs-count">${tabs.length}</span>
      </summary>

      <div class="song-tabs-list">
        ${tabs.map(renderSongTabCard).join('')}
      </div>

    </details>
  </div>
` : ''}
  `);

  document.querySelector('#backBtn').onclick = () => route('setlist');
  document.querySelector('#performanceBtn').onclick = () => route('performance', song.id);
  document.querySelector('#editBtn').onclick = () => route('edit', song.id);
  document.querySelector('#exportBtn').onclick = () => exportSong(song);
  document.querySelector('#duplicateBtn').onclick = () => duplicateSong(song);
}

function renderEditor(song) {
  if (!song) return route('setlist');

  shell(`
    <div class="topbar">
      <button class="btn" id="cancelEdit">‹ Terug</button>
      <div class="eyebrow">Edit mode</div>
    </div>

    <div class="form-grid">
      <label>Titel<input id="fTitle" value="${attr(song.title)}"></label>
      <label>Artiest<input id="fArtist" value="${attr(song.artist)}"></label>
      <div class="meta-grid">
        <label>Capo<input id="fCapo" value="${attr(song.capo ?? '')}" placeholder="bijv. 4"></label>
        <label>Tuning<input id="fTuning" value="${attr(song.tuning || 'Standard')}"></label>
        <label>BPM<input id="fBpm" type="number" value="${attr(song.bpm ?? '')}"></label>
        <label>Duur (mm:ss)<input id="fDuration" value="${formatTime(song.duration || 0)}"></label>
      </div>

      <div class="card">
        <div class="eyebrow" style="margin-bottom:12px">Amp settings</div>
        <div class="form-grid">
          <label>Preset<input id="fPreset" value="${attr(song.amp?.preset || '')}"></label>
          <label>Gain<input id="fGain" value="${attr(song.amp?.gain || '')}"></label>
          <label>EQ<input id="fEq" value="${attr(song.amp?.eq || '')}" placeholder="Bass 5 · Mid 6 · Treble 6"></label>
          <label>Effects<input id="fEffects" value="${attr(song.amp?.effects || '')}" placeholder="Reverb 3 · Delay light"></label>
          <label>Notities<textarea id="fAmpNotes">${esc(song.amp?.notes || '')}</textarea></label>
        </div>
      </div>

      <div class="editor-section">
        <div class="editor-section-title">
          <div>
            <div class="eyebrow">Songstructuur</div>
            <h2>Secties & timestamps</h2>
          </div>
          <button class="btn ghost" id="addSection">＋ Sectie</button>
        </div>

        <div class="section-editor-list" id="sectionEditorList">
          ${(song.sections || []).map((section, index) => sectionEditorCard(section, index)).join('')}
        </div>

        <p class="muted editor-help">Pas de starttijd direct per sectie aan. Met −1s en +1s kun je tijdens het finetunen snel kleine correcties maken. <strong>[NOTE]</strong> blijft een speelnotitie en complete tabs zet je tussen <strong>[TAB]</strong> en <strong>[/TAB]</strong>.</p>
      </div>
    </div>

    <div class="editor-actions">
  <button class="btn ghost" id="deleteSong">
    Verwijder
  </button>

  <button class="btn primary" id="saveEdit">
    ${isMasterEnvironment()
      ? 'Opslaan als master'
      : 'Opslaan'}
  </button>
</div>
  `);

document.querySelector('#cancelEdit').onclick =
  () => route('song', song.id);

document.querySelector('#saveEdit').onclick =
  () => saveEditor(song);

document.querySelector('#deleteSong').onclick =
  () => deleteSong(song);

document.querySelector('#addSection').onclick =
  addEditorSection;

  wireEditorSectionControls();
}

function sectionEditorCard(section = {}, index = 0) {
  return `
    <div class="section-editor-card" data-editor-section>
      <div class="section-editor-head">
        <label class="section-name-field">
          Sectienaam
          <input data-section-name value="${attr(section.name || `Sectie ${index + 1}`)}" placeholder="bijv. Verse 1">
        </label>
        <button class="section-remove-btn" data-remove-section type="button" aria-label="Verwijder sectie">Verwijder</button>
      </div>

      <div class="timestamp-editor-row">
        <label class="timestamp-field">
          Starttijd
          <input class="timestamp-input" data-section-time value="${formatTime(section.start || 0)}" inputmode="numeric" placeholder="0:00" aria-label="Starttijd ${attr(section.name || `sectie ${index + 1}`)}">
        </label>
        <div class="timestamp-nudges" aria-label="Starttijd fijn afstellen">
          <button class="timestamp-nudge" type="button" data-time-adjust="-1">−1s</button>
          <button class="timestamp-nudge" type="button" data-time-adjust="1">+1s</button>
        </div>
      </div>

      <label>
        Inhoud
        <textarea class="section-content-input" data-section-content spellcheck="false">${esc(section.content || '')}</textarea>
      </label>
    </div>
  `;
}

function wireEditorSectionControls() {
  document.querySelectorAll('[data-time-adjust]').forEach(button => {
    button.onclick = () => adjustEditorTimestamp(button, Number(button.dataset.timeAdjust));
  });

  document.querySelectorAll('[data-section-time]').forEach(input => {
    input.onblur = () => {
      input.value = formatTime(parseTime(input.value));
    };
  });

  document.querySelectorAll('[data-remove-section]').forEach(button => {
    button.onclick = () => {
      const card = button.closest('[data-editor-section]');
      if (!card) return;
      card.remove();
      refreshEditorSectionLabels();
    };
  });
}

function adjustEditorTimestamp(button, delta) {
  const card = button.closest('[data-editor-section]');
  const input = card?.querySelector('[data-section-time]');
  if (!input) return;
  input.value = formatTime(Math.max(0, parseTime(input.value) + delta));
}

function addEditorSection() {
  const list = document.querySelector('#sectionEditorList');
  if (!list) return;

  const cards = [...list.querySelectorAll('[data-editor-section]')];
  const lastTime = cards.length
    ? parseTime(cards[cards.length - 1].querySelector('[data-section-time]')?.value)
    : 0;

  list.insertAdjacentHTML('beforeend', sectionEditorCard({
    name: `Sectie ${cards.length + 1}`,
    start: lastTime + 15,
    content: ''
  }, cards.length));

  wireEditorSectionControls();
  refreshEditorSectionLabels();

  const newCard = list.lastElementChild;
  newCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  newCard?.querySelector('[data-section-name]')?.focus();
}

function refreshEditorSectionLabels() {
  document.querySelectorAll('[data-editor-section]').forEach((card, index) => {
    const nameInput = card.querySelector('[data-section-name]');
    if (nameInput && !nameInput.value.trim()) nameInput.placeholder = `Sectie ${index + 1}`;
  });
}

function readEditorSections() {
  return [...document.querySelectorAll('[data-editor-section]')].map((card, index) => ({
    name: card.querySelector('[data-section-name]')?.value.trim() || `Sectie ${index + 1}`,
    start: parseTime(card.querySelector('[data-section-time]')?.value),
    content: card.querySelector('[data-section-content]')?.value.replace(/^\n+|\n+$/g, '') || ''
  }));
}

function buildSongFromEditor(song) {
  const sections = readEditorSections();

  for (let i = 1; i < sections.length; i++) {
    if (sections[i].start < sections[i - 1].start) {
      alert(
        `De starttijd van “${sections[i].name}” ligt vóór ` +
        `“${sections[i - 1].name}”. Pas de timestamps eerst aan.`
      );

      return null;
    }
  }

  return {
    ...song,

    title:
      document.querySelector('#fTitle').value.trim() ||
      'Untitled',

    artist:
      document.querySelector('#fArtist').value.trim() ||
      'Unknown artist',

    capo:
      document.querySelector('#fCapo').value.trim(),

    tuning:
      document.querySelector('#fTuning').value.trim() ||
      'Standard',

    bpm:
      Number(document.querySelector('#fBpm').value) ||
      null,

    duration:
      parseTime(document.querySelector('#fDuration').value),

    amp: {
      preset:
        document.querySelector('#fPreset').value.trim(),

      gain:
        document.querySelector('#fGain').value.trim(),

      eq:
        document.querySelector('#fEq').value.trim(),

      effects:
        document.querySelector('#fEffects').value.trim(),

      notes:
        document.querySelector('#fAmpNotes').value.trim()
    },

    sections
  };
}

function storeEditedSong(updated) {
  state.songs = state.songs.map(song =>
    song.id === updated.id ? updated : song
  );

  markSongLocal(updated.id);
  saveSongs();
}

async function saveEditor(song) {
  const updated = buildSongFromEditor(song);

  if (!updated) return;

  /*
   * Altijd eerst lokaal opslaan.
   *
   * Daardoor raak je je wijzigingen nooit kwijt,
   * zelfs niet wanneer de lokale save-server
   * toevallig niet draait.
   */
  storeEditedSong(updated);

  /*
   * Op gewone apparaten stopt het hier.
   * De wijziging blijft dus alleen in localStorage.
   */
  if (!isMasterEnvironment()) {
    toast('Nummer lokaal opgeslagen');
    route('song', updated.id);
    return;
  }

  /*
   * Op de development-pc schrijven we dezelfde
   * versie ook naar /songs/*.json.
   */
  const result = await saveSongToMaster(updated);

  if (!result) {
    /*
     * De lokale versie is al opgeslagen.
     * We blijven in Edit Mode zodat duidelijk is
     * dat de master-save niet is gelukt.
     */
    return;
  }

  /*
   * De JSON in /songs is vanaf nu de master.
   * Daarom hoeft deze pc geen lokale override
   * meer voor dit nummer te bewaren.
   */
  unmarkSongLocal(updated.id);

  state.sourceFiles.set(
    updated.id,
    result.filename
  );

  saveSongs();

  toast(`Master opgeslagen: ${result.filename}`);

  route('song', updated.id);
}

function renderPerformance(song) {
  if (!song) return route('setlist');

  const savedCountdown = Number(
    localStorage.getItem(STORAGE.countdownSeconds)
  );

  const countdownSeconds = [3, 5, 10].includes(savedCountdown)
    ? savedCountdown
    : 5;

  const timingMultiplier = getTimingMultiplier(song.id);
  const textSize = getPerformanceTextSize();
  const setlistIndex = state.setlist.indexOf(song.id);

  const previousSong =
    setlistIndex > 0
      ? songById(state.setlist[setlistIndex - 1])
      : null;

  const nextSong =
    setlistIndex >= 0 &&
    setlistIndex < state.setlist.length - 1
      ? songById(state.setlist[setlistIndex + 1])
      : null;

  state.performance = {
    songId: song.id,
    current: 0,
    playing: false,
    lastTs: 0,
    raf: null,

    countdownSeconds,
    countdownActive: false,
    countdownStartedAt: 0,
    countdownRaf: null,

    timingMultiplier
  };

  app.innerHTML = `
    <main
      class="performance-shell"
      id="performanceShell"
      data-text-size="${textSize}">

      <div class="performance-header">

        <div class="performance-headline" id="performanceHeadline" title="Tik hier tijdens het spelen om te pauzeren">
          <button class="btn" id="leavePerformance">‹</button>

          <div class="performance-title">
            ${esc(song.title)}
          </div>

          <div class="time" id="clock">
            0:00 / ${formatTime(song.duration)}
          </div>
        </div>

        <div class="progress-track">
          <div
            class="progress-bar"
            id="progressBar">
          </div>
        </div>

        <div class="performance-meta">
          ${esc(song.artist)}
          · Capo ${esc(song.capo || '—')}
          ${song.hideTuningInPerformance
            ? ''
            : ` · ${esc(song.tuning || 'Standard')}`}
        </div>

        <div class="performance-settings">

          <div
            class="countdown-setting"
            id="countdownSetting">

            <span>Starttimer</span>

            <div
              class="countdown-options"
              role="group"
              aria-label="Lengte starttimer">

              ${[3,5,10].map(value => `
                <button
                  class="countdown-option ${
                    value === countdownSeconds
                      ? 'active'
                      : ''
                  }"
                  data-countdown="${value}">
                  ${value}s
                </button>
              `).join('')}

            </div>
          </div>

          <div class="text-size-setting">
  <span>Tekstgrootte</span>

      <div
        class="text-size-options"
        role="group"
        aria-label="Tekstgrootte in Performance Mode">

        <button type="button" class="text-size-option ${textSize === 'small' ? 'active' : ''}" data-text-size-option="small" aria-pressed="${textSize === 'small'}">A−</button>
        <button type="button" class="text-size-option ${textSize === 'normal' ? 'active' : ''}" data-text-size-option="normal" aria-pressed="${textSize === 'normal'}">A</button>
        <button type="button" class="text-size-option ${textSize === 'large' ? 'active' : ''}" data-text-size-option="large" aria-pressed="${textSize === 'large'}">A+</button>

        </div>
      </div>

          <div class="timing-setting">

            <div class="timing-setting-head">
              <span>Timing</span>

              <strong id="timingMultiplierLabel">
                ${timingMultiplier.toFixed(2)}×
              </strong>
            </div>

            <div class="timing-slider-row">

              <span>0.90</span>

              <input
                id="timingMultiplier"
                class="timing-slider"
                type="range"
                min="0.9"
                max="1.1"
                step="0.01"
                value="${timingMultiplier}"
                aria-label="Timing multiplier"
              >

              <span>1.10</span>

            </div>
          </div>

        </div>


        <div class="performance-controls">

          <button
            class="btn"
            id="prevSection">
            ◀ Sectie
          </button>

          <button
            class="btn primary"
            id="playPause">
            ▶ Start
          </button>

          <button
            class="btn"
            id="nextSection">
            Sectie ▶
          </button>

        </div>

            </div>


      <button
        class="section-drawer-toggle"
        id="sectionDrawerToggle"
        type="button"
        aria-label="Spring naar sectie"
        aria-controls="sectionDrawer"
        aria-expanded="false">
        <span></span>
        <span></span>
        <span></span>
      </button>


      <div
        class="section-drawer-backdrop"
        id="sectionDrawerBackdrop">
      </div>


      <aside
        class="section-drawer"
        id="sectionDrawer"
        aria-hidden="true">

        <div class="section-drawer-head">

          <div>
            <div class="eyebrow">
              Spring naar
            </div>

            <strong>
              Sectie
            </strong>
          </div>

          <button
            class="section-drawer-close"
            id="sectionDrawerClose"
            type="button"
            aria-label="Sluit sectiemenu">
            ×
          </button>

        </div>


        <div class="section-drawer-list">

          ${(song.sections || []).map(
            (section, index) => `

              <button
                class="section-jump-item ${
                  index === 0
                    ? 'active'
                    : ''
                }"
                type="button"
                data-section-jump="${index}">

                <span class="section-jump-name">
                  ${esc(section.name)}
                </span>

                <span class="section-jump-time">
                  ${formatTime(section.start)}
                </span>

              </button>

            `
          ).join('')}

        </div>

      </aside>


      <div
        class="performance-content"
        id="performanceContent">

        ${(song.sections || []).map((s, i) => `
          <section
            class="performance-section"
            data-index="${i}"
            data-start="${Number(s.start) || 0}">

            <h2>
              ${esc(s.name)} · ${formatTime(s.start)}
            </h2>

          <div class="song-content">
            ${formatSongContent(s.content || '', { showTabs: false })}
          </div>

          </section>
        `).join('')}

      </div>


      <div
        class="performance-end-nav"
        id="performanceEndNav"
        hidden>

        <div class="eyebrow">
          Einde nummer
        </div>

        <div class="performance-song-nav">

          <button
            class="song-nav-btn"
            id="previousSongBtn"
            ${previousSong ? '' : 'disabled'}>

            <span>← Vorig nummer</span>

            <strong>
              ${
                previousSong
                  ? esc(previousSong.title)
                  : 'Geen vorig nummer'
              }
            </strong>

          </button>


          <button
            class="song-nav-btn"
            id="nextSongBtn"
            ${nextSong ? '' : 'disabled'}>

            <span>Volgend nummer →</span>

            <strong>
              ${
                nextSong
                  ? esc(nextSong.title)
                  : 'Geen volgend nummer'
              }
            </strong>

          </button>

        </div>

      </div>


      <div
        class="countdown-overlay"
        id="countdownOverlay"
        hidden
        aria-live="assertive">

        <div class="countdown-label">
          Start over
        </div>

        <div
          class="countdown-number"
          id="countdownNumber">
          ${countdownSeconds}
        </div>

      </div>


      <div
        class="next-banner"
        id="nextBanner">

        <div class="eyebrow">
          Next
        </div>

        <strong id="nextName">
          —
        </strong>

      </div>

    </main>
  `;


  document.querySelector('#leavePerformance').onclick = () => route('song', song.id);

// Tijdens het spelen zijn alle controls verborgen. Een tik op de compacte
// bovenbalk pauzeert, waarna de controls en instellingen weer verschijnen.
document.querySelector('#performanceHeadline').onclick = event => {
  if (!state.performance?.playing) return;
  if (event.target.closest('button')) return;
  togglePerformance();
};

document.querySelector('#playPause').onclick = togglePerformance;


  document.querySelector(
    '#prevSection'
  ).onclick = () => jumpSection(-1);


    document.querySelector(
    '#nextSection'
  ).onclick = () => jumpSection(1);


  document.querySelector(
    '#sectionDrawerToggle'
  ).onclick = toggleSectionDrawer;


  document.querySelector(
    '#sectionDrawerClose'
  ).onclick = closeSectionDrawer;


  document.querySelector(
    '#sectionDrawerBackdrop'
  ).onclick = closeSectionDrawer;


  document.querySelectorAll(
    '[data-section-jump]'
  ).forEach(button => {

    button.onclick = () =>
      jumpToSection(
        Number(
          button.dataset.sectionJump
        )
      );

  });


  document.addEventListener(
    'keydown',
    sectionDrawerKeyHandler
  );


  document.querySelectorAll(
    '[data-countdown]'
  ).forEach(btn => {

    btn.onclick = () =>
      setCountdownLength(
        Number(btn.dataset.countdown)
      );

  });


  document.querySelector(
    '#timingMultiplier'
  ).oninput = event =>
    setTimingMultiplier(
      song.id,
      Number(event.target.value)
    );

const textSizeOptions = document.querySelector('.text-size-options');

if (textSizeOptions) {
  textSizeOptions.addEventListener('click', event => {
    const btn = event.target.closest('[data-text-size-option]');

    if (!btn) return;

    event.preventDefault();
    event.stopPropagation();

    setPerformanceTextSize(btn.dataset.textSizeOption);
  });
}

  const previousButton =
    document.querySelector(
      '#previousSongBtn'
    );

  if (previousSong) {
    previousButton.onclick = () =>
      route(
        'performance',
        previousSong.id
      );
  }


  const nextButton =
    document.querySelector(
      '#nextSongBtn'
    );

  if (nextSong) {
    nextButton.onclick = () =>
      route(
        'performance',
        nextSong.id
      );
  }


  document.addEventListener(
    'visibilitychange',
    visibilityHandler
  );

  updatePerformanceUI();

  requestWakeLock();
}

function setPerformanceLiveMode(isLive) {
  const shell = document.querySelector('#performanceShell');
  if (!shell) return;

  shell.classList.toggle('is-live', Boolean(isLive));
}

function setPerformanceTextSize(value) {
  if (!['small', 'normal', 'large'].includes(value)) return;

  savePerformanceTextSize(value);

  const shell = document.querySelector('#performanceShell');

  if (shell) {
    shell.dataset.textSize = value;
  }

  document.querySelectorAll('[data-text-size-option]').forEach(btn => {
    const active = btn.dataset.textSizeOption === value;

    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function setTimingMultiplier(songId, value) {

  const p = state.performance;

  const multiplier = Math.min(
    1.1,
    Math.max(
      .9,
      Number(value) || 1
    )
  );

  if (
    p &&
    p.songId === songId
  ) {
    p.timingMultiplier =
      multiplier;
  }

  saveTimingMultiplier(
    songId,
    multiplier
  );

  const label =
    document.querySelector(
      '#timingMultiplierLabel'
    );

  if (label) {
    label.textContent =
      `${multiplier.toFixed(2)}×`;
  }
}


function showPerformanceEndNavigation() {

  const endNav =
    document.querySelector(
      '#performanceEndNav'
    );

  const nextBanner =
    document.querySelector(
      '#nextBanner'
    );

  if (endNav) {
    endNav.hidden = false;
  }

  if (nextBanner) {
    nextBanner.hidden = true;
  }

  requestAnimationFrame(() => {

    endNav?.scrollIntoView({
      behavior: 'smooth',
      block: 'end'
    });

  });
}


function hidePerformanceEndNavigation() {

  const endNav =
    document.querySelector(
      '#performanceEndNav'
    );

  const nextBanner =
    document.querySelector(
      '#nextBanner'
    );

  if (endNav) {
    endNav.hidden = true;
  }

  if (nextBanner) {
    nextBanner.hidden = false;
  }
}

function setCountdownLength(seconds) {
  if (![3, 5, 10].includes(seconds)) return;
  const p = state.performance;
  if (!p || p.countdownActive || p.playing) return;
  p.countdownSeconds = seconds;
  localStorage.setItem(STORAGE.countdownSeconds, String(seconds));
  document.querySelectorAll('[data-countdown]').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.countdown) === seconds));
  const number = document.querySelector('#countdownNumber');
  if (number) number.textContent = seconds;
}

function togglePerformance() {
  const p = state.performance;
  if (!p) return;

  if (p.countdownActive) {
    cancelCountdown();
    return;
  }

  const song = songById(p.songId);
  if (p.current >= (song?.duration || 0)) {
  p.current = 0;

  hidePerformanceEndNavigation();

  updatePerformanceUI();
}

  if (p.playing) {
  p.playing = false;

  if (p.raf) {
    cancelAnimationFrame(p.raf);
  }

  p.raf = null;

  setPerformanceLiveMode(false);

  document.querySelector('#playPause').textContent = '▶ Verder';

  return;
}

  // Alleen vanaf het begin krijg je de starttimer. Hervatten na pauze is direct.
  if (p.current <= 0.05) {
    startCountdown();
  } else {
    startPlayback();
  }
}

function startCountdown() {
  const p = state.performance;
  if (!p || p.countdownActive) return;

  p.countdownActive = true;
  p.countdownStartedAt = performance.now();
  const overlay = document.querySelector('#countdownOverlay');
  const number = document.querySelector('#countdownNumber');
  const button = document.querySelector('#playPause');
  const setting = document.querySelector('#countdownSetting');
  if (overlay) overlay.hidden = false;
  if (number) number.textContent = p.countdownSeconds;
  if (button) button.textContent = '✕ Annuleer';
  if (setting) setting.classList.add('disabled');

  const countdownTick = now => {
    const current = state.performance;
    if (!current || !current.countdownActive) return;
    const elapsed = (now - current.countdownStartedAt) / 1000;
    const remaining = current.countdownSeconds - elapsed;

    if (remaining <= 0) {
      finishCountdown();
      return;
    }

    if (number) number.textContent = Math.ceil(remaining);
    current.countdownRaf = requestAnimationFrame(countdownTick);
  };

  p.countdownRaf = requestAnimationFrame(countdownTick);
}

function finishCountdown() {
  const p = state.performance;
  if (!p) return;
  p.countdownActive = false;
  if (p.countdownRaf) cancelAnimationFrame(p.countdownRaf);
  p.countdownRaf = null;

  const overlay = document.querySelector('#countdownOverlay');
  const number = document.querySelector('#countdownNumber');
  if (number) number.textContent = 'GO';

  // Laat GO heel kort zichtbaar zodat het startmoment visueel duidelijk is.
  setTimeout(() => {
    if (overlay) overlay.hidden = true;
  }, 350);

  document.querySelector('#countdownSetting')?.classList.remove('disabled');
  startPlayback();
}

function cancelCountdown() {
  const p = state.performance;
  if (!p) return;
  p.countdownActive = false;
  if (p.countdownRaf) cancelAnimationFrame(p.countdownRaf);
  p.countdownRaf = null;
  const overlay = document.querySelector('#countdownOverlay');
  if (overlay) overlay.hidden = true;
  document.querySelector('#countdownSetting')?.classList.remove('disabled');
  const button = document.querySelector('#playPause');
  if (button) button.textContent = '▶ Start';
}

function startPlayback() {
  const p = state.performance;

  if (!p) return;

  p.playing = true;
  p.lastTs = performance.now();

  setPerformanceLiveMode(true);

  const button = document.querySelector('#playPause');

  if (button) {
    button.textContent = '❚❚ Pauze';
  }

  tick(p.lastTs);
}

function tick(ts) {
  const p = state.performance;

  if (!p || !p.playing) return;

  const song = songById(p.songId);

  const delta =
    (ts - p.lastTs) / 1000;

  p.lastTs = ts;


  // 0.90x = langzamer
  // 1.00x = normaal
  // 1.10x = sneller
  p.current = Math.min(
    song.duration || 0,

    p.current +
    delta *
    (p.timingMultiplier || 1)
  );


  updatePerformanceUI(true);


  if (p.current >= (song.duration || 0)) {
  p.playing = false;

  setPerformanceLiveMode(false);

  const btn = document.querySelector('#playPause');

  if (btn) {
    btn.textContent = '↻ Opnieuw';
  }

  showPerformanceEndNavigation();

  return;
}


  p.raf =
    requestAnimationFrame(tick);
}

function updatePerformanceUI(autoScroll = false) {
  const p = state.performance;
  if (!p) return;
  const song = songById(p.songId);
  const sections = song.sections || [];
  const duration = song.duration || 1;
  const activeIndex = Math.max(0, sections.findLastIndex ? sections.findLastIndex(s => p.current >= s.start) : findLastIndexCompat(sections, s => p.current >= s.start));

  const clock = document.querySelector('#clock');
  const bar = document.querySelector('#progressBar');
  if (clock) clock.textContent = `${formatTime(p.current)} / ${formatTime(duration)}`;
  if (bar) bar.style.width = `${Math.min(100, (p.current / duration) * 100)}%`;

    document.querySelectorAll(
    '[data-section-jump]'
  ).forEach((button, i) => {

    const active =
      i === activeIndex;

    button.classList.toggle(
      'active',
      active
    );

    if (active) {
      button.setAttribute(
        'aria-current',
        'true'
      );
    } else {
      button.removeAttribute(
        'aria-current'
      );
    }

  });

  const next = sections[activeIndex + 1];
  const nextName = document.querySelector('#nextName');
  if (nextName) nextName.textContent = next ? `${next.name} · ${formatTime(next.start)}` : 'Einde';

  if (autoScroll && sections.length) guidedScroll(sections, activeIndex, p.current);
}

function guidedScroll(sections, activeIndex, current) {
  const currentEl = document.querySelector(`.performance-section[data-index="${activeIndex}"]`);
  if (!currentEl) return;
  const nextEl = document.querySelector(`.performance-section[data-index="${activeIndex + 1}"]`);
  const start = sections[activeIndex]?.start ?? 0;
  const end = sections[activeIndex + 1]?.start ?? songById(state.performance.songId).duration;
  const ratio = end > start ? Math.min(1, Math.max(0, (current - start) / (end - start))) : 0;
  const currentTop = currentEl.offsetTop - window.innerHeight * .34;
  const nextTop = nextEl ? nextEl.offsetTop - window.innerHeight * .34 : currentTop + currentEl.offsetHeight * .8;
  const target = currentTop + (nextTop - currentTop) * ratio;
  window.scrollTo(0, Math.max(0, target));
}

function openSectionDrawer() {

  const shell =
    document.querySelector(
      '#performanceShell'
    );

  const drawer =
    document.querySelector(
      '#sectionDrawer'
    );

  const toggle =
    document.querySelector(
      '#sectionDrawerToggle'
    );

  if (
    !shell ||
    !drawer ||
    !toggle
  ) return;


  shell.classList.add(
    'section-drawer-open'
  );

  drawer.setAttribute(
    'aria-hidden',
    'false'
  );

  toggle.setAttribute(
    'aria-expanded',
    'true'
  );
}


function closeSectionDrawer() {

  const shell =
    document.querySelector(
      '#performanceShell'
    );

  const drawer =
    document.querySelector(
      '#sectionDrawer'
    );

  const toggle =
    document.querySelector(
      '#sectionDrawerToggle'
    );

  if (
    !shell ||
    !drawer ||
    !toggle
  ) return;


  shell.classList.remove(
    'section-drawer-open'
  );

  drawer.setAttribute(
    'aria-hidden',
    'true'
  );

  toggle.setAttribute(
    'aria-expanded',
    'false'
  );
}


function toggleSectionDrawer() {

  const shell =
    document.querySelector(
      '#performanceShell'
    );

  if (!shell) return;


  if (
    shell.classList.contains(
      'section-drawer-open'
    )
  ) {
    closeSectionDrawer();
  } else {
    openSectionDrawer();
  }
}


function sectionDrawerKeyHandler(event) {

  if (event.key === 'Escape') {
    closeSectionDrawer();
  }
}


function seekToSection(
  index,
  { closeDrawer = false } = {}
) {

  const p =
    state.performance;

  if (!p) return;


  if (p.countdownActive) {
    cancelCountdown();
  }


  const song =
    songById(p.songId);

  const sections =
    song?.sections || [];

  const section =
    sections[index];

  if (!section) return;


  p.current =
    Number(section.start) || 0;

  p.lastTs =
    performance.now();


  /*
   * Als je vanaf het einde terug springt,
   * moet de normale NEXT-banner weer terug.
   */
  hidePerformanceEndNavigation();

  updatePerformanceUI();


  /*
   * Als Performance gepauzeerd staat,
   * moet de play-knop ook weer kloppen.
   */
  if (!p.playing) {

    const playButton =
      document.querySelector(
        '#playPause'
      );

    if (playButton) {

      playButton.textContent =
        p.current <= 0.05
          ? '▶ Start'
          : '▶ Verder';

    }
  }


  if (closeDrawer) {
    closeSectionDrawer();
  }


  requestAnimationFrame(() => {

    document.querySelector(
      `.performance-section[data-index="${index}"]`
    )?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });

  });
}


function jumpToSection(index) {

  seekToSection(
    index,
    {
      closeDrawer: true
    }
  );
}


function jumpSection(direction) {

  const p =
    state.performance;

  if (!p) return;


  const song =
    songById(p.songId);

  const sections =
    song?.sections || [];

  if (!sections.length) return;


  let index = Math.max(
    0,
    findLastIndexCompat(
      sections,
      section =>
        p.current >= section.start
    )
  );


  index = Math.min(
    sections.length - 1,
    Math.max(
      0,
      index + direction
    )
  );


  seekToSection(index);
}

function stopPerformance() {
  if (state.performance?.raf) cancelAnimationFrame(state.performance.raf);
  if (state.performance?.countdownRaf) cancelAnimationFrame(state.performance.countdownRaf);
  state.performance = null;
  document.removeEventListener('visibilitychange', visibilityHandler);
  document.removeEventListener(
  'keydown',
  sectionDrawerKeyHandler
);
  if (state.wakeLock) {
    state.wakeLock.release?.().catch(() => {});
    state.wakeLock = null;
  }
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { console.info('Wake Lock niet beschikbaar.', e); }
}
async function visibilityHandler() {
  if (document.visibilityState === 'visible' && state.route.name === 'performance') await requestWakeLock();
}

function extractTabBlocks(text) {
  const blocks = [];
  const regex = /\[TAB\]\s*([\s\S]*?)\s*\[\/TAB\]/gi;

  let match;

  while ((match = regex.exec(String(text || '')))) {
    const content = match[1].replace(/^\n+|\n+$/g, '');

    if (content.trim()) {
      blocks.push(content);
    }
  }

  return blocks;
}

function collectSongTabs(song) {
  const tabs = [];

  // Nieuwe structuur: aparte tabs-property in het songbestand.
  if (Array.isArray(song?.tabs)) {
    song.tabs.forEach((tab, index) => {
      if (!tab) return;

      if (typeof tab === 'string') {
        if (tab.trim()) {
          tabs.push({
            title: `Tab ${index + 1}`,
            content: tab
          });
        }

        return;
      }

      if (tab.content?.trim()) {
        tabs.push({
          title: tab.title?.trim() || `Tab ${index + 1}`,
          content: tab.content
        });
      }
    });
  }

  // Backwards compatibility:
  // bestaande [TAB] blokken uit sections ook verzamelen.
  (song?.sections || []).forEach(section => {
    const blocks = extractTabBlocks(section.content || '');

    blocks.forEach((content, index) => {
      tabs.push({
        title:
          blocks.length > 1
            ? `${section.name} · ${index + 1}`
            : section.name,

        content
      });
    });
  });

  return tabs;
}

function renderSongTabCard(tab) {
  return `
    <div class="song-tab-card">

      <div class="song-tab-title">
        ${esc(tab.title || 'Tab')}
      </div>

      <div class="song-content song-tab-content">
        <div class="tab-block">
          <pre>${esc(tab.content || '')}</pre>
        </div>
      </div>

    </div>
  `;
}

function formatSongContent(text, { showTabs = true } = {}) {
  const lines = text.split('\n');
  const output = [];
  let inTabBlock = false;
  let tabLines = [];

  const flushTabBlock = () => {
  if (!tabLines.length) return;

  if (showTabs) {
    output.push(
      `<div class="tab-block">
        <pre>${esc(tabLines.join('\n'))}</pre>
      </div>`
    );
  }

  tabLines = [];
};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^\[TAB\]$/i.test(trimmed)) {
      flushTabBlock();
      inTabBlock = true;
      continue;
    }

    if (/^\[\/TAB\]$/i.test(trimmed)) {
      flushTabBlock();
      inTabBlock = false;
      continue;
    }

    if (inTabBlock) {
      tabLines.push(line);
      continue;
    }

    if (!trimmed) {
      output.push('<div class="song-line blank-line" aria-hidden="true">&nbsp;</div>');
      continue;
    }

    if (/^\[NOTE\]/i.test(line)) {
      output.push(`<div class="song-line note-line">${esc(line.replace(/^\[NOTE\]\s*/i, ''))}</div>`);
      continue;
    }

    if (line.includes('|') && /[-0-9hpb\/\\]/i.test(line)) {
  // Backwards compatible: losse tabregels uit oudere songbestanden.
  if (showTabs) {
    output.push(
      `<div class="song-line tab-line">${esc(line)}</div>`
    );
  }

  continue;
}

    if (looksLikeChordLine(line)) {
      const nextLine = lines[i + 1];

      const canPairWithNextLine =
        typeof nextLine === 'string' &&
        nextLine.trim() &&
        !looksLikeChordLine(nextLine) &&
        !/^\[NOTE\]/i.test(nextLine.trim()) &&
        !/^\[\/?TAB\]$/i.test(nextLine.trim()) &&
        !(nextLine.includes('|') && /[-0-9hpb\/\\]/i.test(nextLine));

      if (canPairWithNextLine) {
        output.push(renderChordLyricPair(line, nextLine));
        i += 1;
      } else {
        output.push(`<div class="song-line chord-line">${esc(line)}</div>`);
      }

      continue;
    }

    output.push(`<div class="song-line lyric-line">${esc(line)}</div>`);
  }

  flushTabBlock();

  return output.join('');
}

function renderChordLyricPair(chordLine, lyricLine) {
  const chordMatches = [...chordLine.matchAll(/\S+/g)]
    .filter(match => looksLikeChordLine(match[0]));

  if (!chordMatches.length) {
    return `<div class="song-line lyric-line">${esc(lyricLine)}</div>`;
  }

  const cells = [];
  const firstChordStart = chordMatches[0].index || 0;

  if (firstChordStart > 0) {
    const leadingText = lyricLine.slice(0, firstChordStart);

    if (leadingText) {
      cells.push(
        `<span class="chord-lyric-cell no-chord">
          <span class="lyric-fragment">${esc(leadingText)}</span>
        </span>`
      );
    }
  }

  chordMatches.forEach((match, index) => {
    const start = match.index || 0;

    const end =
      index + 1 < chordMatches.length
        ? (chordMatches[index + 1].index || lyricLine.length)
        : lyricLine.length;

    const lyricFragment = lyricLine.slice(
      start,
      Math.max(start, end)
    );

    const chord = match[0];
    const emptyFragment = lyricFragment.length === 0;

    cells.push(`
      <span class="chord-lyric-cell${emptyFragment ? ' chord-only-cell' : ''}">
        <span class="inline-chord">${esc(chord)}</span>
        <span class="lyric-fragment">${emptyFragment ? '&nbsp;' : esc(lyricFragment)}</span>
      </span>
    `);
  });

  return `
    <div class="chord-lyric-line">
      ${cells.join('')}
    </div>
  `;
}

function looksLikeChordLine(line) {
  const t = line.trim();
  if (!t || t.length > 70) return false;
  const tokens = t.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(tok =>
  /^[A-G](#|b)?(m|maj|min|sus|dim|aug|add)?\d*(\/[A-G](#|b)?)?$|^x\d+$/i.test(tok) ||
  /^N\.?C\.?$/i.test(tok) ||
  /^[|:xX-]+$/.test(tok)
  );
}

function createBlankSong() {
  const song = {
    formatVersion: 1,
    id: uid(),
    title: 'Nieuw nummer',
    artist: 'Artiest',
    capo: '',
    tuning: 'Standard',
    bpm: null,
    duration: 240,
    amp: { preset: '', gain: '', eq: '', effects: '', notes: '' },
    sections: [
      { name: 'Intro', start: 0, content: '' },
      { name: 'Verse 1', start: 15, content: '' },
      { name: 'Chorus', start: 45, content: '' }
    ]
  };
state.songs.push(song);
state.setlist.push(song.id);

markSongLocal(song.id);
saveSongs();

applySetlistOrder(state.setlist);

route('edit', song.id);
}

function duplicateSong(song) {
  const copy = JSON.parse(JSON.stringify(song));
  copy.id = uid();
  copy.title = `${copy.title} (kopie)`;
  state.songs.push(copy);
state.setlist.push(copy.id);

markSongLocal(copy.id);
saveSongs();

applySetlistOrder(state.setlist);

toast('Kopie gemaakt');
  route('song', copy.id);
}

function deleteSong(song) {
  if (!confirm(`Verwijder “${song.title}” uit BandSet?`)) return;

  const hiddenIds = readHiddenSongIds();
  hiddenIds.add(song.id);
  saveHiddenSongIds(hiddenIds);

  state.songs = state.songs.filter(s => s.id !== song.id);
  state.setlist = state.setlist.filter(id => id !== song.id);
  unmarkSongLocal(song.id);
  saveSongs();
  applySetlistOrder(state.setlist);

  toast('Nummer verwijderd');
  route('setlist');
}

function getSourceFileName(song) {
  return (
    state.sourceFiles.get(song.id) ||
    `${slug(song.title)}.json`
  );
}

function downloadSourceJson(data, filename) {
  const blob = new Blob(
    [data],
    { type: 'application/json' }
  );

  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');

  link.href = url;
  link.download = filename;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(
    () => URL.revokeObjectURL(url),
    1000
  );
}

async function saveSongToMaster(updated) {
  const filename = getSourceFileName(updated);

  try {
    const response = await fetch(
      'http://127.0.0.1:8787/save-song',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          filename,
          song: updated
        })
      }
    );

    if (!response.ok) {
      const result = await response.json()
        .catch(() => ({}));

      throw new Error(
        result.error ||
        `Server error ${response.status}`
      );
    }

    return await response.json();

  } catch (error) {
    console.error(
      'Master opslaan mislukt:',
      error
    );

    alert(
      'De wijziging is wel lokaal opgeslagen, ' +
      'maar kon niet naar de master-JSON worden geschreven.\n\n' +
      'Controleer of save-server.js draait.'
    );

    return null;
  }
}

function exportSong(song) {
  const data = JSON.stringify(song, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(song.title)}.bandsong`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

importInput.addEventListener('change', async () => {
  const file = importInput.files?.[0];
  importInput.value = '';
  if (!file) return;
  try {
    const song = JSON.parse(await file.text());
    validateSong(song);
    song.id = state.songs.some(s => s.id === song.id) ? uid() : (song.id || uid());
    state.songs.push(song);
      state.setlist.push(song.id);

      markSongLocal(song.id);
      saveSongs();

      applySetlistOrder(state.setlist);

      toast('Nummer geïmporteerd');
    route('song', song.id);
  } catch (e) {
    alert(`Importeren mislukt: ${e.message}`);
  }
});

function validateSong(song) {
  if (!song || typeof song !== 'object') throw new Error('ongeldig bestand');
  if (!song.title || !Array.isArray(song.sections)) throw new Error('titel of secties ontbreken');
  if (!song.formatVersion) song.formatVersion = 1;
}

function meta(label, value) { return `<div class="meta-item"><div class="meta-label">${esc(label)}</div><div class="meta-value">${esc(String(value))}</div></div>`; }
function ampLine(label, value) { return `<div class="amp-line"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`; }
function parseTime(value) {
  // Getallen uit songbestanden zijn al seconden en blijven dus ongemoeid.
  if (typeof value === 'number') return value;

  const raw = String(value ?? '').trim();
  if (!raw) return 0;

  // Snelle invoer zonder dubbele punt:
  // 417 -> 4:17
  // 125 -> 1:25
  // 59  -> 0:59
  if (/^\d+$/.test(raw)) {
    if (raw.length <= 2) return Number(raw);

    const minutes = Number(raw.slice(0, -2)) || 0;
    const seconds = Number(raw.slice(-2)) || 0;

    return minutes * 60 + seconds;
  }

  const parts = raw.split(':').map(Number);

  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return Number(raw) || 0;
}
function formatTime(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function attr(value) { return esc(value); }
function slug(value) { return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'song'; }
function findLastIndexCompat(arr, predicate) { for (let i = arr.length - 1; i >= 0; i--) if (predicate(arr[i], i)) return i; return -1; }
function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = message; document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./service-worker.js'); }
    catch (e) { console.info('Service worker kon niet registreren.', e); }
  }
}

boot();
