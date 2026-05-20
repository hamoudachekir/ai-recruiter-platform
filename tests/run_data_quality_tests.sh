#!/bin/bash

# Data Quality Test Runner
# Runs all data quality, integrity, and consistency tests

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"

# Create results directory
mkdir -p "$RESULTS_DIR"

echo -e "${BLUE}================================================================================================${NC}"
echo -e "${BLUE}                          AI RECRUITER PLATFORM - DATA QUALITY TESTS${NC}"
echo -e "${BLUE}================================================================================================${NC}"
echo ""

# Check MongoDB connection
echo -e "${YELLOW}→ Checking MongoDB connection...${NC}"
if python3 -c "from pymongo import MongoClient; import os; MongoClient(os.getenv('MONGO_URL', 'mongodb://localhost:27017')).server_info()" 2>/dev/null; then
    echo -e "${GREEN}✓ MongoDB connection successful${NC}"
else
    echo -e "${RED}✗ MongoDB connection failed${NC}"
    echo -e "${RED}  Please check MONGO_URL environment variable${NC}"
    exit 1
fi

echo ""

# Test 1: Orphan Detection
echo -e "${BLUE}================================================================================================${NC}"
echo -e "${BLUE}TEST 1/3: Orphan Data Detection${NC}"
echo -e "${BLUE}================================================================================================${NC}"
echo ""

if python3 "$SCRIPT_DIR/audit/orphan_detector.py"; then
    echo -e "${GREEN}✓ Orphan detection completed${NC}"
else
    echo -e "${RED}✗ Orphan detection failed${NC}"
fi

echo ""

# Test 2: Replay Consistency
echo -e "${BLUE}================================================================================================${NC}"
echo -e "${BLUE}TEST 2/3: Replay Consistency Testing${NC}"
echo -e "${BLUE}================================================================================================${NC}"
echo ""

if python3 "$SCRIPT_DIR/audit/replay_consistency_test.py"; then
    echo -e "${GREEN}✓ Replay consistency tests completed${NC}"
else
    echo -e "${RED}✗ Replay consistency tests failed${NC}"
fi

echo ""

# Test 3: Report Integrity
echo -e "${BLUE}================================================================================================${NC}"
echo -e "${BLUE}TEST 3/3: Report Integrity Validation${NC}"
echo -e "${BLUE}================================================================================================${NC}"
echo ""

if python3 "$SCRIPT_DIR/integrity/report_integrity_validator.py"; then
    echo -e "${GREEN}✓ Report integrity validation completed${NC}"
else
    echo -e "${RED}✗ Report integrity validation failed${NC}"
fi

echo ""

# Summary
echo -e "${BLUE}================================================================================================${NC}"
echo -e "${BLUE}                                    TEST SUITE COMPLETE${NC}"
echo -e "${BLUE}================================================================================================${NC}"
echo ""
echo -e "${GREEN}Results saved to:${NC}"
echo -e "  • $RESULTS_DIR/orphan_detection_report.json"
echo -e "  • $RESULTS_DIR/replay_consistency_report.json"
echo -e "  • $RESULTS_DIR/report_integrity_report.json"
echo ""

# Check for issues
ORPHAN_COUNT=$(python3 -c "import json; data=json.load(open('$RESULTS_DIR/orphan_detection_report.json')); print(data['summary']['total_orphaned_records'])" 2>/dev/null || echo "0")
INTEGRITY_VIOLATIONS=$(python3 -c "import json; data=json.load(open('$RESULTS_DIR/report_integrity_report.json')); print(data['summary']['total_violations'])" 2>/dev/null || echo "0")
REPLAY_FAILED=$(python3 -c "import json; data=json.load(open('$RESULTS_DIR/replay_consistency_report.json')); print(data['summary']['failed'])" 2>/dev/null || echo "0")

echo -e "${YELLOW}Summary:${NC}"
echo -e "  • Orphaned records found: ${ORPHAN_COUNT}"
echo -e "  • Integrity violations: ${INTEGRITY_VIOLATIONS}"
echo -e "  • Replay consistency failures: ${REPLAY_FAILED}"
echo ""

if [ "$ORPHAN_COUNT" -gt 0 ] || [ "$INTEGRITY_VIOLATIONS" -gt 0 ] || [ "$REPLAY_FAILED" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Issues detected - review the reports for details${NC}"
    exit 1
else
    echo -e "${GREEN}✓ All tests passed - no issues detected${NC}"
    exit 0
fi
