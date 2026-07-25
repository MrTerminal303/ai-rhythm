"""Synthetic dataset generator for AIRhythm model overfit gates.

Generates configurable toy datasets with metronome clicks, sustained tones,
and chords. Used as the overfit gate for every training stage — models must
overfit the toy set cleanly before scaling to real data.

Per D-12: Noise injection ensures baseline (librosa onset detection) F-score
< 95% on the toy set so models must learn something non-trivial.
Per D-13: Generators are configurable per-stage (Stage 2 adds sustained tones,
Stage 3 adds chords, Stage 4 adds special labels).
"""

from __future__ import annotations

import json
import math
import os
import random
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Tuple

import numpy as np

from airhythm.config import HOP_LENGTH, N_FRAMES, N_MELS, SAMPLE_RATE

__all__ = [
    "ToySample",
    "NoiseConfig",
    "MetronomeClickGenerator",
    "ToyDataset",
    "generate_toy_set",
    "validate_toy_sample",
]

# -- Constants for tone generation --
TONE_FREQUENCY = 440.0  # Hz, default sine tone frequency
CLICK_DURATION = 0.05   # seconds (50ms per D-11)
FMAX = SAMPLE_RATE // 2  # 11025 Hz


@dataclass
class ToySample:
    """A single synthetic training sample.

    Attributes:
        spectrogram: Mel-spectrogram array of shape (1, 128, 400), float32.
        onset_labels: Binary onset label vector of shape (400,), int8.
        metadata: Dictionary with generation parameters (bpm, n_onsets, noise_params, stage).
    """

    spectrogram: np.ndarray  # shape (1, 128, 400), float32
    onset_labels: np.ndarray  # shape (400,), binary int8
    metadata: dict  # includes bpm, n_onsets, noise_params, stage


@dataclass
class NoiseConfig:
    """Configuration for noise injection into synthetic audio.

    Per D-11: Add noise (jitter, amplitude variation, background hum) incrementally.
    Default values calibrated so baseline F-score < 95%.
    """

    jitter_ms: float = 5.0  # max jitter in ms (A5ms per D-11 reference)
    amplitude_db: float = 3.0  # amplitude variation A3dB
    hum_db: float = -20.0  # background hum at -20dB relative to onset
    extra_noise_floor: float = 0.0  # additional white noise level (0 = disabled)
    random_phase: bool = True  # randomize onset sine phase


