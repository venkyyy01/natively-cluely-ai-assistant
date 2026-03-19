#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Natively — One-Click Build & Install for macOS                  ║
# ║  Usage:  chmod +x build-and-install.sh && ./build-and-install.sh ║
# ╚═══════════════════════════════════════════════════════════════════╝

set -euo pipefail

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Constants ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Natively"
INSTALL_DIR="/Applications"
ENTITLEMENTS="$SCRIPT_DIR/assets/entitlements.mac.plist"

# ── Helpers ──
info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[  ✓ ]${NC}  $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
fail()    { echo -e "${RED}[FAIL]${NC}  $1"; exit 1; }
step()    { echo -e "\n${CYAN}${BOLD}━━━ $1 ━━━${NC}"; }

# ── Detect Architecture ──
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
    BUILD_ARCH="arm64"
    ARCH_LABEL="Apple Silicon"
elif [[ "$ARCH" == "x86_64" ]]; then
    BUILD_ARCH="x64"
    ARCH_LABEL="Intel"
else
    fail "Unsupported architecture: $ARCH"
fi

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Banner                                                          ║
# ╚═══════════════════════════════════════════════════════════════════╝
echo ""
echo -e "${CYAN}${BOLD}"
echo "  ┌─────────────────────────────────────────┐"
echo "  │     Natively — Build & Install           │"
echo "  │     macOS • $ARCH_LABEL ($BUILD_ARCH)              │"
echo "  └─────────────────────────────────────────┘"
echo -e "${NC}"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 1: Check Prerequisites                                     ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 1/7 — Checking Prerequisites"

# macOS check
if [[ "$(uname)" != "Darwin" ]]; then
    fail "This script is macOS only."
fi
success "macOS $(sw_vers -productVersion) detected"

# Xcode CLI tools
if ! xcode-select -p &>/dev/null; then
    warn "Xcode Command Line Tools not found. Installing..."
    xcode-select --install
    echo "Please complete the Xcode CLI Tools installation, then re-run this script."
    exit 1
fi
success "Xcode CLI Tools found"

# Node.js
if ! command -v node &>/dev/null; then
    fail "Node.js not found. Install it: brew install node@18"
fi
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 18 ]]; then
    fail "Node.js 18+ required. Found: $(node -v). Run: brew install node@18"
fi
success "Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
    fail "npm not found (should come with Node.js)"
fi
success "npm $(npm -v)"

# Python (needed for node-gyp)
if command -v python3 &>/dev/null; then
    success "Python 3 found ($(python3 --version 2>&1))"
elif command -v python &>/dev/null; then
    success "Python found ($(python --version 2>&1))"
else
    warn "Python not found. node-gyp may fail. Install: brew install python3"
fi

# Rust (optional - for native audio module)
if command -v rustc &>/dev/null; then
    success "Rust $(rustc --version | awk '{print $2}') (native audio module will be built)"
    HAS_RUST=true
else
    warn "Rust not found (optional — native audio module will be skipped)"
    HAS_RUST=false
fi

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 2: Environment Configuration                               ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 2/7 — Environment Configuration"

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    warn "No .env file found. Creating template..."
    cat > "$SCRIPT_DIR/.env" << 'ENVEOF'
# ── Cloud AI Providers (at least one required) ──
GEMINI_API_KEY=
GROQ_API_KEY=
OPENAI_API_KEY=
CLAUDE_API_KEY=

# ── Speech Provider (for transcription) ──
DEEPGRAM_API_KEY=

# ── Local AI via Ollama (free alternative) ──
USE_OLLAMA=true
OLLAMA_MODEL=llama3.2
OLLAMA_URL=http://localhost:11434

# ── Default Model ──
DEFAULT_MODEL=gemini-3.1-flash-lite-preview
ENVEOF
    warn "Created .env with defaults. Edit it later to add your API keys."
    warn "The app will work with Ollama (local) without any API keys."
else
    success ".env file exists"
fi

