# ML Shadow Validation & Performance Testing Suite

This document describes the new validation and performance testing suite for the AI Recruiter Platform, specifically focusing on ML shadow mode validation, drift monitoring, and performance baseline profiling.

## Overview

Three new comprehensive test suites have been added to ensure:
1. **ML Shadow Mode Integrity** - Validates that ML operates in pure shadow mode without affecting recruiter-visible scores
2. **ML Drift Detection** - Monitors model and feature drift over time to identify when retraining is needed
3. **Performance Baselines** - Establishes comprehensive performance metrics for SLA tracking and regression detection

---

## 1. ML Shadow Validation (`tests/ml/shadow_validation.py`)

### Purpose
Validates that ML shadow mode operates correctly and never overwrites deterministic scores.

### Critical Invariant
**`finalVisibleScore` ALWAYS equals `systemScore`** (within 0.001 tolerance)

This is the most important validation - ML predictions are stored for analysis but must NEVER affect what recruiters see.

### Validations Performed

#### 1. Score Invariant Check
- Verifies `finalVisibleScore == systemScore` for all shadow inference records
- Tolerance: 0.001 (floating-point precision)
- **CRITICAL**: Any violation means ML is leaking into production scores

#### 2. ML Prediction Storage
- ML predictions stored in `ml_shadow_results` collection
- Required fields: `mlCalibratedScore`, `scoreDelta`, `modelVersion`, `runAt`
- `scoreDelta` calculation verified: `mlCalibratedScore - systemScore`

#### 3. Feature Vector Stability
- Feature vectors in `interview_ml_dataset` are complete and valid
- All feature values are numeric (int or float)
- No missing or null values
- Feature count consistency across records

#### 4. Skip Flag Behavior
- Records with `shadowInferenceSkipped: true` must have:
  - A `reason` field explaining why
  - NO `mlCalibratedScore` or `scoreDelta`
- Records with `shadowInferenceSkipped: false` must have:
  - Valid `mlCalibratedScore`
  - Valid `scoreDelta`
  - Valid `modelVersion`

#### 5. Score Divergence Statistics
- Mean, max, min score divergence between system and ML
- Percentiles (p50, p95, p99)
- Large divergence tracking (>20 points)

#### 6. Recruiter Override Validation
- Validates `agreementLabel` computation in `interview_ml_dataset`
- Agreement = MATCH if `|systemScore - humanScore| <= 10`
- Agreement = MISMATCH otherwise

### Usage

```bash
# Run shadow validation
python tests/ml/shadow_validation.py

# With custom MongoDB
MONGO_URL=mongodb://localhost:27017 MONGO_DB_NAME=my_db python tests/ml/shadow_validation.py
```

### Output

**Console**: Colored summary with pass/fail indicators
**JSON Report**: `tests/results/ml_shadow_validation_report.json`

