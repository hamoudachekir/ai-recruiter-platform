"""Tests for backend media service helpers.

These tests run in the Python analysis_service environment and validate
the helper functions used by mediaService.js (ported to Python for
testability of the same logic).

Covers:
 1. validateFrameName blocks path traversal
 2. validateFrameName only allows safe image extensions
 3. safePath returns None on traversal
 4. safePath allows valid sub-paths
 5. getInterviewMedia returns available=False for missing dir
 6. getInterviewMedia detects video, audio, frames correctly
 7. No frames returned for empty frames dir
"""

import os
import sys
from pathlib import Path

import pytest

# ──────────────────────────────────────────────────────────────────────────────
# Pure-Python re-implementation of the Node.js helpers for testability.
# This mirrors the exact logic in mediaService.js so the test suite
# validates the same business rules without requiring a Node process.
# ──────────────────────────────────────────────────────────────────────────────

VIDEO_EXTENSIONS = {".webm", ".mp4", ".mkv", ".mov"}
FRAME_EXTENSIONS = {".jpg", ".jpeg", ".png"}

MIME_TYPES = {
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".wav": "audio/wav",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
}

import re as _re


def validate_frame_name(name: str) -> bool:
    """Python port of mediaService.validateFrameName."""
    if not name:
        return False
    if ".." in name or "/" in name or "\\" in name:
        return False
    if not _re.match(r"^[a-zA-Z0-9_\-\.]+$", name):
        return False
    ext = Path(name).suffix.lower()
    return ext in FRAME_EXTENSIONS


def safe_path(base: str, *parts: str) -> str | None:
    """Python port of mediaService.safePath.

    Matches the Node.js implementation exactly:
      const resolved = path.resolve(base);
      const joined   = path.join(resolved, ...parts);
      if (!joined.startsWith(resolved)) return null;

    Node's path.join normalises '..', so we must call Path.resolve()
    on the joined result to collapse any '..' segments before comparing.
    """
    resolved_base = str(Path(base).resolve())
    # Join then resolve so '..' segments collapse the same way Node does
    joined_resolved = str((Path(resolved_base).joinpath(*parts)).resolve())
    if not joined_resolved.startswith(resolved_base):
        return None
    return joined_resolved


