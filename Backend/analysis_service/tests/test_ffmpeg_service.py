"""Tests for FFmpeg service with timeout and retry functionality.

This module tests:
- Subprocess timeout handling
- Retry logic for transient failures
- Error message structuring
- Cleanup of partial files on failure
"""
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.services.ffmpeg_service import (
    extract_audio,
    extract_frames,
    get_duration_seconds,
    run_subprocess_command,
    _cleanup_file,
    _cleanup_directory,
    FFMPEG_TIMEOUT_SEC,
    FFPROBE_TIMEOUT_SEC,
    FFMPEG_MAX_ATTEMPTS,
)


class TestRunSubprocessCommand:
    """Test the run_subprocess_command helper."""

    @patch("app.services.ffmpeg_service.subprocess.run")
    def test_success_on_first_attempt(self, mock_run):
        """Should succeed on first attempt without retries."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="output",
            stderr="",
        )

        result = run_subprocess_command(
            ["ffmpeg", "-i", "input.mp4"],
            timeout_sec=60,
            max_attempts=2,
            step="test_step",
        )

        assert result.returncode == 0
        assert mock_run.call_count == 1

    @patch("app.services.ffmpeg_service.subprocess.run")
    def test_retry_on_failure_then_success(self, mock_run):
        """Should retry on failure and succeed on second attempt."""
        mock_run.side_effect = [
            subprocess.CalledProcessError(1, "cmd", stderr="Error"),
            MagicMock(returncode=0, stdout="output", stderr=""),
        ]

        result = run_subprocess_command(
            ["ffmpeg", "-i", "input.mp4"],
            timeout_sec=60,
            max_attempts=2,
            step="test_step",
        )

        assert result.returncode == 0
        assert mock_run.call_count == 2

    @patch("app.services.ffmpeg_service.subprocess.run")
    def test_all_attempts_exhausted_raises_error(self, mock_run):
        """Should raise RuntimeError after all attempts exhausted."""
        mock_run.side_effect = subprocess.CalledProcessError(
            1, "cmd", stderr="Persistent error message"
        )

        with pytest.raises(RuntimeError) as exc_info:
            run_subprocess_command(
                ["ffmpeg", "-i", "input.mp4"],
                timeout_sec=60,
                max_attempts=2,
                step="test_step",
            )

        assert mock_run.call_count == 2
        error_str = str(exc_info.value)
        assert "subprocess_failed" in error_str
        assert "test_step" in error_str

    @patch("app.services.ffmpeg_service.subprocess.run")
    def test_timeout_error_handling(self, mock_run):
        """Should capture timeout errors with structured format."""
        mock_run.side_effect = subprocess.TimeoutExpired("cmd", 60)

        with pytest.raises(RuntimeError) as exc_info:
            run_subprocess_command(
                ["ffmpeg", "-i", "input.mp4"],
                timeout_sec=60,
                max_attempts=1,
                step="test_step",
            )

        error_str = str(exc_info.value)
        assert "subprocess_timeout" in error_str
        assert "timeoutSec" in error_str

    @patch("app.services.ffmpeg_service.subprocess.run")
    def test_stderr_truncation_in_error(self, mock_run):
        """Should include truncated stderr in error message."""
        long_stderr = "Error: " + "x" * 5000  # Very long error
        mock_run.side_effect = subprocess.CalledProcessError(
            1, "cmd", stderr=long_stderr
        )

        with pytest.raises(RuntimeError) as exc_info:
            run_subprocess_command(
                ["ffmpeg", "-i", "input.mp4"],
                timeout_sec=60,
                max_attempts=1,
                step="test_step",
            )

        error_str = str(exc_info.value)
        assert "stderr" in error_str
        # Should be truncated to ~2000 chars
        assert len(error_str) < 3000


class TestExtractAudio:
    """Test the extract_audio function with cleanup."""

    @patch("app.services.ffmpeg_service.run_subprocess_command")
    @patch("app.services.ffmpeg_service._cleanup_file")
    def test_successful_extraction(self, mock_cleanup, mock_run):
        """Should succeed without cleanup on success."""
        video_path = Path("/tmp/video.mp4")
        audio_path = Path("/tmp/audio.wav")

        extract_audio(video_path, audio_path)

        mock_run.assert_called_once()
        mock_cleanup.assert_not_called()

    @patch("app.services.ffmpeg_service.run_subprocess_command")
    @patch("app.services.ffmpeg_service._cleanup_file")
    def test_cleanup_on_failure(self, mock_cleanup, mock_run):
        """Should cleanup partial audio file on failure."""
        mock_run.side_effect = RuntimeError("Extraction failed")

        video_path = Path("/tmp/video.mp4")
        audio_path = Path("/tmp/audio.wav")

        with pytest.raises(RuntimeError):
            extract_audio(video_path, audio_path)

        mock_cleanup.assert_called_once_with(audio_path)


class TestExtractFrames:
    """Test the extract_frames function with cleanup."""

    @patch("app.services.ffmpeg_service.run_subprocess_command")
    @patch("app.services.ffmpeg_service._cleanup_directory")
    def test_successful_frame_extraction(self, mock_cleanup, mock_run):
        """Should succeed without cleanup on success."""
        video_path = Path("/tmp/video.mp4")
        frames_dir = Path("/tmp/frames")

        extract_frames(video_path, frames_dir, fps=1.0)

        mock_run.assert_called_once()
        mock_cleanup.assert_not_called()

    @patch("app.services.ffmpeg_service.run_subprocess_command")
    @patch("app.services.ffmpeg_service._cleanup_directory")
    def test_cleanup_on_failure(self, mock_cleanup, mock_run):
        """Should cleanup partial frames directory on failure."""
        mock_run.side_effect = RuntimeError("Frame extraction failed")

        video_path = Path("/tmp/video.mp4")
        frames_dir = Path("/tmp/frames")

        with pytest.raises(RuntimeError):
            extract_frames(video_path, frames_dir, fps=1.0)

        mock_cleanup.assert_called_once_with(frames_dir)


class TestGetDurationSeconds:
    """Test the get_duration_seconds function."""

    @patch("app.services.ffmpeg_service.run_subprocess_command")
    def test_successful_duration_extraction(self, mock_run):
        """Should return duration on successful ffprobe."""
        mock_run.return_value = MagicMock(
            stdout="123.456\n",
            stderr="",
            returncode=0,
        )

        video_path = Path("/tmp/video.mp4")
        duration = get_duration_seconds(video_path)

        assert duration == 123.456
        mock_run.assert_called_once()

    @patch("app.services.ffmpeg_service.run_subprocess_command")
    def test_duration_fallback_on_failure(self, mock_run):
        """Should return 0.0 on ffprobe failure."""
        mock_run.side_effect = RuntimeError("ffprobe failed")

        video_path = Path("/tmp/video.mp4")
        duration = get_duration_seconds(video_path)

        assert duration == 0.0

    @patch("app.services.ffmpeg_service.run_subprocess_command")
    def test_invalid_duration_parsing(self, mock_run):
        """Should return 0.0 on invalid duration output."""
        mock_run.return_value = MagicMock(
            stdout="invalid",
            stderr="",
            returncode=0,
        )

        video_path = Path("/tmp/video.mp4")
        duration = get_duration_seconds(video_path)

        assert duration == 0.0


class TestCleanupFunctions:
    """Test the cleanup helper functions."""

    def test_cleanup_existing_file(self, tmp_path):
        """Should delete existing file."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("content")
        assert test_file.exists()

        _cleanup_file(test_file)

        assert not test_file.exists()

    def test_cleanup_nonexistent_file(self, tmp_path):
        """Should not raise error on non-existent file."""
        test_file = tmp_path / "nonexistent.txt"

        _cleanup_file(test_file)  # Should not raise

    def test_cleanup_directory(self, tmp_path):
        """Should delete directory and contents."""
        test_dir = tmp_path / "frames"
        test_dir.mkdir()
        (test_dir / "frame_001.jpg").write_text("frame1")
        (test_dir / "frame_002.jpg").write_text("frame2")

        assert test_dir.exists()

        _cleanup_directory(test_dir)

        assert not test_dir.exists()

    def test_cleanup_nonexistent_directory(self, tmp_path):
        """Should not raise error on non-existent directory."""
        test_dir = tmp_path / "nonexistent"

        _cleanup_directory(test_dir)  # Should not raise


