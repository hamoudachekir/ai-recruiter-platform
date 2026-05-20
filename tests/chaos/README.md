# Chaos Testing Suite

This directory contains chaos engineering tests to validate the AI Recruiter Platform's resilience under failure conditions.

## Overview

Chaos tests simulate real-world failure scenarios to ensure the system:
- Fails gracefully without data corruption
- Provides clear, structured error messages
- Recovers automatically where possible
- Marks jobs appropriately when recovery is impossible
- Maintains audit trails of all failures

## Test Files

### 1. `redis_failure_test.py`
Tests Redis queue failures and recovery mechanisms.

**Test Cases:**
- **Delayed Responses**: High latency Redis operations
- **Connection Timeout**: Redis connection times out during operations
- **Queue Corruption**: Malformed messages in queue
- **Message Loss**: Messages disappearing from queue
- **Connection Pool Exhaustion**: Too many concurrent connections

**Run:**
```bash
python tests/chaos/redis_failure_test.py
```

**Output:** `tests/results/chaos_redis_failure_report.json`

---

### 2. `worker_kill_test.py`
Tests worker process failures during critical operations.

**Test Cases:**
- **Kill During Transcription**: Worker terminated during audio processing
- **Kill During Vision Analysis**: Worker terminated during video analysis
- **Kill During Report Generation**: Worker terminated during final report
- **Job Recovery Mechanism**: Verify retry and recovery logic
- **Signal Handling**: Test SIGTERM, SIGINT, SIGKILL responses
- **Concurrent Worker Failures**: Multiple workers killed simultaneously

**Run:**
```bash
python tests/chaos/worker_kill_test.py
```

**Output:** `tests/results/chaos_worker_kill_report.json`

**Manual Testing Required:** Most tests require manual worker termination to verify behavior.

---

### 3. `gpu_timeout_test.py`
Tests GPU timeout and failure scenarios.

**Test Cases:**
- **GPU Hang Detection**: Long-running GPU operation timeout
- **CUDA Out of Memory**: GPU memory exhaustion handling
- **Graceful Degradation to CPU**: GPU-to-CPU fallback mechanism
- **Concurrent GPU Requests**: Multiple jobs competing for GPU
- **GPU Driver Crash**: Driver failure recovery
- **Memory Fragmentation**: GPU memory fragmentation handling

**Run:**
```bash
python tests/chaos/gpu_timeout_test.py
```

**Output:** `tests/results/chaos_gpu_timeout_report.json`

**Requirements:** 
- NVIDIA GPU (optional, will document manual tests if not available)
- `nvidia-smi` command available

---

### 4. `corrupt_payload_test.py`
Tests corrupted and malformed data handling.

**Test Cases:**
- **Corrupted Transcript JSON**: Malformed JSON parsing
- **Invalid Audio File**: Corrupted/invalid audio files
- **Malformed Vision Payload**: Invalid vision analysis data
- **Missing Required Fields**: Incomplete API requests
- **Oversized Payload**: Payload size limit enforcement
- **Special Characters & Injection**: SQL/NoSQL/XSS injection attempts

**Run:**
```bash
python tests/chaos/corrupt_payload_test.py
```

**Output:** `tests/results/chaos_corrupt_payload_report.json`

---

### 5. `mongo_failure_test.py`
Tests MongoDB failure scenarios.

**Test Cases:**
- **Connection Drop During Persist**: MongoDB disconnects during report save
- **Connection Drop During Finalize**: MongoDB disconnects during finalization
- **Slow Queries**: Extremely slow MongoDB responses
- **Duplicate Key Collision**: Attempting to insert duplicate interviewId
- **Missing Collection**: Access to non-existent collection

**Run:**
```bash
python tests/chaos/mongo_failure_test.py
```

**Output:** `tests/results/chaos_mongo_failure_report.json`

---

## Running All Chaos Tests

### Individual Tests
```bash
# Redis failures
python tests/chaos/redis_failure_test.py

# Worker failures
python tests/chaos/worker_kill_test.py

# GPU timeouts
python tests/chaos/gpu_timeout_test.py

# Corrupted payloads
python tests/chaos/corrupt_payload_test.py

# MongoDB failures
python tests/chaos/mongo_failure_test.py
```

### Batch Execution
```bash
# Run all tests (from project root)
for test in tests/chaos/*_test.py; do
    echo "Running $test..."
    python "$test"
    echo ""
done
```

## Expected Behaviors

All chaos tests verify these core principles:

### 1. **No Silent Failures**
- Jobs must be marked as `failed` when they cannot complete
- Error information must be persisted to the database
- Audit logs must capture failure events

