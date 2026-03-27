"""
generate.py — Core Piano Transformer inference for PianoTransformer.

Wraps Magenta's Music Transformer (piano_transformer checkpoint) to:
- Load a model checkpoint once
- Generate piano MIDI from scratch or from a primer sequence
- Report progress via a shared progress state object

Reference:
  https://colab.research.google.com/notebooks/magenta/piano_transformer/piano_transformer.ipynb
"""

import os
import sys
import tempfile
import threading

import note_seq
import tensorflow.compat.v1 as tf

# Magenta uses TF 1.x compat mode
tf.disable_v2_behavior()

from tensor2tensor.utils import decoding
from tensor2tensor.utils import trainer_lib
from magenta.models.score2perf import score2perf


# ─────────────────────────────────────────────
# Progress state (shared between inference thread and Flask)
# ─────────────────────────────────────────────

class GenerationProgress:
    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        with self.lock:
            self.status = "idle"      # idle | loading | generating | done | error
            self.percent = 0
            self.output_path = None
            self.error_message = None

    def set(self, **kwargs):
        with self.lock:
            for k, v in kwargs.items():
                setattr(self, k, v)

    def snapshot(self):
        with self.lock:
            return {
                "status": self.status,
                "percent": self.percent,
                "output_path": self.output_path,
                "error_message": self.error_message,
            }


progress = GenerationProgress()


# ─────────────────────────────────────────────
# Model loading
# ─────────────────────────────────────────────

_estimator = None
_hparams = None
_encoders = None


def load_model(checkpoint_dir):
    """
    Load the piano_transformer checkpoint. Call once at startup.
    checkpoint_dir: path to directory containing model.ckpt-* files.
    """
    global _estimator, _hparams, _encoders

    print(f"[generate] Loading model from {checkpoint_dir} ...")
    progress.set(status="loading", percent=0)

    from tensor2tensor.utils import registry

    problem_name = "score2perf_maestro_language_uncropped_aug"
    model_name = "transformer"
    hparam_set = "transformer_tpu"

    hparams = trainer_lib.create_hparams(hparam_set)
    hparams.num_hidden_layers = 16
    hparams.sampling_method = "random"

    problem = registry.problem(problem_name)
    problem_hparams = problem.get_hparams(hparams)
    hparams.problem_hparams = problem_hparams

    run_config = trainer_lib.create_run_config(hparams)

    estimator = trainer_lib.create_estimator(
        model_name,
        hparams,
        run_config,
        decode_hparams=decoding.decode_hparams("beam_size=1,alpha=0.0"),
    )

    _estimator = estimator
    _hparams = hparams
    _encoders = problem_hparams.vocabulary["targets"]

    print("[generate] Model loaded.")
    progress.set(status="idle", percent=0)


def _get_checkpoint_path(checkpoint_dir):
    """Return the checkpoint prefix path from a directory."""
    ckpt = tf.train.latest_checkpoint(checkpoint_dir)
    if ckpt:
        return ckpt
    # Fallback: look for unconditional_model_16.ckpt
    prefix = os.path.join(checkpoint_dir, "unconditional_model_16.ckpt")
    if os.path.exists(prefix + ".index"):
        return prefix
    raise FileNotFoundError(f"No checkpoint found in {checkpoint_dir}")


# ─────────────────────────────────────────────
# Generation
# ─────────────────────────────────────────────

def generate_midi(
    checkpoint_dir,
    temperature=1.0,
    sequence_length=512,
    primer_tokens=None,
    tempo_bpm=120,
    output_path=None,
):
    """
    Generate piano MIDI using the Piano Transformer.

    Args:
        checkpoint_dir: Path to model checkpoint directory.
        temperature: Sampling temperature (0.1 = predictable, 2.0 = creative).
        sequence_length: Number of Performance tokens to generate.
        primer_tokens: List of integer token IDs from a primer MIDI (or [] for cold start).
        tempo_bpm: BPM to embed in output MIDI.
        output_path: Where to write the .mid file. If None, uses a temp file.

    Returns:
        Path to the generated .mid file.
    """
    global _estimator, _encoders

    if primer_tokens is None:
        primer_tokens = []

    if output_path is None:
        fd, output_path = tempfile.mkstemp(suffix=".mid", prefix="pt_output_")
        os.close(fd)

    progress.set(status="generating", percent=5)

    try:
        ckpt_path = _get_checkpoint_path(checkpoint_dir)

        # Update sampling temperature for this call
        _hparams.sampling_temp = temperature

        # decode_hparams matching the working test_generate.py pattern
        decode_hp = decoding.decode_hparams("beam_size=1,alpha=0.0")
        decode_hp.extra_length = sequence_length
        decode_hp.batch_size = 1

        # Progress estimator (time-based linear estimate)
        import time
        estimated_total = sequence_length * 0.3  # ~0.3s per token on CPU
        start_time = time.time()
        stop_progress = threading.Event()

        def _update_progress():
            while not stop_progress.is_set():
                elapsed = time.time() - start_time
                pct = min(int(elapsed / estimated_total * 90), 90)
                progress.set(percent=pct)
                stop_progress.wait(timeout=1.0)

        progress_thread = threading.Thread(target=_update_progress, daemon=True)
        progress_thread.start()

        # ── input_fn — exactly as in working test_generate.py ─────────
        targets_val = primer_tokens[:] if primer_tokens else [0]

        def input_fn(params):
            del params
            dataset = tf.data.Dataset.from_tensors({
                "targets": tf.constant([targets_val], dtype=tf.int32),
            })
            return dataset

        result_ids = None
        for result in _estimator.predict(
            input_fn,
            checkpoint_path=ckpt_path,
            yield_single_examples=False,
        ):
            if "outputs" in result:
                result_ids = result["outputs"].flatten().tolist()
            elif "targets" in result:
                result_ids = result["targets"].flatten().tolist()
            break
            break  # single prediction

        stop_progress.set()
        progress_thread.join(timeout=2)
        # ─────────────────────────────────────────────────────────────

        if result_ids is None:
            raise RuntimeError("No output from estimator.predict()")

        progress.set(percent=95)

        # Decode token IDs → NoteSequence
        ns = _decode_tokens_to_note_sequence(result_ids)

        # Write MIDI with tempo
        from midi_utils import write_midi
        write_midi(ns, output_path, tempo_bpm=tempo_bpm)

        progress.set(status="done", percent=100, output_path=output_path)
        print(f"[generate] Done → {output_path}")
        return output_path

    except Exception as e:
        stop_progress.set() if 'stop_progress' in dir() else None
        error_msg = str(e)
        print(f"[generate] ERROR: {error_msg}", file=sys.stderr)
        progress.set(status="error", error_message=error_msg)
        raise


def _decode_tokens_to_note_sequence(token_ids):
    """Decode a list of Performance token IDs to a NoteSequence."""
    encoder_decoder = note_seq.OneHotEventSequenceEncoderDecoder(
        note_seq.PerformanceOneHotEncoding(
            num_velocity_bins=32,
            max_shift_steps=100
        )
    )
    vocab_size = encoder_decoder.num_classes
    perf = note_seq.Performance(steps_per_second=100, num_velocity_bins=32)
    event_list = []
    for t in token_ids:
        if 0 < t < vocab_size:
            try:
                event = encoder_decoder.class_index_to_event(t, event_list)
                event_list.append(event)
                perf.append(event)
            except Exception:
                pass
    return perf.to_sequence()
