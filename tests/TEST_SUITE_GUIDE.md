# Test Suite Guide

This guide documents the comprehensive test suite for the AI Recruiter Platform, including data auditing, integrity validation, and consistency testing.

## Test Files Overview

### 1. Orphan Data Detection

**File:** `tests/audit/orphan_detector.py`

**Purpose:** Detects orphaned/dangling references across database collections.

**Checks:**
- Snapshots without corresponding jobs
- Reports without corresponding jobs  
- Audit logs without corresponding reports
- Vision events without corresponding interviews
- Transcripts without corresponding jobs

**Usage:**
```bash
cd ai-recruiter-platform
python tests/audit/orphan_detector.py
```

**Output:** `tests/results/orphan_detection_report.json`

**Features:**
- Comprehensive orphan detection across all collections
- Cleanup suggestions with risk assessment
- Severity levels (low/medium/high)
- Sample data for verification
- Safe deletion commands

### 2. Replay Consistency Testing

**File:** `tests/audit/replay_consistency_test.py`

**Purpose:** Tests pipeline determinism by replaying reports and comparing outputs.

**Checks:**
- Deterministic fields remain consistent
- Scores match exactly on replay
- Evidence references are stable
- No drift in numeric calculations
- Field type consistency

**Usage:**
```bash
cd ai-recruiter-platform
REPLAY_TEST_LIMIT=20 python tests/audit/replay_consistency_test.py
```

**Output:** `tests/results/replay_consistency_report.json`

**Environment Variables:**
- `REPLAY_TEST_LIMIT`: Max number of reports to test (default: 10)
- `MONGO_URL`: MongoDB connection string
- `MONGO_DB_NAME`: Database name

**Features:**
- Score comparison with float tolerance (±0.01)
- Evidence map validation
- Deterministic field verification
- Pass/fail/skip status tracking

### 3. Report Integrity Validation

**File:** `tests/integrity/report_integrity_validator.py`

**Purpose:** Validates comprehensive report integrity and data quality.

**Checks:**
- ✅ Every score has evidence
- ✅ Evidence IDs exist in evidenceMap
- ✅ No hallucinated skills (against known skills list)
- ✅ No LLM-generated scores in deterministic fields
- ✅ Confidence values bounded [0,1]
- ✅ Decision labels valid (PASS/FAIL/REVIEW_REQUIRED)
- ✅ Metadata versions exist
- ✅ Audit hashes valid (SHA-256)

**Usage:**
```bash
cd ai-recruiter-platform
python tests/integrity/report_integrity_validator.py
```

**Output:** `tests/results/report_integrity_report.json`

**Features:**
- 8 comprehensive validation rules
- Violation tracking with details
- Known skills database validation
- Deterministic field protection
- Hash integrity verification

## Configuration

All test files support these environment variables:

```bash
export MONGO_URL="mongodb://localhost:27017"
export MONGO_DB_NAME="ai_recruiter_dev"
```

## Running All Tests

Create a runner script to execute all tests:

```bash
#!/bin/bash
# run_all_tests.sh

echo "Running Orphan Detection..."
python tests/audit/orphan_detector.py

echo "Running Replay Consistency Tests..."
python tests/audit/replay_consistency_test.py

echo "Running Report Integrity Validation..."
python tests/integrity/report_integrity_validator.py

echo "All tests complete! Check tests/results/ for reports."
```

## Understanding Results

