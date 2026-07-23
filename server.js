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
const APP_TITLE = process.env.APP_TITLE || 'Holy Grail';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const RECENT_DAYS = Number(process.env.RECENT_DAYS || 30);

const AUDIO_RE = /(^audio\/)|(video\/mp4)|(mpeg)/i;
// Groups shown first, in this order; any others appended after.
const PREFERRED_GROUPS = ['BWW', 'Amway', 'WWDB', 'Yager Group']; // shown first, in this order
const DEFERRED_GROUPS = ['Day One']; // pushed to the very end
// Smart collections: talks whose TITLE matches are gathered into a tab
// (non-destructive — the talk still lives under its speaker/group too).
// `after` anchors the tab right after a given group.
const COLLECTIONS = [
  { key: 'women', label: "Women's Leadership", re: /\b(wom[ae]n|ladies|lady)\b/i, after: 'Yager Group' },
];

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
// Vocabulary: a TALK = one complete speech. A talk is either a single track,
// or an ALBUM (one speech split across multiple tracks in the same folder).
const index = {
  status: 'idle', // idle | building | ready | error
  builtAt: null,
  error: null,
  groups: new Map(),  // groupName -> { name, speakers: Map(speaker -> { name, talks: [talk] }) }
  talksById: new Map(),
  groupOrder: [],
  talkCount: 0,
  recent: [], // talks sorted by createdTime desc
};

function cleanTitle(name) {
  let t = name.replace(/\.[^./\\]+$/, '').trim();
  const m = t.match(/^(\d{1,3})[\s._-]+(.*)$/);
  let trackNo = null;
  if (m) { trackNo = Number(m[1]); t = m[2].trim(); }
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

  const groups = new Map();
  const talksById = new Map();

  // Each work item carries the folder chain as {id,name} objects so we can key
  // an album to its folder id.
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
          queue.push({ id: f.id, chain: item.chain.concat({ id: f.id, name: f.name }) });
        } else if (AUDIO_RE.test(f.mimeType || '')) {
          addTrack(f, item.chain);
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  function addTrack(f, chain) {
    // chain = folders above the track, {id,name}, e.g. [Talks, BWW, Speaker, Album]
    let rel = chain.slice();
    if (rel.length && (rel[0].name === 'Talks' || rel[0].name === 'Books')) rel = rel.slice(1);
    const group = (rel[0] && rel[0].name) || 'Other';
    const speaker = rel.length >= 2 ? rel[1].name : group;
    // The talk = the leaf folder that directly contains the tracks (its tracks
    // are the pieces of one speech). If the track sits loose directly under the
    // speaker/group with no folder of its own, it is its own single-track talk.
    const talkFolder = rel.length >= 3 ? rel[rel.length - 1] : null;

    const { title, trackNo } = cleanTitle(f.name || '');
    const durMs = f.videoMediaMetadata && f.videoMediaMetadata.durationMillis;
    const track = {
      id: f.id, title, trackNo, name: f.name,
      mimeType: f.mimeType, size: f.size ? Number(f.size) : null,
      createdTime: f.createdTime || null,
      duration: durMs ? Math.round(Number(durMs) / 1000) : null,
    };

    const talkId = talkFolder ? talkFolder.id : 'trk:' + f.id;
    const talkTitle = talkFolder ? talkFolder.name : title;

    if (!groups.has(group)) groups.set(group, { name: group, speakers: new Map() });
    const g = groups.get(group);
    if (!g.speakers.has(speaker)) g.speakers.set(speaker, { name: speaker, talks: new Map() });
    const sp = g.speakers.get(speaker);
    if (!sp.talks.has(talkId)) {
      const talk = { id: talkId, title: talkTitle, group, speaker, tracks: [], duration: 0, createdTime: null };
      sp.talks.set(talkId, talk);
      talksById.set(talkId, talk);
    }
    sp.talks.get(talkId).tracks.push(track);
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

  // Finalize each talk (order its tracks, sum duration, mark albums).
  for (const g of groups.values()) {
    for (const sp of g.speakers.values()) {
      for (const talk of sp.talks.values()) {
        talk.tracks.sort(
          (a, b) =>
            (a.trackNo != null && b.trackNo != null ? a.trackNo - b.trackNo : 0) ||
            a.name.localeCompare(b.name, undefined, { numeric: true })
        );
        talk.isAlbum = talk.tracks.length > 1;
        talk.trackCount = talk.tracks.length;
        talk.duration = talk.tracks.reduce((s, t) => s + (t.duration || 0), 0) || null;
        talk.createdTime = talk.tracks.map((t) => t.createdTime).filter(Boolean).sort().pop() || null;
      }
      // speaker.talksArr = talks sorted by title
      sp.talksArr = [...sp.talks.values()].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    }
  }

  const groupList = [...groups.keys()];
  const groupOrder = [
    ...PREFERRED_GROUPS.filter((g) => groups.has(g)),
    ...groupList
      .filter((g) => !PREFERRED_GROUPS.includes(g) && !DEFERRED_GROUPS.includes(g))
      .sort((a, b) => groupTalkCount(groups.get(b)) - groupTalkCount(groups.get(a))),
    ...DEFERRED_GROUPS.filter((g) => groups.has(g)),
  ];

  const recent = [...talksById.values()].filter((t) => t.createdTime).sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

  index.groups = groups;
  index.talksById = talksById;
  index.groupOrder = groupOrder;
  index.talkCount = talksById.size;
  index.recent = recent;
  index.status = 'ready';
  index.builtAt = Date.now();
  console.log(`[index] ready: ${talksById.size} talks, ${groups.size} groups (${(Date.now() - t0) / 1000}s)`);
}

function groupTalkCount(g) {
  let n = 0;
  for (const sp of g.speakers.values()) n += sp.talks.size;
  return n;
}
function speakerList(g) {
  return [...g.speakers.values()]
    .map((sp) => ({ name: sp.name, talkCount: sp.talks.size }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
function collectionTalks(re) {
  const out = [];
  for (const t of index.talksById.values()) if (re.test(t.title)) out.push(t);
  out.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return out;
}
// A talk with its tracks inline, ready for the player.
function talkPayload(t) {
  return {
    id: t.id, title: t.title, group: t.group, speaker: t.speaker,
    isAlbum: t.isAlbum, trackCount: t.trackCount, duration: t.duration,
    tracks: t.tracks.map((tr) => ({ id: tr.id, title: tr.title, trackNo: tr.trackNo, duration: tr.duration })),
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
    index: { status: index.status, talks: index.talkCount, groups: index.groups.size, builtAt: index.builtAt },
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
      return { name, speakerCount: g.speakers.size, talkCount: groupTalkCount(g) };
    }),
    collections: COLLECTIONS
      .map((c) => ({ key: c.key, label: c.label, after: c.after || null, count: collectionTalks(c.re).length }))
      .filter((c) => c.count > 0),
  });
});