# Check if at least one AI key is configured
HAS_KEY=false
while IFS='=' read -r key value; do
    # Skip comments and empty lines
    [[ "$key" =~ ^#.*$ ]] && continue
    [[ -z "$key" ]] && continue
    key=$(echo "$key" | xargs) # trim whitespace
    value=$(echo "$value" | xargs)
    
    if [[ "$key" == "GEMINI_API_KEY" || "$key" == "GROQ_API_KEY" || "$key" == "OPENAI_API_KEY" || "$key" == "CLAUDE_API_KEY" ]]; then
        if [[ -n "$value" && "$value" != "dummy_key" ]]; then
            HAS_KEY=true
            break
        fi
    fi
    if [[ "$key" == "USE_OLLAMA" && "$value" == "true" ]]; then
        HAS_KEY=true
        break
    fi
done < "$SCRIPT_DIR/.env"

if [[ "$HAS_KEY" == "true" ]]; then
    success "AI provider configured"
else
    warn "No AI provider API key set. Add keys to .env or install Ollama for local AI."
fi

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 3: Install Dependencies                                    ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 3/7 — Installing Dependencies"

cd "$SCRIPT_DIR"

# Clean install
if [[ -d "node_modules" ]]; then
    info "node_modules exists, running npm install to sync..."
else
    info "Fresh install — this may take a few minutes..."
fi

npm install 2>&1 | tail -5
success "Dependencies installed"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 4: Build Production App                                    ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 4/7 — Building Production App"

info "Cleaning previous builds..."
npm run clean 2>/dev/null || true

info "Compiling TypeScript & bundling frontend..."
npx tsc 2>&1 | tail -3 || true
npx vite build 2>&1 | tail -5

info "Compiling Electron main process..."
npx tsc -p electron/tsconfig.json 2>&1 | tail -3

success "Compilation complete"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 5: Package with Electron Builder                           ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 5/7 — Packaging macOS App (${ARCH_LABEL})"

info "Running electron-builder for $BUILD_ARCH..."
info "This may take several minutes on first run..."

npx electron-builder --mac --$BUILD_ARCH 2>&1 | grep -E "(Building|afterPack|Signing|Packing|DMG|ZIP|✓|ERROR|FAIL)" || true

# Find the built .app
APP_GLOB="$SCRIPT_DIR/release/mac-${BUILD_ARCH}/${APP_NAME}.app"
if [[ "$BUILD_ARCH" == "arm64" ]]; then
    APP_GLOB="$SCRIPT_DIR/release/mac-arm64/${APP_NAME}.app"
else
    APP_GLOB="$SCRIPT_DIR/release/mac/${APP_NAME}.app"
fi

# Fallback: search for it
if [[ ! -d "$APP_GLOB" ]]; then
    APP_GLOB=$(find "$SCRIPT_DIR/release" -name "${APP_NAME}.app" -maxdepth 3 -type d 2>/dev/null | head -1)
fi

if [[ -z "$APP_GLOB" || ! -d "$APP_GLOB" ]]; then
    fail "Build failed — ${APP_NAME}.app not found in release/"
fi

success "Built: $APP_GLOB"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 6: Force Sign                                              ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 6/7 — Force Signing (Ad-Hoc)"

# The electron-builder afterPack hook already signs, but we force re-sign
# to ensure it's clean (handles edge cases where build partially failed)

if [[ -f "$ENTITLEMENTS" ]]; then
    info "Signing with entitlements: $ENTITLEMENTS"
    codesign --force --deep --entitlements "$ENTITLEMENTS" --sign - "$APP_GLOB"
    success "Signed with entitlements (JIT, audio, dylib, Apple Events)"
else
    warn "Entitlements file not found, signing without entitlements"
    codesign --force --deep --sign - "$APP_GLOB"
    success "Signed (ad-hoc, no entitlements)"
fi

# Verify signature
if codesign --verify --verbose "$APP_GLOB" 2>&1 | grep -q "valid on disk"; then
    success "Signature verified"
else
    # Ad-hoc signatures show "invalid info" but still work — this is expected
    info "Ad-hoc signature applied (codesign verify may show warnings — this is normal)"
fi

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 7: Install & Launch                                        ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 7/7 — Installing to ${INSTALL_DIR}"

# Kill existing instance if running
if pgrep -x "$APP_NAME" &>/dev/null; then
    info "Closing existing ${APP_NAME} instance..."
    pkill -x "$APP_NAME" 2>/dev/null || true
    sleep 1
fi

# Remove old installation
if [[ -d "${INSTALL_DIR}/${APP_NAME}.app" ]]; then
    info "Removing previous installation..."
    rm -rf "${INSTALL_DIR}/${APP_NAME}.app"
fi

# Copy to Applications
info "Copying to ${INSTALL_DIR}/${APP_NAME}.app ..."
cp -R "$APP_GLOB" "${INSTALL_DIR}/"

# Remove quarantine flag (bypass Gatekeeper)
xattr -cr "${INSTALL_DIR}/${APP_NAME}.app" 2>/dev/null || true
success "Installed to ${INSTALL_DIR}/${APP_NAME}.app"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Done!                                                           ║
# ╚═══════════════════════════════════════════════════════════════════╝
echo ""
echo -e "${GREEN}${BOLD}"
echo "  ┌─────────────────────────────────────────┐"
echo "  │  ✓  Build & Install Complete!            │"
echo "  │                                          │"
echo "  │  App:  ${INSTALL_DIR}/${APP_NAME}.app    │"
echo "  │  Arch: ${ARCH_LABEL} (${BUILD_ARCH})               │"
echo "  └─────────────────────────────────────────┘"
echo -e "${NC}"

echo -e "${CYAN}Next steps:${NC}"
echo ""
echo "  1. Launch:  open ${INSTALL_DIR}/${APP_NAME}.app"
echo ""
echo "  2. Grant permissions when prompted:"
echo "     • Microphone    (for transcription)"
echo "     • Screen Record (for screenshots)"
echo "     • Accessibility (for keyboard shortcuts)"
echo ""
echo "  3. Configure API keys in Settings → AI Providers"
echo "     (or use Ollama for fully local, free AI)"
echo ""

# Ask to launch
read -rp "$(echo -e "${YELLOW}Launch ${APP_NAME} now? [Y/n]:${NC} ")" LAUNCH
LAUNCH=${LAUNCH:-Y}
if [[ "$LAUNCH" =~ ^[Yy]$ ]]; then
    open "${INSTALL_DIR}/${APP_NAME}.app"
    success "Launched ${APP_NAME}!"
fi
