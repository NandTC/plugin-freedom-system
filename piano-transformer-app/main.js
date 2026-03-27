/**
 * main.js — Electron main process for Piano Transformer
 *
 * Lifecycle:
 *   1. Spawn Python sidecar (--serve mode)
 *   2. Read SIDECAR_PORT:<port> from sidecar stdout
 *   3. Poll /health until model is ready
 *   4. Open BrowserWindow, pass port via IPC
 *   5. Handle file dialogs, generate, progress, save
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_WIDTH  = 640;
const WINDOW_HEIGHT = 560;

// In production: bundled env lives in app.getPath("userData") or resources/
// In dev: use the conda env directly
function getPythonPath() {
  if (app.isPackaged) {
    const condaEnv = path.join(process.resourcesPath, "resources", "python-env");
    return path.join(condaEnv, "bin", "python");
  }
  // Dev: conda env
  return "/opt/homebrew/Caskroom/miniconda/base/envs/piano_transformer/bin/python";
}

function getCheckpointDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "resources", "model-checkpoint");
  }
  return path.join(__dirname, "resources", "model-checkpoint");
}

function getSidecarPath() {
  return path.join(__dirname, "python", "sidecar.py");
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let mainWindow = null;
let sidecarProcess = null;
let sidecarPort = null;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers (Node built-in, no fetch needed)
// ─────────────────────────────────────────────────────────────────────────────

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function httpPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(bodyStr);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidecar lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function spawnSidecar() {
  const python = getPythonPath();
  const sidecar = getSidecarPath();
  const checkpointDir = getCheckpointDir();

  console.log("[main] Spawning sidecar:", python, sidecar);

  // Set PYTHONPATH to include our python/ dir
  const env = Object.assign({}, process.env, {
    PYTHONPATH: path.dirname(sidecar),
    TF_CPP_MIN_LOG_LEVEL: "3",
  });

  sidecarProcess = spawn(python, [sidecar, "--serve", "--checkpoint-dir", checkpointDir], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let resolved = false;

    sidecarProcess.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      console.log("[sidecar]", text.trim());

      if (!resolved) {
        const match = text.match(/SIDECAR_PORT:(\d+)/);
        if (match) {
          sidecarPort = parseInt(match[1], 10);
          resolved = true;
          resolve(sidecarPort);
        }
      }

      // Forward progress messages to renderer
      if (mainWindow) {
        mainWindow.webContents.send("sidecar-log", text.trim());
      }
    });

    sidecarProcess.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      // Only forward non-TF-noise stderr to console
      if (!text.includes("tensorflow") && !text.includes("WARNING") && !text.includes("Gym")) {
        console.error("[sidecar-err]", text.trim());
      }
    });

    sidecarProcess.on("error", (err) => {
      console.error("[main] Failed to spawn sidecar:", err.message);
      if (!resolved) reject(err);
    });

    sidecarProcess.on("exit", (code) => {
      console.log("[main] Sidecar exited with code", code);
      sidecarProcess = null;
    });

    // Timeout after 30s if no port printed
    setTimeout(() => {
      if (!resolved) {
        reject(new Error("Sidecar did not print SIDECAR_PORT within 30s"));
      }
    }, 30000);
  });
}

async function waitForModelReady(port, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await httpGet(port, "/health");
      if (res.status === "ready") return true;
    } catch (_) {
      // Not ready yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Model did not become ready within 2 minutes");
}

// ─────────────────────────────────────────────────────────────────────────────
// Window
// ─────────────────────────────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    resizable: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#FFFFFF",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));

  // Open DevTools for debugging (remove before release)
  mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC handlers
// ─────────────────────────────────────────────────────────────────────────────

// Renderer asks for sidecar port (sent after window load)
ipcMain.handle("get-port", () => sidecarPort);

// Open MIDI file dialog
ipcMain.handle("open-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Seed MIDI",
    filters: [{ name: "MIDI Files", extensions: ["mid", "midi"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Save generated MIDI
ipcMain.handle("save-file", async (_event, sourcePath) => {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save Generated MIDI",
    defaultPath: path.join(app.getPath("downloads"), "piano-transformer-output.mid"),
    filters: [{ name: "MIDI Files", extensions: ["mid"] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.copyFileSync(sourcePath, result.filePath);
  return result.filePath;
});

// Read a file as base64 (for in-app MIDI playback)
ipcMain.handle("read-file", async (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).toString("base64");
});

// POST /generate
ipcMain.handle("generate", async (_event, params) => {
  if (!sidecarPort) throw new Error("Sidecar not ready");
  return await httpPost(sidecarPort, "/generate", params);
});

// GET /progress
ipcMain.handle("get-progress", async () => {
  if (!sidecarPort) return { status: "loading", percent: 0 };
  return await httpGet(sidecarPort, "/progress");
});

// POST /cancel
ipcMain.handle("cancel", async () => {
  if (!sidecarPort) return;
  return await httpPost(sidecarPort, "/cancel", {});
});

// ─────────────────────────────────────────────────────────────────────────────
// App lifecycle
// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Create window immediately (shows "Loading…" state)
  await createWindow();

  // Spawn sidecar in background
  try {
    const port = await spawnSidecar();
    console.log("[main] Sidecar port:", port);

    // Notify renderer the sidecar is alive (model still loading)
    mainWindow?.webContents.send("sidecar-port", port);

    // Wait for model to finish loading
    await waitForModelReady(port);
    mainWindow?.webContents.send("model-ready");

  } catch (err) {
    console.error("[main] Sidecar startup failed:", err.message);
    mainWindow?.webContents.send("sidecar-error", err.message);
  }
});

app.on("window-all-closed", () => {
  if (sidecarProcess) {
    sidecarProcess.kill("SIGTERM");
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on("before-quit", () => {
  if (sidecarProcess) {
    sidecarProcess.kill("SIGTERM");
  }
});
