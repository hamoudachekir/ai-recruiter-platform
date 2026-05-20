"""Tests for Phase 2 improvements.

This module tests:
- Job idempotency and locking
- Cleanup of temporary files
- Vision threshold configuration
- STT fallback telemetry
- API error responses
"""
import copy
import pytest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch, Mock

# Test Phase 2 imports
def test_phase2_imports():
    """Test that all Phase 2 modules can be imported."""
    from app.core.config import (
        VISION_MIN_BRIGHTNESS,
        VISION_MAX_BRIGHTNESS,
        FACE_VISIBLE_MIN_PERCENT,
        MAX_ABSENCE_EVENTS,
    )
    from app.services.stt_service import transcribe_audio
    from app.api.routes_analysis import _check_existing_job, _atomic_start_job
    from app.services.report_graph import _cleanup_analysis_temp_files
    from app.services.vision_service import VisionThresholds

    assert VISION_MIN_BRIGHTNESS is not None
    assert VISION_MAX_BRIGHTNESS is not None
    print("Phase 2 imports: PASSED")


class TestJobIdempotency:
    """Test job idempotency and locking logic."""

    def test_check_existing_job_no_existing(self):
        """When no job exists, should_start should be True."""
        from app.api.routes_analysis import _check_existing_job

        with patch("app.api.routes_analysis.jobs_col") as mock_jobs:
            mock_jobs.find_one.return_value = None

            existing, should_start = _check_existing_job("test-interview", force=False)

            assert existing is None
            assert should_start is True
            print("Test: No existing job - PASSED")

    def test_check_existing_job_running_no_force(self):
        """When job is running and no force, should not start."""
        from app.api.routes_analysis import _check_existing_job

        with patch("app.api.routes_analysis.jobs_col") as mock_jobs:
            mock_jobs.find_one.return_value = {
                "_id": "job-123",
                "interviewId": "test-interview",
                "status": "running",
                "progress": 50,
            }

            existing, should_start = _check_existing_job("test-interview", force=False)

            assert existing is not None
            assert should_start is False
            assert existing["status"] == "running"
            print("Test: Running job without force - PASSED")

    def test_check_existing_job_running_with_force(self):
        """When job is running but force=true, should allow restart."""
        from app.api.routes_analysis import _check_existing_job

        with patch("app.api.routes_analysis.jobs_col") as mock_jobs:
            mock_jobs.find_one.return_value = {
                "_id": "job-123",
                "status": "running",
            }

            existing, should_start = _check_existing_job("test-interview", force=True)

            assert existing is not None
            assert should_start is True  # Force allows restart
            print("Test: Running job with force - PASSED")

    def test_check_existing_job_completed_no_force(self):
        """When job is completed and no force, should not start if report exists."""
        from app.api.routes_analysis import _check_existing_job

        with patch("app.api.routes_analysis.jobs_col") as mock_jobs, \
             patch("app.api.routes_analysis.reports_col") as mock_reports:

            mock_jobs.find_one.return_value = {
                "_id": "job-123",
                "status": "completed",
            }
            mock_reports.find_one.return_value = {"interviewId": "test-interview"}

            existing, should_start = _check_existing_job("test-interview", force=False)

            assert existing is not None
            assert should_start is False  # Already completed with report
            print("Test: Completed job without force - PASSED")

    def test_check_existing_job_failed_with_force(self):
        """When job failed and force=true, should allow rerun."""
        from app.api.routes_analysis import _check_existing_job

        with patch("app.api.routes_analysis.jobs_col") as mock_jobs:
            mock_jobs.find_one.return_value = {
                "_id": "job-123",
                "status": "failed",
            }

            existing, should_start = _check_existing_job("test-interview", force=True)

            assert existing is not None
            assert should_start is True  # Failed jobs can be rerun with force
            print("Test: Failed job with force - PASSED")


