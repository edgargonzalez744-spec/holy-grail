'use strict';

// ---------------------------------------------------------------------------
// Talks Player — tabbed home (Recently Added + groups) -> speakers -> talks
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const audio = $('audio');

const state = {
  appTitle: 'Holy Grail',
  recentDays: 30,
  tabs: [],            // [{key, label}]
  activeTab: 'listen',
  view: 'home',        // home | search | speaker
  currentTrack: null,
  queue: [],
  queueIndex: -1,
  speedIdx: 0,
  speeds: [1, 1.25, 1.5, 2],
  backTo: 'home',      // where the speaker back button returns
};

const ICON_PLAY = '<svg class="play-svg" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg class="play-svg" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
const CHEV = '<svg class="chev" viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M9 6l6 6-6 6"/></svg>';
const PLAYMARK = '<svg viewBox="0 0 24 24" width="15" height="15" style="opacity:.55"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
// Curated jewel-tone palette (cohesive, premium) assigned deterministically.
const PALETTE = [
  ['#1f8a5b', '#0c4d33'], // emerald
  ['#2f5fd0', '#16346f'], // sapphire
  ['#c0304f', '#7a0f2a'], // ruby
  ['#7b4bd0', '#3f2470'], // amethyst
  ['#1f9b8e', '#0f5f57'], // teal
  ['#b5822a', '#7a5312'], // gold / topaz
  ['#b03a6e', '#6e1f47'], // magenta / plum
  ['#3a6ea5', '#1e3f66'], // steel blue
  ['#5a8f3a', '#356020'], // peridot
  ['#c15a3a', '#7a2f1c'], // garnet / copper
  ['#2b7a78', '#134e4c'], // deep teal
  ['#8a4bb0', '#4a2470'], // violet
];
function grad(seed) { const p = PALETTE[hashStr(seed) % PALETTE.length]; return `linear-gradient(140deg, ${p[0]}, ${p[1]})`; }
function initials(s) { const w = String(s || '?').trim().split(/\s+/).filter(Boolean); return ((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toUpperCase(); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0; sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const posKey = (id) => `tp_pos_${id}`, durKey = (id) => `tp_dur_${id}`;
function savePos(id, t) { try { localStorage.setItem(posKey(id), String(Math.floor(t))); } catch (e) {} }
function loadPos(id) { const v = Number(localStorage.getItem(posKey(id))); return isFinite(v) ? v : 0; }
function cacheDur(id, d) { try { localStorage.setItem(durKey(id), String(Math.round(d))); } catch (e) {} }
function cachedDur(id) { const v = Number(localStorage.getItem(durKey(id))); return isFinite(v) && v > 0 ? v : null; }

// ---------------------------------------------------------------------------
// Play history (Continue Listening) + Favorites
// ---------------------------------------------------------------------------
const RECENT_KEY = 'tp_recent', FAV_KEY = 'tp_favs';
function readJson(k) { try { return JSON.parse(localStorage.getItem(k)) || []; } catch (e) { return []; } }
function writeJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function slimTrack(t) { return { id: t.id, title: t.title, speaker: t.speaker, group: t.group, set: t.set, duration: t.duration }; }
function recordPlay(t) {
  const list = readJson(RECENT_KEY).filter((x) => x.id !== t.id);
  list.unshift(slimTrack(t));
  writeJson(RECENT_KEY, list.slice(0, 40));
}
function getContinue() {
  return readJson(RECENT_KEY)
    .map((x) => ({ ...x, pos: loadPos(x.id), dur: cachedDur(x.id) || x.duration || 0 }))
    .filter((x) => x.pos > 15 && (!x.dur || x.pos < x.dur - 20))
    .slice(0, 12);
}
function getFavs() { return readJson(FAV_KEY); }
function isFav(id) { return readJson(FAV_KEY).some((x) => x.id === id); }
function toggleFav(t) {
  let list = readJson(FAV_KEY);
  const on = list.some((x) => x.id === t.id);
  list = on ? list.filter((x) => x.id !== t.id) : [slimTrack(t), ...list];
  writeJson(FAV_KEY, list);
  return !on;
}

const HEART = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20s-7-4.4-9.4-8.5C1.1 8.2 3 4.8 6.4 4.8c2.2 0 4 1.5 5.6 3.3 1.6-1.8 3.4-3.3 5.6-3.3 3.4 0 5.3 3.4 3.8 6.7C19 15.6 12 20 12 20z"/></svg>';
const HEART_FILL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 20s-7-4.4-9.4-8.5C1.1 8.2 3 4.8 6.4 4.8c2.2 0 4 1.5 5.6 3.3 1.6-1.8 3.4-3.3 5.6-3.3 3.4 0 5.3 3.4 3.8 6.7C19 15.6 12 20 12 20z"/></svg>';
const MOON_IC = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M21 12.9A9 9 0 1 1 11.1 3a7 7 0 0 0 9.9 9.9z"/></svg>';
const SPARK_IC = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M11 2l1.7 5.3L18 9l-5.3 1.7L11 16l-1.7-5.3L4 9l5.3-1.7L11 2z"/><path d="M18.5 14l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3z"/></svg>';

function showView(name) {
  state.view = name;
  $('home').classList.toggle('hidden', name !== 'home');
  $('searchView').classList.toggle('hidden', name !== 'search');
  $('speaker').classList.toggle('hidden', name !== 'speaker');
  $('scroll').scrollTop = 0;
}

// ---------------------------------------------------------------------------
// Tabs + home
// ---------------------------------------------------------------------------
async function loadTabs() {
  let data;
  try { data = await (await fetch('/api/groups')).json(); } catch (e) { return; }
  if (data.status !== 'ready') {
    $('indexing').classList.remove('hidden');
    setTimeout(loadTabs, 1500);
    return;
  }
  $('indexing').classList.add('hidden');
  state.recentDays = data.recentDays;
  state.recentCount = data.recentCount;
  state.tabs = [
    { key: 'listen', label: 'Listen Now' },
    { key: 'favorites', label: 'Favorites' },
  ].concat(data.groups.map((g) => ({ key: 'group:' + g.name, label: g.name })));
  // Land on Listen Now only if it has something to show; otherwise open the first group.
  if (state.activeTab === 'listen' && !getContinue().length && data.recentCount === 0 && data.groups.length)
    state.activeTab = 'group:' + data.groups[0].name;
  renderTabs();
  selectTab(state.activeTab);
}

function renderTabs() {
  $('tabs').innerHTML = state.tabs
    .map((t) => `<button class="tab ${t.key === state.activeTab ? 'active' : ''}" data-tab="${escapeHtml(t.key)}">${escapeHtml(t.label)}</button>`)
    .join('');
  $('tabs').querySelectorAll('.tab').forEach((el) => el.addEventListener('click', () => selectTab(el.dataset.tab)));
}

function selectTab(key) {
  state.activeTab = key;
  $('searchInput').value = '';
  renderTabs();
  showView('home');
  if (key === 'listen') loadListenNow();
  else if (key === 'favorites') loadFavorites();
  else loadGroup(key.slice('group:'.length));
}

function continueCard(t, i) {
  const dur = t.dur || t.duration || cachedDur(t.id) || 0;
  const pct = dur ? Math.min(100, Math.round((t.pos / dur) * 100)) : 0;
  const left = dur ? Math.max(0, dur - t.pos) : 0;
  return `
  <div class="ccard" data-i="${i}">
    <div class="ccard-art" style="background:${grad(t.speaker || t.group)}">${escapeHtml(initials(t.speaker || t.title))}
      <div class="ccard-prog"><span style="width:${pct}%"></span></div>
    </div>
    <div class="ccard-title">${escapeHtml(t.title)}</div>
    <div class="ccard-sub">${left ? fmtTime(left) + ' left' : escapeHtml(t.speaker || '')}</div>
  </div>`;
}

async function loadListenNow() {
  const cont = getContinue();
  let recent = [];
  try { recent = (await (await fetch('/api/recent?days=' + state.recentDays)).json()).talks; } catch (e) {}
  let html = '';
  if (cont.length)
    html += `<div class="section-title">Continue listening</div><div class="shelf" id="contShelf">${cont.map(continueCard).join('')}</div>`;
  if (recent.length)
    html += `<div class="section-title">Recently added</div><div class="talks" id="recentTalks">${recent.map((t, i) => talkRowHtml(t, i, true)).join('')}</div>`;
  if (!cont.length && !recent.length)
    html = `<div class="empty"><p>Play a talk and it’ll appear here to pick up where you left off.</p><p style="color:var(--text-3);font-size:14px;margin-top:6px">New talks added to your Drive folder show up under Recently added.</p></div>`;
  $('homeContent').innerHTML = html;
  if (cont.length)
    document.querySelectorAll('#contShelf .ccard').forEach((el) =>
      el.addEventListener('click', () => playFromQueue(cont, Number(el.dataset.i)))
    );
  if (recent.length) bindTalkRows(document.getElementById('recentTalks'), recent);
}

function loadFavorites() {
  const favs = getFavs();
  if (!favs.length) {
    $('homeContent').innerHTML = `<div class="empty"><p>No favorites yet.</p><p style="color:var(--text-3);font-size:14px;margin-top:6px">Tap the ♥ in the player to save a talk here.</p></div>`;
    return;
  }
  $('homeContent').innerHTML = `<div class="section-title">Favorites · ${favs.length}</div><div class="talks" id="favTalks">${favs.map((t, i) => talkRowHtml(t, i, true)).join('')}</div>`;
  bindTalkRows(document.getElementById('favTalks'), favs);
}

async function loadGroup(name) {
  $('homeContent').innerHTML = '<div class="section-title">Loading…</div>';
  let data;
  try { data = await (await fetch('/api/groups/' + encodeURIComponent(name))).json(); } catch (e) { return; }
  const rows = data.speakers
    .map(
      (s) => `
    <div class="rowitem" data-group="${escapeHtml(name)}" data-speaker="${escapeHtml(s.name)}">
      <div class="avatar" style="background:${grad(s.name)}">${escapeHtml(initials(s.name))}</div>
      <div class="rowinfo">
        <div class="rowtitle">${escapeHtml(s.name)}</div>
        <div class="rowsub">${s.trackCount} talk${s.trackCount === 1 ? '' : 's'}</div>
      </div>${CHEV}
    </div>`
    )
    .join('');
  $('homeContent').innerHTML = `<div class="section-title">${escapeHtml(name)} · ${data.speakers.length} speakers</div><div class="rows">${rows}</div>`;
  $('homeContent').querySelectorAll('.rowitem').forEach((el) =>
    el.addEventListener('click', () => openSpeaker(el.dataset.group, el.dataset.speaker, 'home'))
  );
}

// ---------------------------------------------------------------------------
// Speaker detail
// ---------------------------------------------------------------------------
async function openSpeaker(group, speaker, backTo) {
  state.backTo = backTo || 'home';
  let data;
  try { data = await (await fetch('/api/talks?group=' + encodeURIComponent(group) + '&speaker=' + encodeURIComponent(speaker))).json(); }
  catch (e) { return; }
  paintSpeaker(data);
  showView('speaker');
}

function paintSpeaker(data) {
  const isGroupBucket = data.speaker === data.group;
  $('backLabel').textContent = data.group;
  $('speakerAvatar').style.background = grad(data.speaker);
  $('speakerAvatar').textContent = initials(data.speaker);
  $('speakerGroup').textContent = data.group;
  $('speakerName').textContent = data.speaker;
  $('speakerCount').textContent = `${data.talks.length} talk${data.talks.length === 1 ? '' : 's'}`;
  $('playAll').onclick = () => { if (data.talks.length) playFromQueue(data.talks, 0); };

  // Group talks by set; only show a set header when that set groups 2+ talks
  // (avoids a header on top of every single-talk set).
  const sets = [...new Set(data.talks.map((t) => t.set))];
  const setCount = {};
  data.talks.forEach((t) => { setCount[t.set] = (setCount[t.set] || 0) + 1; });
  let html = '';
  let idx = 0;
  for (const setName of sets) {
    const multi = setCount[setName] > 1;
    // Skip the header when the "set" is really just the speaker/group bucket (loose talks).
    if (multi && setName !== data.speaker && !(isGroupBucket && setName === data.group))
      html += `<div class="set-head">${escapeHtml(setName)}</div>`;
    for (const t of data.talks.filter((x) => x.set === setName)) {
      html += talkRowHtml(t, idx, false);
      idx++;
    }
  }
  $('speakerTalks').innerHTML = html;
  bindTalkRows($('speakerTalks'), data.talks);
}

// ---------------------------------------------------------------------------
// Talk rows (shared)
// ---------------------------------------------------------------------------
function talkRowHtml(t, i, showSpeaker) {
  const dur = t.duration || cachedDur(t.id);
  const active = state.currentTrack && state.currentTrack.id === t.id;
  const playing = active && !audio.paused;
  // In recent/search: show "Speaker · Group". In a speaker page: show the set only if it's a
  // real distinct set (not the speaker/title itself) — otherwise nothing.
  // Recent/search rows show "Speaker · Group". On a speaker page the set headers give
  // context, so rows there carry no subtitle.
  const sub = showSpeaker ? `${t.speaker === t.group ? t.group : t.speaker} · ${t.group}` : '';
  return `
    <div class="track ${active ? 'active' : ''}" data-idx="${i}">
      <div class="track-ic">${playing ? '<span class="bars"><i></i><i></i><i></i></span>' : PLAYMARK}</div>
      <div class="track-info">
        <div class="track-title">${escapeHtml(t.title)}</div>
        ${sub ? `<div class="track-sub">${escapeHtml(sub)}</div>` : ''}
      </div>
      <div class="track-dur">${dur ? fmtTime(dur) : ''}</div>
    </div>`;
}
function bindTalkRows(root, talks) {
  root.querySelectorAll('.track[data-idx]').forEach((el) =>
    el.addEventListener('click', () => playFromQueue(talks, Number(el.dataset.idx)))
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
let searchTimer = null;
function onSearch() {
  const q = $('searchInput').value.trim();
  clearTimeout(searchTimer);
  if (!q) { selectTab(state.activeTab); return; }
  searchTimer = setTimeout(() => runSearch(q), 220);
}
async function runSearch(q) {
  let data;
  try { data = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json(); } catch (e) { return; }
  let html = '';
  if (data.speakers.length) {
    html += `<div class="section-title">Speakers</div><div class="rows">`;
    html += data.speakers.map((s) => `
      <div class="rowitem" data-group="${escapeHtml(s.group)}" data-speaker="${escapeHtml(s.name)}">
        <div class="avatar" style="background:${grad(s.name)}">${escapeHtml(initials(s.name))}</div>
        <div class="rowinfo"><div class="rowtitle">${escapeHtml(s.name)}</div><div class="rowsub">${escapeHtml(s.group)} · ${s.trackCount} talk${s.trackCount === 1 ? '' : 's'}</div></div>${CHEV}
      </div>`).join('');
    html += `</div>`;
  }
  if (data.talks.length) {
    html += `<div class="section-title">Talks</div><div class="talks">`;
    html += data.talks.map((t, i) => talkRowHtml(t, i, true)).join('');
    html += `</div>`;
  }
  if (!data.speakers.length && !data.talks.length) html = `<div class="empty"><p>No matches for "${escapeHtml(q)}"</p></div>`;
  const root = $('searchResults');
  root.innerHTML = html;
  root.querySelectorAll('.rowitem').forEach((el) => el.addEventListener('click', () => openSpeaker(el.dataset.group, el.dataset.speaker, 'search')));
  bindTalkRows(root, data.talks);
  showView('search');
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
function playFromQueue(tracks, index) { state.queue = tracks; state.queueIndex = index; playTrack(tracks[index]); }
function playTrack(t) {
  if (!t) return;
  const switching = !state.currentTrack || state.currentTrack.id !== t.id;
  state.currentTrack = t;
  if (switching) {
    audio.src = `/api/stream/${encodeURIComponent(t.id)}`;
    audio.load();
    const resume = loadPos(t.id);
    if (resume > 5) audio.addEventListener('loadedmetadata', function once() {
      if (resume < audio.duration - 10) audio.currentTime = resume;
      audio.removeEventListener('loadedmetadata', once);
    });
  }
  audio.playbackRate = state.speeds[state.speedIdx];
  audio.play().catch(() => {});
  recordPlay(t);
  paintNowPlaying(t);
  openNow();
  setMediaSession(t);
  refreshActive();
}
function paintNowPlaying(t) {
  const g = grad(t.speaker || t.group || '');
  const sub = t.speaker && t.speaker !== t.group ? `${t.speaker} · ${t.group}` : t.group;
  $('nowArt').style.background = g; $('nowArt').textContent = initials(t.speaker || t.title);
  $('nowArt').classList.toggle('paused', audio.paused);
  $('nowBg').style.background = g;
  $('nowTitle').innerHTML = `<span class="mqt">${escapeHtml(t.title)}</span>`;
  $('nowSpeaker').textContent = sub;
  setFavIcon(isFav(t.id));
  requestAnimationFrame(setupMarquee);
  $('miniArt').style.background = g; $('miniArt').textContent = initials(t.speaker || t.title);
  $('miniTitle').textContent = t.title; $('miniSpeaker').textContent = sub;
  $('mini').classList.remove('hidden');
}

function setFavIcon(on) {
  $('favBtn').innerHTML = on ? HEART_FILL : HEART;
  $('favBtn').classList.toggle('on', on);
}
function setupMarquee() {
  const h = $('nowTitle'), s = h.querySelector('.mqt');
  if (!s) return;
  const over = s.scrollWidth - h.clientWidth;
  if (over > 6) {
    s.style.setProperty('--sh', -(over + 14) + 'px');
    s.style.setProperty('--d', Math.max(6, (over + 14) / 26) + 's');
    s.classList.add('run');
  } else {
    s.classList.remove('run');
  }
}
function refreshActive() {
  document.querySelectorAll('.track').forEach((el) => el.classList.remove('active'));
  // Re-mark by matching current track id in visible rows is handled on next render; keep simple.
}
function togglePlay() { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); }
function playNext() { if (state.queueIndex < state.queue.length - 1) playFromQueue(state.queue, state.queueIndex + 1); }
function playPrev() { if (audio.currentTime > 3) { audio.currentTime = 0; return; } if (state.queueIndex > 0) playFromQueue(state.queue, state.queueIndex - 1); }
function updatePlayIcons() {
  $('playBtn').innerHTML = audio.paused ? ICON_PLAY : ICON_PAUSE;
  $('miniPlay').innerHTML = audio.paused
    ? '<svg class="play-svg" viewBox="0 0 24 24" style="width:22px;height:22px"><path d="M8 5v14l11-7z"/></svg>'
    : '<svg class="play-svg" viewBox="0 0 24 24" style="width:22px;height:22px"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
}
function openNow() { $('now').style.transform = ''; $('now').classList.remove('hidden', 'closing'); }
function closeNow() { $('now').classList.add('closing'); setTimeout(() => $('now').classList.add('hidden'), 380); }

// ---------------------------------------------------------------------------
// Audio events
// ---------------------------------------------------------------------------
let seeking = false;
audio.addEventListener('loadedmetadata', () => { $('dur').textContent = fmtTime(audio.duration); if (state.currentTrack) cacheDur(state.currentTrack.id, audio.duration); });
audio.addEventListener('timeupdate', () => {
  if (seeking) return;
  const d = audio.duration || 0, c = audio.currentTime || 0;
  $('cur').textContent = fmtTime(c);
  if (d) { $('seek').value = String(Math.round((c / d) * 1000)); $('miniProgress').firstElementChild.style.width = (c / d) * 100 + '%'; }
  if (state.currentTrack && c > 0) savePos(state.currentTrack.id, c);
  if (sleep.endAt) updateSleepBtn();
});
audio.addEventListener('play', () => {
  updatePlayIcons(); $('nowArt').classList.remove('paused');
  // Build/resume the Clarity graph here — play is a user gesture, so the context can start.
  if (fx.on) { buildFx(); if (fx.ctx && fx.ctx.state === 'suspended') fx.ctx.resume(); }
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('pause', () => { updatePlayIcons(); $('nowArt').classList.add('paused'); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
audio.addEventListener('ended', () => {
  if (state.currentTrack) savePos(state.currentTrack.id, 0);
  if (sleep.endOfTalk) { clearSleep(); return; } // stop the chain when "end of talk" timer is set
  playNext();
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
$('seek').addEventListener('input', () => { seeking = true; const d = audio.duration || 0; if (d) $('cur').textContent = fmtTime((Number($('seek').value) / 1000) * d); });
$('seek').addEventListener('change', () => { const d = audio.duration || 0; if (d) audio.currentTime = (Number($('seek').value) / 1000) * d; seeking = false; });
$('playBtn').addEventListener('click', togglePlay);
$('miniPlay').addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
$('back15').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
$('fwd30').addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 30); });
$('prevBtn').addEventListener('click', playPrev);
$('nextBtn').addEventListener('click', playNext);
$('speedBtn').addEventListener('click', () => { state.speedIdx = (state.speedIdx + 1) % state.speeds.length; const r = state.speeds[state.speedIdx]; audio.playbackRate = r; $('speedBtn').textContent = r + '×'; });
$('nowClose').addEventListener('click', closeNow);
$('mini').addEventListener('click', openNow);
$('mini').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openNow(); });
$('speakerBack').addEventListener('click', () => showView(state.backTo === 'search' ? 'search' : 'home'));
$('searchInput').addEventListener('input', onSearch);
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 15);
  else if (e.code === 'ArrowRight') audio.currentTime += 30;
});

// ---------------------------------------------------------------------------
// Favorites button, sleep timer, swipe-to-dismiss
// ---------------------------------------------------------------------------
$('favBtn').addEventListener('click', () => {
  if (!state.currentTrack) return;
  setFavIcon(toggleFav(state.currentTrack));
  if (state.view === 'home' && state.activeTab === 'favorites') loadFavorites();
});

// ---------------------------------------------------------------------------
// Clarity: real-time cleanup for cassette-sourced audio (Web Audio).
// Graph stays connected; "off" just flattens every stage, so it's transparent.
// ---------------------------------------------------------------------------
const fx = { ctx: null, nodes: null, on: (() => { try { return localStorage.getItem('tp_clarity') === '1'; } catch (e) { return false; } })() };

function buildFx() {
  if (fx.ctx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    const ctx = new Ctx();
    const src = ctx.createMediaElementSource(audio); // same-origin stream, so this is allowed
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 20; hp.Q.value = 0.7;
    const hum = ctx.createBiquadFilter(); hum.type = 'peaking'; hum.frequency.value = 60; hum.Q.value = 8; hum.gain.value = 0;
    const mud = ctx.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 300; mud.Q.value = 1; mud.gain.value = 0;
    const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3000; pres.Q.value = 0.9; pres.gain.value = 0;
    const hiss = ctx.createBiquadFilter(); hiss.type = 'highshelf'; hiss.frequency.value = 7500; hiss.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = 0; comp.knee.value = 6; comp.ratio.value = 1; comp.attack.value = 0.005; comp.release.value = 0.25;
    const gain = ctx.createGain(); gain.gain.value = 1;
    src.connect(hp); hp.connect(hum); hum.connect(mud); mud.connect(pres);
    pres.connect(hiss); hiss.connect(comp); comp.connect(gain); gain.connect(ctx.destination);
    fx.ctx = ctx;
    fx.nodes = { hp, hum, mud, pres, hiss, comp, gain };
    applyFx();
  } catch (e) { /* Web Audio unavailable — playback continues untouched */ }
}

function applyFx() {
  const n = fx.nodes; if (!n) return;
  const t = fx.ctx.currentTime, on = fx.on;
  const set = (p, v) => { try { p.setTargetAtTime(v, t, 0.05); } catch (e) { p.value = v; } };
  set(n.hp.frequency, on ? 85 : 20);    // rumble / handling noise
  set(n.hum.gain, on ? -12 : 0);        // 60Hz mains hum
  set(n.mud.gain, on ? -3.5 : 0);       // boxy 300Hz tape mud
  set(n.pres.gain, on ? 4 : 0);         // 3kHz speech presence
  set(n.hiss.gain, on ? -9 : 0);        // 7.5kHz+ shelf = cassette hiss
  set(n.comp.threshold, on ? -26 : 0);  // even out quiet/loud passages
  set(n.comp.ratio, on ? 3 : 1);
  set(n.gain.gain, on ? 1.35 : 1);      // makeup for the cuts
}

function setClarity(on) {
  fx.on = on;
  try { localStorage.setItem('tp_clarity', on ? '1' : '0'); } catch (e) {}
  if (on) buildFx();
  if (fx.ctx && fx.ctx.state === 'suspended') fx.ctx.resume();
  applyFx();
  $('clarityBtn').classList.toggle('on', on);
}
$('clarityBtn').addEventListener('click', () => setClarity(!fx.on));

const sleep = { timer: null, endAt: null, endOfTalk: false };
function clearSleep() { clearTimeout(sleep.timer); sleep.timer = null; sleep.endAt = null; sleep.endOfTalk = false; updateSleepBtn(); }
function setSleep(val) {
  clearTimeout(sleep.timer); sleep.timer = null; sleep.endAt = null; sleep.endOfTalk = false;
  if (val === 'end') sleep.endOfTalk = true;
  else { const m = Number(val); if (m > 0) { sleep.endAt = Date.now() + m * 60000; sleep.timer = setTimeout(() => { audio.pause(); clearSleep(); }, m * 60000); } }
  updateSleepBtn();
}
function updateSleepBtn() {
  const b = $('sleepBtn');
  if (sleep.endAt) { const m = Math.max(1, Math.round((sleep.endAt - Date.now()) / 60000)); b.innerHTML = MOON_IC + '<span style="margin-left:5px">' + m + 'm</span>'; b.classList.add('on'); }
  else if (sleep.endOfTalk) { b.innerHTML = MOON_IC + '<span style="margin-left:5px">end</span>'; b.classList.add('on'); }
  else { b.innerHTML = MOON_IC; b.classList.remove('on'); }
}
$('sleepBtn').addEventListener('click', (e) => { e.stopPropagation(); $('sleepMenu').classList.toggle('hidden'); });
$('sleepMenu').querySelectorAll('.sleep-opt').forEach((el) =>
  el.addEventListener('click', () => { setSleep(el.dataset.min); $('sleepMenu').classList.add('hidden'); })
);
$('now').addEventListener('click', (e) => {
  if (!$('sleepMenu').classList.contains('hidden') && !e.target.closest('#sleepMenu') && !e.target.closest('#sleepBtn'))
    $('sleepMenu').classList.add('hidden');
});

let drag = { y0: null, on: false };
function dragStart(e) { drag.y0 = e.touches ? e.touches[0].clientY : e.clientY; drag.on = true; $('now').style.transition = 'none'; }
function dragMove(e) { if (!drag.on) return; const y = e.touches ? e.touches[0].clientY : e.clientY; const dy = y - drag.y0; if (dy > 0) $('now').style.transform = 'translateY(' + dy + 'px)'; }
function dragEnd(e) {
  if (!drag.on) return; drag.on = false;
  const y = e.changedTouches ? e.changedTouches[0].clientY : e.clientY; const dy = y - drag.y0;
  $('now').style.transition = '';
  if (dy > 110) {
    $('now').style.transform = 'translateY(100%)';
    setTimeout(() => { $('now').classList.add('hidden'); $('now').style.transform = ''; }, 380);
  } else {
    $('now').style.transform = 'translateY(0)';
    setTimeout(() => { $('now').style.transform = ''; }, 260);
  }
}
['grabber', 'nowArt'].forEach((id) => {
  const el = $(id);
  el.addEventListener('touchstart', dragStart, { passive: true });
  el.addEventListener('touchmove', dragMove, { passive: true });
  el.addEventListener('touchend', dragEnd);
  el.addEventListener('mousedown', dragStart);
});
document.addEventListener('mousemove', dragMove);
document.addEventListener('mouseup', dragEnd);

function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.speaker || t.group || '', album: state.appTitle });
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) {} };
  set('play', () => audio.play()); set('pause', () => audio.pause());
  set('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
  set('seekforward', () => { audio.currentTime += 30; });
  set('previoustrack', playPrev); set('nexttrack', playNext);
  set('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}

// ---------------------------------------------------------------------------
// Theme (light / dark, follows system unless overridden)
// ---------------------------------------------------------------------------
const SUN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M21 12.9A9 9 0 1 1 11.1 3a7 7 0 0 0 9.9 9.9z"/></svg>';
function effectiveTheme() {
  const t = localStorage.getItem('tp_theme');
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyTheme() {
  const eff = effectiveTheme();
  const mc = document.querySelector('meta[name="theme-color"]');
  if (mc) mc.setAttribute('content', eff === 'light' ? '#f4f4f7' : '#0a0a0c');
  $('themeToggle').innerHTML = eff === 'light' ? MOON : SUN;
}
$('themeToggle').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('tp_theme', next);
  document.documentElement.setAttribute('data-theme', next);
  applyTheme();
});
// React to system changes when the user hasn't chosen manually.
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (!localStorage.getItem('tp_theme')) applyTheme();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  updatePlayIcons();
  applyTheme();
  setFavIcon(false);
  updateSleepBtn();
  $('clarityBtn').innerHTML = SPARK_IC;
  $('clarityBtn').classList.toggle('on', fx.on);
  let cfg = { title: 'Holy Grail', gated: false, authed: true };
  try { cfg = await (await fetch('/api/config')).json(); } catch (e) {}
  state.appTitle = cfg.title;
  document.title = cfg.title;
  $('appTitle').textContent = cfg.title;
  $('lockTitle').textContent = cfg.title;
  if (cfg.gated && !cfg.authed) { $('lock').classList.remove('hidden'); return; }
  showApp();
}
function showApp() { $('lock').classList.add('hidden'); $('app').classList.remove('hidden'); showView('home'); loadTabs(); }
$('lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('lockError').textContent = '';
  try {
    const resp = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: $('passcode').value }) });
    if (resp.ok) showApp();
    else { $('lockError').textContent = 'Incorrect code. Try again.'; $('passcode').value = ''; }
  } catch (err) { $('lockError').textContent = 'Something went wrong. Try again.'; }
});

boot();

