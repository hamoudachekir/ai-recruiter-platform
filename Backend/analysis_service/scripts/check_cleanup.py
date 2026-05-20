"""Check cleanup of temporary files."""
import sys
from pathlib import Path
sys.path.insert(0, '.')

from app.core.config import UPLOADS_DIR, ANALYSIS_DIR

def check_cleanup(interview_id):
    print(f"Checking cleanup for interview: {interview_id}")
    print("=" * 70)

    # Expected temp file locations
    temp_audio = ANALYSIS_DIR / "analysis" / f"{interview_id}_audio.wav"
    temp_frames = ANALYSIS_DIR / "analysis" / f"{interview_id}_frames"

    # Original video location
    video_dir = UPLOADS_DIR / interview_id / "raw"
    video_files = list(video_dir.glob("*")) if video_dir.exists() else []

    print("\nTemporary files (should be DELETED after analysis):")
    print(f"  Audio file: {temp_audio}")
    print(f"    Status: {'❌ EXISTS (not cleaned)' if temp_audio.exists() else '✅ Deleted (cleaned up)'}")
    print()
    print(f"  Frames dir: {temp_frames}")
    print(f"    Status: {'❌ EXISTS (not cleaned)' if temp_frames.exists() else '✅ Deleted (cleaned up)'}")

    print("\nOriginal video (should be PRESERVED):")
    if video_files:
        for vf in video_files:
            print(f"  ✅ PRESERVED: {vf}")
    else:
        print(f"  ⚠️ No video files found in {video_dir}")

    print("\n" + "=" * 70)

    # Overall status
    audio_cleaned = not temp_audio.exists()
    frames_cleaned = not temp_frames.exists()
    video_preserved = len(video_files) > 0

    if audio_cleaned and frames_cleaned and video_preserved:
        print("✅ CLEANUP WORKING CORRECTLY")
        print("   - Temp audio deleted")
        print("   - Temp frames deleted")
        print("   - Original video preserved")
    elif not audio_cleaned or not frames_cleaned:
        print("⚠️  CLEANUP INCOMPLETE")
        if not audio_cleaned:
            print("   - Temp audio still exists")
        if not frames_cleaned:
            print("   - Temp frames still exists")
    else:
        print("⚠️  Original video not found (may have been moved/deleted)")

    print("=" * 70)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/check_cleanup.py <interviewId>")
        sys.exit(1)
    check_cleanup(sys.argv[1])
