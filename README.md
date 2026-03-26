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
