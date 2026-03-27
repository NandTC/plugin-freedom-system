# PianoTransformer - Architecture Specification

<!-- CONTRACT STATUS -->
<!-- Stage: 0 (Research & Planning) -->
<!-- Generated: 2026-03-27 -->
<!-- Type: Standalone Electron + Python Sidecar Desktop App -->
<!-- NOT a JUCE audio plugin — no VST/AU, no audio processing chain -->

---

## 1. Core Components

### Component Overview

| Component | Technology | Responsibility |
|-----------|-----------|---------------|
| Electron Shell | Electron 28+, Node.js | Window, IPC, file dialogs, save/open |
| Renderer UI | HTML/CSS/JS (vanilla) | Sliders, dropzone, buttons, status bar |
| IPC Bridge | Electron ipcMain/ipcRenderer | Relay messages between UI and main process |
| Python Sidecar | Python 3.10, TF 2.x, Magenta | Model loading, inference, MIDI I/O |
| Piano Transformer Model | TF checkpoint (Magenta score2perf) | Autoregressive piano token generation |
| MIDI I/O Layer | pretty_midi / note_seq | Read primer .mid, write output .mid |
| Python Bundler | conda-pack or python-build-standalone | Portable Python env for distribution |
| Model Checkpoint | ~1.5GB TF SavedModel / ckpt files | Weights for unconditional piano generation |

---

## 2. Processing Chain / Signal Flow

```
User sets params (temperature, sequenceLength, primerLength, tempo)
       │
User optionally drops seed .mid into dropzone
       │
User clicks "Generate"
       │
       ▼
Electron renderer → ipcRenderer.invoke('generate', params)
       │
       ▼
Electron main (main.js)
  - Resolves path to Python sidecar executable
  - Resolves path to model checkpoint directory
  - Spawns child_process: sidecar --params JSON
       │
       ▼
Python sidecar (sidecar.py / sidecar binary)
  [STARTUP — once per process lifetime]
  - Imports TensorFlow, Magenta (slow: 10-30s cold start)
  - Loads unconditional piano_transformer checkpoint
  - Signals "ready" via stdout JSON line

  [GENERATION REQUEST]
  - Reads params from stdin JSON or argv
  - If primer_midi_path provided: reads .mid → NoteSequence primer
  - Trims primer to primerLength tokens
  - Calls score2perf.generate() or transformer_generate()
    with temperature + sequenceLength
  - Streams progress: {"type":"progress","percent":N} per token batch
  - On completion: writes output .mid to temp path
  - Signals done: {"type":"done","output_path":"/tmp/pt_output.mid"}
       │
       ▼
Electron main receives "done" JSON line
  - Reads output .mid bytes from temp path
  - Returns bytes buffer to renderer via ipcRenderer
       │
       ▼
Renderer:
  - Enables "Download" button
  - On "Download" click: ipcMain dialog.showSaveDialog → writes .mid
  - On "Play" click: loads .mid into @tonejs/midi → plays via Web Audio API
```

---

## 3. System Architecture

### 3.1 Electron Shell

**Pattern (reference: JazzGptMidi main.js)**

- `BrowserWindow`: 640×560, resizable: false, nodeIntegration: true, contextIsolation: false (matches JazzGptMidi pattern)
- `ipcMain.handle('generate', ...)`: spawns Python sidecar with generation params
- `ipcMain.handle('export-midi', ...)`: save dialog → writes bytes buffer (identical to JazzGptMidi pattern)
- `ipcMain.handle('open-midi-file', ...)`: open dialog for seed MIDI
- Shell manages the Python process lifecycle (spawn on first generate, keep-alive option, kill on app quit)

**Key deviation from JazzGptMidi:** JazzGptMidi is pure JS with no Python. PianoTransformer adds a `child_process.spawn` call in main.js to launch the Python sidecar.

### 3.2 IPC Pattern: Local HTTP (Flask) vs. stdin/stdout

**Decision: Local HTTP (Flask on localhost)**

