'use strict';

require('dotenv').config();

/**
 * Talks Player — a single Node service that:
 *   1. Serves the premium frontend (public/)
 *   2. Recursively indexes audio files from a designated Google Drive folder,
 *      grouping them into albums (immediate parent folder) and sections
 *      (top-level group under the root).
 *   3. Streams each file with HTTP Range support (instant seeking on long tracks)
 *
 * Auth to Drive is via a service account (no user ever signs into Google).
 * Access to the app is gated by an optional shared passcode (signed cookie).
 */

const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const cookieParser = require('cookie-parser');
const { google } = require('googleapis');

const PORT = process.env.PORT || 3000;
const FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';
const APP_PASSCODE = process.env.APP_PASSCODE || ''; // empty => no gate (open)
const APP_TITLE = process.env.APP_TITLE || 'Talks';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const AUDIO_RE = /(^audio\/)|(video\/mp4)|(mpeg)/i;

// ---------------------------------------------------------------------------
// Google Drive client (service account)
// ---------------------------------------------------------------------------
let drive = null;
let auth = null;

function initDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.warn('[drive] GOOGLE_SERVICE_ACCOUNT_JSON not set — library will be empty.');
    return;
  }
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (err) {
    console.error('[drive] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON:', err.message);
    return;
  }
  if (credentials.private_key) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }
  auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  drive = google.drive({ version: 'v3', auth });
  console.log('[drive] service account ready:', credentials.client_email || '(unknown)');
}
initDrive();

// ---------------------------------------------------------------------------
// Library index (built once, cached in memory)
// ---------------------------------------------------------------------------
const index = {
  status: 'idle', // idle | building | ready | error
  builtAt: null,
  error: null,
  albums: new Map(), // albumId -> { id, name, section, path, tracks: [] }
  tracksById: new Map(), // trackId -> track
  order: [], // album ids in display order
};

function cleanTitle(name) {
  let t = name.replace(/\.[^./\\]+$/, '').trim(); // strip extension
  const m = t.match(/^(\d{1,3})[\s._-]+(.*)$/); // leading track number
  let trackNo = null;
  if (m) {
    trackNo = Number(m[1]);
    t = m[2].trim();
  }
  return { title: t || name, trackNo };
}