class MetronomeClickGenerator:
    """Generates metronome-click synthetic audio with configurable noise.

    Creates audio with 440Hz sine tones at regular BPM intervals, optionally
    adding jitter, amplitude variation, and background hum.
    """

    def __init__(self, sample_rate: int = SAMPLE_RATE, hop_length: int = HOP_LENGTH):
        self.sample_rate = sample_rate
        self.hop_length = hop_length

    def generate(
        self,
        bpm: float,
        duration_sec: float = 4.0,
        noise: Optional[NoiseConfig] = None,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Generate audio waveform and onset frame indices.

        Args:
            bpm: Beats per minute.
            duration_sec: Total audio duration in seconds.
            noise: Optional noise configuration.

        Returns:
            Tuple of (audio_waveform, frame_indices) where audio_waveform
            is float32 array of shape (num_samples,) and frame_indices is
            an int array of onset frame indices.
        """
        total_samples = int(self.sample_rate * duration_sec)
        audio = np.zeros(total_samples, dtype=np.float64)

        beat_interval_sec = 60.0 / bpm
        n_beats = int(duration_sec / beat_interval_sec)
        tone_samples = int(self.sample_rate * CLICK_DURATION)

        t = np.arange(tone_samples, dtype=np.float64) / self.sample_rate

        onset_times_sec = []
        onset_frame_indices = []

        for i in range(n_beats):
            # Base onset time
            onset_time = i * beat_interval_sec

            if noise and noise.jitter_ms > 0:
                # Apply jitter: randomly shift onset by Ajitter_ms
                jitter_sec = random.uniform(-noise.jitter_ms, noise.jitter_ms) / 1000.0
                onset_time += jitter_sec

            onset_time = max(0.0, min(onset_time, duration_sec - 1e-6))

            # Amplitude variation
            amplitude = 1.0
            if noise and noise.amplitude_db > 0:
                db_variation = random.uniform(-noise.amplitude_db, noise.amplitude_db)
                amplitude = 10.0 ** (db_variation / 20.0)

            # Randomize sine phase if configured
            phase = 0.0
            if noise and noise.random_phase:
                phase = random.uniform(0, 2 * math.pi)

            # Generate sine tone
            tone = amplitude * np.sin(2 * math.pi * TONE_FREQUENCY * t + phase)

            # Apply envelope to avoid clicks at boundaries
            fade_len = min(tone_samples // 10, 5)  # ~5 samples fade
            if fade_len > 0:
                fade_in = np.linspace(0, 1, fade_len)
                fade_out = np.linspace(1, 0, fade_len)
                tone[:fade_len] *= fade_in
                tone[-fade_len:] *= fade_out

            # Place tone at onset position
            start_sample = int(round(onset_time * self.sample_rate))
            end_sample = min(start_sample + tone_samples, total_samples)
            actual_len = end_sample - start_sample
            if actual_len > 0:
                audio[start_sample:end_sample] += tone[:actual_len]

            # Record onset time (center of tone)
            onset_times_sec.append(onset_time)
            # Convert to frame index
            frame_idx = int(round(onset_time * self.sample_rate / self.hop_length))
            onset_frame_indices.append(frame_idx)

        # Apply background hum
        if noise and noise.hum_db != 0:
            hum_amplitude = 10.0 ** (noise.hum_db / 20.0)
            hum_noise = np.random.randn(total_samples).astype(np.float64)
            # Low-pass by applying a simple moving average (crude but works)
            window = int(self.sample_rate * 0.001)  # 1ms window
            if window > 1:
                hum_noise = np.convolve(hum_noise, np.ones(window) / window, mode="same")
            audio += hum_amplitude * hum_noise

        # Apply extra white noise floor
        if noise and noise.extra_noise_floor > 0:
            audio += noise.extra_noise_floor * np.random.randn(total_samples).astype(np.float64)

        # Normalize to prevent clipping
        max_val = np.max(np.abs(audio))
        if max_val > 0:
            audio = audio / max_val * 0.9

        audio = audio.astype(np.float32)
        onset_frame_indices = np.array(sorted(set(onset_frame_indices)), dtype=np.int64)

        return audio, onset_frame_indices

    def audio_to_spectrogram(self, audio: np.ndarray) -> np.ndarray:
        """Convert audio waveform to normalized mel-spectrogram.

        Uses librosa (Slaney mel formula) to keep toygen dependency-light.
        Per RESEARCH.md Section 3: torchaudio uses HTK, librosa uses Slaney.
        Pipeline consistency is maintained within each element.

        Args:
            audio: float32 waveform array.

        Returns:
            Spectrogram of shape (1, 128, 400), float32, normalized.
        """
        import librosa

        # DC offset removal
        audio = audio - audio.mean()

        # Compute mel-spectrogram using librosa
        mel_spec = librosa.feature.melspectrogram(
            y=audio,
            sr=self.sample_rate,
            n_fft=2048,
            hop_length=self.hop_length,
            n_mels=N_MELS,
            power=2.0,
            fmax=FMAX,
        )  # shape: (n_mels, time_frames)

        # Trim or pad to exactly N_FRAMES (400)
        if mel_spec.shape[1] > N_FRAMES:
            mel_spec = mel_spec[:, :N_FRAMES]
        elif mel_spec.shape[1] < N_FRAMES:
            pad_width = N_FRAMES - mel_spec.shape[1]
            mel_spec = np.pad(mel_spec, ((0, 0), (0, pad_width)), mode="constant")

        # Convert to log scale (dB) — common for spectrogram input
        mel_spec = librosa.power_to_db(mel_spec, ref=np.max, top_db=80.0)

        # Normalize: subtract mean, divide by std
        mean = mel_spec.mean()
        std = mel_spec.std()
        if std > 0:
            mel_spec = (mel_spec - mean) / (std + 1e-8)
        else:
            mel_spec = mel_spec - mean

        # Unsqueeze to (1, 128, 400) as float32
        spectrogram = mel_spec[np.newaxis, ...].astype(np.float32)
        return spectrogram

    def generate_sample(
        self,
        bpm: float,
        noise: Optional[NoiseConfig] = None,
    ) -> ToySample:
        """Generate a complete ToySample from audio.

        Args:
            bpm: Beats per minute.
            noise: Optional noise configuration.

        Returns:
            A ToySample with spectrogram, onset_labels, and metadata.
        """
        audio, onset_frames = self.generate(bpm, noise=noise)
        spectrogram = self.audio_to_spectrogram(audio)

        # Build label vector: (400,) binary int8
        onset_labels = np.zeros(N_FRAMES, dtype=np.int8)
        for frame in onset_frames:
            if 0 <= frame < N_FRAMES:
                onset_labels[frame] = 1

        noise_params = None
        if noise:
            noise_params = {
                "jitter_ms": noise.jitter_ms,
                "amplitude_db": noise.amplitude_db,
                "hum_db": noise.hum_db,
                "extra_noise_floor": noise.extra_noise_floor,
                "random_phase": noise.random_phase,
            }

        metadata = {
            "bpm": bpm,
            "n_onsets": int(onset_labels.sum()),
            "onset_frame_indices": onset_frames.tolist(),
            "noise_params": noise_params,
            "stage": 0,
            "generator_type": "metronome_click",
        }

        return ToySample(spectrogram=spectrogram, onset_labels=onset_labels, metadata=metadata)


def _generate_sustained_tone_sample(
    bpm: float,
    sample_rate: int = SAMPLE_RATE,
    hop_length: int = HOP_LENGTH,
    noise: Optional[NoiseConfig] = None,
) -> ToySample:
    """Generate a sample with sustained tones (for Phase 2 hold head).

    Creates tones with durations 400-1200ms at BPM-aligned positions.
    Each tone has a clear onset and a held region.
    """
    import librosa

    duration_sec = 4.0
    total_samples = int(sample_rate * duration_sec)
    audio = np.zeros(total_samples, dtype=np.float64)

    beat_interval_sec = 60.0 / bpm
    n_beats = int(duration_sec / beat_interval_sec)

    # Random sustained duration between 400-1200ms
    sustain_duration_sec = random.uniform(0.4, 1.2)
    sustain_samples = int(sample_rate * sustain_duration_sec)

    onset_frame_indices = []

    for i in range(n_beats):
        onset_time = i * beat_interval_sec

        if noise and noise.jitter_ms > 0:
            jitter_sec = random.uniform(-noise.jitter_ms, noise.jitter_ms) / 1000.0
            onset_time += jitter_sec

        onset_time = max(0.0, min(onset_time, duration_sec - 1e-6))

        # Amplitude variation
        amplitude = 1.0
        if noise and noise.amplitude_db > 0:
            db_variation = random.uniform(-noise.amplitude_db, noise.amplitude_db)
            amplitude = 10.0 ** (db_variation / 20.0)

        # Randomize frequency slightly (within a tone)
        freq_variation = random.choice([0, -5, 5, -10, 10])  # cents
        freq = TONE_FREQUENCY * (2 ** (freq_variation / 1200.0))

        # Generate sustained tone with envelope
        start_sample = int(round(onset_time * sample_rate))
        end_sample = min(start_sample + sustain_samples, total_samples)
        actual_len = end_sample - start_sample

        if actual_len > 0:
            t = np.arange(actual_len, dtype=np.float64) / sample_rate
            phase = random.uniform(0, 2 * math.pi) if (noise and noise.random_phase) else 0.0
            tone = amplitude * np.sin(2 * math.pi * freq * t + phase)

            # Envelope: quick attack (5ms), slow decay
            attack_samples = int(0.005 * sample_rate)
            decay_samples = int(0.01 * sample_rate)
            if attack_samples < actual_len:
                tone[:attack_samples] *= np.linspace(0, 1, attack_samples)
            if decay_samples < actual_len:
                tone[-decay_samples:] *= np.linspace(1, 0, decay_samples)

            audio[start_sample:end_sample] += tone

        # Record onset frame (at the start of the tone)
        frame_idx = int(round(onset_time * sample_rate / hop_length))
        onset_frame_indices.append(frame_idx)

    # Apply noise
    if noise and noise.hum_db != 0:
        hum_amplitude = 10.0 ** (noise.hum_db / 20.0)
        hum_noise = np.random.randn(total_samples).astype(np.float64)
        window = int(sample_rate * 0.001)
        if window > 1:
            hum_noise = np.convolve(hum_noise, np.ones(window) / window, mode="same")
        audio += hum_amplitude * hum_noise

    if noise and noise.extra_noise_floor > 0:
        audio += noise.extra_noise_floor * np.random.randn(total_samples).astype(np.float64)

    max_val = np.max(np.abs(audio))
    if max_val > 0:
        audio = audio / max_val * 0.9

    audio = audio.astype(np.float32)

    # Mel-spectrogram
    audio_proc = audio - audio.mean()
    mel_spec = librosa.feature.melspectrogram(
        y=audio_proc,
        sr=sample_rate,
        n_fft=2048,
        hop_length=hop_length,
        n_mels=N_MELS,
        power=2.0,
        fmax=FMAX,
    )
    if mel_spec.shape[1] > N_FRAMES:
        mel_spec = mel_spec[:, :N_FRAMES]
    elif mel_spec.shape[1] < N_FRAMES:
        mel_spec = np.pad(mel_spec, ((0, 0), (0, N_FRAMES - mel_spec.shape[1])), mode="constant")
    mel_spec = librosa.power_to_db(mel_spec, ref=np.max, top_db=80.0)
    mean = mel_spec.mean()
    std = mel_spec.std()
    if std > 0:
        mel_spec = (mel_spec - mean) / (std + 1e-8)
    else:
        mel_spec = mel_spec - mean
    spectrogram = mel_spec[np.newaxis, ...].astype(np.float32)

    onset_labels = np.zeros(N_FRAMES, dtype=np.int8)
    for frame in onset_frame_indices:
        if 0 <= frame < N_FRAMES:
            onset_labels[frame] = 1

    noise_params = None
    if noise:
        noise_params = {
            "jitter_ms": noise.jitter_ms,
            "amplitude_db": noise.amplitude_db,
            "hum_db": noise.hum_db,
            "extra_noise_floor": noise.extra_noise_floor,
            "random_phase": noise.random_phase,
        }

    metadata = {
        "bpm": bpm,
        "n_onsets": int(onset_labels.sum()),
        "sustain_duration_sec": sustain_duration_sec,
        "onset_frame_indices": onset_frame_indices,
        "noise_params": noise_params,
        "stage": 2,
        "generator_type": "sustained_tone",
    }

    return ToySample(spectrogram=spectrogram, onset_labels=onset_labels, metadata=metadata)


def _generate_chord_sample(
    bpm: float,
    sample_rate: int = SAMPLE_RATE,
    hop_length: int = HOP_LENGTH,
    noise: Optional[NoiseConfig] = None,
) -> ToySample:
    """Generate a sample with chords (for Phase 3 chord head).

    Creates 2-4 simultaneous tones at different frequencies per chord
    position. Frequencies drawn from: 440, 554, 659, 880 Hz.
    """
    import librosa

    chord_frequencies = [440.0, 554.0, 659.0, 880.0]

    duration_sec = 4.0
    total_samples = int(sample_rate * duration_sec)
    audio = np.zeros(total_samples, dtype=np.float64)

    beat_interval_sec = 60.0 / bpm
    n_beats = int(duration_sec / beat_interval_sec)
    tone_samples = int(sample_rate * CLICK_DURATION)

    onset_frame_indices = []

    for i in range(n_beats):
        onset_time = i * beat_interval_sec

        if noise and noise.jitter_ms > 0:
            jitter_sec = random.uniform(-noise.jitter_ms, noise.jitter_ms) / 1000.0
            onset_time += jitter_sec

        onset_time = max(0.0, min(onset_time, duration_sec - 1e-6))

        # Pick 2-4 random frequencies for the chord
        n_notes = random.randint(2, 4)
        chord_notes = random.sample(chord_frequencies, n_notes)

        for freq in chord_notes:
            amplitude = 1.0
            if noise and noise.amplitude_db > 0:
                db_variation = random.uniform(-noise.amplitude_db, noise.amplitude_db)
                amplitude = 10.0 ** (db_variation / 20.0)

            # Each note gets its own amplitude scaling (normalize by sqrt(n_notes) to avoid clipping)
            amplitude /= math.sqrt(n_notes)

            start_sample = int(round(onset_time * sample_rate))
            end_sample = min(start_sample + tone_samples, total_samples)
            actual_len = end_sample - start_sample

            if actual_len > 0:
                t = np.arange(actual_len, dtype=np.float64) / sample_rate
                phase = random.uniform(0, 2 * math.pi) if (noise and noise.random_phase) else 0.0
                tone = amplitude * np.sin(2 * math.pi * freq * t + phase)

                # Apply envelope
                fade_len = min(5, actual_len // 10)
                if fade_len > 0:
                    tone[:fade_len] *= np.linspace(0, 1, fade_len)
                    tone[-fade_len:] *= np.linspace(1, 0, fade_len)

                audio[start_sample:end_sample] += tone[:actual_len]

        frame_idx = int(round(onset_time * sample_rate / hop_length))
        onset_frame_indices.append(frame_idx)

    # Apply noise
    if noise and noise.hum_db != 0:
        hum_amplitude = 10.0 ** (noise.hum_db / 20.0)
        hum_noise = np.random.randn(total_samples).astype(np.float64)
        window = int(sample_rate * 0.001)
        if window > 1:
            hum_noise = np.convolve(hum_noise, np.ones(window) / window, mode="same")
        audio += hum_amplitude * hum_noise

    if noise and noise.extra_noise_floor > 0:
        audio += noise.extra_noise_floor * np.random.randn(total_samples).astype(np.float64)

    max_val = np.max(np.abs(audio))
    if max_val > 0:
        audio = audio / max_val * 0.9

    audio = audio.astype(np.float32)

    # Mel-spectrogram
    audio_proc = audio - audio.mean()
    mel_spec = librosa.feature.melspectrogram(
        y=audio_proc,
        sr=sample_rate,
        n_fft=2048,
        hop_length=hop_length,
        n_mels=N_MELS,
        power=2.0,
        fmax=FMAX,
    )
    if mel_spec.shape[1] > N_FRAMES:
        mel_spec = mel_spec[:, :N_FRAMES]
    elif mel_spec.shape[1] < N_FRAMES:
        mel_spec = np.pad(mel_spec, ((0, 0), (0, N_FRAMES - mel_spec.shape[1])), mode="constant")
    mel_spec = librosa.power_to_db(mel_spec, ref=np.max, top_db=80.0)
    mean = mel_spec.mean()
    std = mel_spec.std()
    if std > 0:
        mel_spec = (mel_spec - mean) / (std + 1e-8)
    else:
        mel_spec = mel_spec - mean
    spectrogram = mel_spec[np.newaxis, ...].astype(np.float32)

    onset_labels = np.zeros(N_FRAMES, dtype=np.int8)
    for frame in onset_frame_indices:
        if 0 <= frame < N_FRAMES:
            onset_labels[frame] = 1

    noise_params = None
    if noise:
        noise_params = {
            "jitter_ms": noise.jitter_ms,
            "amplitude_db": noise.amplitude_db,
            "hum_db": noise.hum_db,
            "extra_noise_floor": noise.extra_noise_floor,
            "random_phase": noise.random_phase,
        }

    metadata = {
        "bpm": bpm,
        "n_onsets": int(onset_labels.sum()),
        "n_notes_per_chord": n_notes,
        "chord_frequencies": chord_notes,
        "onset_frame_indices": onset_frame_indices,
        "noise_params": noise_params,
        "stage": 3,
        "generator_type": "chord",
    }

    return ToySample(spectrogram=spectrogram, onset_labels=onset_labels, metadata=metadata)


class ToyDataset:
    """Collection of synthetic samples from multiple generators.

    Manages sample generation, validation, and serialization.
    """

    def __init__(self, generators: List[Callable], n_per_generator: int = 10):
        self.generators = generators
        self.n_per_generator = n_per_generator
        self.samples: List[ToySample] = []

    def generate(self, noise: Optional[NoiseConfig] = None) -> "ToyDataset":
        """Run each generator n_per_generator times with random BPMs.

        Args:
            noise: Noise configuration passed to each generator.

        Returns:
            Self for chaining.
        """
        bpm_range = (120, 180)
        self.samples = []

        for gen_fn in self.generators:
            for _ in range(self.n_per_generator):
                bpm = random.uniform(*bpm_range)
                sample = gen_fn(bpm, noise=noise)
                self.samples.append(sample)

        return self

    def save(self, output_dir: str) -> None:
        """Save all samples as .npy (spectrogram) and .json (labels + metadata).

        Also creates a manifest.json mapping sample IDs to metadata.

        Args:
            output_dir: Directory to write output files.
        """
        os.makedirs(output_dir, exist_ok=True)
        manifest = {}

        for idx, sample in enumerate(self.samples):
            sample_id = idx
            base_name = f"{sample_id:04d}"

            # Save spectrogram
            np.save(os.path.join(output_dir, f"{base_name}.npy"), sample.spectrogram)

            # Save labels + metadata as JSON
            label_data = {
                "onset_labels": sample.onset_labels.tolist(),
                "metadata": sample.metadata,
            }
            with open(os.path.join(output_dir, f"{base_name}.json"), "w") as f:
                json.dump(label_data, f)

            manifest[base_name] = sample.metadata

        # Write manifest
        with open(os.path.join(output_dir, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=2)

    def validate(self) -> List[str]:
        """Run all self-tests on all samples.

        Returns:
            List of error strings. Empty list means all samples pass.
        """
        all_errors = []
        for idx, sample in enumerate(self.samples):
            errors = validate_toy_sample(sample)
            for err in errors:
                all_errors.append(f"Sample {idx}: {err}")
        return all_errors


def generate_toy_set(
    output_dir: str,
    n_per_class: int = 10,
    noise: Optional[NoiseConfig] = None,
) -> ToyDataset:
    """Create a complete toy dataset with all generator classes.

    Creates 3 generators:
    1. Metronome clicks — basic onset detection (Stages 0-1)
    2. Sustained tones — tones with duration 400-1200ms (Phase 2)
    3. Chords — 2-4 simultaneous tones (Phase 3)

    Per D-13: Sustained tones and chords exist in code now but are only
    required to pass overfit gates starting from Phase 2/3. The stage
    field in metadata tracks this.

    Args:
        output_dir: Directory for saved output (used if save() is called).
        n_per_class: Number of samples per generator class.
        noise: Noise configuration. Defaults to NoiseConfig() with standard values.

    Returns:
        A ToyDataset with all generated samples, already validated.
    """
    if noise is None:
        noise = NoiseConfig()

    generators: List[Callable] = [
        lambda bpm, noise=noise, gen=MetronomeClickGenerator(): gen.generate_sample(bpm, noise=noise),
        lambda bpm, noise=noise: _generate_sustained_tone_sample(bpm, noise=noise),
        lambda bpm, noise=noise: _generate_chord_sample(bpm, noise=noise),
    ]

    dataset = ToyDataset(generators, n_per_generator=n_per_class)
    dataset.generate(noise=noise)
    errors = dataset.validate()
    if errors:
        raise RuntimeError(
            f"Toy dataset validation failed with {len(errors)} error(s):\n"
            + "\n".join(errors[:10])
        )
    return dataset


def validate_toy_sample(sample: ToySample) -> List[str]:
    """Validate a single ToySample for correctness.

    Checks:
    - Spectrogram shape (1, 128, 400)
    - Label shape (400,)
    - Label dtype is int8 or int64
    - Labels are binary (0 or 1)
    - At least one onset present

    Args:
        sample: ToySample to validate.

    Returns:
        List of error strings. Empty list = valid.
    """
    errors: List[str] = []

    # Shape checks
    if sample.spectrogram.shape != (1, N_MELS, N_FRAMES):
        errors.append(
            f"spectrogram shape {sample.spectrogram.shape} != (1, {N_MELS}, {N_FRAMES})"
        )

    if sample.onset_labels.shape != (N_FRAMES,):
        errors.append(
            f"onset_labels shape {sample.onset_labels.shape} != ({N_FRAMES},)"
        )

    # Dtype check
    if sample.onset_labels.dtype not in (np.int8, np.int64):
        errors.append(
            f"onset_labels dtype {sample.onset_labels.dtype} not in (int8, int64)"
        )

    # Binary check
    if sample.onset_labels.max() > 1 or sample.onset_labels.min() < 0:
        errors.append(
            f"onset_labels range [{sample.onset_labels.min()}, {sample.onset_labels.max()}] "
            "not binary [0, 1]"
        )

    # At least one onset
    if sample.onset_labels.sum() == 0:
        errors.append("no onsets found (empty sample)")

    return errors
