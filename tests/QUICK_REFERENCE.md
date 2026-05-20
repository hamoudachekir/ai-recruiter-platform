# Data Quality Tests - Quick Reference Card

## 🚀 Quick Start

```bash
cd ai-recruiter-platform/tests
chmod +x run_data_quality_tests.sh
./run_data_quality_tests.sh
```

## 📁 Files Created

| File | Purpose | Output |
|------|---------|--------|
| `audit/orphan_detector.py` | Detect orphaned data | `results/orphan_detection_report.json` |
| `audit/replay_consistency_test.py` | Test replay determinism | `results/replay_consistency_report.json` |
| `integrity/report_integrity_validator.py` | Validate report integrity | `results/report_integrity_report.json` |

## 🔍 What Each Test Checks

### Orphan Detection (5 checks)
- ❌ Snapshots without jobs
- ❌ Reports without jobs
- ❌ Audit logs without reports
- ❌ Vision events without interviews
- ❌ Transcripts without jobs

### Replay Consistency (3 checks)
- 🔄 Deterministic fields stay consistent
- 🔄 Evidence map integrity
- 🔄 Score reproducibility

### Report Integrity (8 checks)
- ✅ Scores have evidence
- ✅ Evidence IDs valid
- ✅ No hallucinated skills
- ✅ No LLM scores in deterministic fields
- ✅ Confidence values [0,1]
- ✅ Decision labels valid
- ✅ Metadata versions exist
- ✅ Audit hashes valid (SHA-256)

## ⚙️ Environment Variables

```bash
export MONGO_URL="mongodb://localhost:27017"
export MONGO_DB_NAME="ai_recruiter_dev"
export REPLAY_TEST_LIMIT=10  # Number of reports to test
```

## 🏃 Run Individual Tests

```bash
# Orphan detection
python tests/audit/orphan_detector.py

# Replay consistency (with custom limit)
REPLAY_TEST_LIMIT=20 python tests/audit/replay_consistency_test.py

# Integrity validation
python tests/integrity/report_integrity_validator.py
```

## 📊 Understanding Output

### Exit Codes
- `0` = All tests passed
- `1` = Issues detected

### Console Output
- `✓` = Check passed
- `✗` = Check failed
- `⚠` = Warning

### JSON Reports Location
All in `tests/results/`:
- `orphan_detection_report.json`
- `replay_consistency_report.json`
- `report_integrity_report.json`

## 🔧 Common Issues

### MongoDB Connection Failed
```bash
# Test connection
python -c "from pymongo import MongoClient; print(MongoClient('mongodb://localhost:27017').server_info())"
```

### Permission Denied (Shell Script)
```bash
chmod +x tests/run_data_quality_tests.sh
```

### ModuleNotFoundError: pymongo
```bash
pip install pymongo
```

## 📈 Key Metrics

### Summary Fields to Monitor

**Orphan Detection:**
```json
"summary": {
  "total_orphaned_records": 0  // Should be 0
}
```

**Replay Consistency:**
```json
"summary": {
  "failed": 0,  // Should be 0
  "differences_found": []  // Should be empty
}
```

**Report Integrity:**
```json
"summary": {
  "total_violations": 0  // Should be 0
}
```

## 🎯 When to Run

- ✅ Before production deployments
- ✅ After schema changes
- ✅ Nightly in CI/CD
- ✅ When data quality concerns arise
- ✅ After bulk data operations

## 🛠️ Cleanup Orphaned Data

Review `cleanup_suggestions` in orphan report:

```json
{
  "collection": "interview_pipeline_snapshots",
  "action": "delete",
  "risk": "low",
  "affected_count": 10
}
```

⚠️ **Always review before deleting!**

## 📚 Full Documentation

- `TEST_SUITE_GUIDE.md` - Complete guide
- `NEW_TEST_FILES_SUMMARY.md` - Technical details

## 💡 Tips

1. **Start with low limits** when testing on large databases
2. **Run during off-peak hours** for production databases
3. **Archive before deleting** high-risk orphans
4. **Track trends over time** to spot data quality degradation
5. **Update known skills regularly** to reduce false positives

## 🆘 Need Help?

1. Check `TEST_SUITE_GUIDE.md` troubleshooting section
2. Review JSON output files for detailed error messages
3. Enable debug logging: `export LOG_LEVEL=DEBUG`
4. Check MongoDB logs

---

**Quick Commands Cheat Sheet:**

```bash
# Run all tests
./run_data_quality_tests.sh

# Test MongoDB connection
python -c "from pymongo import MongoClient; import os; MongoClient(os.getenv('MONGO_URL', 'mongodb://localhost:27017')).server_info()"

# Check results
cat tests/results/orphan_detection_report.json | python -m json.tool
cat tests/results/replay_consistency_report.json | python -m json.tool
cat tests/results/report_integrity_report.json | python -m json.tool

# Count total issues
python -c "import json; d=json.load(open('tests/results/orphan_detection_report.json')); print(f\"Orphans: {d['summary']['total_orphaned_records']}\")"
python -c "import json; d=json.load(open('tests/results/report_integrity_report.json')); print(f\"Violations: {d['summary']['total_violations']}\")"
```

---

Version 1.0 | Last Updated: 2024