### Report Structure

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "validation_rules": {
    "finalVisibleScore_equals_systemScore": true,
    "ml_never_overwrites_deterministic": true,
    "predictions_stored_correctly": true,
    "feature_vectors_stable": true,
    "confidence_tracked": true,
    "recruiter_overrides_computed": true,
    "skip_flag_behavior_correct": true
  },
  "checks": {
    "score_invariant": {
      "passed": 1523,
      "failed": 0,
      "total": 1523,
      "success": true
    }
  },
  "summary": {
    "total_checks": 6,
    "passed": 6,
    "failed": 0,
    "skipped_inferences": 47,
    "score_divergence_avg": 3.42,
    "score_divergence_max": 14.85
  }
}
```

---

## 2. ML Drift Monitoring (`tests/ml/drift_validation.py`)

### Purpose
Monitors ML model and feature drift over time to identify when model retraining is needed or when system behavior has changed significantly.

### Dependencies
```bash
pip install numpy scipy
```

### Time Windows
- **Baseline Period**: 30 days (configurable via `BASELINE_WINDOW_DAYS`)
- **Recent Period**: 7 days (configurable via `RECENT_WINDOW_DAYS`)
- Comparison: Recent vs Baseline

### Drift Detection Methods

#### 1. Feature Drift Analysis
For each feature in the ML dataset:

**Statistical Tests**:
- **Population Stability Index (PSI)** - Distribution similarity metric
  - PSI < 0.10: No significant drift
  - 0.10 ≤ PSI < 0.25: Warning drift
  - PSI ≥ 0.25: Critical drift
  
- **Kolmogorov-Smirnov Test** - Distribution difference test
  - Tests null hypothesis that distributions are the same
  
- **Mean Shift** - Change in feature mean
  - Warning: >10% change
  - Critical: >25% change
  
- **Standard Deviation Shift** - Change in feature variance

**Severity Levels**:
- **Critical**: PSI > 0.25 OR mean shift > 25%
- **Warning**: PSI > 0.10 OR mean shift > 10%
- **None**: Below thresholds

#### 2. Score Drift Detection
Monitors drift in the relationship between system scores and ML predictions:

- Mean delta between baseline and recent periods
- T-test for statistical significance
- **Drift Detected** if:
  - Absolute shift > 5 points, OR
  - Relative shift > 20%

#### 3. Confidence Trend Analysis
Monitors changes in prediction confidence over time:

- Mean confidence: Baseline vs Recent
- **Drift Detected** if absolute shift > 0.10 (10%)

### Drift Alerts

The system generates alerts for:
- **Critical Feature Drift**: Feature distributions changed significantly
- **Score Drift**: System-ML relationship changed
- **Confidence Drift**: Prediction confidence trending up or down

### Usage

```bash
# Run drift monitoring
python tests/ml/drift_validation.py

# With custom time windows (edit file constants)
# RECENT_WINDOW_DAYS = 14  # Last 2 weeks
# BASELINE_WINDOW_DAYS = 60  # Previous 60 days
```

### Output

**Console**: Colored summary with drift alerts
**JSON Report**: `tests/results/ml_drift_report.json`

### Report Structure

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "time_windows": {
    "recent_days": 7,
    "baseline_days": 30,
    "recent_start": "2024-01-08T10:30:00Z",
    "baseline_start": "2023-12-09T10:30:00Z",
    "baseline_end": "2024-01-08T10:30:00Z"
  },
  "drift_alerts": [
    {
      "type": "feature_drift",
      "severity": "critical",
      "feature": "transcript_quality_score",
      "psi": 0.28,
      "mean_shift": -12.4
    }
  ],
  "feature_drift": {
    "total_features": 45,
    "features_with_drift": 3,
    "critical_drift": ["transcript_quality_score"],
    "warning_drift": ["qna_avg_depth", "technical_score"]
  },
  "summary": {
    "total_features_monitored": 45,
    "features_with_drift": 3,
    "critical_drift_count": 1,
    "warning_drift_count": 2,
    "score_drift_detected": false,
    "confidence_drift_detected": false
  }
}
```

### When to Retrain

**Critical Drift (Action Required)**:
- Any feature with PSI > 0.25
- Score drift > 10 points
- Multiple features with warning drift

**Warning Drift (Monitor Closely)**:
- Features with PSI > 0.10
- Score drift 5-10 points
- Confidence trending significantly

---

## 3. Performance Baseline Profiler (`tests/performance/baseline_profiler.py`)

### Purpose
Establishes comprehensive performance baselines for:
- SLA target setting
- Performance regression detection
- Capacity planning
- System health monitoring

### Dependencies
```bash
pip install psutil
pip install gputil  # Optional, for GPU monitoring
```

### Metrics Collected

#### 1. Report Generation Latency
- End-to-end pipeline latency from audit logs
- **Statistics**: avg, min, max, p50, p95, p99
- **Distribution**: <1s, 1-5s, 5-10s, >10s
- **Source**: `interview_audit_logs` collection

#### 2. MongoDB Performance
- **Write Performance**: Insert latency (10 test writes)
- **Read Performance**: Query latency (10 test reads)
- **Statistics**: avg, min, max, p95
- Uses temporary collection `_performance_test` (auto-cleaned)

