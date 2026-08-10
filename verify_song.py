#!/usr/bin/env python3
"""Interactive spectrogram viewer for AIRhythm preprocessed chunks.

Loads normalized mel-spectrogram chunks from data/minimal_dataset/,
reconstructs audio via Griffin-Lim, and provides an Audacity-style
GUI with onset markers for verifying label alignment.
"""

from __future__ import annotations

import json
import logging
import sys
import time
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
FRAME_TIME = 220 / 22050  # ≈ 9.98ms per spectrogram frame
CHUNK_FRAMES = 400        # frames per chunk (matches config.N_FRAMES)
CHUNK_DURATION = CHUNK_FRAMES * FRAME_TIME  # ≈ 3.99s per chunk

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)


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
    active: np.ndarray = field(repr=False, default=None)  # (T,)
    onsets: np.ndarray = field(repr=False, default=None)  # (T,)
    count: np.ndarray = field(repr=False, default=None)  # (T,)
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
        logger.info("Loading: %s", self.display_name)
        self.load_metadata()
        logger.info("  beatmapset_id=%d  chunks=%d", self.beatmapset_id, self.num_chunks)
        self._load_spec_and_labels()
        logger.info("  spec=%s  onsets=%d  total_frames=%d", self.spec.shape, int(self.onsets.sum()), self.onsets.shape[0])
        if progress_cb:
            progress_cb("Loading audio...")
        self._load_original_audio()
        if self.waveform is None:
            if progress_cb:
                progress_cb("Inverting mel-spectrogram to audio...")
            self._reconstruct_audio()
        logger.info("  audio=%.1fs  waveform=%s", self.duration, self.waveform.shape)

    def _load_spec_and_labels(self) -> None:
        """Load and stitch all chunks + labels into full arrays."""
        chunks, labels = [], []
        for i in range(self.num_chunks):
            c = np.load(self.dir / f"{i:04d}.npy")  # (1, 128, 400)
            l = np.load(self.dir / f"{i:04d}_labels.npy")  # (3, 400)
            chunks.append(c)
            labels.append(l)
        full = np.concatenate(chunks, axis=2)  # (1, 128, T)
        lab = np.concatenate(labels, axis=1)  # (3, T)
        self.active = lab[0]
        self.onsets = lab[1]
        self.count = lab[2]

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

    def _load_original_audio(self) -> None:
        """Load original.audio (saved during scrape) if present."""
        f = self.dir / "original.audio"
        if not f.is_file():
            return
        try:
            import io
            self.waveform, _ = librosa.load(
                io.BytesIO(f.read_bytes()), sr=SAMPLE_RATE, mono=True
            )
            logger.info("  loaded original audio: %.1fs", self.duration)
        except Exception as exc:
            logger.warning("  original.audio load failed (%s); falling back", exc)
            self.waveform = None

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
            "active_frames": int(self.active.sum()),
            "max_count": int(self.count.max()) if self.count is not None else 0,
            "waveform_len": len(self.waveform),
            "duration": self.duration,
        }


def discover_songs() -> list[Song]:
    """Find all song dirs under DATA_DIR."""
    if not DATA_DIR.is_dir():
        logger.warning("DATA_DIR not found: %s", DATA_DIR)
        return []
    songs = []
    for d in sorted(DATA_DIR.iterdir()):
        if d.is_dir() and (d / "metadata.json").exists():
            s = Song(dir=d)
            s.load_metadata()
            songs.append(s)
    logger.info("Discovered %d songs in %s", len(songs), DATA_DIR)
    return songs


# ── GUI ──────────────────────────────────────────────────────────────

import tkinter as tk
from tkinter import ttk

