/**
 * app.js — Piano Transformer renderer process
 *
 * Connects to the Python Flask sidecar via window.electronAPI (IPC bridge).
 * Handles:
 *   - Sidecar lifecycle (loading → ready)
 *   - File drop/pick for primer MIDI
 *   - Generation with progress polling
 *   - Download / open in DAW
 */

(function () {
  "use strict";

  // ─── DOM refs ──────────────────────────────────────────────────────────────

  const statusLine      = document.getElementById("status-line");
  const dropzone        = document.getElementById("dropzone");
  const dropzoneLoaded  = document.getElementById("dropzone-loaded");
  const dropzoneFile    = document.getElementById("dropzone-filename");
  const dropzoneClear   = document.getElementById("dropzone-clear");

  const tempSlider      = document.getElementById("temperature");
  const tempDisplay     = document.getElementById("temperature-display");
  const seqSlider       = document.getElementById("sequence-length");
  const seqDisplay      = document.getElementById("sequence-length-display");
  const primerSlider    = document.getElementById("primer-length");
  const primerDisplay   = document.getElementById("primer-length-display");
  const tempoSlider     = document.getElementById("tempo");
  const tempoDisplay    = document.getElementById("tempo-display");

  const btnPlay         = document.getElementById("btn-play");
  const btnGenerate     = document.getElementById("btn-generate");
  const btnDownload     = document.getElementById("btn-download");

  // ─── State ─────────────────────────────────────────────────────────────────

  let modelReady     = false;
  let isGenerating   = false;
  let primerMidiPath = null;   // absolute path to selected seed MIDI
  let outputMidiPath = null;   // absolute path to last generated MIDI
  let pollInterval   = null;

  // Playback state (defined before use below)
  let isPlaying      = false;
  let scheduledParts = [];

  // ─── Slider bindings ───────────────────────────────────────────────────────

  tempSlider.addEventListener("input", () => {
    tempDisplay.textContent = parseFloat(tempSlider.value).toFixed(2);
  });

  seqSlider.addEventListener("input", () => {
    seqDisplay.textContent = `${parseInt(seqSlider.value, 10)} steps`;
  });

  primerSlider.addEventListener("input", () => {
    primerDisplay.textContent = `${parseInt(primerSlider.value, 10)} steps`;
  });

  tempoSlider.addEventListener("input", () => {
    tempoDisplay.textContent = `${parseInt(tempoSlider.value, 10)} BPM`;
  });

  // ─── Dropzone ──────────────────────────────────────────────────────────────

  function setPrimerFile(filePath) {
    primerMidiPath = filePath;
    const name = filePath.split("/").pop().split("\\").pop();
    dropzoneFile.textContent = name;
    dropzone.classList.add("is-loaded");
  }

  function clearPrimerFile() {
    primerMidiPath = null;
    dropzoneFile.textContent = "";
    dropzone.classList.remove("is-loaded");
  }

  dropzone.addEventListener("click", async (e) => {
    if (e.target === dropzoneClear) return;
    try {
      const filePath = await window.electronAPI.openFile();
      if (filePath) setPrimerFile(filePath);
    } catch (err) {
      console.error("[dropzone] open-file error:", err);
    }
  });

  dropzoneClear.addEventListener("click", (e) => {
    e.stopPropagation();
    clearPrimerFile();
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("drag-over");
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file && file.path) {
      setPrimerFile(file.path);
    }
  });

  // ─── Model ready ───────────────────────────────────────────────────────────

  function onModelReady() {
    modelReady = true;
    setStatus("Ready");
    btnGenerate.disabled = false;
  }

  // ─── Generation ────────────────────────────────────────────────────────────

  function setStatus(msg, active = false) {
    statusLine.textContent = msg;
    statusLine.classList.toggle("is-active", active);
  }

  function startProgressPoll() {
    pollInterval = setInterval(async () => {
      try {
        const snap = await window.electronAPI.getProgress();

        if (snap.status === "generating") {
          setStatus(`Generating… ${snap.percent}%`, true);
        } else if (snap.status === "done") {
          stopProgressPoll();
          outputMidiPath = snap.output_path;
          setStatus("Complete", true);
          finishGeneration(true);
        } else if (snap.status === "error") {
          stopProgressPoll();
          setStatus(`Error: ${snap.error_message}`, false);
          finishGeneration(false);
        }
      } catch (err) {
        console.error("[poll] progress error:", err);
      }
    }, 500);
  }

  function stopProgressPoll() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function finishGeneration(success) {
    isGenerating = false;
    btnGenerate.textContent = "Generate";
    btnGenerate.disabled = false;
    setInputsEnabled(true);

    if (success && outputMidiPath) {
      btnDownload.disabled = false;
      btnPlay.disabled = false;
    }
  }

  function setInputsEnabled(enabled) {
    tempSlider.disabled    = !enabled;
    seqSlider.disabled     = !enabled;
    primerSlider.disabled  = !enabled;
    tempoSlider.disabled   = !enabled;
  }

  btnGenerate.addEventListener("click", async () => {
    if (!modelReady) return;

    if (isGenerating) {
      // Cancel
      try {
        await window.electronAPI.cancel();
        stopProgressPoll();
        setStatus("Cancelled");
        finishGeneration(false);
      } catch (err) {
        console.error("[generate] cancel error:", err);
      }
      return;
    }

    isGenerating = true;
    outputMidiPath = null;
    if (isPlaying) stopPlayback();
    btnDownload.disabled = true;
    btnPlay.disabled = true;
    btnGenerate.textContent = "Cancel";
    setInputsEnabled(false);
    setStatus("Generating… 0%", true);

    try {
      await window.electronAPI.generate({
        temperature:    parseFloat(tempSlider.value),
        sequenceLength: parseInt(seqSlider.value, 10),
        primerLength:   parseInt(primerSlider.value, 10),
        primerMidi:     primerMidiPath || null,
        tempo:          parseInt(tempoSlider.value, 10),
      });
      startProgressPoll();
    } catch (err) {
      console.error("[generate] error:", err);
      setStatus(`Error: ${err.message}`);
      finishGeneration(false);
    }
  });

  // ─── Download ──────────────────────────────────────────────────────────────

  btnDownload.addEventListener("click", async () => {
    if (!outputMidiPath) return;
    try {
      const savedPath = await window.electronAPI.saveFile(outputMidiPath);
      if (savedPath) {
        setStatus(`Saved: ${savedPath.split("/").pop()}`, true);
      }
    } catch (err) {
      console.error("[download] error:", err);
    }
  });

  // ─── Playback (Tone.js + @tonejs/midi) ────────────────────────────────────
  // Audio is lazy-initialized on first Play click to avoid AudioContext
  // creation before user gesture (which crashes Chromium's renderer).

  let synth = null;
  let parts = [];

  function initAudio() {
    if (synth) return; // already initialized
    synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle8" },
      envelope: { attack: 0.005, decay: 0.4, sustain: 0.35, release: 1.8 },
      volume: -8,
    }).toDestination();
  }

  function stopPlayback() {
    Tone.Transport.stop();
    Tone.Transport.cancel();
    parts.forEach((p) => p.dispose());
    parts = [];
    isPlaying = false;
    btnPlay.textContent = "Play";
  }

  async function startPlayback(midiPath) {
    // Resume/init audio (requires user gesture — we're inside a click handler)
    await Tone.start();
    initAudio();

    // Read file bytes via IPC
    const base64 = await window.electronAPI.readFile(midiPath);
    if (!base64) { setStatus("Could not read MIDI file"); return; }

    // Decode base64 → ArrayBuffer
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Parse MIDI
    const midi = new Midi(bytes.buffer);

    // Set tempo
    if (midi.header.tempos.length > 0) {
      Tone.Transport.bpm.value = midi.header.tempos[0].bpm;
    }

    // One Part per track (not per note)
    Tone.Transport.cancel();
    parts = [];

    midi.tracks.forEach((track) => {
      if (track.notes.length === 0) return;
      const events = track.notes.map((n) => [n.time, n]);
      const part = new Tone.Part((time, note) => {
        synth.triggerAttackRelease(note.name, note.duration, time, note.velocity);
      }, events);
      part.start(0);
      parts.push(part);
    });

    Tone.Transport.start();
    isPlaying = true;
    btnPlay.textContent = "Stop";

    // Auto-stop when piece ends
    Tone.Transport.scheduleOnce(() => {
      stopPlayback();
      setStatus("Playback complete");
    }, midi.duration + 2);
  }

  btnPlay.addEventListener("click", async () => {
    if (!outputMidiPath) return;
    if (isPlaying) {
      stopPlayback();
      setStatus("Stopped");
    } else {
      setStatus("Playing…", true);
      try {
        await startPlayback(outputMidiPath);
      } catch (err) {
        console.error("[play] error:", err);
        setStatus("Playback error");
        stopPlayback();
      }
    }
  });

  // ─── Sidecar events ────────────────────────────────────────────────────────

  window.electronAPI.onModelReady(() => {
    onModelReady();
  });

  window.electronAPI.onSidecarError((msg) => {
    setStatus(`Sidecar error: ${msg}`);
  });

  // No context menu
  document.addEventListener("contextmenu", (e) => e.preventDefault());

})();