Rationale:
- Inference is long-running (15-120s depending on sequenceLength)
- Flask allows easy progress SSE (Server-Sent Events) or polling endpoint
- Flask makes it trivial to pass complex JSON params (no arg-length limits)
- Flask is battle-tested for Electron+Python (many reference implementations)
- stdin/stdout is simpler but progress streaming is awkward with buffering issues

**Architecture:**
```
Electron main.js
  spawns → python sidecar → starts Flask on localhost:PORT (random port to avoid conflicts)
  signals ready → sidecar prints {"type":"ready","port":PORT} to stdout
  Electron reads that one stdout line → stores PORT
  All subsequent communication → HTTP to localhost:PORT
```

**Flask endpoints:**
- `POST /generate` — body: `{temperature, sequenceLength, primerLength, primerMidiBase64, tempo}` → returns 200 when queued
- `GET /status` — returns `{status: "idle|generating|done|error", percent: N, outputMidi: base64string}`
- `POST /cancel` — stops current generation

**Port selection:** Flask binds to port 0 (OS-assigned) and prints the actual port to stdout. Electron reads it once on startup.

**Fallback architecture (if Flask proves too complex for bundling):**
Use stdin/stdout with JSON Lines protocol. Python flushes after every print. Electron listens on `childProcess.stdout.on('data', ...)`. Progress lines: `{"type":"progress","percent":N}`. Each approach works; Flask is preferred for robustness.

### 3.3 Python Sidecar — Inference Engine

**Entry point:** `sidecar.py`

**Startup sequence:**
1. Import TensorFlow, Magenta, pretty_midi (cold: 10-30s)
2. Load piano_transformer checkpoint via Magenta's `score2perf` or `music_transformer` API
3. Print `{"type":"ready","port":PORT}` to stdout
4. Start Flask server, block on `app.run()`

**Generation:**
```python
from magenta.models.score2perf import score2perf
import note_seq

# Unconditional generation from scratch
generated = model.generate(
    targets=primer_tokens,          # [] if no primer
    decode_length=sequence_length,
    temperature=temperature
)

# Convert event tokens → NoteSequence
ns = encoder.decode(generated)

# Write .mid
note_seq.sequence_proto_to_midi_file(ns, output_path)
```

**Primer MIDI handling:**
```python
import note_seq
primer_ns = note_seq.midi_file_to_note_sequence(primer_midi_path)
# Trim to primerLength tokens via encoder
encoder = score2perf.AbsoluteMidiEncoder()  # or PianoPerformanceLanguageModelConfig
primer_tokens = encoder.encode_note_sequence(primer_ns)[:primer_length]
```

**Progress reporting during generation:**
Magenta's transformer uses TensorFlow sampling which is a single blocking call. To get progress, either:
- Option A: Run generation in a background thread; Flask /status polls a shared state variable
- Option B: Chunk generation — generate in blocks of N tokens, updating progress between chunks (requires custom generate loop, moderate complexity)
- **Recommended: Option A** — simpler, no custom loop needed

### 3.4 MIDI File I/O

**Reading seed MIDI:**
- Electron renderer: dragover/drop on dropzone div → reads file path
- Main process: passes absolute path to Python sidecar in `/generate` request body
- Python: `note_seq.midi_file_to_note_sequence(path)` → NoteSequence proto
- Library: `note_seq` (part of Magenta) and/or `pretty_midi`

**Writing output MIDI:**
- Python: `note_seq.sequence_proto_to_midi_file(ns, temp_path)`
- Python returns base64-encoded bytes to Flask response OR writes to temp path and returns path
- Electron main: reads bytes → passes to renderer
- Renderer: stores ArrayBuffer → on Download, calls `ipcRenderer.invoke('export-midi', ...)`
- Library: `note_seq` (Magenta) handles all NoteSequence → MIDI conversion

**Playback in Electron renderer:**
- Library: `@tonejs/midi` (same as JazzGptMidi) — parses .mid bytes in renderer
- Audio: Web Audio API via Soundfont player (same as JazzGptMidi)
- Tempo parameter: applied to playback speed, also embedded in output .mid

