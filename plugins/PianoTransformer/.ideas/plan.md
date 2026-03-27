# PianoTransformer - Implementation Plan

<!-- Stage: 0 (Research & Planning) -->
<!-- Generated: 2026-03-27 -->
<!-- Type: Standalone Electron + Python Sidecar Desktop App -->

---

## 1. Complexity Assessment

### Parameter Score

```
Parameters: 4 (temperature, sequenceLength, primerLength, tempo)
param_score = min(4 / 5, 2.0) = 0.8
```

### Algorithm / Component Score

Core system components requiring non-trivial implementation:

| Component | Score | Justification |
|-----------|-------|--------------|
| TF/Magenta model loading + inference | +1.0 | ML inference pipeline, version-sensitive |
| Primer MIDI encoding (NoteSequence pipeline) | +1.0 | Non-trivial encoding/decoding, Magenta API |
| Electron ↔ Python IPC (Flask + child_process) | +1.0 | Cross-process communication with async progress |
| Python environment bundling (conda-pack + checkpoint) | +1.0 | Distribution engineering, multi-platform |
| MIDI file I/O + in-app playback | +0.5 | MIDI parsing/write + Web Audio |

**algorithm_count = 4.5**

### Complexity Features

| Feature | Score | Present |
|---------|-------|---------|
| Long-running async operations | +1.0 | Yes — inference 15-180s, progress reporting required |
| Cross-process communication | +0.5 | Yes — Electron spawns Python, HTTP IPC |
| Large binary distribution (2GB+) | +0.5 | Yes — TF env + model checkpoint |
| Platform-specific bundling | +0.5 | Yes — Mac arm64/x86, Windows |

**feature_count = 2.5**

### Total Score

```
raw_score = param_score + algorithm_count + feature_count
          = 0.8 + 4.5 + 2.5
          = 7.8
final_score = min(7.8, 5.0) = 5.0
```

**Complexity Score: 5.0 / 5.0 — Maximum Complexity**
**Complexity Tier: 6 (ML app with file I/O, multi-process architecture, distribution engineering)**
**Research Depth Applied: DEEP**

---

## 2. Implementation Strategy

**Strategy: Phase-based implementation**

With a complexity score of 5.0, this project requires careful phase breakdown. The main risk is building too much before validating the Python inference layer — which is the highest-risk component. The plan front-loads the Python sidecar work to fail fast on the hardest problem.

**Key principle:** Get the Python script generating MIDI from the command line FIRST, before touching Electron. Every subsequent phase builds on a proven foundation.

**Duration estimate:** 3-5 days of focused work (depending on TF/Magenta version issues)

---

## 3. Phase Breakdown

### Phase 1: Python Sidecar — Standalone CLI (Day 1-2)

**Goal:** A working `sidecar.py` that generates piano MIDI from the command line with no Electron involved.

**Deliverables:**
- `python/sidecar.py` — CLI entry point
- `python/requirements.txt` — pinned dependencies
- `python/generate.py` — core generation module
- `python/midi_utils.py` — MIDI read/write helpers
- `python/README.md` — setup instructions for the environment

**Tasks:**
1. Set up conda environment: `conda create -n piano_transformer python=3.10`
2. Install and verify: `pip install magenta==2.1.4 tensorflow==2.9.1 note_seq flask pretty_midi`
3. Download model checkpoint from GCS to `resources/model-checkpoint/`
4. Implement `generate.py`:
   - Load checkpoint via Magenta score2perf API
   - Unconditional generation (no primer) with temperature + sequence_length
   - Return NoteSequence → write .mid
5. Implement `midi_utils.py`:
   - `read_primer_midi(path, primer_length)` → token list
   - `write_midi(note_sequence, output_path, tempo)` → .mid file
6. Implement `sidecar.py` with CLI args:
   - `--temperature FLOAT`
   - `--sequence-length INT`
   - `--primer-length INT`
   - `--primer-midi PATH` (optional)
   - `--tempo INT`
   - `--output PATH`
7. Test: `python sidecar.py --temperature 1.0 --sequence-length 512 --output test.mid`
8. Test with primer: `python sidecar.py --primer-midi seed.mid --primer-length 64 --output continuation.mid`

