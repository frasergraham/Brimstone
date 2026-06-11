// Preload for Caleb's Studio — exposes a minimal, repo-confined filesystem
// bridge to the admin tools running in the renderer. Every path is resolved
// against (and confined to) the selected repository root in the main process
// (see studio-main.js resolveInRepo). The tools feature-detect window.studioAPI
// and, when present, write straight to disk instead of triggering a browser
// download.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioAPI', {
  // Repo root management
  getRepoRoot:    ()         => ipcRenderer.invoke('studio:get-repo-root'),
  chooseRepoRoot: ()         => ipcRenderer.invoke('studio:choose-repo-root'),

  // Repo-relative filesystem primitives. Paths may be "/src/x", "src/x", or
  // "./src/x"; all resolve under the repo root. Each returns a result object
  // ({ ok, ... }) rather than throwing so callers can show a status line.
  readFile:  (rel)        => ipcRenderer.invoke('studio:read-file', rel),
  writeFile: (rel, text)  => ipcRenderer.invoke('studio:write-file', rel, text),
  listDir:   (rel)        => ipcRenderer.invoke('studio:list-dir', rel),
  exists:    (rel)        => ipcRenderer.invoke('studio:exists', rel),
});
