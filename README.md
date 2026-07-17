# Talks Player

A premium, Apple-Music-style browser player for long-form motivation talks stored in a
single Google Drive folder. One Node service serves the UI **and** streams audio from
Drive with HTTP Range support, so scrubbing a 90-minute talk is instant and every track
resumes where you left off.

## Features

- 🎧 Auto-lists every audio file in one Drive folder you designate
- ⚡ Range-aware streaming proxy — instant seeking on hour-long tracks
- ▶️ Resume-where-you-left-off (per track)
- ⏭ Skip back 15s / forward 30s, playback speed (1× → 2×)
- 📱 Lock-screen / hardware media controls (Media Session API)
- 🔒 Optional shared passcode for your team
- 🎨 Deterministic gradient cover art — no per-file artwork needed

## Preview the UI right now

```bash
npm install
npm start
```

Then open **http://localhost:3000/?demo=1** to see the full interface with sample talks
(the `?demo=1` flag shows the UI without needing Drive connected yet).

## Connect Google Drive (one-time)

1. **Create a service account**
   - Google Cloud Console → create/select a project
   - Enable the **Google Drive API**
   - IAM & Admin → Service Accounts → create one → Keys → **Add key → JSON** (downloads a file)
2. **Share your folder with it**
   - Put your talks in one Drive folder
   - Share that folder (Viewer) with the service account's `client_email` from the JSON
3. **Fill in the env vars** (copy `.env.example` → `.env`)
   - `DRIVE_FOLDER_ID` = the id in the folder URL
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = the entire JSON key contents on one line
   - `APP_PASSCODE` = a code your team types (leave blank for open access)
   - `APP_TITLE` = what to call the app
   - `SESSION_SECRET` = any long random string

Name files as `Title - Speaker.mp3` and the app splits them automatically.

## Deploy on Render

- **New Web Service** → connect this repo
- Build command: `npm install`
- Start command: `npm start`
- Add the same environment variables in the Render dashboard
  (paste the service-account JSON as a single-line value)
- `PORT` is provided by Render automatically

## Local dev

```bash
npm run dev   # restarts on file changes
```