**Test criteria:**
- [ ] `python sidecar.py` generates a valid .mid file in under 3 minutes on CPU
- [ ] Generated .mid opens in a DAW and contains recognizable piano notes
- [ ] Primer continuation mode sounds like it continues from the seed
- [ ] temperature=0.1 produces noticeably more repetitive output than temperature=1.8
- [ ] No TensorFlow import errors or runtime crashes

**Risk checkpoint:** If TF/Magenta version conflicts cannot be resolved in Phase 1, evaluate PyTorch alternatives (chathasphere/pno-ai, spectraldoy/music-transformer). This is the decision gate.

**Git commit:** `feat: PianoTransformer Phase 1 — Python sidecar CLI working`

---

### Phase 2: Flask IPC Layer (Day 2-3)

**Goal:** Wrap the sidecar in a Flask HTTP server so Electron can drive it asynchronously with progress reporting.

**Deliverables:**
- `python/server.py` — Flask HTTP server wrapping generate.py
- Updated `python/sidecar.py` — starts Flask server, prints port to stdout
- `python/progress.py` — thread-safe progress tracker

**Tasks:**
1. Add Flask to sidecar:
   ```python
   from flask import Flask, request, jsonify
   app = Flask(__name__)
   ```
2. Implement `POST /generate` endpoint:
   - Accepts JSON: `{temperature, sequenceLength, primerLength, primerMidiBase64, tempo}`
   - Decodes base64 primer MIDI to temp file if provided
   - Starts inference in background thread
   - Returns `{"status": "started"}`
3. Implement `GET /status` endpoint:
   - Returns `{"status": "idle|loading|generating|done|error", "percent": N, "outputMidi": base64string|null}`
4. Implement `POST /cancel` endpoint
5. Implement progress tracker:
   - Background thread updates `progress.percent` during generation
   - Since TF generation is a single blocking call, progress is estimated (0%→90% linearly, 100% on done)
6. Print port to stdout on startup: `{"type":"ready","port":PORT}`
7. Test with curl:
   - `curl -X POST http://localhost:PORT/generate -d '{"temperature":1.0,"sequenceLength":256}' -H 'Content-Type: application/json'`
   - Poll `GET /status` until done
   - Verify outputMidi base64 decodes to valid .mid

**Test criteria:**
- [ ] Flask server starts and prints port to stdout
- [ ] POST /generate returns 200 immediately (non-blocking)
- [ ] GET /status transitions through loading → generating → done
- [ ] Output MIDI base64 decodes to valid .mid file
- [ ] App handles concurrent /status polls without crashing
- [ ] Cancel endpoint stops generation (best effort — TF may not cancel cleanly)

**Git commit:** `feat: PianoTransformer Phase 2 — Flask IPC server`

---

### Phase 3: Electron Shell (Day 3-4)

**Goal:** Full working app — Electron UI drives Python sidecar via IPC, all features wired.

**Deliverables:**
- `main.js` — Electron main process with sidecar management
- `src/index.html` — UI based on v3 mockup
- `src/css/styles.css` — Swiss Minimal styles
- `src/js/app.js` — UI logic, state machine, IPC calls
- `package.json` — Electron project config

**Tasks:**

**main.js:**
1. Spawn Python sidecar on app start:
   ```javascript
   const sidecar = child_process.spawn(pythonExePath, [sidecarPath]);
   sidecar.stdout.on('data', (data) => {
     const msg = JSON.parse(data.toString());
     if (msg.type === 'ready') sidecarPort = msg.port;
   });
   ```
2. Implement IPC handlers:
   - `ipcMain.handle('generate', ...)` → POST to Flask /generate
   - `ipcMain.handle('poll-status', ...)` → GET /status
   - `ipcMain.handle('export-midi', ...)` → save dialog (reuse JazzGptMidi pattern)
   - `ipcMain.handle('open-midi-file', ...)` → open dialog for seed MIDI
3. Kill sidecar on app quit: `app.on('quit', () => sidecar.kill())`

**src/index.html + styles.css:**
1. Implement layout from v3-ui.yaml exactly:
   - Header: "Piano Transformer" + subtitle
   - Dropzone: 584×60, dashed inner border, empty/loaded states
   - 4 sliders: temperature, sequenceLength, primerLength, tempo
   - 3 buttons: Play (102px), Generate (272px), Download (194px)
   - Status bar: 12px gray text
2. Swiss Minimal styles: black/white, border-radius: 0, no shadows

