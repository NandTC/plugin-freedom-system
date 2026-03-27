/**
 * preload.js — Electron context bridge
 *
 * Exposes a minimal, typed API to the renderer via window.electronAPI.
 * All IPC goes through this bridge — the renderer never touches Node directly.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Sidecar lifecycle events
  onSidecarPort:  (fn) => ipcRenderer.on("sidecar-port",  (_e, port)  => fn(port)),
  onModelReady:   (fn) => ipcRenderer.on("model-ready",   ()          => fn()),
  onSidecarLog:   (fn) => ipcRenderer.on("sidecar-log",   (_e, msg)   => fn(msg)),
  onSidecarError: (fn) => ipcRenderer.on("sidecar-error", (_e, msg)   => fn(msg)),

  // File operations
  openFile:    ()           => ipcRenderer.invoke("open-file"),
  saveFile:    (srcPath)    => ipcRenderer.invoke("save-file", srcPath),
  readFile:    (filePath)   => ipcRenderer.invoke("read-file", filePath),

  // Generation
  generate:    (params)     => ipcRenderer.invoke("generate", params),
  getProgress: ()           => ipcRenderer.invoke("get-progress"),
  cancel:      ()           => ipcRenderer.invoke("cancel"),
});