#### 3. Replay Evaluation Latency
- Latency for replay evaluations
- **Source**: `replay_evaluation_results` collection
- **Statistics**: avg, min, max, p50, p95, p99

#### 4. WebSocket Latency
- Message delivery latency for real-time sessions
- **Source**: `realtime_sessions` collection
- **Statistics**: avg, min, max, p50, p95, p99

#### 5. Queue Processing Latency
- **Queue Wait Time**: Time from job creation to start
- **Processing Time**: Time from start to completion
- **Source**: `video_analysis_jobs` collection
- **Statistics**: avg, min, max, p95 for both metrics

#### 6. System Resources
**System-wide**:
- CPU usage (total and per-core)
- RAM usage (total, available, used, percent)

**Process-specific**:
- Python process CPU usage
- Process memory (RSS, VMS)

**GPU (if available)**:
- GPU load percentage
- GPU memory usage
- GPU temperature

### Usage

```bash
# Run performance profiler
python tests/performance/baseline_profiler.py

# With custom lookback period (edit file constant)
# LOOKBACK_DAYS = 14  # Last 2 weeks
```

### Output

**Console**: Colored performance summary
**JSON Report**: `tests/results/performance_baseline.json`

### Report Structure

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "lookback_days": 7,
  "report_latency": {
    "total_reports": 1523,
    "avg_ms": 3421.5,
    "p95_ms": 8234.2,
    "p99_ms": 12456.8,
    "latency_distribution": {
      "under_1s": 145,
      "1s_to_5s": 1023,
      "5s_to_10s": 298,
      "over_10s": 57
    }
  },
  "mongodb_performance": {
    "write_performance": {
      "avg_ms": 2.34,
      "p95_ms": 4.12
    },
    "read_performance": {
      "avg_ms": 1.23,
      "p95_ms": 2.45
    }
  },
  "system_resources": {
    "system": {
      "cpu_percent": 23.5,
      "memory_percent": 67.8,
      "memory_used_mb": 5432.1
    },
    "gpu": [
      {
        "name": "NVIDIA RTX 3090",
        "load_percent": 45.2,
        "memory_percent": 62.3,
        "temperature_c": 68.0
      }
    ]
  },
  "summary": {
    "avg_report_latency_ms": 3421.5,
    "p95_report_latency_ms": 8234.2,
    "p99_report_latency_ms": 12456.8,
    "mongodb_write_avg_ms": 2.34,
    "mongodb_read_avg_ms": 1.23,
    "avg_cpu_percent": 23.5,
    "peak_cpu_percent": 45.2,
    "avg_ram_mb": 5432.1
  }
}
```

### Setting SLA Targets

Use these baselines to establish SLAs:

**Example SLA Targets** (based on p95):
- Report generation: < 10 seconds (p95)
- MongoDB writes: < 5ms (p95)
- MongoDB reads: < 3ms (p95)
- WebSocket latency: < 100ms (p95)
- Queue wait time: < 5 seconds (p95)

---

## Running All Tests

### Individual Tests
```bash
python tests/ml/shadow_validation.py
python tests/ml/drift_validation.py
python tests/performance/baseline_profiler.py
```

### All Together (Shell Script)
```bash
#!/bin/bash
echo "Running ML Shadow Validation..."
python tests/ml/shadow_validation.py

echo "Running ML Drift Monitoring..."
python tests/ml/drift_validation.py

echo "Running Performance Baseline Profiler..."
python tests/performance/baseline_profiler.py

echo "All tests complete. Reports in tests/results/"
```

---

## Scheduling

### Daily Monitoring (Recommended)
```bash
# Crontab entry - run at 2 AM daily
0 2 * * * cd /path/to/ai-recruiter-platform && python tests/ml/shadow_validation.py
```

### Weekly Drift Analysis (Recommended)
```bash
# Crontab entry - run Sunday at 3 AM
0 3 * * 0 cd /path/to/ai-recruiter-platform && python tests/ml/drift_validation.py
```

### Weekly Performance Baseline (Recommended)
```bash
# Crontab entry - run Monday at 1 AM
0 1 * * 1 cd /path/to/ai-recruiter-platform && python tests/performance/baseline_profiler.py
```

---

## Integration with CI/CD

### GitHub Actions Example
```yaml
name: ML Validation Tests

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM
  workflow_dispatch:  # Manual trigger

