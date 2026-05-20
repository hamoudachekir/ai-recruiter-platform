# ML Validation Suite - Quick Start

## 🎯 What These Tests Do

### 1. **Shadow Validation** (`ml/shadow_validation.py`)
Ensures ML NEVER overwrites recruiter-visible scores. This is the most critical test.

**Key Check**: `finalVisibleScore == systemScore` (always)

### 2. **Drift Monitoring** (`ml/drift_validation.py`)
Detects when ML model needs retraining due to feature or score drift.

**Key Metric**: PSI (Population Stability Index) - measures distribution changes

### 3. **Performance Profiler** (`performance/baseline_profiler.py`)
Establishes performance baselines for SLA tracking.

**Key Metrics**: Report latency, MongoDB performance, system resources

---

## 🚀 Quick Run

### Run All Tests (Recommended)
```bash
cd tests
./run_ml_validation_suite.sh
```

### Run Individual Tests
```bash
# Shadow validation (daily)
python tests/ml/shadow_validation.py

# Drift monitoring (weekly)
python tests/ml/drift_validation.py

# Performance baseline (weekly)
python tests/performance/baseline_profiler.py
```

---

## 📦 Installation

```bash
# Core dependencies
pip install pymongo

# ML drift monitoring
pip install numpy scipy

# Performance profiling
pip install psutil

# Optional GPU monitoring
pip install gputil

# Install all
pip install pymongo numpy scipy psutil gputil
```

---

## 📊 Output Reports

All reports saved to `tests/results/`:
- `ml_shadow_validation_report.json`
- `ml_drift_report.json`
- `performance_baseline.json`

---

## 🔔 When to Alert

### 🚨 CRITICAL (Immediate Action)
- ❌ **Shadow Mode Violation**: `finalVisibleScore ≠ systemScore`
  - **Action**: Stop ML inference immediately
  
- ❌ **Critical Feature Drift**: PSI > 0.25
  - **Action**: Schedule model retraining

### ⚠️ WARNING (Monitor Closely)
- ⚠️ **Warning Feature Drift**: PSI > 0.10
  - **Action**: Increase monitoring frequency
  
- ⚠️ **Score Drift**: System-ML relationship changing
  - **Action**: Review model calibration

### ℹ️ INFO (Track Trends)
- ℹ️ **Performance Changes**: Latency trends
  - **Action**: Compare against baseline

---

## 📅 Recommended Schedule

| Test | Frequency | When | Why |
|------|-----------|------|-----|
| Shadow Validation | Daily | 2 AM | Critical safety check |
| Drift Monitoring | Weekly | Sunday 3 AM | Identify retraining needs |
| Performance Baseline | Weekly | Monday 1 AM | Track SLA compliance |

### Crontab Setup
```bash
# Daily shadow validation
0 2 * * * cd /path/to/ai-recruiter-platform/tests && python ml/shadow_validation.py

# Weekly drift monitoring
0 3 * * 0 cd /path/to/ai-recruiter-platform/tests && python ml/drift_validation.py

# Weekly performance baseline
0 1 * * 1 cd /path/to/ai-recruiter-platform/tests && python performance/baseline_profiler.py
```

---

## 🔍 Understanding Results

### Shadow Validation Report
```json
{
  "validation_rules": {
    "finalVisibleScore_equals_systemScore": true  // ✓ MUST be true
  },
  "summary": {
    "passed": 6,
    "failed": 0,  // ✓ MUST be 0
    "score_divergence_avg": 3.42  // ML vs System difference
  }
}
```

**Good**: `failed: 0`, all rules `true`  
**Bad**: Any `failed > 0` or rule `false`

### Drift Report
```json
{
  "drift_alerts": [
    {
      "type": "feature_drift",
      "severity": "critical",  // ⚠️ Action needed
      "feature": "transcript_quality_score",
      "psi": 0.28  // > 0.25 = critical
    }
  ],
  "summary": {
    "critical_drift_count": 1  // ⚠️ Retrain if > 0
  }
}
```

**Good**: `critical_drift_count: 0`  
**Action Needed**: `critical_drift_count > 0`

### Performance Report
```json
{
  "summary": {
    "avg_report_latency_ms": 3421.5,
    "p95_report_latency_ms": 8234.2,  // Compare to SLA
    "mongodb_write_avg_ms": 2.34,
    "avg_cpu_percent": 23.5
  }
}
```

**Compare**: Current metrics vs previous baseline  
**Alert**: If p95 > 2x baseline

---

## 🛠️ Troubleshooting

### No Data Found
```
Error: No shadow records found
```
**Fix**: Ensure ML shadow mode is running. Check `ml_shadow_results` collection.

### Missing Dependencies
```
ImportError: No module named 'scipy'
```
**Fix**: `pip install scipy numpy`

### Connection Error
```
Error: Connection refused
```
**Fix**: Check MongoDB connection:
```bash
MONGO_URL=mongodb://localhost:27017 python tests/ml/shadow_validation.py
```

---

## 📖 Full Documentation

For detailed documentation, see:
- **Full Guide**: `tests/NEW_VALIDATION_TESTS_README.md`
- **Test Suite Guide**: `tests/TEST_SUITE_GUIDE.md`
- **System Docs**: `tests/README.md`

---

## ✅ Success Criteria

### Shadow Validation
- ✅ All `validation_rules` are `true`
- ✅ `failed: 0` violations
- ✅ Score divergence within expected range (<15 points avg)

### Drift Monitoring
- ✅ `critical_drift_count: 0`
- ✅ Less than 3 features with warning drift
- ✅ No significant score drift

### Performance
- ✅ All latencies within SLA targets
- ✅ No significant regression vs baseline
- ✅ System resources healthy

---

## 🎓 Key Concepts

### PSI (Population Stability Index)
Measures how much a feature's distribution has changed:
- **< 0.10**: No significant drift ✅
- **0.10 - 0.25**: Warning drift ⚠️
- **> 0.25**: Critical drift 🚨

### Score Divergence
Difference between system and ML scores:
- **< 10 points**: Expected variation ✅
- **10-20 points**: Monitor closely ⚠️
- **> 20 points**: Investigate 🚨

### Latency Percentiles
- **p50**: Median (50% of requests faster)
- **p95**: 95% of requests faster (SLA target)
- **p99**: 99% of requests faster (worst case)

---

## 📞 Support

Questions? Issues?
1. Check `tests/NEW_VALIDATION_TESTS_README.md` for detailed docs
2. Review logs in `.tmp-test-logs/`
3. Check MongoDB collections: `ml_shadow_results`, `interview_ml_dataset`

---

**Version**: 1.0.0  
**Last Updated**: 2024-01-15  
**Python**: 3.10+  
**MongoDB**: 4.4+