### 3.5 Python Environment Bundling

**Challenge:** Distributing ~2-3GB Python environment (Python runtime + TF + Magenta + model checkpoint) cross-platform.

**Recommended approach: conda-pack**

Rationale:
- Creates a portable, relocatable conda environment archive
- Better handles binary extension modules (TF, NumPy) than PyInstaller
- Can be unpacked into `resources/python-env/` in the Electron app bundle
- Avoids PyInstaller's known issues with TF (ModuleNotFoundError for tensorflow_core)
- Used successfully by TransformerLab (LLM Electron app with PyTorch)

**Build process:**
```bash
# Create conda env with correct Python version
conda create -n piano_transformer python=3.10
conda activate piano_transformer
pip install magenta tensorflow note_seq pretty_midi flask

# Pack the environment
conda-pack -n piano_transformer -o resources/python-env-mac.tar.gz

# In Electron app: unpack on first launch
# resources/python-env/ → resources/python-env/bin/python
```

**Alternative: PyInstaller (simpler but riskier)**
- PyInstaller bundles sidecar.py into a single binary
- Known issues with TF hidden imports require: `--hidden-import=tensorflow --collect-all tensorflow`
- Produces ~500MB binary (TF + Magenta) without checkpoint (~1.5GB stored separately)
- Risk: TF dynamic library loading at runtime often fails with PyInstaller
- Fallback only if conda-pack proves unworkable

**Alternative: python-build-standalone (Simon Willison approach)**
- Downloads prebuilt CPython into `resources/python/`
- Runs `pip install` on first launch to install deps
- Simple, but requires internet on first run — conflicts with "no internet" requirement
- Not suitable for offline-first distribution

**Model checkpoint storage:**
- Checkpoint stored at: `resources/model-checkpoint/` inside Electron bundle
- Files: `checkpoint`, `model.ckpt-0.data-00000-of-00001`, `model.ckpt-0.index`, `model.ckpt-0.meta`
- Total size: ~1.5GB
- Download: fetched from `gs://magentadata/models/music_transformer/checkpoints/` during build, NOT bundled in repo
- Build script (`scripts/download-model.sh`) downloads checkpoint into `resources/model-checkpoint/`
- Electron main: passes `resources/model-checkpoint/` absolute path to Python sidecar at runtime

### 3.6 UI State Management

**States:**
- `idle`: sliders active, Generate enabled, Download disabled, Play disabled
- `loading-model`: "Loading model... this may take 30 seconds" in status bar (first run)
- `generating`: Generate button disabled, spinner or progress %, Download disabled
- `done`: Download enabled, Play enabled, status "Ready"
- `error`: status bar shows error message, Generate re-enabled

**State machine (renderer JS):**
```javascript
let appState = 'idle';
let generatedMidiBuffer = null;

// Transitions: idle → loading-model → idle → generating → done/error → idle
```

**Progress bar:** Status line text shows "Generating... 42%" — updated via polling `/status` every 500ms during generation. No visual progress bar (Swiss Minimal aesthetic — text only per mockup).

### 3.7 macOS Notarization

**Based on JazzGptMidi pattern:**
- `hardenedRuntime: true`
- Entitlements required for Python subprocess:
  - `com.apple.security.cs.allow-jit: true`
  - `com.apple.security.cs.allow-unsigned-executable-memory: true`
  - `com.apple.security.cs.disable-library-validation: true` — REQUIRED for bundled Python dylibs
  - `com.apple.security.network.client: true` — required for localhost Flask communication

**Critical:** `disable-library-validation` is essential when bundling external Python dylibs (TF, NumPy). JazzGptMidi's entitlements.plist already includes this. Same plist can be reused.

**Windows:** No notarization required; electron-builder NSIS installer handles code signing optionally.

---

## 4. Parameter Mapping