PLACEHOLDER = "— Select a song —"


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
        self.play_started_at = 0.0  # wall clock when playback started
        self.chunk_idx = 0
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
        names = [s.display_name for s in self.songs]
        self.combo = ttk.Combobox(
            bar, values=[PLACEHOLDER] + names, state="readonly", width=50
        )
        self.combo.current(0)
        self.combo.pack(side=tk.LEFT, padx=8)
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

        self.prev_btn = tk.Button(
            transport, text="⏮", font=("", 12), width=3,
            bg=self.BG, fg=self.FG, relief=tk.FLAT, cursor="hand2",
            command=self._prev_chunk,
        )
        self.prev_btn.pack(side=tk.LEFT)

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
        self.play_btn.pack(side=tk.LEFT, padx=4)

        self.next_btn = tk.Button(
            transport, text="⏭", font=("", 12), width=3,
            bg=self.BG, fg=self.FG, relief=tk.FLAT, cursor="hand2",
            command=self._next_chunk,
        )
        self.next_btn.pack(side=tk.LEFT)

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

        self.chunk_label = tk.Label(
            transport, text="", bg=self.BG, fg="#e6c07b", font=("", 10)
        )
        self.chunk_label.pack(side=tk.LEFT, padx=12)

        self.status_label = tk.Label(
            transport, text="", bg=self.BG, fg="#58a6ff", font=("", 10)
        )
        self.status_label.pack(side=tk.RIGHT)

        # Bind keys
        self.root.bind("<space>", lambda e: self._toggle_play())
        self.root.bind("<Left>", lambda e: self._prev_chunk())
        self.root.bind("<Right>", lambda e: self._next_chunk())

        # Initial state: nothing loaded
        self._set_controls_enabled(False)
        if not self.songs:
            self.combo.config(state=tk.DISABLED)
            self.info_label.config(text="No songs found in data/minimal_dataset/")
            self.status_label.config(text="No songs found")
        else:
            self.status_label.config(text="Select a song")

    # ── Song loading + chunk display ─────────────────────────────────

    def _load_song(self, index: int) -> None:
        """Load song data and render first chunk."""
        if index < 0 or index >= len(self.songs):
            logger.warning("Invalid song index: %d (have %d songs)", index, len(self.songs))
            return
        if self.is_playing:
            sd.stop()
            self.is_playing = False
            self.play_btn.config(text="▶")
        self.current_time = 0.0
        self.chunk_idx = 0
        self._set_controls_enabled(False)

        self.song = self.songs[index]
        logger.info("Loading song %d/%d: %s", index + 1, len(self.songs), self.song.display_name)
        self.status_label.config(text="🔄 Loading spectrogram...")
        self.root.update()

        def _progress(msg: str) -> None:
            logger.info("  %s", msg)
            self.status_label.config(text=f"🔄 {msg}")
            self.root.update()

        self.song.load(progress_cb=_progress)
        self.seek.config(to=self.song.duration)
        self.seek.set(0.0)
        self._draw_chunk()
        self._format_time(0.0)
        self.info_label.config(
            text=f"{self.song.beatmapset_id} · {self.song.num_chunks} chunks · {self.song.duration:.1f}s"
        )
        self.status_label.config(text="✓ Ready")
        self._set_controls_enabled(True)

    def _draw_chunk(self) -> None:
        """Render the current chunk of the spectrogram with onset markers."""
        if self.song is None or self.song.spec is None:
            return
        n = max(self.song.num_chunks, 1)
        self.chunk_idx = max(0, min(self.chunk_idx, n - 1))
        t0 = self.chunk_idx * CHUNK_DURATION
        start = self.chunk_idx * CHUNK_FRAMES
        end = start + CHUNK_FRAMES

        self.ax.clear()
        self.ax.set_facecolor("#0d1117")
        self.ax.tick_params(colors="#586069", labelsize=8)
        self.ax.set_xlabel("Time (s)", color="#586069", fontsize=9)
        self.ax.set_ylabel("Mel bin", color="#586069", fontsize=9)

        chunk_spec = self.song.spec[:, start:end]
        extent = [t0, t0 + CHUNK_DURATION, 0, 128]
        self.ax.imshow(
            chunk_spec, aspect="auto", origin="lower", extent=extent, cmap="viridis"
        )

        # Onset markers: red line, orange when chord (count > 1)
        onset_idx = np.where(self.song.onsets[start:end] == 1)[0]
        self.onset_lines = []
        for fi in onset_idx:
            color = "#ffa500" if self.song.count[start + fi] > 1 else self.ONSET_COLOR
            self.onset_lines.append(
                self.ax.axvline(t0 + fi * FRAME_TIME, color=color, linewidth=0.8, alpha=0.7)
            )

        # Hold spans: green horizontal bars at plot bottom (y near 2)
        for fi in onset_idx:
            if self.song.active[start + fi] != 1:
                continue
            # find run length of active frames starting at fi
            run = 1
            while start + fi + run < end and self.song.active[start + fi + run] == 1:
                run += 1
            self.ax.barh(
                2, run * FRAME_TIME,
                left=t0 + fi * FRAME_TIME,
                height=3, color=self.CURSOR_COLOR, alpha=0.85, edgecolor="none",
            )

        # Play cursor at current song time
        self.cursor_line = self.ax.axvline(
            self.current_time, color=self.CURSOR_COLOR, linewidth=1.5
        )

        self.ax.set_xlim(t0, t0 + CHUNK_DURATION)
        self.ax.set_ylim(0, 132)  # leave room for hold bars at y=2..5
        self.chunk_label.config(text=f"Chunk {self.chunk_idx + 1}/{n}")
        self.canvas.draw()

    def _format_time(self, t: float) -> None:
        """Render MM:SS.T / MM:SS.T."""
        total = self.song.duration if self.song else 0.0
        cur = f"{int(t // 60)}:{int(t % 60):02d}.{int((t * 10) % 10)}"
        tot = f"{int(total // 60)}:{int(total % 60):02d}.{int((total * 10) % 10)}"
        self.time_label.config(text=f"{cur} / {tot}")

    def _set_controls_enabled(self, enabled: bool) -> None:
        """Enable/disable transport controls during loading."""
        state = tk.NORMAL if enabled else tk.DISABLED
        for w in (self.play_btn, self.prev_btn, self.next_btn, self.seek):
            w.config(state=state)

    # ── Playback ─────────────────────────────────────────────────────

    def _toggle_play(self) -> None:
        """Toggle playback on/off."""
        if self.song is None or self.song.waveform is None:
            logger.warning("Play pressed but no song loaded")
            return
        if self.is_playing:
            logger.info("Pause at %.1fs", self.current_time)
            sd.stop()
            self.is_playing = False
            self.play_btn.config(text="▶")
        else:
            logger.info("Play from %.1fs", self.current_time)
            start_sample = int(self.current_time * SAMPLE_RATE)
            sd.play(
                self.song.waveform[start_sample:],
                samplerate=SAMPLE_RATE,
                blocking=False,
            )
            self.is_playing = True
            self.play_started_at = time.monotonic() - self.current_time
            self.play_btn.config(text="⏸")
            self._tick()

    def _tick(self) -> None:
        """Called every 30ms during playback — update cursor, seek, chunk."""
        if not self.is_playing:
            return
        self.current_time = time.monotonic() - self.play_started_at
        duration = self.song.duration if self.song else 0.0
        if self.current_time >= duration:
            logger.info("Playback finished")
            self.current_time = 0.0
            self.is_playing = False
            self.play_btn.config(text="▶")
            self.chunk_idx = 0
            self.seek.set(0.0)
            self._draw_chunk()
            self._format_time(0.0)
            return
        new_chunk = min(int(self.current_time // CHUNK_DURATION), self.song.num_chunks - 1)
        if new_chunk != self.chunk_idx:
            self.chunk_idx = new_chunk
            self._draw_chunk()
        else:
            self._update_cursor()
        self.seek.set(self.current_time)
        self._format_time(self.current_time)
        self.root.after(30, self._tick)

    def _update_cursor(self) -> None:
        """Move play cursor to current_time."""
        if self.cursor_line is not None:
            self.cursor_line.set_xdata([self.current_time])
            self.canvas.draw_idle()

    # ── Seek and chunk navigation ────────────────────────────────────

    def _jump_to_time(self, t: float) -> None:
        """Seek to song time t, restarting playback if playing."""
        if self.song is None:
            return
        was_playing = self.is_playing
        if was_playing:
            sd.stop()
        self.current_time = max(0.0, min(t, self.song.duration))
        self.chunk_idx = min(
            int(self.current_time // CHUNK_DURATION), self.song.num_chunks - 1
        )
        self.seek.set(self.current_time)
        if was_playing:
            self.is_playing = False
            self.play_btn.config(text="▶")
            self._toggle_play()
        else:
            self._draw_chunk()
            self._format_time(self.current_time)

    def _on_seek(self, event) -> None:
        """Jump to clicked position in seek bar."""
        self._jump_to_time(self.seek.get())

    def _prev_chunk(self) -> None:
        if self.song is None:
            return
        if self.chunk_idx > 0:
            self._jump_to_time((self.chunk_idx - 1) * CHUNK_DURATION)

    def _next_chunk(self) -> None:
        if self.song is None:
            return
        if self.chunk_idx < self.song.num_chunks - 1:
            self._jump_to_time((self.chunk_idx + 1) * CHUNK_DURATION)

    # ── Song switching ───────────────────────────────────────────────

    def _on_song_change(self, event) -> None:
        """Switch to a different song, or clear if placeholder selected."""
        idx = self.combo.current()
        if idx == 0:  # placeholder -> unload
            if self.is_playing:
                logger.info("Stopping playback")
                sd.stop()
                self.is_playing = False
                self.play_btn.config(text="▶")
            self.song = None
            self.current_time = 0.0
            self._set_controls_enabled(False)
            self.ax.clear()
            self.canvas.draw()
            self.time_label.config(text="00:00.0 / 00:00.0")
            self.chunk_label.config(text="")
            self.info_label.config(text="")
            self.status_label.config(text="Select a song")
            return

        if self.is_playing:
            logger.info("Stopping playback for song switch")
            sd.stop()
            self.is_playing = False
            self.play_btn.config(text="▶")

        logger.info("Switching to song index %d", idx - 1)
        self.status_label.config(text="🔄 Loading + reconstructing...")
        self.root.update()

        try:
            self._load_song(idx - 1)
        except Exception as e:
            logger.error("Load failed for index %d: %s", idx - 1, e)
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
        onset_times = np.where(s.onsets == 1)[0] * FRAME_TIME
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