// A smart collection (talks whose title matches the collection's pattern)
app.get('/api/collection/:key', requireAuth, (req, res) => {
  const c = COLLECTIONS.find((x) => x.key === req.params.key);
  if (!c) return res.status(404).json({ error: 'collection not found' });
  res.json({ key: c.key, label: c.label, talks: collectionTalks(c.re).map(talkPayload) });
});

// One group -> its speakers
app.get('/api/groups/:name', requireAuth, (req, res) => {
  const g = index.groups.get(req.params.name);
  if (!g) return res.status(404).json({ error: 'group not found' });
  res.json({ name: g.name, speakers: speakerList(g) });
});

// One speaker -> their talks (each talk carries its tracks inline)
app.get('/api/speaker', requireAuth, (req, res) => {
  const g = index.groups.get(String(req.query.group || ''));
  if (!g) return res.status(404).json({ error: 'group not found' });
  const sp = g.speakers.get(String(req.query.speaker || ''));
  if (!sp) return res.status(404).json({ error: 'speaker not found' });
  res.json({ group: g.name, speaker: sp.name, talks: sp.talksArr.map(talkPayload) });
});

// Recently added talks (last N days by Drive createdTime)
app.get('/api/recent', requireAuth, (req, res) => {
  const days = Number(req.query.days || RECENT_DAYS);
  const cutoff = Date.now() - days * 86400000;
  const talks = index.recent
    .filter((t) => new Date(t.createdTime).getTime() >= cutoff)
    .slice(0, 300)
    .map((t) => ({ ...talkPayload(t), createdTime: t.createdTime }));
  res.json({ days, talks });
});

// Search talks + speakers
app.get('/api/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ speakers: [], talks: [] });
  const speakers = [];
  for (const g of index.groups.values()) {
    for (const sp of g.speakers.values()) {
      if (sp.name.toLowerCase().includes(q)) {
        speakers.push({ group: g.name, name: sp.name, talkCount: sp.talks.size });
        if (speakers.length >= 40) break;
      }
    }
    if (speakers.length >= 40) break;
  }
  const talks = [];
  for (const t of index.talksById.values()) {
    if (t.title.toLowerCase().includes(q)) {
      talks.push(talkPayload(t));
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
