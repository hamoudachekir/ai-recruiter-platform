"""Verify the metadata fix is working correctly."""
import sys
sys.path.insert(0, '.')

import logging
logging.basicConfig(level=logging.INFO, format='%(message)s')

from app.services.interview_metadata import get_report_metadata, resolve_interview_metadata

def main():
    print("=" * 70)
    print("METADATA FIX VERIFICATION")
    print("=" * 70)

    # Working room with candidate
    interview_id = 'room-1778057279953-l0hmu8ldy'

    print(f"\n📝 Test Room: {interview_id}")
    print("-" * 70)

    # Get metadata
    metadata = get_report_metadata(interview_id)

    print("\n📊 RESOLVED METADATA:")
    print(f"  candidate_name:  {metadata['candidate_name']}")
    print(f"  candidate_email: {metadata['candidate_email']}")
    print(f"  job_title:       {metadata['job_title']}")
    print(f"  job_id:          {metadata['job_id']}")
    print(f"  application_id:  {metadata['application_id']}")

    # Check if using real values or fallbacks
    using_fallback_candidate = metadata['candidate_name'] == 'Candidate'
    using_fallback_job = metadata['job_title'] == 'Role'

    print("\n✅ VERIFICATION RESULTS:")

    if using_fallback_candidate:
        print("  ❌ candidate_name: Using fallback 'Candidate'")
        print("     → Room may not have candidate assigned")
    else:
        print(f"  ✅ candidate_name: Using REAL value '{metadata['candidate_name']}'")

    if using_fallback_job:
        print("  ⚠️  job_title: Using fallback 'Role'")
        print("     → Room does not have job assigned (expected for this room)")
    else:
        print(f"  ✅ job_title: Using REAL value '{metadata['job_title']}'")

    # Summary
    print("\n" + "=" * 70)
    if not using_fallback_candidate:
        print("🎉 SUCCESS: Real candidate metadata is being resolved!")
        print("   The fix is working correctly.")
    else:
        print("⚠️  WARNING: Still using fallback values.")
        print("   Check that room has candidate assigned.")

    print("=" * 70)

    # Show the detailed resolution
    print("\n📋 DETAILED RESOLUTION LOG:")
    print("-" * 70)
    # This will trigger the logging
    resolve_interview_metadata(interview_id)

if __name__ == "__main__":
    main()
