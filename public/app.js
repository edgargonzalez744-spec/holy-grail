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
  activeTab: 'recent',
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
function grad(seed) { const h = hashStr(seed); const a = h % 360, b = (a + 40 + (h % 60)) % 360; return `linear-gradient(140deg, hsl(${a} 60% 46%), hsl(${b} 56% 32%))`; }
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
  state.tabs = [{ key: 'recent', label: 'Recently Added' }].concat(
    data.groups.map((g) => ({ key: 'group:' + g.name, label: g.name }))
  );
  // Don't land on "Recently Added" if nothing's been added lately — open the first group instead.
  if (state.activeTab === 'recent' && data.recentCount === 0 && data.groups.length)
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
  if (key === 'recent') loadRecent();
  else loadGroup(key.slice('group:'.length));
}

async function loadRecent() {
  $('homeContent').innerHTML = '<div class="section-title">Loading…</div>';
  let data;
  try { data = await (await fetch('/api/recent?days=' + state.recentDays)).json(); } catch (e) { return; }
  if (!data.talks.length) {
    $('homeContent').innerHTML = `<div class="empty"><p>Nothing added in the last ${data.days} days.</p><p style="color:var(--text-3);font-size:14px;margin-top:6px">New talks you add to your Drive folder will show up here.</p></div>`;
    return;
  }
  const rows = data.talks
    .map((t, i) => talkRowHtml(t, i, true))
    .join('');
  $('homeContent').innerHTML = `<div class="section-title">Added in the last ${data.days} days · ${data.talks.length}</div><div class="talks">${rows}</div>`;
  bindTalkRows($('homeContent'), data.talks);
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
  paintNowPlaying(t);
  openNow();
  setMediaSession(t);
  refreshActive();
}
function paintNowPlaying(t) {
  const g = grad(t.speaker || t.group || '');
  const sub = t.speaker && t.speaker !== t.group ? `${t.speaker} · ${t.group}` : t.group;
  $('nowArt').style.background = g; $('nowArt').textContent = initials(t.speaker || t.title);
  $('nowBg').style.background = g;
  $('nowTitle').textContent = t.title; $('nowSpeaker').textContent = sub;
  $('miniArt').style.background = g; $('miniArt').textContent = initials(t.speaker || t.title);
  $('miniTitle').textContent = t.title; $('miniSpeaker').textContent = sub;
  $('mini').classList.remove('hidden');
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
function openNow() { $('now').classList.remove('hidden', 'closing'); }
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
});
audio.addEventListener('play', () => { updatePlayIcons(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { updatePlayIcons(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
audio.addEventListener('ended', () => { if (state.currentTrack) savePos(state.currentTrack.id, 0); playNext(); });

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
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  updatePlayIcons();
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
