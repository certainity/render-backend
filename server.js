const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const { Readable } = require("stream");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 25000;
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const STREAM_TOKEN_TTL_MS = Number(process.env.STREAM_TOKEN_TTL_MS) || 60 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use((req, _res, next) => {
  req.requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[${req.requestId}] ${req.method} ${req.originalUrl}`);
  next();
});

app.get("/", (_req, res) => {
  res.status(200).send("API Running");
});

app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

function sanitizeUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    const error = new Error("url is required");
    error.statusCode = 400;
    throw error;
  }

  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch {
    const error = new Error("invalid url");
    error.statusCode = 400;
    throw error;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error("only http/https urls are supported");
    error.statusCode = 400;
    throw error;
  }

  return parsed.toString();
}

function tryExtractFacebookVideoId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("facebook.com") && host !== "fb.watch") return null;

    const pathname = parsed.pathname || "";
    const watchId = parsed.searchParams.get("v");
    if (watchId && /^\d+$/.test(watchId)) return watchId;

    const patterns = [
      /\/share\/v\/([A-Za-z0-9._-]+)/i,
      /\/reel\/(\d+)/i,
      /\/videos\/(\d+)/i,
      /\/watch\/\?v=(\d+)/i,
      /^\/([^/]+)$/i, // fb.watch short path
    ];

    for (const pattern of patterns) {
      const match = `${pathname}${parsed.search}`.match(pattern) || pathname.match(pattern);
      if (match && match[1]) return match[1];
    }
  } catch {
    // ignore
  }
  return null;
}

function normalizeFacebookUrl(url) {
  const videoId = tryExtractFacebookVideoId(url);
  if (!videoId) return url;
  return `https://www.facebook.com/watch/?v=${encodeURIComponent(videoId)}`;
}

function buildYtDlpCommand(url) {
  const platform = getPlatformFromUrl(url);
  const base = `${YTDLP_BIN} -j --no-playlist --no-warnings --socket-timeout 15`;
  if (platform === "facebook") {
    return `${base} --add-header "Referer:https://www.facebook.com/" --add-header "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" ${escapeShellArg(url)}`;
  }
  return `${base} ${escapeShellArg(url)}`;
}

function getPlatformFromUrl(input) {
  try {
    const hostname = new URL(input).hostname.toLowerCase();

    if (
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtu.be" ||
      hostname.endsWith(".youtu.be") ||
      hostname === "youtube-nocookie.com" ||
      hostname.endsWith(".youtube-nocookie.com")
    ) {
      return "youtube";
    }

    if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname === "twitter.com" || hostname.endsWith(".twitter.com")) {
      return "twitter";
    }

    if (hostname === "tiktok.com" || hostname.endsWith(".tiktok.com")) {
      return "tiktok";
    }

    if (hostname === "facebook.com" || hostname.endsWith(".facebook.com") || hostname === "fb.watch") {
      return "facebook";
    }

    if (hostname === "instagram.com" || hostname.endsWith(".instagram.com")) {
      return "instagram";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

function escapeShellArg(value) {
  return `"${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
}

function runYtDlp(url, requestId) {
  const command = buildYtDlpCommand(url);
  console.log(`[${requestId}] executing: ${command}`);

  return new Promise((resolve, reject) => {
    const child = exec(
      command,
      {
        timeout: REQUEST_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (stderr && stderr.trim()) {
          console.error(`[${requestId}] yt-dlp stderr: ${stderr.trim()}`);
        }

        if (error) {
          if (error.killed || error.signal === "SIGTERM") {
            const timeoutError = new Error("yt-dlp request timed out");
            timeoutError.statusCode = 504;
            return reject(timeoutError);
          }

          const commandError = new Error("failed to fetch video metadata");
          commandError.statusCode = 502;
          commandError.details = stderr ? stderr.trim() : error.message;
          return reject(commandError);
        }

        try {
          resolve(JSON.parse(stdout));
        } catch {
          const parseError = new Error("invalid yt-dlp response");
          parseError.statusCode = 502;
          reject(parseError);
        }
      }
    );

    child.on("error", (err) => {
      console.error(`[${requestId}] process error: ${err.message}`);
    });
  });
}

function getPublicBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

function safeFilename(input) {
  return String(input || "video")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "video";
}

function guessExt(format) {
  if (format?.ext) return String(format.ext).toLowerCase();
  try {
    const pathname = new URL(format?.url || "").pathname;
    const ext = pathname.split(".").pop();
    if (ext) return ext.toLowerCase();
  } catch {
    // ignore
  }
  return "mp4";
}

function inferHeight(format) {
  if (typeof format?.height === "number") return format.height;

  const resolution = typeof format?.resolution === "string" ? format.resolution : "";
  const match = resolution.match(/(\d{3,4})$/);
  if (match) return Number(match[1]);

  const text = [format?.format_note, format?.format, format?.format_id]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (/\b1080p\b/.test(text)) return 1080;
  if (/\b1024p\b/.test(text)) return 1024;
  if (/\b720p\b|\bhd\b/.test(text)) return 720;
  if (/\b540p\b/.test(text)) return 540;
  if (/\b480p\b/.test(text)) return 480;
  if (/\b360p\b|\bsd\b/.test(text)) return 360;
  return null;
}

function getQualityLabel(format) {
  const height = inferHeight(format);
  if (height) return `${height}p`;
  return format?.format_note || format?.resolution || format?.format || "unknown";
}

function cookieJarToHeader(cookieJar) {
  const reserved = new Set(["domain", "path", "expires", "max-age", "secure", "httponly", "samesite"]);

  const pairs = String(cookieJar || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eqIndex = part.indexOf("=");
      if (eqIndex <= 0) return null;
      const key = part.slice(0, eqIndex).trim();
      const value = part.slice(eqIndex + 1).trim().replace(/^"|"$/g, "");
      if (!key || reserved.has(key.toLowerCase())) return null;
      return `${key}=${value}`;
    })
    .filter(Boolean);

  return pairs.length ? pairs.join("; ") : null;
}

function getForwardableHeaders(format) {
  const headers = {};
  const rawHeaders = format?.http_headers || format?.headers;

  if (rawHeaders && typeof rawHeaders === "object") {
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value !== "string") continue;
      const normalized = key.toLowerCase();
      if (
        normalized === "user-agent" ||
        normalized === "referer" ||
        normalized === "accept" ||
        normalized === "accept-language"
      ) {
        headers[key] = value;
      }
    }
  }

  const cookieHeader = cookieJarToHeader(format?.cookies);
  if (cookieHeader) headers.Cookie = cookieHeader;

  return headers;
}

function mintAssetToken(url, headers = {}) {
  const payload = {
    url: String(url),
    expiresAt: Date.now() + STREAM_TOKEN_TTL_MS,
    headers,
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function parseAssetToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token), "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.url !== "string") return null;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function findThumbnailUrl(metadata) {
  if (typeof metadata?.thumbnail === "string" && /^https?:\/\//i.test(metadata.thumbnail)) {
    return metadata.thumbnail;
  }

  if (Array.isArray(metadata?.thumbnails)) {
    for (const thumb of metadata.thumbnails) {
      if (typeof thumb?.url === "string" && /^https?:\/\//i.test(thumb.url)) {
        return thumb.url;
      }
    }
  }

  return null;
}

function resolveThumbnailHeaders(metadata, sourceUrl) {
  const fromMetadata = getForwardableHeaders(metadata || {});
  if (Object.keys(fromMetadata).length) return fromMetadata;

  if (Array.isArray(metadata?.formats)) {
    for (const format of metadata.formats) {
      const headers = getForwardableHeaders(format || {});
      if (Object.keys(headers).length) return headers;
    }
  }

  const fallback = {};
  const platform = getPlatformFromUrl(sourceUrl || "");
  if (platform === "instagram") {
    fallback.Referer = "https://www.instagram.com/";
    fallback.Accept = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
  }
  return fallback;
}

function buildThumbnailProxyUrl(metadata, sourceUrl, baseUrl) {
  const thumbnail = findThumbnailUrl(metadata);
  if (!thumbnail) return null;

  const headers = resolveThumbnailHeaders(metadata, sourceUrl);
  const token = mintAssetToken(thumbnail, headers);
  return `${baseUrl}/api/thumb?t=${encodeURIComponent(token)}`;
}

function mintStreamToken(format, title) {
  const ext = guessExt(format);
  const filename = `${safeFilename(title)} ${safeFilename(getQualityLabel(format))}.${ext}`;
  const payload = {
    url: String(format.url),
    filename,
    expiresAt: Date.now() + STREAM_TOKEN_TTL_MS,
    headers: getForwardableHeaders(format),
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function parseStreamToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token), "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.url !== "string" || typeof payload.filename !== "string") return null;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function normalizeFormats(rawFormats, title, baseUrl) {
  if (!Array.isArray(rawFormats)) return [];

  const seen = new Set();

  return rawFormats
    .filter((format) => {
      if (!format || typeof format !== "object" || !format.format_id || !format.url) return false;
      if (format.vcodec === "none") return false;
      if (typeof format.url !== "string" || !/^https?:\/\//i.test(format.url)) return false;
      const protocol = String(format.protocol || "").toLowerCase();
      if (protocol.includes("m3u8")) return false;
      return true;
    })
    .sort((a, b) => (inferHeight(b) || 0) - (inferHeight(a) || 0))
    .filter((format) => {
      const key = `${getQualityLabel(format)}::${guessExt(format)}::${inferHeight(format) || "na"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((format) => ({
      format_id: String(format.format_id),
      ext: guessExt(format),
      quality: getQualityLabel(format),
      url: `${baseUrl}/api/stream?t=${encodeURIComponent(mintStreamToken(format, title))}`,
    }));
}

app.post("/api/download", async (req, res, next) => {
  try {
    const originalUrl = sanitizeUrl(req.body?.url);
    const normalizedUrl = getPlatformFromUrl(originalUrl) === "facebook" ? normalizeFacebookUrl(originalUrl) : originalUrl;
    let metadata;

    try {
      metadata = await runYtDlp(normalizedUrl, req.requestId);
    } catch (error) {
      // Retry Facebook once with the original URL if normalized URL fails.
      if (getPlatformFromUrl(originalUrl) === "facebook" && normalizedUrl !== originalUrl) {
        metadata = await runYtDlp(originalUrl, req.requestId);
      } else {
        throw error;
      }
    }
    const baseUrl = getPublicBaseUrl(req);

    res.status(200).json({
      platform: getPlatformFromUrl(originalUrl),
      title: metadata?.title || null,
      thumbnail: buildThumbnailProxyUrl(metadata, originalUrl, baseUrl),
      formats: normalizeFormats(metadata?.formats, metadata?.title || "video", baseUrl),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/thumb", async (req, res, next) => {
  try {
    const payload = parseAssetToken(req.query.t);
    if (!payload) {
      return res.status(404).json({ error: "invalid or expired thumbnail token" });
    }

    const headers = {
      ...(payload.headers || {}),
    };

    if (!Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")) {
      headers["User-Agent"] =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    }

    const upstream = await fetch(payload.url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!upstream.ok) {
      return res.status(502).json({ error: "thumbnail upstream error", status: upstream.status });
    }

    const contentType = upstream.headers.get("content-type");
    const contentLength = upstream.headers.get("content-length");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200);

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    if (error?.name === "TimeoutError") {
      return res.status(504).json({ error: "thumbnail request timed out" });
    }
    next(error);
  }
});

app.get("/api/stream", async (req, res, next) => {
  try {
    const token = req.query.t;
    const payload = parseStreamToken(token);

    if (!payload) {
      return res.status(404).json({ error: "invalid or expired token" });
    }

    const headers = {
      ...(payload.headers || {}),
    };

    if (!Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")) {
      headers["User-Agent"] =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    }

    if (!Object.keys(headers).some((key) => key.toLowerCase() === "accept")) {
      headers.Accept = "*/*";
    }

    const range = req.headers.range;
    if (range) headers.Range = range;

    const upstream = await fetch(payload.url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({ error: "upstream error", status: upstream.status });
    }

    const contentType = upstream.headers.get("content-type");
    const contentLength = upstream.headers.get("content-length");
    const acceptRanges = upstream.headers.get("accept-ranges");
    const contentRange = upstream.headers.get("content-range");

    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);
    if (contentRange) res.setHeader("Content-Range", contentRange);

    const asciiFilename = payload.filename.replace(/[^\x20-\x7E]+/g, "").replace(/"/g, "").trim() || "video.mp4";
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(payload.filename)}`
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.status(upstream.status === 206 ? 206 : 200);

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    if (error?.name === "TimeoutError") {
      return res.status(504).json({ error: "stream request timed out" });
    }
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

app.use((error, req, res, _next) => {
  const statusCode = Number(error.statusCode) || 500;
  const payload = {
    error: error.message || "internal server error",
  };

  if (error.details) {
    payload.details = error.details;
  }

  console.error(`[${req.requestId || "unknown"}]`, error);
  res.status(statusCode).json(payload);
});

const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

server.requestTimeout = REQUEST_TIMEOUT_MS + 5000;
server.headersTimeout = REQUEST_TIMEOUT_MS + 10000;