### Orphan Detection Report

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "summary": {
    "total_checks": 5,
    "orphans_found": 2,
    "total_orphaned_records": 15
  },
  "orphans_detected": [
    {
      "type": "snapshots",
      "count": 10,
      "severity": "medium",
      "message": "Found 10 snapshots without jobs"
    }
  ],
  "cleanup_suggestions": [
    {
      "collection": "interview_pipeline_snapshots",
      "action": "delete",
      "affected_count": 10,
      "risk": "low"
    }
  ]
}
```

### Replay Consistency Report

```json
{
  "timestamp": "2024-01-15T10:35:00Z",
  "summary": {
    "total_tested": 10,
    "passed": 8,
    "failed": 2,
    "skipped": 0
  },
  "differences_found": [
    {
      "interview_id": "abc123",
      "type": "score_mismatch",
      "field": "overallScore",
      "original": 85.5,
      "replayed": 85.6,
      "difference": 0.1
    }
  ]
}
```

### Integrity Validation Report

```json
{
  "timestamp": "2024-01-15T10:40:00Z",
  "summary": {
    "total_checks": 8,
    "passed": 7,
    "failed": 1,
    "total_violations": 3
  },
  "violations": [
    {
      "interview_id": "xyz789",
      "field": "technicalEvaluation.score",
      "issue": "Score exists but no evidence IDs",
      "score": 75
    }
  ]
}
```

## Best Practices

### 1. Regular Auditing
Run these tests regularly (e.g., nightly) to catch issues early:
- After major deployments
- Before releases
- When data quality concerns arise
- As part of CI/CD pipeline

### 2. Incremental Cleanup
For orphan data:
1. Review cleanup suggestions
2. Archive high-risk data first
3. Delete low-risk orphans
4. Re-run detection to verify

### 3. Determinism Monitoring
- Track replay consistency over time
- Alert on determinism drift
- Investigate failed comparisons immediately

### 4. Integrity Enforcement
- Set up automated alerts for violations
- Review unknown skills regularly
- Update known skills list as needed
- Enforce evidence requirements

## Integration with CI/CD

Add to your CI pipeline:

```yaml
# .github/workflows/data-quality.yml
name: Data Quality Tests

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM
  workflow_dispatch:

jobs:
  data-quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.11'
      
      - name: Install dependencies
        run: pip install pymongo
      
      - name: Run Orphan Detection
        env:
          MONGO_URL: ${{ secrets.MONGO_URL }}
          MONGO_DB_NAME: ${{ secrets.MONGO_DB_NAME }}
        run: python tests/audit/orphan_detector.py
      
      - name: Run Integrity Validation
        env:
          MONGO_URL: ${{ secrets.MONGO_URL }}
          MONGO_DB_NAME: ${{ secrets.MONGO_DB_NAME }}
        run: python tests/integrity/report_integrity_validator.py
      
      - name: Upload Results
        uses: actions/upload-artifact@v3
        with:
          name: data-quality-reports
          path: tests/results/*.json
```

## Troubleshooting

### Connection Issues

```bash
# Test MongoDB connection
python -c "from pymongo import MongoClient; print(MongoClient('mongodb://localhost:27017').server_info())"
```

### Permission Issues

Ensure the MongoDB user has read access to all collections:
- `video_analysis_jobs`
- `interview_final_reports`
- `interview_pipeline_snapshots`
- `interview_audit_logs`
- `post_interview_vision_events`
- `callrooms`
- `interview_transcripts`

### Performance Issues

For large databases:
- Add indexes on `interviewId` fields
- Run tests during off-peak hours
- Use `REPLAY_TEST_LIMIT` to limit sample size
- Consider sharding for very large collections

## Extending the Tests

### Adding New Validation Rules

To add a new integrity check:

```python
def validate_my_new_rule(self) -> Dict[str, Any]:
    """Validate my new rule."""
    _LOG.info("VALIDATE: Checking my new rule...")
    
    check_result = {
        "name": "my_new_rule",
        "description": "Description of what this validates",
        "status": "pass",
        "details": {},
        "violations": [],
    }
    
    try:
        # Your validation logic here
        pass
    except Exception as e:
        check_result["status"] = "error"
        check_result["error"] = str(e)
        _LOG.error(f"✗ Validation failed: {e}")
    
    return check_result
```

Then add it to `run_all_validations()`:

```python
checks = [
    # ... existing checks ...
    self.validate_my_new_rule,
]
```

### Adding New Skills

Update the `KNOWN_SKILLS` set in `report_integrity_validator.py`:

```python
KNOWN_SKILLS = {
    # ... existing skills ...
    "new_skill_1",
    "new_skill_2",
}
```

## Support

For issues or questions:
1. Check MongoDB logs
2. Review test output JSON files
3. Enable DEBUG logging: `export LOG_LEVEL=DEBUG`
4. Contact the platform team

## License

Part of the AI Recruiter Platform - Internal Use Only
