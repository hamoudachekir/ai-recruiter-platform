# New Test Files Created

## 📁 Created Files

### Test Implementations

1. **`tests/ml/shadow_validation.py`** (784 lines)
   - ML Shadow Mode Validator
   - Ensures finalVisibleScore == systemScore invariant
   - Validates ML predictions stored correctly without affecting production
   - Output: `tests/results/ml_shadow_validation_report.json`

2. **`tests/ml/drift_validation.py`** (646 lines)
   - ML Drift Monitor
   - Tracks feature distribution changes using PSI
   - Detects score and confidence drift
   - Requires: `numpy`, `scipy`
   - Output: `tests/results/ml_drift_report.json`

3. **`tests/performance/baseline_profiler.py`** (608 lines)
   - Performance Baseline Profiler
   - Collects latency, MongoDB, and system resource metrics
   - Establishes SLA baselines
   - Requires: `psutil`, optional `gputil`
   - Output: `tests/results/performance_baseline.json`

### Runner Scripts

4. **`tests/run_ml_validation_suite.sh`** (133 lines)
   - Shell script to run all three tests
   - Checks dependencies
   - Provides colored output
   - Exit code indicates pass/fail
   - Usage: `./tests/run_ml_validation_suite.sh`

### Documentation

5. **`tests/NEW_VALIDATION_TESTS_README.md`** (604 lines)
   - Comprehensive documentation for all tests
   - Detailed metrics explanations
   - CI/CD integration examples
   - Scheduling recommendations
   - Troubleshooting guide

6. **`tests/ML_VALIDATION_QUICK_START.md`** (260 lines)
   - Quick reference guide
   - Installation instructions
   - Alert criteria
   - Success criteria
   - Key concepts explained

7. **`tests/NEW_TEST_FILES_CREATED.md`** (This file)
   - Summary of all created files
   - Installation and usage instructions

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
pip install pymongo numpy scipy psutil gputil
```

### 2. Run All Tests
```bash
cd tests
./run_ml_validation_suite.sh
```

### 3. Check Reports
```bash
ls -lh tests/results/
cat tests/results/ml_shadow_validation_report.json
```

---

## 📊 What Each Test Does

### Shadow Validation (Critical - Run Daily)
**Purpose**: Ensures ML operates in pure shadow mode

**Key Validations**:
- ✓ `finalVisibleScore == systemScore` (CRITICAL)
- ✓ ML predictions stored in correct collection
- ✓ Feature vectors stable and complete
- ✓ Skip flag behavior correct
- ✓ Recruiter override stats accurate

**Why Important**: Any violation means ML is leaking into production scores and affecting real decisions.

### Drift Monitoring (Run Weekly)
**Purpose**: Identifies when model needs retraining

**Key Metrics**:
- Feature drift (PSI)
- Score drift (system vs ML)
- Confidence trends

**Why Important**: Prevents model degradation and maintains accuracy as data distributions change.

### Performance Profiler (Run Weekly)
**Purpose**: Tracks system performance for SLA compliance

**Key Metrics**:
- Report generation latency (p50, p95, p99)
- MongoDB read/write performance
- System resources (CPU, RAM, GPU)
- Queue processing times

**Why Important**: Identifies performance regressions before they impact users.

---

## 📋 File Structure

```
tests/
├── ml/
│   ├── shadow_validation.py          # ML shadow mode validator
│   └── drift_validation.py            # ML drift monitor
├── performance/
│   └── baseline_profiler.py           # Performance baseline profiler
├── results/
│   ├── ml_shadow_validation_report.json
│   ├── ml_drift_report.json
│   └── performance_baseline.json
├── run_ml_validation_suite.sh         # Run all tests
├── NEW_VALIDATION_TESTS_README.md     # Full documentation
├── ML_VALIDATION_QUICK_START.md       # Quick reference
└── NEW_TEST_FILES_CREATED.md          # This file
```

---

## 🔧 Dependencies

### Core (Required for all tests)
```bash
pip install pymongo
```

### ML Drift Monitoring
```bash
pip install numpy scipy
```

### Performance Profiling
```bash
pip install psutil
```

### Optional (GPU monitoring)
```bash
pip install gputil
```

### Install All
```bash
pip install pymongo numpy scipy psutil gputil
```

---

## 📝 Usage Examples

### Run Individual Tests

```bash
# Shadow validation (most critical - run daily)
python tests/ml/shadow_validation.py

# Drift monitoring (run weekly)
python tests/ml/drift_validation.py

# Performance profiling (run weekly)
python tests/performance/baseline_profiler.py
```

### Run All Tests
```bash
cd tests
./run_ml_validation_suite.sh
```

### With Custom MongoDB
```bash
MONGO_URL=mongodb://prod-server:27017 \
MONGO_DB_NAME=prod_db \
python tests/ml/shadow_validation.py
```

---

## 📅 Recommended Schedule

| Test | Frequency | Command |
|------|-----------|---------|
| Shadow Validation | Daily | `python tests/ml/shadow_validation.py` |
| Drift Monitoring | Weekly | `python tests/ml/drift_validation.py` |
| Performance Baseline | Weekly | `python tests/performance/baseline_profiler.py` |

### Crontab Example
```bash
# Daily shadow validation at 2 AM
0 2 * * * cd /path/to/ai-recruiter-platform && python tests/ml/shadow_validation.py

