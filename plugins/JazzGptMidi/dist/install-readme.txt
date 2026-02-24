JazzGptMidi by TÂCHES — Installation Guide
==========================================
Version 1.0.0

FILES IN THIS PACKAGE
---------------------
• JazzGptMidi-by-TACHES.pkg  — macOS installer (VST3 + AU)
• install-readme.txt          — This file

INSTALLATION
------------
1. Double-click JazzGptMidi-by-TACHES.pkg
2. Follow the installer screens (Welcome → ReadMe → Install)
3. Enter your Mac password when prompted
4. Click Close when installation is complete

FIRST USE — GATEKEEPER BYPASS
------------------------------
Because this plugin is not notarized by Apple, macOS will block
it the first time you load it in a DAW. Follow these steps once:

1. Try to load JazzGptMidi in your DAW
2. macOS shows "cannot be opened because the developer cannot be verified"
3. Open System Settings → Privacy & Security
4. Scroll down — you'll see a message about JazzGptMidi
5. Click "Open Anyway"
6. Confirm in the dialog that appears
7. Repeat for the other format (VST3 and AU require separate approval)

This is a one-time step. After authorising, it loads normally every time.

PLUGIN LOCATIONS
----------------
After installation:
  VST3:  ~/Library/Audio/Plug-Ins/VST3/JazzGptMidi.vst3
  AU:    ~/Library/Audio/Plug-Ins/Components/JazzGptMidi.component

DAW RESCANNING
--------------
Logic Pro:   Preferences → Plug-in Manager → Reset & Rescan Selection
Ableton:     Preferences → Plug-ins → Rescan
Reaper:      Options → Preferences → Plug-ins → Re-scan
Bitwig:      Settings → Plug-ins → Rescan

HOW TO USE
----------
1. Load JazzGptMidi on an instrument track
2. Click ⋮ Options → Copy Prompt
3. Paste the prompt into ChatGPT, Claude, or any LLM
4. Ask for a jazz composition — e.g.:
   "Write a slow blues in F minor, 12 bars, 72 bpm, medium swing"
5. Copy the LLM's full response
6. Paste it into the JazzGptMidi text area
7. Press ▶ Play to preview through the built-in piano
8. Drag the MIDI button to a DAW track to import the composition

SYSTEM REQUIREMENTS
-------------------
• macOS 13 or later
• Any AU/VST3 compatible DAW

SUPPORT
-------
nobody.computer