| UI Parameter | Python Arg | Type | Range | Default | Notes |
|-------------|-----------|------|-------|---------|-------|
| temperature | `temperature` | float | 0.1 – 2.0 | 1.0 | Passed directly to model.generate() |
| sequenceLength | `decode_length` | int | 128 – 2048 | 512 | Number of event tokens to generate |
| primerLength | `primer_length` | int | 0 – 512 | 64 | Tokens from primer sequence to use as context |
| tempo | `tempo` | int | 40 – 200 | 120 | Embedded in output .mid tempo map; used for playback |
| (implicit) | `primer_midi_path` | str | n/a | null | Absolute path to dropped seed .mid file |

**Token vs. note distinction:**
The Magenta Performance encoding uses "event tokens" — a mix of NOTE_ON, NOTE_OFF, TIME_SHIFT, and VELOCITY change events. One note typically generates 2-3 tokens. 512 tokens ≈ 30-60 seconds of piano music depending on density.

---

## 5. Algorithm Details

### 5.1 Piano Transformer Inference

**Model:** Unconditional piano_transformer (score2perf `AbsoluteMidi` vocabulary, unconditioned variant)

**Architecture:**
- Transformer decoder (attention-based autoregressive)
- Trained on MAESTRO dataset (classical piano performances)
- Vocabulary: ~310 tokens (88 MIDI notes × on/off, 100 time-shift bins, 32 velocity bins)
- Context window: 2048 tokens

**Generation algorithm (autoregressive sampling):**
```
FOR i in range(decode_length):
    logits = transformer_forward(context + generated_so_far)
    logits = logits / temperature
    next_token = categorical_sample(softmax(logits))
    generated_so_far.append(next_token)
    IF next_token == EOS: break
```