class TestVisionThresholds:
    """Test vision threshold configuration."""

    def test_vision_thresholds_from_config(self):
        """VisionThresholds should use values from config."""
        from app.services.vision_service import VisionThresholds
        from app.core.config import (
            VISION_MIN_BRIGHTNESS,
            VISION_MAX_BRIGHTNESS,
            VISION_CENTER_TOLERANCE_X,
        )

        vt = VisionThresholds()

        assert vt.min_brightness == VISION_MIN_BRIGHTNESS
        assert vt.max_brightness == VISION_MAX_BRIGHTNESS
        assert vt.center_tolerance_x == VISION_CENTER_TOLERANCE_X
        print("Test: Vision thresholds from config - PASSED")

    def test_vision_thresholds_custom_values(self):
        """VisionThresholds should accept custom values."""
        from app.services.vision_service import VisionThresholds

        vt = VisionThresholds(
            min_brightness=40.0,
            max_brightness=200.0,
            no_face_secs=10,
        )

        assert vt.min_brightness == 40.0
        assert vt.max_brightness == 200.0
        assert vt.no_face_secs == 10
        print("Test: Custom vision thresholds - PASSED")


class TestCleanupTempFiles:
    """Test cleanup of temporary analysis files."""

    def test_cleanup_file_safe_existing(self, tmp_path):
        """Should delete existing file."""
        from app.services.report_graph import _cleanup_file_safe

        test_file = tmp_path / "audio.wav"
        test_file.write_text("audio content")

        assert test_file.exists()
        result = _cleanup_file_safe(test_file)

        assert result is True
        assert not test_file.exists()
        print("Test: Cleanup existing file - PASSED")

    def test_cleanup_file_safe_nonexistent(self):
        """Should return False for non-existent file (nothing to delete)."""
        from app.services.report_graph import _cleanup_file_safe

        result = _cleanup_file_safe("/nonexistent/path/file.wav")

        # Function returns False when file doesn't exist (not an error, just nothing done)
        assert result is False
        print("Test: Cleanup non-existent file - PASSED")

    def test_cleanup_directory_safe_existing(self, tmp_path):
        """Should delete directory and contents."""
        from app.services.report_graph import _cleanup_directory_safe

        test_dir = tmp_path / "frames"
        test_dir.mkdir()
        (test_dir / "frame_001.jpg").write_text("frame1")
        (test_dir / "frame_002.jpg").write_text("frame2")

        assert test_dir.exists()
        result = _cleanup_directory_safe(test_dir)

        assert result is True
        assert not test_dir.exists()
        print("Test: Cleanup directory - PASSED")

    def test_cleanup_analysis_temp_files(self, tmp_path):
        """Should cleanup both audio and frames."""
        from app.services.report_graph import _cleanup_analysis_temp_files

        # Create temp files
        audio_file = tmp_path / "audio.wav"
        audio_file.write_text("audio")
        frames_dir = tmp_path / "frames"
        frames_dir.mkdir()
        (frames_dir / "frame.jpg").write_text("frame")

        state = {
            "interview_id": "test-123",
            "audio_path": str(audio_file),
            "frames_dir": str(frames_dir),
        }

        with patch("app.services.report_graph.ANALYSIS_CLEANUP_TEMP_FILES", True):
            result = _cleanup_analysis_temp_files(state)

        assert result["cleanup_result"]["audio_deleted"] is True
        assert result["cleanup_result"]["frames_deleted"] is True
        assert not audio_file.exists()
        assert not frames_dir.exists()
        print("Test: Cleanup temp files - PASSED")

    def test_cleanup_skipped_when_disabled(self, tmp_path):
        """Should skip cleanup when disabled."""
        from app.services.report_graph import _cleanup_analysis_temp_files

        audio_file = tmp_path / "audio.wav"
        audio_file.write_text("audio")

        state = {
            "interview_id": "test-123",
            "audio_path": str(audio_file),
        }

        with patch("app.services.report_graph.ANALYSIS_CLEANUP_TEMP_FILES", False):
            result = _cleanup_analysis_temp_files(state)

        assert result == {}  # Empty result when skipped
        assert audio_file.exists()  # File should still exist
        print("Test: Cleanup skipped - PASSED")


