#!/usr/bin/env python3
"""Interactive spectrogram viewer for AIRhythm preprocessed chunks.

Loads normalized mel-spectrogram chunks from data/minimal_dataset/,
reconstructs audio via Griffin-Lim, and provides an Audacity-style
GUI with onset markers for verifying label alignment.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import sounddevice as sd
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

import librosa

DATA_DIR = Path("data/minimal_dataset")
SAMPLE_RATE = 22050


# ── Data loading ─────────────────────────────────────────────────────


@dataclass
class Song:
    """One preprocessed song: loaded chunks, labels, metadata."""

    dir: Path
    title: str = ""
    artist: str = ""
    beatmapset_id: int = 0
    difficulty_name: str = ""
    num_chunks: int = 0

    # Lazy-loaded
    spec: np.ndarray = field(repr=False, default=None)  # (128, T)
    onsets: np.ndarray = field(repr=False, default=None)  # (T,)
    waveform: np.ndarray = field(repr=False, default=None)  # (N,)

    def load_metadata(self) -> None:
        meta = json.loads((self.dir / "metadata.json").read_text())
        self.title = meta.get("title", "Unknown")
        self.artist = meta.get("artist", "Unknown")
        self.beatmapset_id = meta.get("beatmapset_id", 0)
        self.difficulty_name = meta.get("difficulty_name", "")
        self.num_chunks = meta.get("num_chunks", 0)

    def load(self, progress_cb=None) -> None:
        """Load, stitch, and invert to waveform."""
        self.load_metadata()
        self._load_spec_and_onsets()
        if progress_cb:
            progress_cb("Inverting mel-spectrogram to audio...")
        self._reconstruct_audio()

    def _load_spec_and_onsets(self) -> None:
        """Load and stitch all chunks + labels into full arrays."""
        chunks, labels = [], []
        for i in range(self.num_chunks):
            c = np.load(self.dir / f"{i:04d}.npy")  # (1, 128, 400)
            l = np.load(self.dir / f"{i:04d}_labels.npy")  # (400,)
            chunks.append(c)
            labels.append(l)
        # Concatenate along time axis
        full = np.concatenate(chunks, axis=2)  # (1, 128, T)
        self.onsets = np.concatenate(labels)  # (T,)

        # De-normalize: each chunk was normalized to mean 0 / std 1 per-chunk.
        # Residual mean/std of the concatenated array is near 0/1, so this
        # gives us back ~log1p(mel-power).
        mean = full.mean()
        std = full.std() + 1e-8
        raw_db = full * std + mean
        # Undo log1p -> power mel
        power = np.expm1(raw_db.clip(min=-10, max=40))
        self.spec = power[0].astype(np.float64)  # (128, T)

    def _reconstruct_audio(self) -> None:
        """Griffin-Lim from mel power spectrogram.

        Uses hop_length=220 to match preprocessing (config.HOP_LENGTH),
        ensuring reconstructed audio duration matches the spectrogram
        time axis for cursor alignment.
        """
        self.waveform = librosa.feature.inverse.mel_to_audio(
            self.spec, sr=SAMPLE_RATE, hop_length=220
        )

    @property
    def duration(self) -> float:
        if self.waveform is None:
            return 0.0
        return len(self.waveform) / SAMPLE_RATE

    @property
    def display_name(self) -> str:
        return f"{self.title} — {self.artist}"

    def check(self) -> dict:
        """Return reconstruction diagnostics."""
        if self.waveform is None:
            return {"status": "not loaded"}
        return {
            "status": "ok",
            "spec_shape": self.spec.shape,
            "spec_range": (float(self.spec.min()), float(self.spec.max())),
            "onsets": int(self.onsets.sum()),
            "waveform_len": len(self.waveform),
            "duration": self.duration,
        }


def discover_songs() -> list[Song]:
    """Find all song dirs under DATA_DIR."""
    if not DATA_DIR.is_dir():
        return []
    songs = []
    for d in sorted(DATA_DIR.iterdir()):
        if d.is_dir() and (d / "metadata.json").exists():
            s = Song(dir=d)
            s.load_metadata()
            songs.append(s)
    return songs


# ── GUI skeleton ─────────────────────────────────────────────────────

import tkinter as tk
from tkinter import ttk


class SpectrogramViewer:
    """Main application window."""

    # Dark theme colors
    BG = "#1a1a2e"
    FG = "#e0e0e0"
    ACCENT = "#e94560"
    CURSOR_COLOR = "#7cfc00"
    ONSET_COLOR = "#ff6b6b"

    def __init__(self) -> None:
        self.songs = discover_songs()
        self.song: Optional[Song] = None
        self.is_playing = False
        self.current_time = 0.0
        self.cursor_line = None
        self.onset_lines: list = []

        # Build window
        self.root = tk.Tk()
        self.root.title("verify_song.py — Spectrogram Viewer")
        self.root.configure(bg=self.BG)
        self.root.geometry("1100x720")
        self.root.minsize(800, 500)

        # ---- Song selector bar ----
        bar = tk.Frame(self.root, bg=self.BG)
        bar.pack(fill=tk.X, padx=12, pady=(12, 4))

        tk.Label(bar, text="Song:", bg=self.BG, fg=self.FG).pack(side=tk.LEFT)
        self.song_var = tk.StringVar()
        names = [s.display_name for s in self.songs]
        self.combo = ttk.Combobox(
            bar, values=names, state="readonly", width=50
        )
        self.combo.pack(side=tk.LEFT, padx=8)
        if names:
            self.combo.current(0)
        self.combo.bind("<<ComboboxSelected>>", self._on_song_change)

        self.info_label = tk.Label(
            bar, text="", bg=self.BG, fg="#8892b0", font=("", 11)
        )
        self.info_label.pack(side=tk.LEFT, padx=12)

        # ---- Spectrogram canvas ----
        self.fig = Figure(figsize=(10, 4), dpi=100)
        self.fig.patch.set_facecolor(self.BG)
        self.ax = self.fig.add_subplot(111)
        self.ax.set_facecolor("#0d1117")
        self.ax.tick_params(colors="#586069", labelsize=8)
        self.ax.set_xlabel("Time (s)", color="#586069", fontsize=9)
        self.ax.set_ylabel("Mel bin", color="#586069", fontsize=9)

        self.canvas = FigureCanvasTkAgg(self.fig, master=self.root)
        self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True, padx=12, pady=4)
        self.canvas.draw()

        # ---- Transport bar ----
        transport = tk.Frame(self.root, bg=self.BG)
        transport.pack(fill=tk.X, padx=12, pady=(0, 12))

        self.play_btn = tk.Button(
            transport,
            text="▶",
            font=("", 14),
            width=3,
            bg=self.ACCENT,
            fg="white",
            activebackground="#ff6b6b",
            relief=tk.FLAT,
            cursor="hand2",
            command=self._toggle_play,
        )
        self.play_btn.pack(side=tk.LEFT)

        # Seek bar
        self.seek = ttk.Scale(transport, from_=0, to=100, orient=tk.HORIZONTAL)
        self.seek.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=12)
        self.seek.bind("<ButtonRelease-1>", self._on_seek)

        self.time_label = tk.Label(
            transport,
            text="00:00.0 / 00:00.0",
            bg=self.BG,
            fg=self.FG,
            font=("Courier New", 12),
        )
        self.time_label.pack(side=tk.LEFT)

        # Loading indicator
        self.status_label = tk.Label(
            transport, text="", bg=self.BG, fg="#58a6ff", font=("", 10)
        )
        self.status_label.pack(side=tk.RIGHT)

        # Bind keys
        self.root.bind("<space>", lambda e: self._toggle_play())

        # Empty state guard
        if not self.songs:
            self.info_label.config(text="No songs found in data/minimal_dataset/")
            self.play_btn.config(state=tk.DISABLED)
            self.combo.config(state=tk.DISABLED)
        else:
            self._load_song(0)

    # ── Song loading + spectrogram display ────────────────────────────

    def _load_song(self, index: int) -> None:
        """Load song data and render its spectrogram."""
        if index < 0 or index >= len(self.songs):
            return
        self.is_playing = False
        self.play_btn.config(text="▶")
        self.current_time = 0.0
        self._clear_onset_lines()

        self.song = self.songs[index]
        self.status_label.config(text="🔄 Loading spectrogram...")
        self.root.update()

        def _progress(msg: str) -> None:
            self.status_label.config(text=f"🔄 {msg}")
            self.root.update()

        self.song.load(progress_cb=_progress)
        self._draw_spectrogram()

        self.seek.config(to=self.song.duration)
        self._format_time(0.0)
        self.info_label.config(
            text=f"{self.song.beatmapset_id} · {self.song.num_chunks} chunks · {self.song.duration:.1f}s"
        )
        self.status_label.config(text="✓ Ready")

    def _clear_onset_lines(self) -> None:
        for l in self.onset_lines:
            l.remove()
        self.onset_lines.clear()
        if self.cursor_line is not None:
            self.cursor_line.remove()
            self.cursor_line = None

    def _draw_spectrogram(self) -> None:
        """Render the mel-spectrogram and onset markers."""
        if self.song is None or self.song.spec is None:
            return
        self.ax.clear()
        self.ax.set_facecolor("#0d1117")
        self.ax.tick_params(colors="#586069", labelsize=8)
        self.ax.set_xlabel("Time (s)", color="#586069", fontsize=9)
        self.ax.set_ylabel("Mel bin", color="#586069", fontsize=9)

        n_frames = self.song.spec.shape[1]
        frame_time = 220 / 22050
        extent = [0, n_frames * frame_time, 0, 128]

        self.ax.imshow(
            self.song.spec,
            aspect="auto",
            origin="lower",
            extent=extent,
            cmap="viridis",
        )

        # Onset markers
        onset_times = np.where(self.song.onsets == 1)[0] * frame_time
        self.onset_lines = [
            self.ax.axvline(t, color=self.ONSET_COLOR, linewidth=0.8, alpha=0.7)
            for t in onset_times
        ]

        self.cursor_line = self.ax.axvline(
            0, color=self.CURSOR_COLOR, linewidth=1.5
        )

        self.ax.set_xlim(0, extent[1])
        self.canvas.draw()

    def _format_time(self, t: float) -> None:
        """Render MM:SS.T / MM:SS.T."""
        total = self.song.duration if self.song else 0.0
        cur = f"{int(t // 60)}:{int(t % 60):02d}.{int((t * 10) % 10)}"
        tot = f"{int(total // 60)}:{int(total % 60):02d}.{int((total * 10) % 10)}"
        self.time_label.config(text=f"{cur} / {tot}")

    # ── Play/Pause and seek ──────────────────────────────────────────

    def _toggle_play(self) -> None:
        """Toggle playback on/off."""
        if self.song is None or self.song.waveform is None:
            return
        if self.is_playing:
            sd.stop()
            self.is_playing = False
            self.play_btn.config(text="▶")
        else:
            start_sample = int(self.current_time * SAMPLE_RATE)
            sd.play(
                self.song.waveform[start_sample:],
                samplerate=SAMPLE_RATE,
                blocking=False,
            )
            self.is_playing = True
            self.play_btn.config(text="⏸")
            self._tick()

    def _on_seek(self, event) -> None:
        """Jump to clicked position in seek bar."""
        was_playing = self.is_playing
        if was_playing:
            sd.stop()
        self.current_time = self.seek.get()
        if was_playing:
            start_sample = int(self.current_time * SAMPLE_RATE)
            sd.play(
                self.song.waveform[start_sample:],
                samplerate=SAMPLE_RATE,
                blocking=False,
            )
            self.is_playing = True
            self.play_btn.config(text="⏸")
            self._tick()
        self._update_cursor()
        self._format_time(self.current_time)

    def _tick(self) -> None:
        """Called every 30ms during playback — update cursor + time."""
        if not self.is_playing:
            return
        try:
            pos = sd.get_stream().time
            self.current_time = pos
        except Exception:
            self.current_time = self.seek.get()
        if self.current_time >= (self.song.duration if self.song else 0):
            self.current_time = 0.0
            self.is_playing = False
            self.play_btn.config(text="▶")
        self._update_cursor()
        self._format_time(self.current_time)
        if self.is_playing:
            self.root.after(30, self._tick)

    def _update_cursor(self) -> None:
        """Move play cursor to current_time."""
        if self.cursor_line is not None:
            self.cursor_line.set_xdata([self.current_time])
            self.canvas.draw_idle()

    # ── Song switching ────────────────────────────────────────────────

    def _on_song_change(self, event) -> None:
        """Switch to a different song."""
        idx = self.combo.current()
        if idx < 0:
            return
        if self.is_playing:
            sd.stop()
            self.is_playing = False
            self.play_btn.config(text="▶")

        self.status_label.config(text="🔄 Loading + reconstructing...")
        self.root.update()

        try:
            self._load_song(idx)
            self.status_label.config(text="✓ Ready")
        except Exception as e:
            self.status_label.config(text="✗ Load failed")
            self.info_label.config(text=f"Error: {e}")

    def run(self) -> None:
        self.root.mainloop()


# ── CLI check mode ───────────────────────────────────────────────────


def cli_check():
    """Print onset times for all songs without launching GUI."""
    songs = discover_songs()
    if not songs:
        print("No songs found")
        return
    for s in songs:
        s.load()
        frame_time = 220 / 22050
        onset_times = np.where(s.onsets == 1)[0] * frame_time
        print(f"\n=== {s.display_name} ===")
        print(f"  Duration: {s.duration:.1f}s")
        print(f"  Onsets: {len(onset_times)}")
        if len(onset_times) > 0:
            print(f"  First 10 onset times (s): {onset_times[:10].tolist()}")
        else:
            print(f"  ** No onsets **")
        diag = s.check()
        print(f"  Spec range: [{diag['spec_range'][0]:.4f}, {diag['spec_range'][1]:.4f}]")


if __name__ == "__main__":
    if "--cli" in sys.argv:
        cli_check()
    else:
        app = SpectrogramViewer()
        app.run()
