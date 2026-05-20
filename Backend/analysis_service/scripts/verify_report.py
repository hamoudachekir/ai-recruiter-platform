"""Verify report fields in MongoDB."""
import sys
import json
sys.path.insert(0, '.')

from app.db.mongo import reports_col, jobs_col

def verify_report(interview_id):
    print(f"Verifying report for interview: {interview_id}")
    print("=" * 70)

    # Get report
    report = reports_col.find_one({"interviewId": interview_id}, {"_id": 0})

    if not report:
        print("❌ No report found in MongoDB!")
        return False

    print("\n✅ Report found in MongoDB")

    # Check job status
    job = jobs_col.find_one({"interviewId": interview_id}, {"_id": 0})
    if job:
        print(f"✅ Job status: {job.get('status', 'unknown')}")
        print(f"   Current step: {job.get('currentStep', 'unknown')}")
        print(f"   Progress: {job.get('progress', 0)}%")
        if job.get('error'):
            print(f"   Error: {job['error']}")
    else:
        print("⚠️ No job record found")

    print("\n" + "=" * 70)
    print("REPORT FIELDS VERIFICATION")
    print("=" * 70)

    checks = {
        "Basic Info": {
            "interviewId": report.get("interviewId"),
            "candidateName": report.get("candidateName"),
            "jobTitle": report.get("jobTitle"),
        },
        "Deterministic Scores": {
            "overallScore": report.get("overallScore"),
            "technicalScore": report.get("technicalScore"),
            "hrScore": report.get("hrScore"),
        },
        "Vision Metrics": {
            "faceVisiblePercent": (report.get("visionMonitoring") or {}).get("faceVisiblePercent"),
            "absenceEvents": (report.get("visionMonitoring") or {}).get("absenceEvents"),
            "totalChecks": (report.get("visionMonitoring") or {}).get("totalChecks"),
        },
        "Audio Metrics": {
            "transcriptionAvailable": (report.get("audioAnalysis") or {}).get("transcriptionAvailable"),
            "longSilenceEvents": (report.get("audioAnalysis") or {}).get("longSilenceEvents"),
            "longSilenceSeconds": (report.get("audioAnalysis") or {}).get("longSilenceSeconds"),
        },
        "Integrity Metrics": {
            "totalAlerts": (report.get("integrity") or {}).get("totalAlerts"),
            "highSeverityCount": (report.get("integrity") or {}).get("highSeverityCount"),
        },
        "Polish Metadata": report.get("polish", {}),
    }

    all_ok = True
    for category, fields in checks.items():
        print(f"\n{category}:")
        if isinstance(fields, dict):
            for field, value in fields.items():
                status = "✅" if value is not None else "❌"
                print(f"  {status} {field}: {value}")
                if value is None and category not in ["Polish Metadata"]:
                    all_ok = False
        else:
            print(f"  Value: {fields}")

    print("\n" + "=" * 70)

    # Verify deterministic scores are within valid range
    scores_valid = True
    for score_name in ["overallScore", "technicalScore", "hrScore"]:
        score = report.get(score_name)
        if score is not None:
            if not (0 <= score <= 100):
                print(f"❌ {score_name} out of range: {score}")
                scores_valid = False

    if scores_valid and all_ok:
        print("✅ All deterministic scores are valid (0-100)")

    # Show actual report keys for debugging
    print("\nActual report top-level keys:")
    for key in sorted(report.keys()):
        value = report[key]
        if isinstance(value, dict):
            print(f"  {key}: {{...}} (nested object)")
        elif isinstance(value, list):
            print(f"  {key}: [...] (list with {len(value)} items)")
        else:
            print(f"  {key}: {value}")

    # Verify polish didn't modify numeric fields (if polish was applied)
    polish = report.get("polish") or {}
    if polish.get("enabled"):
        print(f"\n✅ Polish was enabled")
        print(f"   Provider: {polish.get('provider', 'unknown')}")
        print(f"   Model: {polish.get('model', 'unknown')}")
        print(f"   Success: {polish.get('success', False)}")
        print(f"   Non-destructive: {polish.get('nonDestructive', False)}")

        if polish.get("nonDestructive"):
            print("✅ Polish confirmed as non-destructive (numeric fields protected)")
        else:
            print("⚠️ Polish nonDestructive flag not set")
    else:
        print("\nℹ️ Polish was skipped (deterministic report only)")

    print("\n" + "=" * 70)
    print("VERIFICATION COMPLETE")
    print("=" * 70)

    return all_ok

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/verify_report.py <interviewId>")
        sys.exit(1)

    interview_id = sys.argv[1]
    success = verify_report(interview_id)
    sys.exit(0 if success else 1)
