'use strict';

// ---------------------------------------------------------------------------
// Talks Player — frontend (browse → album → track, with search)
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const audio = $('audio');

const state = {
  appTitle: 'Talks',
  view: 'browse', // browse | album | search
  currentTrack: null,
  queue: [], // tracks in the current album/queue
  queueIndex: -1,
  albumCache: {}, // albumId -> {name, section, tracks}
  speeds: [1, 1.25, 1.5, 2],
  speedIdx: 0,
};

const ICON_PLAY = '<svg class="play-svg" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg class="play-svg" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

// ---------------------------------------------------------------------------
// Art helpers (deterministic gradient + initials)
// ---------------------------------------------------------------------------
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function grad(seed) {
  const h = hashStr(seed);
  const h1 = h % 360;
  const h2 = (h1 + 40 + (h % 60)) % 360;
  return `linear-gradient(140deg, hsl(${h1} 60% 46%), hsl(${h2} 56% 32%))`;
}
function initials(s) {
  const words = String(s || '?').trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || '?') + (words[1]?.[0] || '')).toUpperCase();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Resume position (per track)
// ---------------------------------------------------------------------------
const posKey = (id) => `tp_pos_${id}`;
const durKey = (id) => `tp_dur_${id}`;
function savePos(id, t) { try { localStorage.setItem(posKey(id), String(Math.floor(t))); } catch (e) {} }
function loadPos(id) { const v = Number(localStorage.getItem(posKey(id))); return isFinite(v) ? v : 0; }
function cacheDur(id, d) { try { localStorage.setItem(durKey(id), String(Math.round(d))); } catch (e) {} }
function cachedDur(id) { const v = Number(localStorage.getItem(durKey(id))); return isFinite(v) && v > 0 ? v : null; }

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function showView(name) {
  state.view = name;
  $('browse').classList.toggle('hidden', name !== 'browse');
  $('searchView').classList.toggle('hidden', name !== 'search');
  $('album').classList.toggle('hidden', name !== 'album');
  $('scroll').scrollTop = 0;
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------
async function loadLibrary() {
  let data;
  try { data = await (await fetch('/api/library')).json(); } catch (e) { return; }

  if (data.status !== 'ready') {
    $('indexing').classList.remove('hidden');
    $('sections').innerHTML = '';
    $('indexingSub').textContent = data.totals && data.totals.tracks ? `${data.totals.tracks} found so far…` : '';
    setTimeout(loadLibrary, 1500); // poll until index is ready
    return;
  }
  $('indexing').classList.add('hidden');
  $('totals').textContent = `${data.totals.tracks.toLocaleString()} talks · ${data.totals.albums.toLocaleString()} sets`;
  renderSections(data.sections);
}

function albumCardHtml(a) {
  return `
  <div class="card" data-album="${a.id}">
    <div class="card-art" style="background:${grad(a.name + a.section)}">${escapeHtml(shortLabel(a.name))}</div>
    <div class="card-name">${escapeHtml(a.name)}</div>
    <div class="card-sub">${a.trackCount} track${a.trackCount === 1 ? '' : 's'}</div>
  </div>`;
}
// Show initials for long names, or the short name itself if brief.
function shortLabel(name) {
  const clean = name.replace(/\(.*?\)/g, '').trim();
  if (clean.length <= 10) return clean;
  return initials(clean);
}

function renderSections(sections) {
  $('sections').innerHTML = sections
    .map(
      (s) => `
    <div class="section">
      <div class="section-head">
        <h2>${escapeHtml(s.name)}</h2>
        <span class="cnt">${s.albums.length} sets</span>
      </div>
      <div class="row">${s.albums.map(albumCardHtml).join('')}</div>
    </div>`
    )
    .join('');
  bindAlbumCards($('sections'));
}

function bindAlbumCards(root) {
  root.querySelectorAll('.card[data-album]').forEach((el) => {
    el.addEventListener('click', () => openAlbum(el.dataset.album));
  });
}

// ---------------------------------------------------------------------------
// Album view
// ---------------------------------------------------------------------------
async function openAlbum(id) {
  let album = state.albumCache[id];
  if (!album) {
    try { album = await (await fetch('/api/albums/' + encodeURIComponent(id))).json(); }
    catch (e) { return; }
    state.albumCache[id] = album;
  }
  paintAlbum(album);
  showView('album');
}

function paintAlbum(album) {
  $('albumArt').style.background = grad(album.name + album.section);
  $('albumArt').textContent = shortLabel(album.name);
  $('albumSection').textContent = album.section;
  $('albumName').textContent = album.name;
  $('albumCount').textContent = `${album.tracks.length} track${album.tracks.length === 1 ? '' : 's'}`;
  $('playAll').onclick = () => { if (album.tracks.length) playFromQueue(album.tracks, 0); };

  $('albumTracks').innerHTML = album.tracks
    .map((t, i) => {
      const dur = t.duration || cachedDur(t.id);
      const active = state.currentTrack && state.currentTrack.id === t.id;
      const playing = active && !audio.paused;
      return `
      <div class="track ${active ? 'active' : ''}" data-idx="${i}">
        <div class="track-no">${playing ? '<span class="bars"><i></i><i></i><i></i></span>' : (t.trackNo != null ? t.trackNo : i + 1)}</div>
        <div class="track-info">
          <div class="track-title">${escapeHtml(t.title)}</div>
          <div class="track-sub">${escapeHtml(album.section)}</div>
        </div>
        <div class="track-dur">${dur ? fmtTime(dur) : ''}</div>
      </div>`;
    })
    .join('');
  $('albumTracks').querySelectorAll('.track').forEach((el) => {
    el.addEventListener('click', () => playFromQueue(album.tracks, Number(el.dataset.idx)));
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
let searchTimer = null;
function onSearch() {
  const q = $('searchInput').value.trim();
  clearTimeout(searchTimer);
  if (!q) { showView('browse'); return; }
  searchTimer = setTimeout(() => runSearch(q), 220);
}
async function runSearch(q) {
  let data;
  try { data = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json(); } catch (e) { return; }
  const root = $('searchResults');
  let html = '';
  if (data.albums.length) {
    html += `<div class="result-head">Sets</div><div class="grid">${data.albums.map(albumCardHtml).join('')}</div>`;
  }
  if (data.tracks.length) {
    html += `<div class="result-head">Talks</div><div class="album-tracks">`;
    html += data.tracks
      .map(
        (t) => `
      <div class="track" data-track-album="${t.albumId}" data-track-id="${t.id}">
        <div class="track-no"><svg viewBox="0 0 24 24" width="16" height="16" style="opacity:.5"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></div>
        <div class="track-info">
          <div class="track-title">${escapeHtml(t.title)}</div>
          <div class="track-sub">${escapeHtml(t.album)} · ${escapeHtml(t.section)}</div>
        </div>
        <div class="track-dur">${t.duration ? fmtTime(t.duration) : ''}</div>
      </div>`
      )
      .join('');
    html += `</div>`;
  }
  if (!data.albums.length && !data.tracks.length) {
    html = `<div class="empty"><p>No matches for "${escapeHtml(q)}"</p></div>`;
  }
  root.innerHTML = html;
  bindAlbumCards(root);
  root.querySelectorAll('.track[data-track-id]').forEach((el) => {
    el.addEventListener('click', () => playSearchTrack(el.dataset.trackAlbum, el.dataset.trackId));
  });
  showView('search');
}
async function playSearchTrack(albumId, trackId) {
  let album = state.albumCache[albumId];
  if (!album) {
    try { album = await (await fetch('/api/albums/' + encodeURIComponent(albumId))).json(); state.albumCache[albumId] = album; }
    catch (e) { return; }
  }
  const idx = album.tracks.findIndex((t) => t.id === trackId);
  playFromQueue(album.tracks, idx >= 0 ? idx : 0);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
function playFromQueue(tracks, index) {
  state.queue = tracks;
  state.queueIndex = index;
  playTrack(tracks[index]);
}

function playTrack(t) {
  if (!t) return;
  const switching = !state.currentTrack || state.currentTrack.id !== t.id;
  state.currentTrack = t;

  if (switching) {
    audio.src = `/api/stream/${encodeURIComponent(t.id)}`;
    audio.load();
    const resume = loadPos(t.id);
    if (resume > 5) {
      audio.addEventListener('loadedmetadata', function once() {
        if (resume < audio.duration - 10) audio.currentTime = resume;
        audio.removeEventListener('loadedmetadata', once);
      });
    }
  }
  audio.playbackRate = state.speeds[state.speedIdx];
  audio.play().catch(() => {});
  paintNowPlaying(t);
  openNow();
  setMediaSession(t);
  refreshActiveRows();
}

function paintNowPlaying(t) {
  const g = grad((t.album || '') + (t.section || ''));
  // On single-talk sets the album name == title; show the group instead.
  const sub = t.album && t.album !== t.title ? t.album : t.section || '';
  $('nowArt').style.background = g;
  $('nowArt').textContent = shortLabel(t.album || t.title);
  $('nowBg').style.background = g;
  $('nowTitle').textContent = t.title;
  $('nowSpeaker').textContent = sub;
  $('miniArt').style.background = g;
  $('miniArt').textContent = shortLabel(t.album || t.title);
  $('miniTitle').textContent = t.title;
  $('miniSpeaker').textContent = sub;
  $('mini').classList.remove('hidden');
}

function refreshActiveRows() {
  // Re-mark active track in whatever list is showing.
  document.querySelectorAll('.album-tracks .track, #sections .track').forEach((el) => {
    el.classList.remove('active');
  });
  if (state.view === 'album' && state.queue.length) {
    const rows = $('albumTracks').querySelectorAll('.track');
    if (rows[state.queueIndex]) rows[state.queueIndex].classList.add('active');
  }
}

function togglePlay() { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); }
function playNext() { if (state.queueIndex < state.queue.length - 1) playFromQueue(state.queue, state.queueIndex + 1); }
function playPrev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.queueIndex > 0) playFromQueue(state.queue, state.queueIndex - 1);
}

function updatePlayIcons() {
  $('playBtn').innerHTML = audio.paused ? ICON_PLAY : ICON_PAUSE;
  $('miniPlay').innerHTML = audio.paused
    ? '<svg class="play-svg" viewBox="0 0 24 24" style="width:22px;height:22px"><path d="M8 5v14l11-7z"/></svg>'
    : '<svg class="play-svg" viewBox="0 0 24 24" style="width:22px;height:22px"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
}

// ---------------------------------------------------------------------------
// Now-playing open/close
// ---------------------------------------------------------------------------
function openNow() { $('now').classList.remove('hidden', 'closing'); }
function closeNow() { $('now').classList.add('closing'); setTimeout(() => $('now').classList.add('hidden'), 380); }

// ---------------------------------------------------------------------------
// Audio events
// ---------------------------------------------------------------------------
let seeking = false;
audio.addEventListener('loadedmetadata', () => {
  $('dur').textContent = fmtTime(audio.duration);
  if (state.currentTrack) cacheDur(state.currentTrack.id, audio.duration);
});
audio.addEventListener('timeupdate', () => {
  if (seeking) return;
  const d = audio.duration || 0, c = audio.currentTime || 0;
  $('cur').textContent = fmtTime(c);
  if (d) {
    $('seek').value = String(Math.round((c / d) * 1000));
    $('miniProgress').firstElementChild.style.width = (c / d) * 100 + '%';
  }
  if (state.currentTrack && c > 0) savePos(state.currentTrack.id, c);
});
audio.addEventListener('play', () => { updatePlayIcons(); refreshActiveRows(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { updatePlayIcons(); refreshActiveRows(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
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
$('speedBtn').addEventListener('click', () => {
  state.speedIdx = (state.speedIdx + 1) % state.speeds.length;
  const rate = state.speeds[state.speedIdx];
  audio.playbackRate = rate;
  $('speedBtn').textContent = rate + '×';
});
$('nowClose').addEventListener('click', closeNow);
$('mini').addEventListener('click', openNow);
$('mini').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openNow(); });
$('albumBack').addEventListener('click', () => { showView($('searchInput').value.trim() ? 'search' : 'browse'); });
$('searchInput').addEventListener('input', onSearch);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 15);
  else if (e.code === 'ArrowRight') audio.currentTime += 30;
});

// ---------------------------------------------------------------------------
// Media Session
// ---------------------------------------------------------------------------
function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.album || t.section || '', album: state.appTitle });
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) {} };
  set('play', () => audio.play());
  set('pause', () => audio.pause());
  set('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
  set('seekforward', () => { audio.currentTime += 30; });
  set('previoustrack', playPrev);
  set('nexttrack', playNext);
  set('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  updatePlayIcons();
  let cfg = { title: 'Talks', gated: false, authed: true };
  try { cfg = await (await fetch('/api/config')).json(); } catch (e) {}
  state.appTitle = cfg.title;
  document.title = cfg.title;
  $('appTitle').textContent = cfg.title;
  $('lockTitle').textContent = cfg.title;

  if (cfg.gated && !cfg.authed) { $('lock').classList.remove('hidden'); return; }
  showApp();
}
function showApp() {
  $('lock').classList.add('hidden');
  $('app').classList.remove('hidden');
  showView('browse');
  loadLibrary();
}

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
