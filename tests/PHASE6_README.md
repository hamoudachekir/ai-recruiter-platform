# Phase 6 — Real-World Validation Framework

## 🎯 Overview

Phase 6 provides a **comprehensive validation framework** to stress-test and validate the AI interview reporting system under real-world conditions. This phase focuses **ONLY** on validation, testing, and operational readiness—it does **NOT** add new features or modify existing behavior.

---

## 📋 Table of Contents

- [What Phase 6 Does](#what-phase-6-does)
- [What Phase 6 Does NOT Do](#what-phase-6-does-not-do)
- [Test Suites](#test-suites)
- [Quick Start](#quick-start)
- [Test Reports](#test-reports)
- [Operational Readiness Score](#operational-readiness-score)
- [CI/CD Integration](#cicd-integration)
- [Troubleshooting](#troubleshooting)

---

## ✅ What Phase 6 Does

Phase 6 provides **7 comprehensive test suites** that validate:

1. **Load Testing** — System behavior under concurrent load (10, 50, 100 interviews)
2. **Chaos Testing** — Failure injection and recovery (MongoDB, Redis, GPU, Workers, Payloads)
3. **Data Consistency** — Cross-collection integrity and orphan detection
4. **Replay Determinism** — Verify replay produces identical results
5. **Report Integrity** — Validate report structure, evidence, and metadata
6. **ML Shadow Validation** — Ensure ML never overwrites deterministic scores
7. **Performance Baseline** — Collect latency and resource usage metrics

---

## ❌ What Phase 6 Does NOT Do

Phase 6 is **validation-only**. It does NOT:

- ❌ Add new product features
- ❌ Redesign UI
- ❌ Modify recruiter workflows
- ❌ Change Phase 1-3 deterministic scoring logic
- ❌ Activate ML scoring globally
- ❌ Touch ATS/billing/multi-tenant features
- ❌ Modify report generation behavior

**Phase 6 ONLY validates and stress-tests existing functionality.**

---

## 🧪 Test Suites

### 1. Load Testing (`tests/load/`)

Simulates concurrent interviews to measure:
- Report generation latency (avg, p50, p95, p99)
- MongoDB query performance
- Queue wait times
- Resource usage (CPU, RAM, GPU)
- Success rate under load

**Files:**
- `concurrent_interview_runner.py` — Main load test runner
- `locustfile.py` — Locust-based HTTP load testing
- `websocket_load_test.py` — WebSocket connection stress testing

**Report:** `tests/results/load_test_report.json`

---

### 2. Chaos Testing (`tests/chaos/`)

Injects failures to test resilience:
- MongoDB connection drops during persist/finalize
- Redis queue failures and delays
- Worker process kills during processing
- GPU timeouts and OOM conditions
- Corrupted payload handling

**Files:**
- `mongo_failure_test.py` — MongoDB failure injection
- `redis_failure_test.py` — Redis queue failure tests
- `worker_kill_test.py` — Worker process crash tests
- `gpu_timeout_test.py` — GPU timeout scenarios
- `corrupt_payload_test.py` — Malformed data handling

**Reports:** `tests/results/chaos_*_report.json`

**Expected Behaviors:**
- ✅ No silent failures
- ✅ Jobs transition to `failed` state with structured errors
- ✅ Watchdog detects stuck jobs
- ✅ No data corruption

---

### 3. Data Consistency (`tests/audit/`)

Validates data integrity across collections:
- Every COMPLETED job has a report
- Reports have required Phase 3 fields (decisionTrace, confidenceDecision, biasReport)
- Audit logs exist for all reports
- No orphan snapshots or missing references
- Scores have supporting evidence
- Confidence values bounded [0, 1]

**Files:**
- `consistency_audit.py` — Main consistency checker
- `orphan_detector.py` — Detects orphaned data
- `replay_consistency_test.py` — Verifies replay determinism

**Reports:**
- `tests/results/data_consistency_report.json`
- `tests/results/orphan_detection_report.json`
- `tests/results/replay_consistency_report.json`

---

### 4. Report Integrity (`tests/integrity/`)

Validates report structure and content:
- Every score has evidence
- Evidence IDs exist in evidenceMap
- No hallucinated skills
- No LLM-generated scores in deterministic fields
- Metadata versions present
- Audit hashes valid

**Files:**
- `report_integrity_validator.py` — Comprehensive integrity checker

**Report:** `tests/results/report_integrity_report.json`

---

### 5. ML Shadow Validation (`tests/ml/`)

Ensures ML operates safely in shadow mode:
- **CRITICAL:** `finalVisibleScore == systemScore` (always)
- ML predictions stored but never shown to recruiters
- Feature vectors stable
- Confidence drift tracked
- Recruiter override stats accurate

**Files:**
- `shadow_validation.py` — ML shadow mode validator
- `drift_validation.py` — ML drift detection

**Reports:**
- `tests/results/ml_shadow_validation_report.json`
- `tests/results/ml_drift_report.json`

---

### 6. Performance Baseline (`tests/performance/`)

Collects performance metrics:
- Report generation latency (avg, p95, p99)
- MongoDB read/write latency
- Replay latency
- WebSocket latency
- CPU/RAM/GPU usage
- Queue processing time

**Files:**
- `baseline_profiler.py` — Performance metrics collector

**Report:** `tests/results/performance_baseline.json`

---

## 🚀 Quick Start

### Prerequisites

```bash
# Install dependencies
pip install pymongo requests psutil numpy scipy

# Optional: GPU monitoring
pip install gputil
```

### Run Full Validation

```bash
cd tests
python run_phase6_validation.py
```

This will:
1. Run all 6 test suites sequentially
2. Generate individual reports in `tests/results/`
3. Create master report: `tests/results/PHASE6_MASTER_REPORT.json`
4. Print comprehensive summary
5. Calculate **Operational Readiness Score**

---

## 📊 Test Reports

All tests generate JSON reports in `tests/results/`:

| Report File | Description |
|-------------|-------------|
| `load_test_report.json` | Load testing results (10/50/100 concurrent) |
| `chaos_*_report.json` | Failure injection test results |
| `data_consistency_report.json` | Data integrity audit results |
| `orphan_detection_report.json` | Orphaned data detection |
| `replay_consistency_report.json` | Replay determinism verification |
| `report_integrity_report.json` | Report structure validation |
| `ml_shadow_validation_report.json` | ML shadow mode validation |
| `ml_drift_report.json` | ML model drift analysis |
| `performance_baseline.json` | Performance metrics |
| **`PHASE6_MASTER_REPORT.json`** | **Aggregated master report** |

---

## 🎖 Operational Readiness Score

The master runner calculates a **weighted operational readiness score** based on test results:

| Score | Status | Meaning |
|-------|--------|---------|
| **≥90%** | ✅ **PRODUCTION_READY** | System ready for deployment |
| **75-89%** | ⚠️ **NEEDS_ATTENTION** | Issues require fixes before production |
| **<75%** | ❌ **NOT_READY** | System not ready for production |

### Weighting

Tests are weighted by criticality:

- **Data Consistency Audit:** 15 points
- **Report Integrity:** 15 points
- **Replay Consistency:** 10 points
- **Load Testing:** 10 points
- **ML Shadow Validation:** 10 points
- **Performance Baseline:** 10 points
- **Chaos Tests:** 5 points each
- **Orphan Detection:** 5 points
- **ML Drift:** 5 points

**Total:** 100 points

---

## 🔄 CI/CD Integration

### GitHub Actions

```yaml
name: Phase 6 Validation

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM
  workflow_dispatch:

jobs:
  validate:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.10'
      
      - name: Install dependencies
        run: |
          pip install pymongo requests psutil numpy scipy
      
      - name: Start MongoDB
        run: |
          docker run -d -p 27017:27017 mongo:latest
      
      - name: Run Phase 6 Validation
        run: |
          cd tests
          python run_phase6_validation.py
      
      - name: Upload Reports
        uses: actions/upload-artifact@v3
        with:
          name: phase6-reports
          path: tests/results/
      
      - name: Check Operational Readiness
        run: |
          SCORE=$(jq '.operational_readiness.score' tests/results/PHASE6_MASTER_REPORT.json)
          if (( $(echo "$SCORE < 90" | bc -l) )); then
            echo "❌ Operational readiness below 90%: $SCORE%"
            exit 1
          fi
```

### Jenkins

```groovy
pipeline {
    agent any
    
    triggers {
        cron('H 2 * * *')  // Daily at 2 AM
    }
    
    stages {
        stage('Setup') {
            steps {
                sh 'pip install pymongo requests psutil numpy scipy'
            }
        }
        
        stage('Phase 6 Validation') {
            steps {
                sh '''
                    cd tests
                    python run_phase6_validation.py
                '''
            }
        }
        
        stage('Archive Reports') {
            steps {
                archiveArtifacts artifacts: 'tests/results/*.json', fingerprint: true
            }
        }
        
        stage('Check Readiness') {
            steps {
                script {
                    def report = readJSON file: 'tests/results/PHASE6_MASTER_REPORT.json'
                    def score = report.operational_readiness.score
                    
                    if (score < 90) {
                        error("Operational readiness below 90%: ${score}%")
                    }
                }
            }
        }
    }
}
```

---

## 🐛 Troubleshooting

### "MongoDB connection failed"

```bash
# Check if MongoDB is running
mongosh

# Start MongoDB
mongod --dbpath /path/to/data
```

### "Script not found" errors

```bash
# Ensure you're running from the tests directory
cd tests
python run_phase6_validation.py

# Or use absolute paths in configuration
```

### "Test timeout (600s)"

Some tests may timeout under heavy load. You can:
1. Increase timeout in `run_phase6_validation.py`
2. Run individual suites separately
3. Reduce concurrent load (edit test configurations)

### Load tests fail with "no test interviews"

```bash
# Set test interview IDs
export TEST_INTERVIEW_IDS="interview_001,interview_002,interview_003"

# Or create test interviews in your database
```

### GPU tests fail

GPU tests are optional. If you don't have a GPU:
- Tests will be marked as "manual_check_required"
- This won't affect overall pass rate significantly (5 points)

---

## 📈 Best Practices

### 1. **Run Daily in CI/CD**
Automate Phase 6 validation to catch regressions early.

### 2. **Monitor Trends**
Track operational readiness scores over time:
```bash
# Extract scores
jq '.operational_readiness.score' tests/results/PHASE6_MASTER_REPORT.json >> scores_history.txt
```

### 3. **Archive Reports**
Keep historical reports for trend analysis:
```bash
# Timestamp reports
DATE=$(date +%Y%m%d_%H%M%S)
cp tests/results/PHASE6_MASTER_REPORT.json archive/phase6_${DATE}.json
```

### 4. **Set Alerts**
Configure alerts for critical failures:
- Operational readiness <90%
- ML shadow score divergence >1%
- Load test success rate <95%
- Chaos test failures

### 5. **Run Before Deployments**
Always run Phase 6 validation before deploying to production.

---

## 📚 Additional Documentation

- **`tests/chaos/README.md`** — Chaos testing guide
- **`tests/audit/TEST_SUITE_GUIDE.md`** — Data quality tests guide
- **`tests/ml/NEW_VALIDATION_TESTS_README.md`** — ML validation guide
- **`PHASE_VERIFICATION_REPORT.md`** — Overall system verification

---

## 🎯 Summary

Phase 6 provides **production-grade validation** to ensure:

✅ **Reliability** — System handles failures gracefully  
✅ **Determinism** — Replay produces identical results  
✅ **Integrity** — Reports are structurally sound and evidence-backed  
✅ **Safety** — ML never overwrites deterministic scores  
✅ **Performance** — System meets latency and throughput requirements  
✅ **Consistency** — Data remains consistent across collections  

**Phase 6 is the final gate before production deployment.**

---

## 📞 Support

For issues or questions:
1. Check troubleshooting section above
2. Review individual test documentation
3. Examine failed test reports in `tests/results/`
4. Check service logs for detailed error messages

---

**Remember:** Phase 6 is **validation-only**. It ensures the system is production-ready without changing any functionality.
