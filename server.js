const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 25000;
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";

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

function escapeShellArg(value) {
  return `"${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
}

function runYtDlp(url, requestId) {
  const command = `${YTDLP_BIN} -j --no-playlist --no-warnings --socket-timeout 15 ${escapeShellArg(url)}`;
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

function normalizeFormats(rawFormats) {
  if (!Array.isArray(rawFormats)) return [];

  return rawFormats
    .filter((format) => format && typeof format === "object" && format.format_id && format.url)
    .map((format) => ({
      format_id: String(format.format_id),
      ext: format.ext || null,
      quality:
        format.format_note ||
        format.resolution ||
        (format.height ? `${format.height}p` : null) ||
        format.format ||
        "unknown",
      url: String(format.url),
    }));
}

app.post("/api/download", async (req, res, next) => {
  try {
    const url = sanitizeUrl(req.body?.url);
    const metadata = await runYtDlp(url, req.requestId);

    res.status(200).json({
      title: metadata?.title || null,
      thumbnail: metadata?.thumbnail || null,
      formats: normalizeFormats(metadata?.formats),
    });
  } catch (error) {
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