jobs:
  ml-validation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.10'
      
      - name: Install dependencies
        run: |
          pip install pymongo numpy scipy psutil
      
      - name: Run shadow validation
        env:
          MONGO_URL: ${{ secrets.MONGO_URL }}
          MONGO_DB_NAME: ${{ secrets.MONGO_DB_NAME }}
        run: python tests/ml/shadow_validation.py
      
      - name: Run drift monitoring
        run: python tests/ml/drift_validation.py
      
      - name: Upload reports
        uses: actions/upload-artifact@v3
        with:
          name: test-reports
          path: tests/results/*.json
```

---

## Alerting

### Critical Alerts (Immediate Action Required)

1. **Shadow Mode Violation**
   - `finalVisibleScore != systemScore`
   - **Action**: Stop ML inference immediately, investigate

2. **Critical Feature Drift**
   - PSI > 0.25 or mean shift > 25%
   - **Action**: Schedule model retraining

3. **Performance Degradation**
   - P95 latency > 2x baseline
   - **Action**: Investigate system bottlenecks

### Warning Alerts (Monitor)

1. **Warning Feature Drift**
   - PSI > 0.10 or mean shift > 10%
   - **Action**: Increase monitoring frequency

2. **Score Drift**
   - System-ML relationship changing
   - **Action**: Consider model recalibration

3. **Confidence Drift**
   - Prediction confidence trending
   - **Action**: Review model inputs

---

## Troubleshooting

### No Data Found
```
Error: No shadow records found
```
**Solution**: Ensure ML shadow mode is enabled and running. Check `ml_shadow_results` collection.

### Insufficient Historical Data
```
Error: Insufficient data (baseline=5, recent=3)
```
**Solution**: Wait for more data to accumulate. Drift monitoring needs at least 10 records per period.

### Import Errors
```
ImportError: No module named 'scipy'
```
**Solution**: Install required dependencies:
```bash
pip install numpy scipy psutil
```

### MongoDB Connection Issues
```
Error: Connection refused
```
**Solution**: Check MongoDB connection:
```bash
MONGO_URL=mongodb://localhost:27017 python tests/ml/shadow_validation.py
```

---

## Report Archive

All reports are saved with timestamps. To track trends over time:

```bash
# Create dated archive directory
mkdir -p tests/results/archive/$(date +%Y-%m-%d)

# Copy reports
cp tests/results/*.json tests/results/archive/$(date +%Y-%m-%d)/
```

---

## Dependencies

### Core Dependencies
```txt
pymongo>=4.0.0
python>=3.10
```

### ML Drift Monitoring
```txt
numpy>=1.24.0
scipy>=1.10.0
```

### Performance Profiling
```txt
psutil>=5.9.0
gputil>=1.4.0  # Optional
```

### Install All
```bash
pip install pymongo numpy scipy psutil gputil
```

---

## Best Practices

1. **Run shadow validation daily** - Catch ML violations immediately
2. **Monitor drift weekly** - Identify retraining needs early
3. **Track performance trends** - Compare against baseline regularly
4. **Archive reports** - Keep historical data for trend analysis
5. **Set up alerts** - Automated notifications for critical issues
6. **Review reports regularly** - Don't just collect data, act on it

---

## Contact & Support

For questions or issues with these tests:
- Check existing test documentation in `tests/README.md`
- Review system logs in `.tmp-test-logs/`
- Consult the TEST_SUITE_GUIDE.md for overall testing strategy

---

**Last Updated**: 2024-01-15
**Test Suite Version**: 1.0.0
**Minimum System Requirements**: Python 3.10+, MongoDB 4.4+