### 2. **Structured Error Responses**
All errors should follow this format:
```json
{
  "error": {
    "type": "timeout|validation|system|network",
    "message": "Human-readable error message",
    "details": {
      "stage": "transcription|vision|report",
      "timestamp": "ISO-8601",
      "additionalInfo": {}
    }
  }
}
```

### 3. **Data Integrity**
- No partial writes to database
- All-or-nothing transactions
- No corrupted documents
- Original data preserved on failure

### 4. **Resource Cleanup**
- GPU memory released after failure
- Temporary files cleaned up
- Database connections closed
- Redis connections returned to pool

### 5. **Recoverability**
- Failed jobs can be retried
- Retry count tracked
- Max retry limit enforced
- Clear retry vs permanent failure distinction

## Manual Testing

Many chaos scenarios require manual intervention. Each test file includes detailed instructions in its output.

### Common Manual Tests

#### 1. Kill Worker Process
```bash
# Find worker PID
ps aux | grep worker

# Kill with SIGKILL (abrupt)
kill -9 <PID>

# Kill with SIGTERM (graceful)
kill -15 <PID>
```

#### 2. Simulate Network Issues
```bash
# Add network delay (Linux)
sudo tc qdisc add dev eth0 root netem delay 1000ms

# Drop packets
sudo tc qdisc add dev eth0 root netem loss 50%

# Reset
sudo tc qdisc del dev eth0 root netem
```

#### 3. GPU Memory Limit
```bash
# Reduce GPU power limit (forces OOM faster)
sudo nvidia-smi -pl 50

# Reset to default
sudo nvidia-smi -pl <default_wattage>
```

#### 4. MongoDB Disconnect
```bash
# Pause MongoDB (Docker)
docker pause mongodb-container

# Resume
docker unpause mongodb-container

# Or stop/start
docker stop mongodb-container
docker start mongodb-container
```

#### 5. Redis Flush
```bash
# Flush specific database
redis-cli -n 0 FLUSHDB

# Flush all
redis-cli FLUSHALL
```

## Interpreting Results

### Test Status Values

- **`pass`**: Test completed and all checks passed
- **`fail`**: Test completed but checks failed
- **`error`**: Test encountered an unexpected error
- **`manual_check_required`**: Test requires manual verification
- **`not_implemented`**: Test is documented but not automated

### Check Status Values

- **`pass`**: Check succeeded
- **`fail`**: Check failed
- **`manual_check`**: Requires manual verification

### Sample Report Structure
```json
{
  "timestamp": "2024-01-01T12:00:00Z",
  "tests": {
    "test_name": {
      "name": "test_name",
      "description": "Test description",
      "status": "pass",
      "checks": {
        "check_name": {
          "expected": "Expected behavior",
          "actual": "Actual result",
          "status": "pass"
        }
      },
      "error": null
    }
  },
  "summary": {
    "total": 5,
    "passed": 4,
    "failed": 1
  }
}
```

## Best Practices

1. **Run in Non-Production Environment**: Always run chaos tests in development/staging
2. **Backup Data**: Ensure database backups before testing
3. **Monitor Resources**: Watch CPU, memory, GPU during tests
4. **Review Logs**: Check application logs for error handling
5. **Verify Recovery**: Ensure system recovers after each test
6. **Document Findings**: Note any unexpected behaviors

## Integration with CI/CD

### Automated Tests
Can be added to CI pipeline:
```yaml
# .github/workflows/chaos-tests.yml
- name: Run Chaos Tests
  run: |
    python tests/chaos/corrupt_payload_test.py
    python tests/chaos/mongo_failure_test.py
```

### Manual Tests
Run periodically (monthly/quarterly):
- Worker kill tests
- GPU timeout tests
- Network partition tests
- Complete system chaos

## Dependencies

All chaos tests require:
```bash
pip install pymongo redis psutil
```

GPU tests additionally require:
```bash
# NVIDIA drivers and toolkit
nvidia-smi
```

## Contributing

When adding new chaos tests:

1. Follow the existing test pattern
2. Include clear expected behaviors
3. Document manual test procedures
4. Save results to `tests/results/`
5. Update this README

## Related Documentation

- [System Validation Report](../SYSTEM_VALIDATION_REPORT.json)
- [Load Testing](../load/)
- [Performance Testing](../performance/)
- [Integrity Testing](../integrity/)

## References

- [Principles of Chaos Engineering](https://principlesofchaos.org/)
- [Netflix Chaos Monkey](https://netflix.github.io/chaosmonkey/)
- [Google SRE Book - Chapter 32: Chaos Engineering](https://sre.google/sre-book/table-of-contents/)