def get_interview_media(interviews_root: str, interview_id: str) -> dict:
    """Python port of mediaService.getInterviewMedia."""
    interview_dir = Path(interviews_root) / str(interview_id)
    raw_dir = interview_dir / "raw"
    analysis_dir = interview_dir / "analysis"
    frames_dir = analysis_dir / "frames"

    # Video
    video_file = None
    video_available = False
    video_size_mb = 0.0
    if raw_dir.exists():
        for f in raw_dir.iterdir():
            if f.suffix.lower() in VIDEO_EXTENSIONS:
                video_file = f.name
                video_size_mb = round(f.stat().st_size / (1024 * 1024), 2)
                video_available = True
                break

    # Audio
    audio_path = analysis_dir / "audio.wav"
    audio_available = audio_path.exists()

    # Frames
    frames = []
    if frames_dir.exists():
        frame_files = sorted(
            f.name for f in frames_dir.iterdir() if f.suffix.lower() in FRAME_EXTENSIONS
        )[:50]
        frames = [{"filename": f, "index": i + 1} for i, f in enumerate(frame_files)]

    return {
        "available": video_available or audio_available or len(frames) > 0,
        "interviewId": str(interview_id),
        "video": {
            "available": video_available,
            "filename": video_file,
            "sizeMb": video_size_mb,
        },
        "audio": {
            "available": audio_available,
            "filename": "audio.wav" if audio_available else None,
        },
        "frames": frames,
        "frameCount": len(frames),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Tests
# ──────────────────────────────────────────────────────────────────────────────


class TestValidateFrameName:
    """Security: frame name validation."""

    def test_valid_jpg(self):
        assert validate_frame_name("frame_0001.jpg") is True

    def test_valid_png(self):
        assert validate_frame_name("frame-002.png") is True

    def test_valid_jpeg(self):
        assert validate_frame_name("snap.jpeg") is True

    def test_blocks_path_traversal_dotdot(self):
        assert validate_frame_name("../../etc/passwd") is False

    def test_blocks_path_traversal_slash(self):
        assert validate_frame_name("subdir/frame.jpg") is False

    def test_blocks_backslash(self):
        assert validate_frame_name("subdir\\frame.jpg") is False

    def test_blocks_dotdot_only(self):
        assert validate_frame_name("..") is False

    def test_blocks_disallowed_extension(self):
        assert validate_frame_name("shell.php") is False

    def test_blocks_video_extension(self):
        assert validate_frame_name("video.webm") is False

    def test_blocks_empty_string(self):
        assert validate_frame_name("") is False

    def test_blocks_null_bytes(self):
        # Null byte injection attempt
        assert validate_frame_name("frame.jpg\x00.php") is False

    def test_blocks_special_chars(self):
        assert validate_frame_name("frame;rm -rf /.jpg") is False

    def test_blocks_space_in_name(self):
        # Space is not in the allowed char set
        assert validate_frame_name("my frame.jpg") is False


class TestSafePath:
    """Security: path traversal prevention."""

    def test_valid_subpath_allowed(self, tmp_path):
        base = str(tmp_path)
        result = safe_path(base, "interview123", "frames", "frame_001.jpg")
        assert result is not None
        assert result.startswith(str(Path(base).resolve()))

    def test_traversal_blocked_double_dot(self, tmp_path):
        base = str(tmp_path)
        result = safe_path(base, "..", "secret.txt")
        assert result is None

    def test_traversal_blocked_deep(self, tmp_path):
        base = str(tmp_path)
        result = safe_path(base, "a", "..", "..", "etc", "passwd")
        assert result is None

    def test_same_dir_allowed(self, tmp_path):
        base = str(tmp_path)
        result = safe_path(base, "somefile.txt")
        assert result is not None

    def test_nested_sub_allowed(self, tmp_path):
        base = str(tmp_path)
        result = safe_path(base, "a", "b", "c", "d.jpg")
        assert result is not None
        assert str(Path(base).resolve()) in result


class TestGetInterviewMedia:
    """getInterviewMedia returns correct structure."""

    def test_missing_dir_returns_unavailable(self, tmp_path):
        result = get_interview_media(str(tmp_path), "nonexistent-interview")
        assert result["available"] is False
        assert result["video"]["available"] is False
        assert result["audio"]["available"] is False
        assert result["frames"] == []

    def test_detects_webm_video(self, tmp_path):
        iid = "interview-abc"
        raw_dir = tmp_path / iid / "raw"
        raw_dir.mkdir(parents=True)
        video_file = raw_dir / "recording.webm"
        video_file.write_bytes(b"fake video content" * 1000)

        result = get_interview_media(str(tmp_path), iid)
        assert result["available"] is True
        assert result["video"]["available"] is True
        assert result["video"]["filename"] == "recording.webm"
        assert result["video"]["sizeMb"] > 0

    def test_detects_mp4_video(self, tmp_path):
        iid = "interview-mp4"
        raw_dir = tmp_path / iid / "raw"
        raw_dir.mkdir(parents=True)
        (raw_dir / "interview.mp4").write_bytes(b"fake mp4" * 100)

        result = get_interview_media(str(tmp_path), iid)
        assert result["video"]["available"] is True
        assert result["video"]["filename"] == "interview.mp4"

    def test_detects_audio(self, tmp_path):
        iid = "interview-audio"
        analysis_dir = tmp_path / iid / "analysis"
        analysis_dir.mkdir(parents=True)
        (analysis_dir / "audio.wav").write_bytes(b"fake wav" * 100)

        result = get_interview_media(str(tmp_path), iid)
        assert result["available"] is True
        assert result["audio"]["available"] is True
        assert result["audio"]["filename"] == "audio.wav"

    def test_no_audio_after_cleanup(self, tmp_path):
        """Audio file was deleted by cleanup node — should show unavailable."""
        iid = "interview-noclean"
        # Only create the directory structure, no audio.wav
        analysis_dir = tmp_path / iid / "analysis"
        analysis_dir.mkdir(parents=True)

        result = get_interview_media(str(tmp_path), iid)
        assert result["audio"]["available"] is False
        assert result["audio"]["filename"] is None

    def test_detects_frames(self, tmp_path):
        iid = "interview-frames"
        frames_dir = tmp_path / iid / "analysis" / "frames"
        frames_dir.mkdir(parents=True)
        # Create 5 fake frame files
        for i in range(1, 6):
            (frames_dir / f"frame_{i:04d}.jpg").write_bytes(b"fake jpeg")

        result = get_interview_media(str(tmp_path), iid)
        assert result["available"] is True
        assert result["frameCount"] == 5
        assert len(result["frames"]) == 5
        assert result["frames"][0]["index"] == 1
        assert result["frames"][0]["filename"].endswith(".jpg")

    def test_frames_limited_to_50(self, tmp_path):
        iid = "interview-manyframes"
        frames_dir = tmp_path / iid / "analysis" / "frames"
        frames_dir.mkdir(parents=True)
        # Create 80 frames
        for i in range(1, 81):
            (frames_dir / f"frame_{i:04d}.jpg").write_bytes(b"x")

        result = get_interview_media(str(tmp_path), iid)
        assert result["frameCount"] == 50
        assert len(result["frames"]) == 50

    def test_ignores_non_image_files_in_frames_dir(self, tmp_path):
        iid = "interview-mixed"
        frames_dir = tmp_path / iid / "analysis" / "frames"
        frames_dir.mkdir(parents=True)
        (frames_dir / "frame_0001.jpg").write_bytes(b"jpeg")
        (frames_dir / "manifest.json").write_bytes(b"{}")
        (frames_dir / "hidden.php").write_bytes(b"<?php")

        result = get_interview_media(str(tmp_path), iid)
        assert result["frameCount"] == 1
        assert result["frames"][0]["filename"] == "frame_0001.jpg"

    def test_no_raw_dir_means_no_video(self, tmp_path):
        iid = "interview-noraw"
        # analysis dir exists but no raw dir
        analysis_dir = tmp_path / iid / "analysis"
        analysis_dir.mkdir(parents=True)

        result = get_interview_media(str(tmp_path), iid)
        assert result["video"]["available"] is False

    def test_raw_dir_with_unknown_extension_not_detected(self, tmp_path):
        iid = "interview-badext"
        raw_dir = tmp_path / iid / "raw"
        raw_dir.mkdir(parents=True)
        (raw_dir / "video.avi").write_bytes(b"avi")  # .avi not in VIDEO_EXTENSIONS

        result = get_interview_media(str(tmp_path), iid)
        assert result["video"]["available"] is False


class TestMimeTypes:
    """MIME type resolution."""

    def test_webm(self):
        assert MIME_TYPES[".webm"] == "video/webm"

    def test_mp4(self):
        assert MIME_TYPES[".mp4"] == "video/mp4"

    def test_wav(self):
        assert MIME_TYPES[".wav"] == "audio/wav"

    def test_jpg(self):
        assert MIME_TYPES[".jpg"] == "image/jpeg"

    def test_png(self):
        assert MIME_TYPES[".png"] == "image/png"
