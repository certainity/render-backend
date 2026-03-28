# Video Downloader API

Production-ready Node.js Express backend for fetching video metadata with `yt-dlp`, designed for Render.com free tier.

## Files

- `server.js`
- `package.json`
- `render.yaml`

## Local Run

```bash
npm install
node server.js
```

Server runs on:

```bash
http://localhost:3000
```

## Local YouTube and Instagram testing

For local YouTube and Instagram extraction, the most reliable Windows setup is a manual cookies file exported from a signed-in browser.

Preferred setup:

```bash
$env:PORT=4000
$env:YTDLP_COOKIES_FILE="C:\path\to\cookies.txt"
node server.js
```

If you do not have a cookies file yet, browser-cookie mode is still supported:

Example:

```bash
$env:PORT=4000
$env:YTDLP_COOKIES_FROM_BROWSER="chrome"
$env:YTDLP_BROWSER_PROFILE="Default"
node server.js
```

If yt-dlp says it cannot copy the Chrome cookie database, fully close Chrome and retry. If that still fails, export a `cookies.txt` file and use `YTDLP_COOKIES_FILE` instead.

Optional fallback if cookie decryption needs it:

```bash
$env:YTDLP_BROWSER_KEYRING="basic"
```

Pair this with the frontend local env:

```env
NEXT_PUBLIC_ENABLE_YOUTUBE_LOCAL=1
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
```

## Endpoints

### `GET /`

Returns:

```text
API Running
```

### `GET /health`

Returns:

```text
OK
```

### `POST /api/download`

Request:

```json
{
  "url": "https://example.com/video"
}
```

Response:

```json
{
  "title": "Video title",
  "thumbnail": "https://example.com/thumb.jpg",
  "formats": [
    {
      "format_id": "18",
      "ext": "mp4",
      "quality": "360p",
      "url": "https://..."
    }
  ]
}
```

## Render Deploy

### Build Command

```bash
npm install && pip install yt-dlp
```

### Start Command

```bash
node server.js
```

### Render Steps

```text
1. Push this folder to GitHub.
2. In Render, click New + > Web Service.
3. Connect your GitHub repo.
4. Set Root Directory to render-backend
5. Build Command: npm install && pip install yt-dlp
6. Start Command: node server.js
7. Deploy
```

## GitHub Push Steps

```bash
git init
git add .
git commit -m "Initial video downloader backend"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```
