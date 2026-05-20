# System Validation Test Suite

## 🎯 Purpose

This test suite validates **ALL 5 phases** of the AI Recruiter Platform to ensure production readiness:

- ✅ **Phase 1**: Pipeline Stability
- ✅ **Phase 2**: Atomic + Replayable Architecture  
- ✅ **Phase 3**: Explainability + Bias + Auditability
- ✅ **Phase 4**: ML Calibration (Shadow Mode)
- ✅ **Phase 4.5**: Validation + Governance
- ✅ **Phase 5**: Enterprise Infrastructure

---

## 🚀 Quick Start

### Prerequisites

Make sure all services are running:

```bash
# Terminal 1: Backend API
cd Backend/server
npm start

# Terminal 2: Analysis Service
cd Backend/analysis_service
python -m uvicorn app.main:app --host 0.0.0.0 --port 8090

# Terminal 3: MongoDB
mongod

# Terminal 4: Frontend (optional, for manual testing)
cd Frontend
npm run dev
```

### Run Validation Suite

```bash
cd tests
python run_full_system_validation.py
```

### Install Dependencies

```bash
pip install pymongo requests
```

---

## 📊 What Gets Validated

### Phase 1: Pipeline Stability
- ✓ Analysis service running
- ✓ Backend API running
- ✓ MongoDB connected
- ✓ Required collections exist

### Phase 2: Atomic + Replayable
- ✓ Reports have graph versions
- ✓ Pipeline snapshots exist
- ✓ Deterministic replay (same input = same output)

### Phase 3: Explainability + Bias + Audit
- ✓ Decision trace exists
- ✓ Score breakdown with evidence
- ✓ Reasoning steps documented
- ✓ Evidence map complete
- ✓ All scores have evidence
- ✓ Bias report exists
- ✓ Bias risk level calculated
- ✓ Confidence assessment exists
- ✓ Audit log references exist
- ✓ Audit events in database

### Phase 4: ML Calibration (Shadow Mode)
- ✓ Shadow mode flag exists
- ✓ Shadow mode is enabled
- ✓ ML model version tracked
- ✓ System score != ML score (isolation)
- ✓ Feature extraction working

### Phase 4.5: Validation + Governance
- ✓ Feature schema version exists
- ✓ A/B testing group assigned
- ✓ Graph version exists
- ✓ Graph completed successfully
- ✓ Quality gates exist

### Phase 5: Enterprise Infrastructure
- ✓ Metrics endpoint accessible
- ✓ ATS integration infrastructure
- ✓ Tenant support infrastructure

---

## 📈 Expected Output

```
╔══════════════════════════════════════════════════════════════════╗
║         AI RECRUITER PLATFORM - SYSTEM VALIDATION SUITE          ║
╚══════════════════════════════════════════════════════════════════╝

======================================================================
PHASE 1: PIPELINE STABILITY
======================================================================

✓ Analysis service running: PASS
✓ Backend API running: PASS
✓ MongoDB connected: PASS
✓ Collection 'video_analysis_jobs' exists: PASS
✓ Collection 'interview_final_reports' exists: PASS
...

======================================================================
VALIDATION SUMMARY
======================================================================

✓ Phase 1: PASS
✓ Phase 2: PASS
✓ Phase 3: PASS
⚠ Phase 4: PARTIAL
✓ Phase 4.5: PASS
✓ Phase 5: PASS

Total Tests: 45
Passed: 42
Failed: 3

Pass Rate: 93.3%

✓ SYSTEM VALIDATION: PASS
System is production-ready!

Report saved to: tests/SYSTEM_VALIDATION_REPORT.json
```

---

## 📝 Output Files

### SYSTEM_VALIDATION_REPORT.json

Contains detailed results:

