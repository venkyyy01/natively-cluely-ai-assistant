#!/bin/bash

# Comprehensive validation script for Native Architecture implementation
# Tests all components and features according to the spec

set -e

echo "=== Natively Native Architecture Validation ==="
echo

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

failed_tests=0
total_tests=0

test_result() {
    local test_name="$1"
    local success="$2"
    total_tests=$((total_tests + 1))
    
    if [ "$success" = "true" ]; then
        echo -e "${GREEN}✓${NC} $test_name"
    else
        echo -e "${RED}✗${NC} $test_name"
        failed_tests=$((failed_tests + 1))
    fi
}

test_json_rpc() {
    local method="$1"
    local params="$2"
    local expected_key="$3"
    
    local payload="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\""
    if [ -n "$params" ]; then
        payload="$payload,\"params\":$params"
    fi
    payload="$payload}"
    
    cd node-backend
    local response=$(echo "$payload" | node dist/main.js 2>/dev/null | tail -1)
    cd ..
    
    if echo "$response" | jq -e "has(\"result\") and (.result | has(\"$expected_key\"))" >/dev/null 2>&1; then
        return 0
    elif echo "$response" | jq -e ".result" >/dev/null 2>&1 && [ -z "$expected_key" ]; then
        return 0
    else
        echo "  Response: $response"
        return 1
    fi
}

echo "1. Build System Validation"
echo "========================="

# Test Swift build
cd swift-host
if swift build >/dev/null 2>&1; then
    test_result "Swift host builds successfully" true
else
    test_result "Swift host builds successfully" false
fi
cd ..

# Test Node.js build
cd node-backend
if pnpm build >/dev/null 2>&1; then
    test_result "Node.js backend builds successfully" true
else
    test_result "Node.js backend builds successfully" false
fi
cd ..

# Test full app build
if ./scripts/build-macos.sh >/dev/null 2>&1; then
    test_result "Full app bundle builds successfully" true
else
    test_result "Full app bundle builds successfully" false
fi

echo

echo "2. Core RPC Methods"
echo "=================="

# Test ping
if test_json_rpc "ping" "" ""; then
    test_result "Basic ping/pong IPC" true
else
    test_result "Basic ping/pong IPC" false
fi

# Test settings
if test_json_rpc "settings:getAll" "" "isUndetectable"; then
    test_result "Settings management" true
else
    test_result "Settings management" false
fi

# Test cache stats
if test_json_rpc "cache:getStats" "" "response"; then
    test_result "Cache statistics" true
else
    test_result "Cache statistics" false
fi

# Test LLM stats
if test_json_rpc "llm:getStats" "" "totalRequests"; then
    test_result "LLM client statistics" true
else
    test_result "LLM client statistics" false
fi

echo

echo "3. Intelligence Pipeline"
echo "======================"

# Test context assembly
context_params='{"sources":[{"type":"transcript","priority":10}],"budget":1000,"query":"test"}'
if test_json_rpc "context:assemble" "$context_params" "chunks"; then
    test_result "Parallel context assembly" true
else
    test_result "Parallel context assembly" false
fi

# Test prefetch prediction
prefetch_params='{"phase":"technical","recentQuestions":["What is React?"],"topics":["frontend"]}'
if test_json_rpc "prefetch:predict" "$prefetch_params" "questions"; then
    test_result "Predictive prefetching" true
else
    test_result "Predictive prefetching" false
fi

# Test prefetch stats
if test_json_rpc "prefetch:getStats" "" "cache"; then
    test_result "Prefetch cache statistics" true
else
    test_result "Prefetch cache statistics" false
fi

echo

echo "4. File Structure Validation"
echo "==========================="

# Check Swift files
swift_files=(
    "swift-host/NativelyHost/App.swift"
    "swift-host/NativelyHost/AppDelegate.swift"
    "swift-host/NativelyHost/ASPanel.swift"
    "swift-host/NativelyHost/ASWindow.swift"
    "swift-host/NativelyHost/DisplayExclusionManager.swift"
    "swift-host/NativelyHost/WebViewManager.swift"
    "swift-host/NativelyHost/IPCBridge.swift"
    "swift-host/NativelyHost/ANEEmbeddingService.swift"
    "swift-host/NativelyHost/BertTokenizer.swift"
    "swift-host/NativelyHost/HotkeyManager.swift"
    "swift-host/NativelyHost/ScreenCapture.swift"
    "swift-host/NativelyHost/StatusBarManager.swift"
    "swift-host/NativelyHost/WindowManager.swift"
)

for file in "${swift_files[@]}"; do
    if [ -f "$file" ]; then
        test_result "$(basename "$file") exists" true
    else
        test_result "$(basename "$file") exists" false
    fi
done

# Check Node.js files
node_files=(
    "node-backend/main.ts"
    "node-backend/rpc-handlers.ts"
    "node-backend/settings.ts"
    "node-backend/llm/LLMClient.ts"
    "node-backend/llm/PromptCompiler.ts"
    "node-backend/llm/StreamManager.ts"
    "node-backend/cache/EnhancedCache.ts"
    "node-backend/context/ParallelContextAssembler.ts"
    "node-backend/context/AdaptiveContextWindow.ts"
    "node-backend/prefetch/PredictivePrefetcher.ts"
    "node-backend/workers/ScoringWorker.ts"
)

for file in "${node_files[@]}"; do
    if [ -f "$file" ]; then
        test_result "$(basename "$file") exists" true
    else
        test_result "$(basename "$file") exists" false
    fi
done

echo

echo "5. Stealth Configuration"
echo "======================="

# Check Info.plist stealth settings
if grep -q "assistantservicesd" swift-host/NativelyHost/Resources/Info.plist; then
    test_result "Process name camouflaged as assistantservicesd" true
else
    test_result "Process name camouflaged as assistantservicesd" false
fi

if grep -q "<key>LSUIElement</key>" swift-host/NativelyHost/Resources/Info.plist; then
    test_result "Dock icon hidden (LSUIElement)" true
else
    test_result "Dock icon hidden (LSUIElement)" false
fi

if grep -q "com.local.AssistantServices" swift-host/NativelyHost/Resources/Info.plist; then
    test_result "Bundle ID camouflaged" true
else
    test_result "Bundle ID camouflaged" false
fi

# Check for display exclusion in ASPanel/ASWindow
if grep -q "sharingType.*none" swift-host/NativelyHost/ASPanel.swift; then
    test_result "Display exclusion configured (sharingType = .none)" true
else
    test_result "Display exclusion configured (sharingType = .none)" false
fi

echo

echo "6. Build Artifacts"
echo "================="

# Check if app bundle exists
if [ -d "build/AssistantServices.app" ]; then
    test_result "App bundle created" true
else
    test_result "App bundle created" false
fi

# Check if executable is properly named
if [ -f "build/AssistantServices.app/Contents/MacOS/assistantservicesd" ]; then
    test_result "Executable properly named" true
else
    test_result "Executable properly named" false
fi

# Check if backend is bundled
if [ -f "build/AssistantServices.app/Contents/Resources/backend/main.js" ]; then
    test_result "Backend bundled in app" true
else
    test_result "Backend bundled in app" false
fi

echo

echo "=== Validation Summary ==="
echo "Total tests: $total_tests"
echo "Passed: $((total_tests - failed_tests))"
echo "Failed: $failed_tests"

if [ $failed_tests -eq 0 ]; then
    echo -e "${GREEN}🎉 All tests passed! Implementation is complete and working.${NC}"
    exit 0
else
    echo -e "${RED}❌ $failed_tests test(s) failed. Implementation needs attention.${NC}"
    exit 1
fi