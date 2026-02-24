// JazzGptMidi - UI Logic
import { getNativeFunction } from './juce/index.js';

// Get native function wrappers
const playCompositionNative = getNativeFunction('playComposition');
const stopPlaybackNative = getNativeFunction('stopPlayback');
const exportMIDINative = getNativeFunction('exportMIDI');
const updateCompositionTextNative = getNativeFunction('updateCompositionText');
const saveSongNative = getNativeFunction('saveSong');
const loadSongNative = getNativeFunction('loadSong');
const openURLNative = getNativeFunction('openURL');

// Get DOM elements
const compositionTextArea = document.getElementById('composition');
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const statusBar = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');
const playhead = document.getElementById('playhead');
const exportMidi = document.getElementById('exportMidi');
const optionsBtn = document.getElementById('optionsBtn');
const optionsMenu = document.getElementById('optionsMenu');
const optionCopyPrompt = document.getElementById('optionCopyPrompt');
const optionSaveSong = document.getElementById('optionSaveSong');
const optionLoadSong = document.getElementById('optionLoadSong');
const optionReset = document.getElementById('optionReset');

// Preview values
const tempoVal = document.getElementById('tempoVal');
const keyVal = document.getElementById('keyVal');
const timeVal = document.getElementById('timeVal');
const barsVal = document.getElementById('barsVal');
const notesVal = document.getElementById('notesVal');
const chordsVal = document.getElementById('chordsVal');

// Check if JUCE backend is available
const hasJuce = typeof window.__JUCE__ !== 'undefined';

// Debug: Log JUCE availability
console.log('JUCE backend available:', hasJuce);
if (hasJuce) {
    console.log('Native functions initialized: playComposition, stopPlayback, exportMIDI, updateCompositionText');
}

// Handle external link clicks (nobody.computer)
const externalLinks = document.querySelectorAll('a[href^="http"]');
externalLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        if (hasJuce) {
            openURLNative(link.href);
        }
    });
});

// Transport controls
playBtn.addEventListener('click', () => {
    console.log('Play button clicked');

    if (!hasJuce) {
        console.error('JUCE backend not available');
        showStatus('JUCE backend not available', 'error');
        return;
    }

    const text = compositionTextArea.value;
    if (!text.trim()) {
        console.warn('No composition text');
        showStatus('No composition text', 'error');
        return;
    }

    console.log('Calling playComposition with text length:', text.length);

    // Call C++ to play composition (via JUCE native function wrapper)
    try {
        playCompositionNative(text);
        console.log('playComposition called successfully');
    } catch (e) {
        console.error('Error calling playComposition:', e);
        showStatus('Error: ' + e.message, 'error');
    }
});

stopBtn.addEventListener('click', () => {
    if (!hasJuce) return;

    // Call C++ to stop playback (via JUCE native function wrapper)
    stopPlaybackNative();
});

// Export button handler
exportMidi.addEventListener('click', () => {
    if (!hasJuce) {
        showStatus('JUCE backend not available', 'error');
        return;
    }

    const text = compositionTextArea.value;
    if (!text.trim()) {
        showStatus('No composition text', 'error');
        return;
    }

    exportMIDINative('full', text);
});

// Drag-and-drop handlers for MIDI export
function setupDragHandlers(element, mode) {
    element.addEventListener('dragstart', (e) => {
        const text = compositionTextArea.value;
        if (!text.trim()) {
            e.preventDefault();
            showStatus('No composition to export', 'error');
            return;
        }

        // Visual feedback
        element.classList.add('dragging');
        showStatus(`Drag ${mode} MIDI to your DAW...`, 'success');

        // Prepare MIDI data for drag (browser will handle the drag image)
        if (hasJuce) {
            exportMIDINative(mode, text);
        }
    });

    element.addEventListener('dragend', () => {
        element.classList.remove('dragging');
        showStatus('Ready', 'success');
    });
}

setupDragHandlers(exportMidi, 'full');

// Options menu toggle
optionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = optionsMenu.style.display === 'block';
    optionsMenu.style.display = isVisible ? 'none' : 'block';
});

// Close menu when clicking outside
document.addEventListener('click', (e) => {
    if (!optionsMenu.contains(e.target) && e.target !== optionsBtn) {
        optionsMenu.style.display = 'none';
    }
});