```json
{
  "timestamp": "2026-05-12T17:30:00.000000",
  "phases": {
    "Phase 1": {
      "status": "pass",
      "tests": {
        "analysis_service_running": true,
        "backend_api_running": true,
        "mongodb_connected": true,
        ...
      }
    },
    ...
  },
  "summary": {
    "total_tests": 45,
    "passed": 42,
    "failed": 3,
    "warnings": 0
  }
}
```

---

## 🎯 Pass Criteria

| Pass Rate | Status | Meaning |
|-----------|--------|---------|
| ≥ 80% | ✅ PASS | Production-ready |
| 60-79% | ⚠️ PARTIAL | Needs attention |
| < 60% | ❌ FAIL | Not production-ready |

---

## 🔍 Troubleshooting

### "Analysis service not running"
```bash
cd Backend/analysis_service
python -m uvicorn app.main:app --host 0.0.0.0 --port 8090
```

### "MongoDB not connected"
```bash
# Check if MongoDB is running
mongosh

# Start MongoDB
mongod
```

### "No reports found"
Run at least one interview through the system before validation:
1. Create a call room
2. Have a candidate join
3. Complete the interview
4. Run analysis

### "Collection not found"
The system will create collections automatically on first use. Run a complete interview first.

---

## 🧪 Manual Testing Checklist

After automated validation passes, manually test:

- [ ] Create a new call room
- [ ] Candidate joins and completes interview
- [ ] Run post-interview analysis
- [ ] Verify report generation
- [ ] Check explainability (decision trace)
- [ ] Verify bias detection works
- [ ] Confirm confidence scoring
- [ ] Test report download (PDF, TXT)
- [ ] Verify candidate report view
- [ ] Check recruiter dashboard

---

## 📚 Next Steps

### If Tests PASS ✅
1. Review `SYSTEM_VALIDATION_REPORT.json`
2. Check `PHASE_VERIFICATION_REPORT.md`
3. Deploy to staging environment
4. Run user acceptance testing
5. Document any edge cases
6. Prepare for production

### If Tests FAIL ❌
1. Review failed test details in console
2. Check `SYSTEM_VALIDATION_REPORT.json`
3. Fix issues one phase at a time
4. Re-run validation
5. Document fixes

---

## 🔧 Advanced Usage

### Run Specific Phase Only

Edit `run_full_system_validation.py`:

```python
# Comment out phases you don't want to test
self.results["phases"]["Phase 1"] = self.validate_phase1_pipeline()
# self.results["phases"]["Phase 2"] = self.validate_phase2_replay()
# ...
```

### Add Custom Tests

Add methods to `SystemValidator` class:

```python
def validate_custom_feature(self) -> Dict[str, Any]:
    results = {
        "status": "pass",
        "tests": {},
    }
    
    # Your test logic here
    
    return results
```

### Change Database

Edit configuration at the top of the file:

```python
MONGO_URL = "mongodb://your-host:27017"
DB_NAME = "your_database"
```

---

## 🎉 Production Checklist

Before deploying to production:

- [ ] Validation suite passes (≥80%)
- [ ] All Phase 3 tests pass (explainability)
- [ ] Shadow mode enabled (Phase 4)
- [ ] Quality gates enforced (Phase 4.5)
- [ ] Load testing completed
- [ ] Security audit completed
- [ ] Documentation updated
- [ ] Monitoring configured
- [ ] Backup strategy in place
- [ ] Rollback plan documented

---

## 📞 Support

If you encounter issues:

1. Check the console output for specific error messages
2. Review `SYSTEM_VALIDATION_REPORT.json`
3. Check service logs:
   - Backend: `Backend/server/logs/`
   - Analysis: `Backend/analysis_service/.launch-logs/`
4. Verify all services are running
5. Check MongoDB connection

---

## 📖 Documentation

- `PHASE_VERIFICATION_REPORT.md` - Detailed phase-by-phase verification
- `FIX_SUMMARY.md` - Recent fixes and changes
- `QUICK_START.md` - Quick start guide

---

**Remember**: This is a **production AI decision system**. Correctness > Features!
