'use strict';

require('dotenv').config();

/**
 * Talks Player — a single Node service that:
 *   1. Serves the premium frontend (public/)
 *   2. Recursively indexes audio from a designated Google Drive folder,
 *      grouping into Group -> Speaker -> Talk (matching the Drive layout:
 *      Talks / <Group> / <Speaker> / <Set> / NN Track.mp3)
 *   3. Streams each file with HTTP Range support (instant seeking on long tracks)
 *
 * Auth to Drive is via a service account. App access is gated by an optional
 * shared passcode (signed cookie).
 */

const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const cookieParser = require('cookie-parser');
const { google } = require('googleapis');

const PORT = process.env.PORT || 3000;
const FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';
const APP_PASSCODE = process.env.APP_PASSCODE || '';
const APP_TITLE = process.env.APP_TITLE || 'Talks';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const RECENT_DAYS = Number(process.env.RECENT_DAYS || 30);

const AUDIO_RE = /(^audio\/)|(video\/mp4)|(mpeg)/i;
// Groups shown first, in this order; any others appended after.
const PREFERRED_GROUPS = ['BWW', 'Amway', 'WWDB', 'Yager Group', 'Day One'];

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
  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
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
  tracksById: new Map(),
  groups: new Map(), // groupName -> { name, speakers: Map(speakerName -> track[]) }
  groupOrder: [],
  recent: [], // tracks sorted by createdTime desc
};

function cleanTitle(name) {
  let t = name.replace(/\.[^./\\]+$/, '').trim();
  const m = t.match(/^(\d{1,3})[\s._-]+(.*)$/);
  let trackNo = null;
  if (m) {
    trackNo = Number(m[1]);
    t = m[2].trim();
  }
  return { title: t || name, trackNo };
}

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

  const tracksById = new Map();
  const groups = new Map();

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
          'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, videoMediaMetadata(durationMillis))',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken: pageToken || undefined,
      });
      for (const f of data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          queue.push({ id: f.id, chain: item.chain.concat(f.name) });
        } else if (AUDIO_RE.test(f.mimeType || '')) {
          addTrack(f, item.chain);
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  function addTrack(f, chain) {
    // chain is folder names from the root folder down, e.g. ["Talks","BWW","Steve Ridley","Set"]
    let rel = chain.slice();
    if (rel[0] === 'Talks' || rel[0] === 'Books') rel = rel.slice(1);
    const group = rel[0] || 'Other';
    const speaker = rel.length >= 2 ? rel[1] : group; // mid level = speaker (or the group itself)
    const set = rel[2] || rel[rel.length - 1] || group; // the set/event, for context under a speaker

    const { title, trackNo } = cleanTitle(f.name || '');
    const durMs = f.videoMediaMetadata && f.videoMediaMetadata.durationMillis;
    const track = {
      id: f.id,
      title,
      trackNo,
      name: f.name,
      group,
      speaker,
      set,
      size: f.size ? Number(f.size) : null,
      mimeType: f.mimeType,
      createdTime: f.createdTime || null,
      modifiedTime: f.modifiedTime || null,
      duration: durMs ? Math.round(Number(durMs) / 1000) : null,
    };
    tracksById.set(track.id, track);
    if (!groups.has(group)) groups.set(group, { name: group, speakers: new Map() });
    const g = groups.get(group);
    if (!g.speakers.has(speaker)) g.speakers.set(speaker, []);
    g.speakers.get(speaker).push(track);
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
            if (!queue.length && active === 0) { done = true; resolve(); }
            else pump();
          })
          .catch((err) => { done = true; reject(err); });
      }
      if (!queue.length && active === 0 && !done) { done = true; resolve(); }
    }
    pump();
  });

  // Sort talks within each speaker (by set, then track number, then name).
  for (const g of groups.values()) {
    for (const talks of g.speakers.values()) {
      talks.sort(
        (a, b) =>
          a.set.localeCompare(b.set, undefined, { numeric: true }) ||
          (a.trackNo != null && b.trackNo != null ? a.trackNo - b.trackNo : 0) ||
          a.name.localeCompare(b.name, undefined, { numeric: true })
      );
    }
  }

  // Group display order: preferred first, then the rest by track count.
  const groupList = [...groups.keys()];
  const groupOrder = [
    ...PREFERRED_GROUPS.filter((g) => groups.has(g)),
    ...groupList
      .filter((g) => !PREFERRED_GROUPS.includes(g))
      .sort((a, b) => trackCount(groups.get(b)) - trackCount(groups.get(a))),
  ];

  const recent = [...tracksById.values()]
    .filter((t) => t.createdTime)
    .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

  index.tracksById = tracksById;
  index.groups = groups;
  index.groupOrder = groupOrder;
  index.recent = recent;
  index.status = 'ready';
  index.builtAt = Date.now();
  console.log(
    `[index] ready: ${tracksById.size} talks, ${groups.size} groups (${(Date.now() - t0) / 1000}s)`
  );
}

