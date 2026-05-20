# Chaos Tests Quick Reference

Quick commands and expected results for all chaos tests.

## Quick Start

```bash
# Install dependencies
pip install pymongo redis psutil

# Run all automated tests
cd ai-recruiter-platform
python tests/chaos/redis_failure_test.py
python tests/chaos/corrupt_payload_test.py
python tests/chaos/mongo_failure_test.py
python tests/chaos/gpu_timeout_test.py
python tests/chaos/worker_kill_test.py

# View results
ls tests/results/chaos_*_report.json
```

## Test Summary Matrix

| Test File | Automated | Manual | Focus Area | Duration |
|-----------|-----------|--------|------------|----------|
| `redis_failure_test.py` | ✓ | Partial | Queue resilience | ~30s |
| `worker_kill_test.py` | Partial | ✓ | Process failures | ~20s + manual |
| `gpu_timeout_test.py` | ✓ | Partial | GPU failures | ~15s |
| `corrupt_payload_test.py` | ✓ | Partial | Input validation | ~10s |
| `mongo_failure_test.py` | ✓ | Partial | DB resilience | ~20s |

## Expected Test Results

### Redis Failure Test
```
Total Tests: 5
Expected Passed: 3-4
Expected Manual Checks: 1-2
Focus: Queue corruption detection, connection handling
```

### Worker Kill Test
```
Total Tests: 6
Expected Passed: 1-2
Expected Manual Checks: 4-5
Focus: Job recovery, signal handling
```

### GPU Timeout Test
```
Total Tests: 6
Expected Passed: 3-4
Expected Manual Checks: 2-3
Focus: GPU resource management, CPU fallback
```

### Corrupt Payload Test
```
Total Tests: 6
Expected Passed: 6
Expected Manual Checks: 30+
Focus: Input validation, injection prevention
```

### MongoDB Failure Test
```
Total Tests: 5
Expected Passed: 3
Expected Manual Checks: 2
Focus: Connection handling, data integrity
```

## Common Issues & Solutions

### Import Errors

**Problem:** `ModuleNotFoundError: No module named 'redis'`

**Solution:**
```bash
pip install redis pymongo psutil
```

### GPU Not Detected

**Problem:** GPU tests report no GPU available

**Solution:** Tests will still run and document manual test procedures. No action needed unless GPU testing is required.

### Connection Refused

**Problem:** `redis.exceptions.ConnectionError: Error connecting to Redis`

**Solution:** Ensure Redis/MongoDB are running:
```bash
# Check Redis
redis-cli ping

# Check MongoDB
mongosh --eval "db.adminCommand('ping')"
```

## Test Output Files

All tests save results to `tests/results/`:

```
tests/results/
├── chaos_redis_failure_report.json
├── chaos_worker_kill_report.json
├── chaos_gpu_timeout_report.json
├── chaos_corrupt_payload_report.json
└── chaos_mongo_failure_report.json
```

## Manual Test Checklists

### Redis Tests (5-10 minutes)
- [ ] Connection timeout during job processing
- [ ] Queue corruption with dead letter queue
- [ ] Message loss detection

### Worker Tests (15-20 minutes)
- [ ] Kill worker during transcription (SIGKILL)
- [ ] Kill worker during vision analysis (SIGKILL)
- [ ] Kill worker during report generation (SIGKILL)
- [ ] Graceful shutdown (SIGTERM)
- [ ] Multiple simultaneous worker kills

### GPU Tests (10-15 minutes)
- [ ] GPU timeout with long-running job
- [ ] CUDA OOM with large model
- [ ] CPU fallback when GPU unavailable
- [ ] Concurrent GPU job queueing

### Payload Tests (15-20 minutes)
- [ ] Submit malformed JSON
- [ ] Submit invalid audio file
- [ ] Submit oversized payload (>10MB)
- [ ] Test SQL injection attempts
- [ ] Test XSS attempts

### MongoDB Tests (5-10 minutes)
- [ ] Pause MongoDB during report persist
- [ ] Pause MongoDB during finalize
- [ ] Duplicate interviewId insertion

## Success Criteria

A chaos test suite is successful when:

✓ **No Silent Failures**: All failures logged and visible  
✓ **Structured Errors**: All error responses follow standard format  
✓ **Data Integrity**: No partial writes or corrupted documents  
✓ **Resource Cleanup**: No memory leaks or orphaned resources  
✓ **Recoverability**: Failed jobs can be retried successfully  

## Troubleshooting

### Test Hangs

If a test hangs, check:
1. Database/Redis connections active
2. No deadlocks in worker processes
3. GPU not hung (check `nvidia-smi`)

Press `Ctrl+C` to interrupt and check logs.

### False Failures

Some tests may fail if:
- System is under heavy load
- Network latency is high
- Docker containers restarting

Re-run the test or adjust timeout values.

### Manual Test Setup

For manual tests that require system modification:

1. **Backup data first**
2. **Run in non-production environment**
3. **Have recovery plan ready**
4. **Monitor system resources**
5. **Document all findings**

## Next Steps

After running chaos tests:

1. Review all JSON reports
2. Address any unexpected failures
3. Document system improvements
4. Schedule regular chaos testing (monthly/quarterly)
5. Update error handling based on findings

## Support

For questions or issues:
- Check main README: `tests/chaos/README.md`
- Review test source code for implementation details
- Check system logs: Application logs, MongoDB logs, Redis logs