# Weekly drift monitoring (Sunday 3 AM)
0 3 * * 0 cd /path/to/ai-recruiter-platform && python tests/ml/drift_validation.py

# Weekly performance baseline (Monday 1 AM)
0 1 * * 1 cd /path/to/ai-recruiter-platform && python tests/performance/baseline_profiler.py
```

---

## 🎯 Success Criteria

### Shadow Validation ✅
- All validation rules pass (`true`)
- No violations (`failed: 0`)
- Score divergence within expected range

### Drift Monitoring ✅
- No critical drift (`critical_drift_count: 0`)
- Minimal warning drift (<3 features)
- Stable score relationships

### Performance ✅
- Latencies within SLA targets
- No significant regression vs baseline
- System resources healthy

---

## 🚨 Alert Criteria

### CRITICAL (Immediate Action)
1. **Shadow Mode Violation**: `finalVisibleScore ≠ systemScore`
   - **Action**: Stop ML inference immediately
   - **Impact**: ML affecting production scores

2. **Critical Feature Drift**: PSI > 0.25
   - **Action**: Schedule model retraining
   - **Impact**: Model accuracy degrading

3. **Performance Degradation**: p95 > 2x baseline
   - **Action**: Investigate bottlenecks
   - **Impact**: User experience affected

### WARNING (Monitor Closely)
1. **Warning Feature Drift**: PSI > 0.10
2. **Score Drift**: System-ML relationship changing
3. **Moderate Performance Regression**: p95 > 1.5x baseline

---

## 📖 Documentation References

- **Quick Start**: `tests/ML_VALIDATION_QUICK_START.md`
- **Full Documentation**: `tests/NEW_VALIDATION_TESTS_README.md`
- **Test Suite Guide**: `tests/TEST_SUITE_GUIDE.md`
- **System Documentation**: `tests/README.md`

---

## 🔍 Troubleshooting

### Common Issues

1. **No data found**
   - Ensure ML shadow mode is enabled
   - Check MongoDB collections have data
   - Verify lookback period has data

2. **Import errors**
   - Install missing dependencies: `pip install numpy scipy psutil`
   - Check Python version >= 3.10

3. **Connection errors**
   - Verify MongoDB is running
   - Check MONGO_URL environment variable
   - Test connection: `mongo --eval "db.version()"`

---

## ✨ Features

### Shadow Validation
- ✓ Score invariant checking (0.001 tolerance)
- ✓ ML storage validation
- ✓ Feature vector stability
- ✓ Skip flag behavior
- ✓ Score divergence statistics
- ✓ Recruiter override validation

### Drift Monitoring
- ✓ Feature drift analysis (PSI)
- ✓ Score drift detection
- ✓ Confidence trend analysis
- ✓ Statistical significance testing (KS test, t-test)
- ✓ Configurable time windows
- ✓ Severity classification

### Performance Profiler
- ✓ Report generation latency
- ✓ MongoDB performance
- ✓ Replay evaluation latency
- ✓ WebSocket latency
- ✓ Queue processing times
- ✓ System resources (CPU, RAM, GPU)
- ✓ Percentile statistics (p50, p95, p99)

---

## 🎓 Key Concepts

### PSI (Population Stability Index)
Distribution similarity metric:
- < 0.10: No significant drift ✅
- 0.10 - 0.25: Warning drift ⚠️
- > 0.25: Critical drift 🚨

### Score Divergence
System vs ML score difference:
- < 10: Expected ✅
- 10-20: Monitor ⚠️
- > 20: Investigate 🚨

### Latency Percentiles
- **p50**: Median
- **p95**: SLA target
- **p99**: Worst case

---

## 📊 Report Outputs

### Shadow Validation Report
```json
{
  "validation_rules": {...},
  "checks": {...},
  "violations": [...],
  "summary": {
    "total_checks": 6,
    "passed": 6,
    "failed": 0
  }
}
```

### Drift Report
```json
{
  "drift_alerts": [...],
  "feature_drift": {...},
  "score_drift": {...},
  "confidence_trends": {...},
  "summary": {
    "critical_drift_count": 0
  }
}
```

### Performance Report
```json
{
  "report_latency": {...},
  "mongodb_performance": {...},
  "system_resources": {...},
  "summary": {
    "avg_report_latency_ms": 3421.5,
    "p95_report_latency_ms": 8234.2
  }
}
```

---

## 🤝 Integration

### CI/CD
See `tests/NEW_VALIDATION_TESTS_README.md` for:
- GitHub Actions workflow
- Jenkins pipeline
- GitLab CI configuration

### Monitoring
Integrate with:
- Prometheus/Grafana
- DataDog
- Sentry
- PagerDuty

---

## 📞 Support

For questions or issues:
1. Check documentation: `tests/NEW_VALIDATION_TESTS_README.md`
2. Review logs: `.tmp-test-logs/`
3. Verify MongoDB collections
4. Check Python version and dependencies

---

**Created**: 2024-01-15  
**Version**: 1.0.0  
**Total Lines**: ~2,500+ across all files  
**Languages**: Python, Bash, Markdown  
**Dependencies**: pymongo, numpy, scipy, psutil, gputil (optional)