// Copy Prompt option
optionCopyPrompt.addEventListener('click', async () => {
    const jazzGptPrompt = `You are JazzGPT, a jazz composer. You craft compositions that breathe with the imperfect perfection of human performance.

YOUR VOICE:
Speak only in musical structure. Let the rhythm sway, let notes fall slightly ahead or behind. Jazz lives in these spaces between the beats.

THE LANGUAGE OF COMPOSITION:

TITLE: [your composition's name]
TEMPO: [heartbeat in BPM]
KEY: [tonal center]
TIME: [meter]
SWING: [none/light/medium/heavy]
BARS: [length of your statement]

CHORDS:
bar [number]: [harmony]

Single chord per measure:
bar 1: Cmaj7

Multiple chords with durations in parentheses:
bar 2: Cmaj7(2) Dm7(2)
bar 3: C7(1) F7(1) Bb7(2)

Durations must complete the measure (sum to 4 in 4/4, to 3 in 3/4).

MELODY:
bar [number] beat [position]: [pitch] duration [beats]

TIMING AS HUMAN GESTURE:

Beat positions breathe freely—use any decimal to express human timing:
beat 1.0 = precisely on the downbeat
beat 1.5 = exactly halfway through beat 1
beat 1.52 = slightly late, relaxed, laid back
beat 1.48 = slightly early, anticipating, pushing forward
beat 2.05 = just a touch behind beat 2
beat 2.97 = rushing into beat 3
beat 3.33 = somewhere in the flow, finding its own moment

Let notes arrive when they feel right. The space between 1.5 and 1.52 can be the difference between mechanical and alive.

Most notes will land close to round numbers (1.0, 1.5, 2.0), but when a note needs to breathe, let it drift—a subtle 0.03 or 0.08 can give it soul.

NOTATION GUIDE:

Pitches: note + octave (C4, Eb5, F#3, Bb4)
Use # for sharps, b for flats
Middle C = C4

Durations (in beats, can be any decimal):
4.0 = whole note
2.0 = half note
1.5 = dotted quarter
1.0 = quarter note
0.5 = eighth note
0.25 = sixteenth note
0.33 = triplet eighth

Chord vocabulary: Cmaj7, Dm7, G7, Am7b5, Bdim7, C7alt, Csus4, C9, C13, Ebmaj7#11...

THE ESSENCE:

Most notes stay close to the grid—1.0, 1.5, 2.0—but when you feel a note should breathe differently, let the decimal express it. A note at 2.05 instead of 2.0 carries a different weight, a different intention.

BEFORE YOU COMPOSE:
✓ Bar numbers flow sequentially
✓ Chord durations sum to the time signature
✓ Beat positions are decimals (can be any value)
✓ Note durations are positive decimals
✓ Pitches follow [note][accidental][octave]
✓ Nothing exists outside this structure
✓ No explanations, no markdown, just the composition

You are now ready. Reply only: "JazzGPT ready. Tell me what you hear."`;

    try {
        await navigator.clipboard.writeText(jazzGptPrompt);
        showStatus('Prompt copied to clipboard!', 'success');

        // Reset status after 2 seconds
        setTimeout(() => {
            showStatus('Ready', 'success');
        }, 2000);
    } catch (e) {
        console.error('Copy failed:', e);
        showStatus('Copy failed (clipboard access denied)', 'error');
    }

    optionsMenu.style.display = 'none';
});

// Save Song option
optionSaveSong.addEventListener('click', () => {
    if (!hasJuce) {
        showStatus('JUCE backend not available', 'error');
        return;
    }

    const text = compositionTextArea.value;
    if (!text.trim()) {
        showStatus('No composition to save', 'error');
        return;
    }

    // Call C++ to save as text file
    try {
        saveSongNative(text);
        showStatus('Saving song...', 'success');
    } catch (e) {
        console.error('Save failed:', e);
        showStatus('Save failed: ' + e.message, 'error');
    }

    optionsMenu.style.display = 'none';
});

// Load Song option
optionLoadSong.addEventListener('click', () => {
    if (!hasJuce) {
        showStatus('JUCE backend not available', 'error');
        return;
    }

    // Call C++ to open file chooser and load text
    try {
        loadSongNative();
        showStatus('Loading song...', 'success');
    } catch (e) {
        console.error('Load failed:', e);
        showStatus('Load failed: ' + e.message, 'error');
    }

    optionsMenu.style.display = 'none';
});

// Reset option
optionReset.addEventListener('click', () => {
    // Stop playback if active
    if (hasJuce) {
        stopPlaybackNative();
    }

    // Clear text area
    compositionTextArea.value = '';
    showStatus('Text cleared - ready for new composition', 'success');

    // Update C++ state
    if (hasJuce) {
        updateCompositionTextNative('');
    }

    optionsMenu.style.display = 'none';
});

// Text area change handler (save state)
compositionTextArea.addEventListener('input', () => {
    if (hasJuce) {
        updateCompositionTextNative(compositionTextArea.value);
    }
});

// C++ -> JavaScript API (called from C++)
window.updatePreview = function(data) {
    tempoVal.textContent = data.tempo || '-';
    keyVal.textContent = data.key || '-';
    timeVal.textContent = data.time || '-';
    barsVal.textContent = data.bars || '-';
    notesVal.textContent = data.notesCount || '-';
    chordsVal.textContent = data.chordsCount || '-';
};

window.updatePlayhead = function(position) {
    playhead.textContent = position || '';
};

window.showStatus = function(message, type) {
    statusBar.className = 'status-bar';
    if (type) statusBar.classList.add(type);
    statusText.textContent = message;
};

window.setPlayingState = function(playing) {
    if (playing) {
        playBtn.classList.add('playing');
        statusBar.classList.remove('success', 'error');
        statusBar.classList.add('playing');
    } else {
        playBtn.classList.remove('playing');
        statusBar.classList.remove('playing');
        statusBar.classList.add('success');
        playhead.textContent = '';
    }
};

window.restoreText = function(text) {
    compositionTextArea.value = text;
};

// Initial status
if (hasJuce) {
    console.log('JUCE backend available');
} else {
    console.log('Running in browser preview mode');
}