function trackCount(g) {
  let n = 0;
  for (const t of g.speakers.values()) n += t.length;
  return n;
}
function speakerTrackList(g) {
  // [{name, trackCount}] sorted alphabetically (speaker == group means "loose" bucket)
  return [...g.speakers.entries()]
    .map(([name, talks]) => ({ name, trackCount: talks.length }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
function slimTalk(t) {
  return {
    id: t.id, title: t.title, trackNo: t.trackNo, set: t.set,
    group: t.group, speaker: t.speaker, duration: t.duration,
  };
}

// ---------------------------------------------------------------------------
// Passcode gate
// ---------------------------------------------------------------------------
function sign(v) { return `${v}.${crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex')}`; }
function verify(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const v = token.slice(0, i), mac = token.slice(i + 1);
  const exp = crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
  const a = Buffer.from(mac), b = Buffer.from(exp);
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
    recentDays: RECENT_DAYS,
    index: { status: index.status, talks: index.tracksById.size, groups: index.groups.size, builtAt: index.builtAt },
  });
});

app.post('/api/login', (req, res) => {
  if (!APP_PASSCODE) return res.json({ ok: true });
  const supplied = (req.body && req.body.passcode) || '';
  const a = Buffer.from(String(supplied)), b = Buffer.from(APP_PASSCODE);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b)))
    return res.status(401).json({ error: 'wrong passcode' });
  res.cookie('tp_auth', sign(`ok:${Date.now()}`), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('tp_auth'); res.json({ ok: true }); });

// Top-level tabs: groups (ordered) + recent count
app.get('/api/groups', requireAuth, (req, res) => {
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  const recentCount = index.recent.filter((t) => new Date(t.createdTime).getTime() >= cutoff).length;
  res.json({
    status: index.status,
    recentDays: RECENT_DAYS,
    recentCount,
    groups: index.groupOrder.map((name) => {
      const g = index.groups.get(name);
      return { name, speakerCount: g.speakers.size, trackCount: trackCount(g) };
    }),
  });
});

// One group -> its speakers
app.get('/api/groups/:name', requireAuth, (req, res) => {
  const g = index.groups.get(req.params.name);
  if (!g) return res.status(404).json({ error: 'group not found' });
  res.json({ name: g.name, speakers: speakerTrackList(g) });
});

// One speaker -> their talks
app.get('/api/talks', requireAuth, (req, res) => {
  const g = index.groups.get(String(req.query.group || ''));
  if (!g) return res.status(404).json({ error: 'group not found' });
  const talks = g.speakers.get(String(req.query.speaker || ''));
  if (!talks) return res.status(404).json({ error: 'speaker not found' });
  res.json({
    group: g.name,
    speaker: String(req.query.speaker),
    talks: talks.map(slimTalk),
  });
});

// Recently added (last N days by Drive createdTime)
app.get('/api/recent', requireAuth, (req, res) => {
  const days = Number(req.query.days || RECENT_DAYS);
  const cutoff = Date.now() - days * 86400000;
  const talks = index.recent
    .filter((t) => new Date(t.createdTime).getTime() >= cutoff)
    .slice(0, 300)
    .map((t) => ({ ...slimTalk(t), createdTime: t.createdTime }));
  res.json({ days, talks });
});

// Search talks + speakers
app.get('/api/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ speakers: [], talks: [] });
  const speakers = [];
  for (const g of index.groups.values()) {
    for (const [name, talks] of g.speakers.entries()) {
      if (name.toLowerCase().includes(q)) {
        speakers.push({ group: g.name, name, trackCount: talks.length });
        if (speakers.length >= 40) break;
      }
    }
    if (speakers.length >= 40) break;
  }
  const talks = [];
  for (const t of index.tracksById.values()) {
    if (t.title.toLowerCase().includes(q)) {
      talks.push(slimTalk(t));
      if (talks.length >= 60) break;
    }
  }
  res.json({ speakers, talks });
});

app.post('/api/refresh', requireAuth, (req, res) => {
  if (index.status === 'building') return res.json({ status: 'building' });
  buildIndex().catch((e) => { index.status = 'error'; index.error = e.message; });
  res.json({ status: 'building' });
});

// Stream with Range passthrough
app.get('/api/stream/:id', requireAuth, async (req, res) => {
  if (!drive || !auth) return res.status(503).send('Drive not configured');
  try {
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    const accessToken = tokenResp && tokenResp.token;
    if (!accessToken) throw new Error('no access token');
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(req.params.id)}?alt=media&supportsAllDrives=true`;
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (req.headers.range) headers.Range = req.headers.range;
    const driveResp = await fetch(url, { headers });
    if (!driveResp.ok && driveResp.status !== 206) {
      console.error('[stream] drive', driveResp.status);
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
  if (drive && FOLDER_ID) {
    buildIndex().catch((e) => { index.status = 'error'; index.error = e.message; console.error('[index] build failed:', e.message); });
  }
});