class TestSTTFallbackTelemetry:
    """Test STT fallback telemetry."""

    def test_stt_fallback_when_import_fails(self):
        """Should return fallback telemetry when import fails."""
        from app.services.stt_service import transcribe_audio

        with patch("builtins.__import__", side_effect=ImportError("No module named faster_whisper")):
            result = transcribe_audio(Path("/tmp/audio.wav"), "base", "cpu", "int8")

        assert result["transcriptionAvailable"] is False
        assert result["sttFallback"] is True
        assert result["sttFallbackReason"] == "faster_whisper_unavailable"
        assert result["fullText"] == ""
        print("Test: STT fallback on import error - PASSED")

    @pytest.mark.skip(reason="Requires faster-whisper to be installed - tested in integration")
    def test_stt_success(self):
        """Should return success telemetry when transcription works.

        Note: This test requires faster-whisper to be installed.
        In unit tests we can't easily mock the local import.
        This is covered by integration tests.
        """
        pass


class TestAPIErrorResponses:
    """Test API error response formatting."""

    def test_build_error_response_basic(self):
        """Should build structured error response."""
        from app.api.routes_analysis import _build_error_response

        result = _build_error_response(
            job_id="job-123",
            status="failed",
            code="ffmpeg_failed",
            message="Audio extraction failed",
        )

        assert result["success"] is False
        assert result["jobId"] == "job-123"
        assert result["status"] == "failed"
        assert result["error"]["code"] == "ffmpeg_failed"
        assert result["error"]["message"] == "Audio extraction failed"
        print("Test: Error response basic - PASSED")

    def test_build_error_response_with_step(self):
        """Should include step in error response when provided."""
        from app.api.routes_analysis import _build_error_response

        result = _build_error_response(
            job_id="job-123",
            status="failed",
            code="subprocess_timeout",
            message="FFmpeg timed out",
            step="extract_audio",
        )

        assert result["error"]["code"] == "subprocess_timeout"
        assert result["error"]["step"] == "extract_audio"
        print("Test: Error response with step - PASSED")


class TestConfigEnvironmentVariables:
    """Test that environment variables affect config."""

    def test_vision_threshold_env_vars(self):
        """Vision thresholds should be configurable via env vars."""
        import os

        # Set custom values
        original_min = os.environ.get("VISION_MIN_BRIGHTNESS")
        os.environ["VISION_MIN_BRIGHTNESS"] = "45.0"

        try:
            # Need to reimport to pick up new values
            import importlib
            from app.core import config
            importlib.reload(config)

            assert config.VISION_MIN_BRIGHTNESS == 45.0
        finally:
            # Restore original
            if original_min is not None:
                os.environ["VISION_MIN_BRIGHTNESS"] = original_min
            else:
                os.environ.pop("VISION_MIN_BRIGHTNESS", None)

        print("Test: Vision threshold env vars - PASSED")


if __name__ == "__main__":
    print("\n=== Phase 2 Feature Tests ===\n")

    test_phase2_imports()

    # Job idempotency tests
    test_job = TestJobIdempotency()
    test_job.test_check_existing_job_no_existing()
    test_job.test_check_existing_job_running_no_force()
    test_job.test_check_existing_job_running_with_force()
    test_job.test_check_existing_job_completed_no_force()
    test_job.test_check_existing_job_failed_with_force()

    # Vision threshold tests
    test_vision = TestVisionThresholds()
    test_vision.test_vision_thresholds_from_config()
    test_vision.test_vision_thresholds_custom_values()

    # API error tests
    test_api = TestAPIErrorResponses()
    test_api.test_build_error_response_basic()
    test_api.test_build_error_response_with_step()

    print("\n=== All Phase 2 Tests PASSED ===\n")