**src/js/app.js:**
1. Implement app state machine: idle → loading → generating → done/error
2. Dropzone drag/drop:
   - Accept .mid files only
   - Show filename on load, × to clear
   - Store file path for primer
3. Slider binding:
   - Live value display on right side of each slider
   - Values persist as app state
4. Generate button:
   - On click: read all slider values + primer file path
   - Call `ipcRenderer.invoke('generate', params)`
   - Start polling status every 500ms
   - Update status bar: "Generating... N%"
5. Download button:
   - Enabled only when `appState === 'done'`
   - On click: `ipcRenderer.invoke('export-midi', midiBytes)`
6. Play button:
   - Parse stored MIDI bytes with `@tonejs/midi`
   - Play with soundfont-player at tempo param value
   - Toggle to Stop

**Test criteria:**
- [ ] App window opens at 640×560, not resizable
- [ ] Drag .mid onto dropzone shows filename
- [ ] All 4 sliders display correct values as they move
- [ ] Clicking Generate shows "Loading model..." then "Generating... N%"
- [ ] Generation completes and Download button becomes active
- [ ] Download saves valid .mid file
- [ ] Play button plays generated MIDI at correct tempo
- [ ] App gracefully handles sidecar crash (shows error in status bar)

**Git commit:** `feat: PianoTransformer Phase 3 — Electron shell wired`

---

### Phase 4: Bundling and Distribution (Day 4-5)

**Goal:** Distributable app that runs on a clean Mac without any Python or Conda installed.

**Deliverables:**
- `scripts/build-env.sh` — creates and packs conda environment
- `scripts/download-model.sh` — downloads model checkpoint to resources/
- `scripts/build.sh` — full build pipeline
- Updated `package.json` — electron-builder config with extraResources
- `dist/PianoTransformer-1.0.0-mac.dmg` — working distributable

**Tasks:**

**Python environment packaging:**
1. Create reference conda environment on build machine:
   ```bash
   conda create -n piano_transformer python=3.10
   pip install magenta==2.1.4 tensorflow==2.9.1 flask note_seq pretty_midi
   ```
2. Pack environment:
   ```bash
   conda-pack -n piano_transformer -o resources/python-env.tar.gz
   ```
3. Unpack to `resources/python-env/` (committed directory, not tarball)

**Model checkpoint:**
1. Write `scripts/download-model.sh`:
   ```bash
   MODEL_DIR="resources/model-checkpoint"
   gsutil -m cp "gs://magentadata/models/music_transformer/checkpoints/unconditional_model_16.ckpt*" $MODEL_DIR/
   ```
2. Add `resources/model-checkpoint/` to `.gitignore` (too large for git)
3. Document in README: run `./scripts/download-model.sh` before building

**Electron-builder config:**
```json
"extraResources": [
  { "from": "resources/python-env", "to": "python-env" },
  { "from": "resources/model-checkpoint", "to": "model-checkpoint" },
  { "from": "python/sidecar.py", "to": "sidecar.py" },
  { "from": "python/generate.py", "to": "generate.py" },
  { "from": "python/midi_utils.py", "to": "midi_utils.py" },
  { "from": "python/server.py", "to": "server.py" }
]
```

**Path resolution in main.js:**
```javascript
// In packaged app, resources are at process.resourcesPath
const pythonBin = path.join(process.resourcesPath, 'python-env', 'bin', 'python');
const sidecarScript = path.join(process.resourcesPath, 'sidecar.py');
const modelDir = path.join(process.resourcesPath, 'model-checkpoint');
```

**macOS notarization:**
- Reuse JazzGptMidi's entitlements.plist (already includes disable-library-validation)
- Add `signingIdentity` to electron-builder config
- Run `npm run build:mac` → triggers notarization via electron-builder

**Test criteria:**
- [ ] `npm run build:mac` completes without errors
- [ ] Built .dmg mounts and installs without Gatekeeper warnings
- [ ] App launches on clean Mac (no Python or Conda installed)
- [ ] Sidecar starts successfully from bundled python-env
- [ ] Model loads from bundled resources/model-checkpoint
- [ ] Full generation cycle works in bundled app
- [ ] App quits cleanly (no zombie processes)

**Git commit:** `feat: PianoTransformer Phase 4 — bundling and distribution`

---

## 4. Stage Breakdown

