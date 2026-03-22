#!/bin/bash
# scripts/assemble-bundle.sh
# Assemble the macOS app bundle from build artifacts
#
# Takes build artifacts from:
#   - swift-host/.build/release/assistantservicesd
#   - node-backend/dist/main.js
#   - dist/ (React UI)
#   - models/ (ONNX models if present)
#
# Creates:
#   - build/AssistantServices.app
#
# Usage:
#   ./scripts/assemble-bundle.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_ROOT/build"
APP_NAME="AssistantServices"
APP_PATH="$BUILD_DIR/$APP_NAME.app"

echo "Assembling $APP_NAME.app..."

# Clean previous build
rm -rf "$APP_PATH"

# Create bundle structure
mkdir -p "$APP_PATH/Contents/MacOS"
mkdir -p "$APP_PATH/Contents/Resources/dist"
mkdir -p "$APP_PATH/Contents/Resources/backend"
mkdir -p "$APP_PATH/Contents/Resources/models"
mkdir -p "$APP_PATH/Contents/Frameworks"

# Copy Info.plist
INFO_PLIST="$PROJECT_ROOT/swift-host/NativelyHost/Resources/Info.plist"
if [ -f "$INFO_PLIST" ]; then
    cp "$INFO_PLIST" "$APP_PATH/Contents/"
    echo "  Copied Info.plist"
else
    echo "WARNING: Info.plist not found at $INFO_PLIST"
    # Create minimal Info.plist
    cat > "$APP_PATH/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>assistantservicesd</string>
    <key>CFBundleIdentifier</key>
    <string>com.local.AssistantServices</string>
    <key>CFBundleName</key>
    <string>AssistantServices</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
EOF
fi

# Copy Swift executable
SWIFT_BINARY="$PROJECT_ROOT/swift-host/.build/release/assistantservicesd"
if [ -f "$SWIFT_BINARY" ]; then
    cp "$SWIFT_BINARY" "$APP_PATH/Contents/MacOS/assistantservicesd"
    chmod +x "$APP_PATH/Contents/MacOS/assistantservicesd"
    echo "  Copied Swift executable"
else
    echo "ERROR: Swift binary not found at $SWIFT_BINARY"
    echo "Run 'cd swift-host && swift build -c release' first"
    exit 1
fi

# Copy React UI (if exists)
if [ -d "$PROJECT_ROOT/dist" ]; then
    cp -r "$PROJECT_ROOT/dist/"* "$APP_PATH/Contents/Resources/dist/"
    echo "  Copied React UI"
else
    echo "  Skipping React UI (dist/ not found)"
fi

# Copy Node.js backend
if [ -f "$PROJECT_ROOT/node-backend/dist/main.js" ]; then
    cp -r "$PROJECT_ROOT/node-backend/dist/"* "$APP_PATH/Contents/Resources/backend/"
    echo "  Copied Node.js backend"
else
    echo "  Skipping Node.js backend (node-backend/dist/ not found)"
fi

# Copy Node.js binary as renamed executable (for stealth)
NODE_PATH=$(which node 2>/dev/null || echo "")
if [ -n "$NODE_PATH" ] && [ -f "$NODE_PATH" ]; then
    cp "$NODE_PATH" "$APP_PATH/Contents/Resources/assistantd"
    chmod +x "$APP_PATH/Contents/Resources/assistantd"
    echo "  Copied Node.js as assistantd"
else
    echo "  WARNING: Node.js not found, backend will not work"
fi

# Copy Rust native module (if exists)
NATIVE_MODULE="$PROJECT_ROOT/native-module/native.node"
if [ -f "$NATIVE_MODULE" ]; then
    cp "$NATIVE_MODULE" "$APP_PATH/Contents/Frameworks/"
    echo "  Copied Rust native module"
fi

# Copy ONNX models (if present)
MODELS_SWIFT="$PROJECT_ROOT/swift-host/NativelyHost/Resources/models"
MODELS_ROOT="$PROJECT_ROOT/models"

if [ -d "$MODELS_SWIFT" ] && [ "$(ls -A "$MODELS_SWIFT" 2>/dev/null)" ]; then
    cp -r "$MODELS_SWIFT/"* "$APP_PATH/Contents/Resources/models/"
    echo "  Copied ONNX models from swift-host"
elif [ -d "$MODELS_ROOT" ] && [ "$(ls -A "$MODELS_ROOT" 2>/dev/null)" ]; then
    cp -r "$MODELS_ROOT/"* "$APP_PATH/Contents/Resources/models/"
    echo "  Copied ONNX models from models/"
else
    echo "  No ONNX models found (ANE embeddings will use fallback)"
fi

# Create PkgInfo
echo -n "APPL????" > "$APP_PATH/Contents/PkgInfo"

echo ""
echo "Bundle assembled at $APP_PATH"
echo ""
echo "Bundle structure:"
find "$APP_PATH" -type f | head -20 | while read -r f; do
    SIZE=$(du -h "$f" | cut -f1)
    echo "  $SIZE  ${f#$APP_PATH/}"
done

TOTAL_SIZE=$(du -sh "$APP_PATH" | cut -f1)
echo ""
echo "Total size: $TOTAL_SIZE"