class TestEnvironmentConfiguration:
    """Test environment variable configuration."""

    @patch.dict("os.environ", {"FFMPEG_TIMEOUT_SEC": "120"}, clear=False)
    def test_ffmpeg_timeout_config(self):
        """FFMPEG_TIMEOUT_SEC should be configurable."""
        # Re-import to pick up new env value
        import importlib
        from app.services import ffmpeg_service
        importlib.reload(ffmpeg_service)

        assert ffmpeg_service.FFMPEG_TIMEOUT_SEC == 120

    @patch.dict("os.environ", {"FFMPEG_MAX_ATTEMPTS": "3"}, clear=False)
    def test_max_attempts_config(self):
        """FFMPEG_MAX_ATTEMPTS should be configurable."""
        import importlib
        from app.services import ffmpeg_service
        importlib.reload(ffmpeg_service)

        assert ffmpeg_service.FFMPEG_MAX_ATTEMPTS == 3

    @patch.dict("os.environ", {"FFPROBE_TIMEOUT_SEC": "30"}, clear=False)
    def test_ffprobe_timeout_config(self):
        """FFPROBE_TIMEOUT_SEC should be configurable."""
        import importlib
        from app.services import ffmpeg_service
        importlib.reload(ffmpeg_service)

        assert ffmpeg_service.FFPROBE_TIMEOUT_SEC == 30