**Key API (Magenta's score2perf):**
```python
from magenta.models.score2perf import score2perf

# Config
config = score2perf.AbsoluteMidiConfig()
problem = score2perf.AbsoluteMidiAbsPitchVelocityDurationChordProblem()

# Load model from checkpoint
estimator = score2perf.build_estimator(config, checkpoint_dir)

# Generate
generated_ids = score2perf.generate(
    estimator,
    primer_ids=primer_tokens,
    decode_length=sequence_length,
    temperature=temperature
)
```

**Alternative lower-level approach (if score2perf API proves brittle):**
Use `tensor2tensor` `Estimator.predict()` directly, which is what the Colab notebook does. The Colab calls `unconditional_samples = unconditional_generate(targets=[], decode_length=1024)` — a thin wrapper around the TF estimator.

### 5.2 Primer MIDI Encoding

**Flow:**
1. Read .mid file with `note_seq.midi_file_to_note_sequence(path)` → protobuf NoteSequence
2. Encode to event token IDs: `encoder = note_seq.encoder_decoder.MusicEncoderDecoder()` or Performance RNN encoder
3. Take `tokens[:primer_length]` as context window
4. Feed into generation as `targets` parameter (primer_ids)

**Risk:** If primerLength = 0, pass empty list `[]` — unconditional generation from scratch.

### 5.3 MIDI Output Generation

**Flow:**
1. Generation returns list of integer token IDs
2. Decode: `ns = encoder.decode_ids(generated_ids)` → NoteSequence proto
3. Apply tempo: set `ns.tempos[0].qpm = tempo`
4. Write: `note_seq.sequence_proto_to_midi_file(ns, output_path)` → standard MIDI file

### 5.4 In-App Playback

**Library:** `@tonejs/midi` (same as JazzGptMidi)
- Parses .mid bytes in renderer process
- Returns track/note structure
- Schedules Web Audio API events
- Tempo controlled by Tone.js transport

**Audio source:** Soundfont player with acoustic piano samples (same approach as JazzGptMidi)

---

## 6. Integration Points

### 6.1 Dependencies and Interactions

```
Electron main.js
    ├── depends on: child_process (Node.js built-in)
    ├── depends on: fs (Node.js built-in)
    ├── depends on: path (Node.js built-in)
    ├── depends on: electron (BrowserWindow, ipcMain, dialog)
    └── spawns: Python sidecar process
            ├── depends on: tensorflow 2.x
            ├── depends on: magenta (score2perf, note_seq)
            ├── depends on: flask
            ├── depends on: pretty_midi
            └── loads: model checkpoint (resources/model-checkpoint/)

Renderer (index.html / app.js)
    ├── depends on: ipcRenderer (Electron)
    ├── depends on: @tonejs/midi (MIDI parsing)
    ├── depends on: soundfont-player (audio)
    └── reads from: Electron main (via ipc)
```

### 6.2 Processing Order Requirements

1. Python sidecar must start BEFORE any generate request is made
2. Model checkpoint must be loaded BEFORE generation begins
3. Primer MIDI (if provided) must be read and encoded BEFORE generation
4. Generation must complete BEFORE Download button is enabled
5. Output .mid must exist at temp path BEFORE Electron reads it

### 6.3 Thread Boundaries

| Thread | Runs In | Concern |
|--------|---------|---------|
| Electron main | Node.js main thread | IPC, process management, file I/O |
| Electron renderer | Chromium renderer process | UI, Web Audio, playback |
| Python main | Python process | Flask server, process mgmt |
| Python inference | Python background thread | TF inference (blocks main thread if not threaded) |
| Python MIDI I/O | Python main thread | Fast, non-blocking |

**Critical thread concern:** TensorFlow inference blocks Python's GIL. Flask is single-threaded by default. Solution: run inference in a `threading.Thread`, use `threading.Event` for progress signaling. Or use `app.run(threaded=True)` so Flask handles concurrent requests.

### 6.4 Sidecar Lifecycle

```
App launch → main.js created
First "Generate" click → spawn sidecar
  Sidecar starts → loads TF + model (10-30s)
  Sidecar ready → main.js receives port number
  Sidecar alive → kept running for app lifetime
  Subsequent generates → POST /generate to existing sidecar
App quit → app.on('quit') → childProcess.kill()
```

**Keep-alive vs. spawn-per-generation:**
Keep-alive is strongly preferred: model loading (10-30s) makes per-generation spawn unacceptable.
The sidecar process persists from first use until app quit.

---

## 7. Implementation Risks

### Risk 1: TensorFlow + Magenta version compatibility (HIGH)
- **Description:** Magenta requires TF 2.x but specific minor version pinning matters. TF 2.9-2.12 known to work with Magenta. TF 2.13+ changed APIs.
- **Probability:** HIGH — this is the #1 failure mode for Magenta projects
- **Mitigation:** Pin exact versions: `tensorflow==2.9.1 magenta==2.1.4` and test before bundling
- **Fallback:** Use a Docker image to capture working environment, then conda-pack from it. Alternatively, consider a standalone PyTorch port (chathasphere/pno-ai or spectraldoy/music-transformer) which avoids TF entirely

### Risk 2: Python environment bundling size (HIGH)
- **Description:** TF alone is ~500MB, Magenta adds ~100MB, model checkpoint is ~1.5GB. Total distribution: 2.2-3GB. This may exceed GitHub releases limits and make distribution painful.
- **Probability:** HIGH — size is a real constraint
- **Mitigation:**
  - Separate model download from app download (app ~600MB, model downloaded on first launch)
  - Or host model on a CDN and download to `~/Library/Application Support/PianoTransformer/`
  - Strip unnecessary TF ops (tflite runtime? unlikely to work for this model size)
- **Fallback:** Ship without model; on first launch, app auto-downloads model checkpoint to user's data directory

### Risk 3: PyInstaller fails with TensorFlow (MEDIUM-HIGH)
- **Description:** PyInstaller + TF is a known problematic combination. Missing hidden imports cause runtime crashes.
- **Probability:** MEDIUM-HIGH if PyInstaller is chosen
- **Mitigation:** Use conda-pack instead of PyInstaller. If PyInstaller needed: use `--collect-all tensorflow` flag.
- **Fallback:** conda-pack or python-build-standalone approach

### Risk 4: macOS notarization with bundled Python dylibs (MEDIUM)
- **Description:** Apple's notarization rejects unsigned dylibs unless `disable-library-validation` entitlement is set.
- **Probability:** MEDIUM — JazzGptMidi already solved this with correct entitlements
- **Mitigation:** Reuse JazzGptMidi's entitlements.plist exactly. Add `disable-library-validation: true`.
- **Fallback:** Sign all Python dylibs individually (complex but possible with `codesign --deep`)

### Risk 5: Long cold start UX (MEDIUM)
- **Description:** First generation takes 10-30s just for model loading. Users may think app is frozen.
- **Probability:** HIGH (this will definitely happen)
- **Mitigation:** Show "Loading model..." status on first Generate click. Start sidecar eagerly on app launch in background. Clear progress messaging in status bar.
- **Fallback:** Pre-warm sidecar on app start (no user action needed, just fires off background process)

### Risk 6: Flask port conflicts (LOW)
- **Description:** Random localhost port could theoretically conflict with other apps.
- **Probability:** LOW with random port selection
- **Mitigation:** Use port 0 (OS-assigned), read actual port from sidecar stdout. Retry with new port if startup fails.
- **Fallback:** Use stdin/stdout IPC instead of Flask

### Risk 7: Windows cross-platform compatibility (MEDIUM)
- **Description:** Python path separators, conda-pack activation scripts differ on Windows.
- **Probability:** MEDIUM for first Windows build
- **Mitigation:** Use `path.join()` throughout, test Windows conda activation scripts. Use POSIX-style paths only within Python.
- **Fallback:** MVP ships Mac-only first; Windows as Phase 2

---

## 8. Architecture Decisions

### Decision 1: Flask vs. stdin/stdout IPC
- **Chosen:** Flask (local HTTP)
- **Reason:** Long-running inference makes stdin/stdout awkward. Flask allows clean async progress polling, easy JSON params, and cancellation endpoint. Better separation of concerns.
- **Alternative considered:** stdin/stdout JSON lines (simpler, fewer dependencies)
- **Tradeoff:** Flask adds ~5MB to bundle and a port management complexity; worth it for cleaner async

### Decision 2: conda-pack vs. PyInstaller
- **Chosen:** conda-pack
- **Reason:** PyInstaller has documented, recurring issues with TensorFlow (hidden imports, dynamic lib loading). conda-pack produces a full relocatable environment that TF works natively in.
- **Alternative considered:** PyInstaller (smaller output, single binary)
- **Tradeoff:** conda-pack produces a directory (not a single binary), but the Python env is pre-installed and works reliably

### Decision 3: Model download strategy
- **Chosen:** Download model on first launch, cache in user data directory
- **Reason:** 1.5GB checkpoint + ~600MB Python env = ~2.1GB app is too large for a DMG. Separating lets the app itself be reasonable in size (~200-600MB).
- **Alternative considered:** Bundle model inside DMG (simple, offline after install)
- **Tradeoff:** Requires internet on first launch. Mitigated with clear "Downloading model..." UX and resumable download.

### Decision 4: Keep-alive sidecar vs. per-generation spawn
- **Chosen:** Keep-alive sidecar (spawned on app launch or first use, lives until app quit)
- **Reason:** Model loading takes 10-30s. Per-generation spawn would make every generation slow.
- **Tradeoff:** Consumes RAM (TF model ~2-4GB RAM) for full app lifetime

### Decision 5: @tonejs/midi for playback
- **Chosen:** Same `@tonejs/midi` + `soundfont-player` pattern as JazzGptMidi
- **Reason:** Proven in JazzGptMidi, same MIDI format, same Electron renderer context
- **Tradeoff:** Soundfont samples are not as expressive as the generated MIDI deserves, but fits the "preview before export" use case

---

## 9. Special Considerations

### Performance
- TF inference on CPU: ~60-180s for 512 tokens. GPU acceleration requires CUDA (not bundled).
- RAM: TF model footprint ~2-4GB. Minimum system RAM recommendation: 8GB.
- Inference runs in Python background thread to keep Flask responsive.

### macOS Silicon (Apple Silicon / M1/M2/M3)
- `tensorflow-macos` package required for Apple Silicon (not standard `tensorflow`)
- May require `tensorflow-metal` for GPU acceleration via Metal API
- Build process needs arm64 conda environment on Apple Silicon machines
- conda-pack env must match target architecture (no x86→arm64 cross-packing)

### Temp File Cleanup
- Python writes output .mid to `tempfile.mktemp()` path
- Electron reads file, then should delete temp file
- On app quit: clean up any temp files left by Python sidecar

### No Internet After Model Download
- All inference is local after model is downloaded
- Flask server binds to `127.0.0.1` only (not `0.0.0.0`) — no network exposure
- Entitlements require `network.client` only for localhost communication

### Error Handling
- Python sidecar stderr is piped to Electron main and logged to console
- Flask error responses include `{"type":"error","message":"..."}` JSON
- Common errors: out of memory (large sequenceLength), corrupt primer MIDI, model not found
- All errors surfaced in status bar with actionable message

---

## 10. Research References

### Professional Apps Researched
- **Magenta Studio** (Ableton plugin) — uses same Magenta models, shows real-world packaging approach
- **TransformerLab** (Electron + Python + PyTorch LLM runner) — battle-tested conda-pack + Electron pattern for large ML models
- **JazzGptMidi** (same project) — reference for Electron structure, IPC patterns, MIDI export, notarization

### Model / Algorithm References
- [Google Magenta Piano Transformer Colab](https://colab.research.google.com/notebooks/magenta/piano_transformer/piano_transformer.ipynb)
- [Magenta Piano Transformer blog post](https://magenta.tensorflow.org/piano-transformer)
- [score2perf README](https://github.com/magenta/magenta/blob/main/magenta/models/score2perf/README.md)
- [asigalov61 Piano Transformer Colab fork](https://github.com/asigalov61/Google-Magenta-Piano-Transformer-Colab)
- GCS checkpoint base: `gs://magentadata/models/music_transformer/checkpoints/unconditional_model_16.ckpt`

### Bundling References
- [Simon Willison: Bundling Python inside Electron](https://til.simonwillison.net/electron/python-inside-electron)
- [TransformerLab: Packaging Python and PyTorch](https://lab.cloud/blog/packaging%20python/)
- [conda-pack documentation](https://conda.github.io/conda-pack/)
- [PyInstaller + TF issues](https://github.com/pyinstaller/pyinstaller/issues/6538)

### IPC / Architecture References
- [Electron + Flask integration (Red Buffer)](https://medium.com/red-buffer/integrating-python-flask-backend-with-electron-nodejs-frontend-8ac621d13f72)
- [Electron Python subprocess streaming (DEV)](https://dev.to/ruiclarateixeira/running-python-from-node-and-stream-output-565a)
- [Simon Willison: Signing + notarizing Electron macOS](https://til.simonwillison.net/electron/sign-notarize-electron-macos)

### MIDI Libraries
- [note_seq (Magenta)](https://github.com/magenta/note-seq)
- [mido documentation](https://mido.readthedocs.io/en/stable/)
- [@tonejs/midi](https://github.com/Tonejs/Midi) — renderer-side MIDI parsing (reused from JazzGptMidi)

---

## 11. Design Sync Check (Mockup vs. Brief)

**Mockup version checked:** v3-ui.yaml (approved)

**Parameters in mockup:**
- temperature: 0.1–2.0, default 1.0 — MATCHES brief
- sequence_length: 128–2048, default 512 — MATCHES brief (mockup uses snake_case, brief uses camelCase — cosmetic difference)
- primer_length: 0–512, default 64 — MATCHES brief
- tempo: 40–200 BPM, default 120 — MATCHES brief

**UI elements in mockup:**
- Seed MIDI dropzone — covered in architecture (3.3 primer MIDI handling)
- 3 action buttons: Play, Generate, Download — covered (3.6 UI state management)
- Status bar with text states — covered (3.6)

**No conflicts found.** Mockup v3 is fully consistent with creative brief.
