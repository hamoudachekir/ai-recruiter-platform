"""Deep inspection of report structure."""
import sys
import json
sys.path.insert(0, '.')

from app.db.mongo import reports_col

def inspect_nested(data, indent=0):
    """Recursively inspect nested structure."""
    prefix = "  " * indent
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, dict):
                print(f"{prefix}{key}: {{...}}")
                inspect_nested(value, indent + 1)
            elif isinstance(value, list):
                print(f"{prefix}{key}: [...] ({len(value)} items)")
                if value and indent < 2:
                    print(f"{prefix}  [0]:")
                    inspect_nested(value[0], indent + 2)
            else:
                print(f"{prefix}{key}: {value}")
    else:
        print(f"{prefix}{data}")

def main(interview_id):
    print(f"Inspecting report for: {interview_id}")
    print("=" * 70)

    report = reports_col.find_one({"interviewId": interview_id}, {"_id": 0})

    if not report:
        print("No report found!")
        return

    # Inspect nested objects
    for key in ['technicalEvaluation', 'visionMonitoring', 'audioAnalysis', 'integrityAlerts']:
        value = report.get(key)
        if value:
            print(f"\n{key}:")
            if isinstance(value, list):
                print(f"  List with {len(value)} items")
                if value:
                    print("  First item:")
                    inspect_nested(value[0], 2)
            else:
                inspect_nested(value, 1)
            print("-" * 70)

    # Show polish status
    polish = report.get('polish')
    print(f"\npolish: {polish}")

    # Show scores
    print(f"\nScores:")
    print(f"  overallScore: {report.get('overallScore')}")
    if report.get('technicalEvaluation'):
        tech = report['technicalEvaluation']
        if isinstance(tech, dict):
            print(f"  technicalEvaluation.score: {tech.get('score')}")
    print(f"  hrScore: {report.get('hrScore')}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/inspect_report.py <interviewId>")
        sys.exit(1)
    main(sys.argv[1])