| Stage | Description | Owner | Status |
|-------|-------------|-------|--------|
| Stage 0 | Research & Planning | research-planning-agent | Complete |
| Phase 1 | Python sidecar CLI | dsp-agent (adapted) | Pending |
| Phase 2 | Flask IPC server | dsp-agent | Pending |
| Phase 3 | Electron shell + UI | gui-agent (adapted) | Pending |
| Phase 4 | Bundling + distribution | dsp-agent | Pending |

---

## 5. Key Risks Summary

| Risk | Severity | Mitigation | Decision Gate |
|------|----------|------------|---------------|
| TF/Magenta version conflicts | HIGH | Pin versions, test in Phase 1 | Phase 1 is the gate — fail fast |
| Distribution size (2GB+) | HIGH | Separate model download from app | Design decision in Phase 4 |
| PyInstaller TF incompatibility | MEDIUM-HIGH | Use conda-pack instead | Resolved by architecture decision |
| macOS notarization with Python dylibs | MEDIUM | Reuse JazzGptMidi entitlements | Low risk given prior art |
| Cold start UX (10-30s model load) | MEDIUM | Eager pre-warm + clear status messaging | UX polish in Phase 3 |
| Apple Silicon vs x86 env | MEDIUM | Build separate conda-pack per arch | Phase 4 testing |

---

## 6. Implementation Notes

### Dependencies to Install (Python)

```
magenta==2.1.4
tensorflow==2.9.1          # pinned — newer versions may break Magenta
tensorflow-macos==2.9.0    # Apple Silicon only
note_seq==0.0.5
pretty_midi==0.2.10
flask==2.3.3
```

### Dependencies to Install (Node.js)

```
electron==28.x             # same as JazzGptMidi
electron-builder==24.x     # same as JazzGptMidi
@tonejs/midi==2.0.28       # same as JazzGptMidi
soundfont-player==0.12.0   # same as JazzGptMidi
```

### File Structure

```
PianoTransformer/
  main.js                        ← Electron main process
  package.json                   ← Electron project + build config
  entitlements.plist             ← macOS notarization (reuse JazzGptMidi)
  src/
    index.html                   ← UI
    css/styles.css               ← Swiss Minimal styles
    js/app.js                    ← UI logic + state machine
  python/
    sidecar.py                   ← Entry point: starts Flask, prints port
    generate.py                  ← Magenta inference core
    midi_utils.py                ← Read primer .mid, write output .mid
    server.py                    ← Flask HTTP server + endpoints
    progress.py                  ← Thread-safe progress tracking
    requirements.txt             ← Pinned Python deps
  resources/
    model-checkpoint/            ← Git-ignored; download via script
      checkpoint
      unconditional_model_16.ckpt.data-*
      unconditional_model_16.ckpt.index
      unconditional_model_16.ckpt.meta
    python-env/                  ← Git-ignored; built via conda-pack
  scripts/
    download-model.sh            ← Fetch checkpoint from GCS
    build-env.sh                 ← Create and pack conda environment
    build.sh                     ← Full build pipeline
  assets/
    icon.icns                    ← macOS icon
    icon.ico                     ← Windows icon
  .ideas/
    creative-brief.md
    architecture.md
    plan.md
    mockups/
```

### TensorFlow Version Note

The Magenta Music Transformer (piano_transformer) was developed against TF 1.x/2.x compat mode. Use TF 2.9.x for best compatibility. TF 2.13+ dropped `tf.compat.v1` session-based APIs that Magenta internally uses. Do not upgrade past 2.12 without testing.

For Apple Silicon: use `tensorflow-macos` + `tensorflow-metal` (both in the `apple` conda channel). The conda environment must be built natively on arm64 — no Rosetta.

### Model Checkpoint Details

- GCS path: `gs://magentadata/models/music_transformer/checkpoints/unconditional_model_16.ckpt`
- Files to download: `.data-00000-of-00001`, `.index`, `.meta` + `checkpoint` config file
- Total size: ~1.5GB
- Alternative checkpoint: `melody_conditioned_model_16.ckpt` (not used in Phase 1, potential future feature)

### Progress Simulation Strategy

Since Magenta's transformer calls a single TF operation for the full sequence, true token-by-token progress isn't easily accessible. Use a time-based linear estimate:
- Start timer when generation begins
- Estimate total time based on sequenceLength (empirical: ~0.3s/token on CPU)
- Report `percent = min(elapsed / estimated_total * 100, 95)`
- Jump to 100% when done
- Show "Generating... N%" in status bar (matches mockup)