// Simple concurrency pool for the recursive walk.
async function buildIndex() {
  if (!drive || !FOLDER_ID) {
    index.status = 'error';
    index.error = 'Drive not configured';
    return;
  }
  index.status = 'building';
  index.error = null;
  console.log('[index] building…');
  const t0 = Date.now();

  const albums = new Map();
  const tracksById = new Map();

  // Each work item is a folder to list, carrying its path chain [{id,name}].
  const queue = [{ id: FOLDER_ID, chain: [] }];
  const CONCURRENCY = 8;
  let active = 0;
  let done = false;

  async function listFolder(item) {
    let pageToken = null;
    do {
      const { data } = await drive.files.list({
        q: `'${item.id}' in parents and trashed = false`,
        fields:
          'nextPageToken, files(id, name, mimeType, size, modifiedTime, videoMediaMetadata(durationMillis))',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken: pageToken || undefined,
      });
      for (const f of data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          queue.push({ id: f.id, chain: item.chain.concat({ id: f.id, name: f.name }) });
        } else if (AUDIO_RE.test(f.mimeType || '')) {
          addTrack(f, item);
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  function addTrack(f, folder) {
    const chain = folder.chain;
    // album = immediate parent folder; section = first meaningful group under root.
    const album = chain[chain.length - 1] || { id: FOLDER_ID, name: APP_TITLE };
    // Section: the folder just below the root's "Talks"-style top level.
    // chain[0] is usually the top folder (e.g. "Talks"); chain[1] is the group.
    let section = 'Talks';
    if (chain.length >= 2) section = chain[1].name;
    else if (chain.length === 1) section = chain[0].name;

    const { title, trackNo } = cleanTitle(f.name || '');
    const durMs = f.videoMediaMetadata && f.videoMediaMetadata.durationMillis;
    const track = {
      id: f.id,
      title,
      trackNo,
      name: f.name,
      albumId: album.id,
      album: album.name,
      section,
      size: f.size ? Number(f.size) : null,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      duration: durMs ? Math.round(Number(durMs) / 1000) : null,
    };
    tracksById.set(track.id, track);
    if (!albums.has(album.id)) {
      albums.set(album.id, {
        id: album.id,
        name: album.name,
        section,
        path: chain.map((c) => c.name).join('/'),
        tracks: [],
      });
    }
    albums.get(album.id).tracks.push(track);
  }

  await new Promise((resolve, reject) => {
    function pump() {
      if (done) return;
      while (active < CONCURRENCY && queue.length) {
        const item = queue.shift();
        active++;
        listFolder(item)
          .then(() => {
            active--;
            if (!queue.length && active === 0) {
              done = true;
              resolve();
            } else pump();
          })
          .catch((err) => {
            done = true;
            reject(err);
          });
      }
      if (!queue.length && active === 0 && !done) {
        done = true;
        resolve();
      }
    }
    pump();
  });

  // Sort tracks within each album (by track number, then name).
  for (const alb of albums.values()) {
    alb.tracks.sort((a, b) => {
      if (a.trackNo != null && b.trackNo != null) return a.trackNo - b.trackNo;
      if (a.trackNo != null) return -1;
      if (b.trackNo != null) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }

  // Album display order: by section, then album name.
  const order = [...albums.values()]
    .sort(
      (a, b) =>
        a.section.localeCompare(b.section) || a.name.localeCompare(b.name, undefined, { numeric: true })
    )
    .map((a) => a.id);

  index.albums = albums;
  index.tracksById = tracksById;
  index.order = order;
  index.status = 'ready';
  index.builtAt = Date.now();
  console.log(
    `[index] ready: ${tracksById.size} tracks in ${albums.size} albums (${
      (Date.now() - t0) / 1000
    }s)`
  );
}

// Group albums by section for the browse view.
function sectionsPayload() {
  const sections = new Map();
  for (const id of index.order) {
    const a = index.albums.get(id);
    if (!sections.has(a.section)) sections.set(a.section, []);
    sections.get(a.section).push({ id: a.id, name: a.name, trackCount: a.tracks.length });
  }
  // Sort sections by album count (richest first), then name.
  return [...sections.entries()]
    .map(([name, albums]) => ({ name, albums }))
    .sort((x, y) => y.albums.length - x.albums.length || x.name.localeCompare(y.name));
}

// ---------------------------------------------------------------------------
// Passcode gate (stateless signed cookie)
// ---------------------------------------------------------------------------
function sign(value) {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  return `${value}.${mac}`;
}
function verify(token) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const value = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function requireAuth(req, res, next) {
  if (!APP_PASSCODE) return next();
  if (verify(req.cookies && req.cookies.tp_auth)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(cookieParser());

app.get('/api/config', (req, res) => {
  res.json({
    title: APP_TITLE,
    gated: Boolean(APP_PASSCODE),
    authed: !APP_PASSCODE || verify(req.cookies && req.cookies.tp_auth),
    driveReady: Boolean(drive && FOLDER_ID),
    index: {
      status: index.status,
      albums: index.albums.size,
      tracks: index.tracksById.size,
      builtAt: index.builtAt,
    },
  });
});

app.post('/api/login', (req, res) => {
  if (!APP_PASSCODE) return res.json({ ok: true });
  const supplied = (req.body && req.body.passcode) || '';
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(APP_PASSCODE);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'wrong passcode' });
  const token = sign(`ok:${Date.now()}`);
  res.cookie('tp_auth', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('tp_auth');
  res.json({ ok: true });
});

// Browse: sections -> albums
app.get('/api/library', requireAuth, (req, res) => {
  res.json({
    status: index.status,
    totals: { albums: index.albums.size, tracks: index.tracksById.size },
    sections: index.status === 'ready' ? sectionsPayload() : [],
  });
});

// One album's tracks
app.get('/api/albums/:id', requireAuth, (req, res) => {
  const a = index.albums.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'album not found' });
  res.json({
    id: a.id,
    name: a.name,
    section: a.section,
    path: a.path,
    tracks: a.tracks.map((t) => ({
      id: t.id,
      title: t.title,
      trackNo: t.trackNo,
      album: t.album,
      section: t.section,
      duration: t.duration,
      size: t.size,
      mimeType: t.mimeType,
    })),
  });
});

// Search across tracks and albums
app.get('/api/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ albums: [], tracks: [] });
  const albums = [];
  for (const id of index.order) {
    const a = index.albums.get(id);
    if (a.name.toLowerCase().includes(q) || a.section.toLowerCase().includes(q)) {
      albums.push({ id: a.id, name: a.name, section: a.section, trackCount: a.tracks.length });
      if (albums.length >= 60) break;
    }
  }
  const tracks = [];
  for (const t of index.tracksById.values()) {
    if (t.title.toLowerCase().includes(q)) {
      tracks.push({
        id: t.id,
        title: t.title,
        album: t.album,
        albumId: t.albumId,
        section: t.section,
        duration: t.duration,
      });
      if (tracks.length >= 60) break;
    }
  }
  res.json({ albums, tracks });
});

// Rebuild the index on demand
app.post('/api/refresh', requireAuth, async (req, res) => {
  if (index.status === 'building') return res.json({ status: 'building' });
  buildIndex().catch((e) => {
    index.status = 'error';
    index.error = e.message;
  });
  res.json({ status: 'building' });
});

// Stream a file with Range passthrough
app.get('/api/stream/:id', requireAuth, async (req, res) => {
  if (!drive || !auth) return res.status(503).send('Drive not configured');
  const id = req.params.id;
  try {
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    const accessToken = tokenResp && tokenResp.token;
    if (!accessToken) throw new Error('no access token');

    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      id
    )}?alt=media&supportsAllDrives=true`;
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (req.headers.range) headers.Range = req.headers.range;

    const driveResp = await fetch(url, { headers });
    if (!driveResp.ok && driveResp.status !== 206) {
      const text = await driveResp.text().catch(() => '');
      console.error('[stream] drive', driveResp.status, text.slice(0, 200));
      return res.status(driveResp.status).send('upstream error');
    }
    res.status(driveResp.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const v = driveResp.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!driveResp.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    if (driveResp.body) Readable.fromWeb(driveResp.body).pipe(res);
    else res.end();
  } catch (err) {
    console.error('[stream] error:', err.message);
    if (!res.headersSent) res.status(500).send('stream error');
    else res.end();
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`[server] Talks Player on http://localhost:${PORT} | gate: ${APP_PASSCODE ? 'ON' : 'OFF'}`);
  // Kick off the initial index build.
  if (drive && FOLDER_ID) {
    buildIndex().catch((e) => {
      index.status = 'error';
      index.error = e.message;
      console.error('[index] build failed:', e.message);
    });
  }
});
