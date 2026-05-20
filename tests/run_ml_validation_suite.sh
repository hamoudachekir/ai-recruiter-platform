#!/bin/bash
# ML Validation Suite Runner
# Runs all ML shadow validation, drift monitoring, and performance profiling tests

set -e  # Exit on error

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         ML VALIDATION & PERFORMANCE TEST SUITE                    ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check Python version
PYTHON_VERSION=$(python --version 2>&1 | awk '{print $2}')
echo -e "${BLUE}Python version:${NC} $PYTHON_VERSION"
echo ""

# Check dependencies
echo -e "${BLUE}Checking dependencies...${NC}"
python -c "import pymongo; import numpy; import scipy; import psutil" 2>/dev/null
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ All required dependencies installed${NC}"
else
    echo -e "${RED}✗ Missing dependencies. Install with:${NC}"
    echo -e "${YELLOW}  pip install pymongo numpy scipy psutil${NC}"
    exit 1
fi
echo ""

# Create results directory
mkdir -p results
echo -e "${GREEN}✓ Results directory ready: tests/results/${NC}"
echo ""

# Function to run test with error handling
run_test() {
    local test_name=$1
    local test_file=$2

    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}Running: ${test_name}${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    if python "$test_file"; then
        echo ""
        echo -e "${GREEN}✓ ${test_name} completed successfully${NC}"
        return 0
    else
        echo ""
        echo -e "${RED}✗ ${test_name} failed${NC}"
        return 1
    fi
}

# Track results
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Test 1: ML Shadow Validation
if run_test "ML Shadow Validation" "ml/shadow_validation.py"; then
    ((TESTS_PASSED++))
else
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))
echo ""
echo ""

# Test 2: ML Drift Monitoring
if run_test "ML Drift Monitoring" "ml/drift_validation.py"; then
    ((TESTS_PASSED++))
else
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))
echo ""
echo ""

# Test 3: Performance Baseline Profiler
if run_test "Performance Baseline Profiler" "performance/baseline_profiler.py"; then
    ((TESTS_PASSED++))
else
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))
echo ""
echo ""

# Print final summary
echo -e "${BLUE}╔═══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                    TEST SUITE SUMMARY                             ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Tests run:    ${TESTS_RUN}"
echo -e "${GREEN}Passed:       ${TESTS_PASSED}${NC}"
if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "${RED}Failed:       ${TESTS_FAILED}${NC}"
else
    echo -e "Failed:       ${TESTS_FAILED}"
fi
echo ""

# List generated reports
if [ -d "results" ] && [ "$(ls -A results/*.json 2>/dev/null)" ]; then
    echo -e "${BLUE}Generated Reports:${NC}"
    ls -lh results/*.json | awk '{print "  " $9 " (" $5 ")"}'
    echo ""
fi

# Exit with appropriate code
if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "${RED}═════════════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}  ✗ SOME TESTS FAILED - REVIEW REPORTS FOR DETAILS${NC}"
    echo -e "${RED}═════════════════════════════════════════════════════════════════${NC}"
    exit 1
else
    echo -e "${GREEN}═════════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  ✓ ALL TESTS PASSED${NC}"
    echo -e "${GREEN}═════════════════════════════════════════════════════════════════${NC}"
    exit 0
fi
