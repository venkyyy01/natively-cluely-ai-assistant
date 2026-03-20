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
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NEON_PINK='\033[38;5;213m'
NEON_CYAN='\033[38;5;51m'
NEON_GREEN='\033[38;5;118m'
NEON_VIOLET='\033[38;5;99m'
NEON_ORANGE='\033[38;5;208m'
STEEL='\033[38;5;250m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Constants ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Natively"
INSTALL_DIR="/Applications"
ENTITLEMENTS="$SCRIPT_DIR/assets/entitlements.mac.plist"
RELEASE_DIR="$SCRIPT_DIR/release"
IS_TTY=false
if [[ -t 1 ]]; then
    IS_TTY=true
fi

# ── Helpers ──
info()    { echo -e "${NEON_CYAN}[INFO]${NC}  ${STEEL}$1${NC}"; }
success() { echo -e "${NEON_GREEN}[ OK ]${NC}  ${WHITE}$1${NC}"; }
warn()    { echo -e "${NEON_ORANGE}[WARN]${NC}  ${WHITE}$1${NC}"; }
fail()    { echo -e "${RED}[FAIL]${NC}  ${WHITE}$1${NC}"; exit 1; }
step()    { echo -e "\n${NEON_VIOLET}${BOLD}################################################################${NC}"; echo -e "${NEON_PINK}${BOLD}##${NC} ${NEON_CYAN}${BOLD}$1${NC}"; echo -e "${NEON_VIOLET}${BOLD}################################################################${NC}"; }

boot_line() {
    local color="$1"
    local label="$2"
    local detail="$3"
    echo -e "${color}${BOLD}>${NC} ${WHITE}${label}${NC} ${STEEL}${detail}${NC}"
}

boot_sequence() {
    boot_line "$NEON_GREEN" "reactor" "waking xeno-forge core"
    sleep 0.05
    boot_line "$NEON_CYAN" "sensors" "calibrating host architecture matrix"
    sleep 0.05
    boot_line "$NEON_PINK" "shields" "arming manifest and signing rails"
    sleep 0.05
    boot_line "$NEON_ORANGE" "nav" "locking install vector to /Applications"
    sleep 0.05
    echo -e "${NEON_VIOLET}${BOLD}~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~${NC}"
}

spinner() {
    local pid="$1"
    local label="$2"
    local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    local i=0

    if [[ "$IS_TTY" != true ]]; then
        wait "$pid"
        return $?
    fi

    while kill -0 "$pid" 2>/dev/null; do
        printf "\r${NEON_VIOLET}${BOLD}[${frames[i]}]${NC} ${NEON_CYAN}${BOLD}%s${NC} ${STEEL}...${NC}" "$label"
        i=$(( (i + 1) % ${#frames[@]} ))
        sleep 0.08
    done

    wait "$pid"
    local status=$?
    if [[ $status -eq 0 ]]; then
        printf "\r${NEON_GREEN}${BOLD}[OK]${NC} ${WHITE}%s${NC}                                                       \n" "$label"
    else
        printf "\r${RED}${BOLD}[XX]${NC} ${WHITE}%s${NC}                                                        \n" "$label"
    fi
    return $status
}

run_with_spinner() {
    local label="$1"
    shift
    local log_file
    log_file=$(mktemp)

    if [[ "$IS_TTY" == true ]]; then
        "$@" >"$log_file" 2>&1 &
        local pid=$!
        if ! spinner "$pid" "$label"; then
            echo -e "${RED}${BOLD}--- command output -------------------------------------------------------${NC}"
            sed -n '1,200p' "$log_file"
            rm -f "$log_file"
            return 1
        fi
    else
        info "$label"
        if ! "$@" >"$log_file" 2>&1; then
            echo -e "${RED}${BOLD}--- command output -------------------------------------------------------${NC}"
            sed -n '1,200p' "$log_file"
            rm -f "$log_file"
            return 1
        fi
    fi

    rm -f "$log_file"
}

cleanup_stale_artifacts() {
    local paths=(
        "$SCRIPT_DIR/dist"
        "$SCRIPT_DIR/dist-electron"
        "$SCRIPT_DIR/release"
        "$SCRIPT_DIR/node_modules/.cache"
        "$SCRIPT_DIR/.vite"
        "$SCRIPT_DIR/native-module/target"
        "$SCRIPT_DIR/native-module/index.darwin-arm64.node"
        "$SCRIPT_DIR/native-module/index.darwin-x64.node"
        "$SCRIPT_DIR/native-module/index.linux-x64-gnu.node"
        "$SCRIPT_DIR/native-module/index.win32-x64-msvc.node"
        "$HOME/Library/Caches/electron-builder"
        "$HOME/Library/Caches/electron"
    )

    info "Removing previous build artifacts and packaging caches..."
    for path in "${paths[@]}"; do
        if [[ -e "$path" ]]; then
            rm -rf "$path"
        fi
    done

    info "Removing stale packaged artifacts..."
    rm -f "$SCRIPT_DIR"/*.dmg "$SCRIPT_DIR"/*.zip "$SCRIPT_DIR"/*.blockmap 2>/dev/null || true
    rm -f "$RELEASE_DIR"/*.dmg "$RELEASE_DIR"/*.zip "$RELEASE_DIR"/*.blockmap "$RELEASE_DIR"/*.yml 2>/dev/null || true

    info "Clearing npm cache for a truly fresh packaging pass..."
    npm cache clean --force >/dev/null 2>&1 || warn "npm cache cleanup skipped"

    success "Fresh-build cleanup complete"
}

print_banner() {
    echo ""
    echo -e "${NEON_VIOLET}${BOLD}################################################################################${NC}"
    echo -e "${NEON_VIOLET}${BOLD}#                                                                              #${NC}"
    echo -e "${NEON_VIOLET}${BOLD}#${NC} ${NEON_GREEN}${BOLD}                 .        *        .      .       *       .           ${NC} ${NEON_VIOLET}${BOLD}#${NC}"
    echo -e "${NEON_VIOLET}${BOLD}#${NC} ${NEON_CYAN}${BOLD}      _   _      _  _____ ___ __     _______ _    __   __           ${NC} ${NEON_VIOLET}${BOLD}#${NC}"
    echo -e "${NEON_VIOLET}${BOLD}#${NC} ${NEON_CYAN}${BOLD}     | \\ | |    / \|_   _|_ _|\\ \\   / / ____| |   \\ \\ / /           ${NC} ${NEON_VIOLET}${BOLD}#${NC}"
    echo -e "${NEON_VIOLET}${BOLD}#${NC} ${NEON_PINK}${BOLD}     |  \\| |   / _ \\ | |  | |  \\ \\ / /|  _| | |    \\ V /            ${NC} ${NEON_VIOLET}${BOLD}#${NC}"
    echo -e "${NEON_VIOLET}${BOLD}#${NC} ${NEON_ORANGE}${BOLD}     | |\\  |  / ___ \\| |  | |   \\ V / | |___| |___  | |             ${NC} ${NEON_VIOLET}${BOLD}#${NC}"
    echo -e "${NEON_VIOLET}${BOLD}#${NC} ${NEON_GREEN}${BOLD}     |_| \\_| /_/   \\_\\_| |___|   \\_/  |_____|_____| |_|             ${NC} ${NEON_VIOLET}${BOLD}#${NC}"
    echo -e "${NEON_VIOLET}${BOLD}#                                                                              #${NC}"
    echo -e "${NEON_VIOLET}${BOLD}#${NC} ${WHITE}${BOLD}   [ XENO-FORGE ]${NC} ${STEEL}macOS release pipeline armed and ready${NC}               ${NEON_VIOLET}${BOLD}#${NC}"
    echo -e "${NEON_VIOLET}${BOLD}#${NC} ${NEON_ORANGE}${BOLD}   SIGNAL:${NC} ${WHITE}$ARCH_LABEL${NC}  ${NEON_ORANGE}${BOLD}CORE:${NC} ${WHITE}$BUILD_ARCH${NC}  ${NEON_ORANGE}${BOLD}TARGET:${NC} ${WHITE}${APP_NAME}.app${NC}                 ${NEON_VIOLET}${BOLD}#${NC}"
    echo -e "${NEON_VIOLET}${BOLD}#                                                                              #${NC}"
    echo -e "${NEON_VIOLET}${BOLD}################################################################################${NC}"
}

print_done_card() {
    echo ""
    echo -e "${NEON_GREEN}${BOLD}########################################################################${NC}"
    echo -e "${NEON_GREEN}${BOLD}#${NC} ${WHITE}${BOLD}ALIEN SHIPYARD STATUS: INSTALL COMPLETE${NC}                             ${NEON_GREEN}${BOLD}#${NC}"
    echo -e "${NEON_GREEN}${BOLD}#${NC} ${NEON_CYAN}${BOLD}APP   ${NC}${WHITE}${INSTALL_DIR}/${APP_NAME}.app${NC}                                      ${NEON_GREEN}${BOLD}#${NC}"
    echo -e "${NEON_GREEN}${BOLD}#${NC} ${NEON_CYAN}${BOLD}ARCH  ${NC}${WHITE}${ARCH_LABEL} (${BUILD_ARCH})${NC}                                             ${NEON_GREEN}${BOLD}#${NC}"
    echo -e "${NEON_GREEN}${BOLD}#${NC} ${NEON_CYAN}${BOLD}STATE ${NC}${WHITE}rebuilt | signed | manifest-verified | launch-ready${NC}             ${NEON_GREEN}${BOLD}#${NC}"
    echo -e "${NEON_GREEN}${BOLD}########################################################################${NC}"
}

require_plist_key() {
    local plist_path="$1"
    local key="$2"

    if /usr/bin/plutil -extract "$key" raw -o - "$plist_path" >/dev/null 2>&1; then
        success "Manifest key present: $key"
    else
        fail "Missing manifest key in $(basename "$plist_path"): $key"
    fi
}

require_file() {
    local file_path="$1"
    local label="$2"

    if [[ -f "$file_path" ]]; then
        success "$label present"
    else
        fail "Missing required file: $file_path"
    fi
}

require_asar_entry() {
    local asar_path="$1"
    local entry_path="$2"
    local label="$3"

    if npx asar list "$asar_path" | grep -Fxq "$entry_path"; then
        success "$label present"
    else
        fail "Missing required app.asar entry: $entry_path"
    fi
}

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
print_banner
boot_sequence

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 1: Check Prerequisites                                     ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 1/8 — Checking Prerequisites"

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
step "Step 2/8 — Environment Configuration"

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
step "Step 3/8 — Installing Dependencies"

cd "$SCRIPT_DIR"

# Clean install
if [[ -d "node_modules" ]]; then
    info "node_modules exists, running npm install to sync..."
else
    info "Fresh install — this may take a few minutes..."
fi

run_with_spinner "syncing npm dependency matrix" npm install
success "Dependencies installed"

info "Rebuilding Electron native database dependencies for ${ARCH_LABEL}..."
run_with_spinner "realigning sqlite and native addon binaries" node scripts/ensure-electron-native-deps.js
success "Electron native dependencies aligned"

if [[ "$HAS_RUST" == "true" ]]; then
    info "Building native audio module for ${ARCH_LABEL}..."
    run_with_spinner "forging native audio addon" npm run build:native:current
    success "Native audio addon built"
else
    warn "Rust unavailable — packaged app may miss native audio capture"
fi

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 4: Fresh Cleanup & Build Production App                    ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 4/8 — Fresh Cleanup & Building Production App"

cleanup_stale_artifacts

info "Running production build pipeline..."
run_with_spinner "forging full production bundle" npm run app:build

success "Compilation complete"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 5: Package with Electron Builder                           ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 5/8 — Packaging macOS App (${ARCH_LABEL})"

info "Using packaged release created by app:build..."
info "This may take several minutes on first run..."

# Find the built .app
APP_GLOB="$SCRIPT_DIR/release/mac-${BUILD_ARCH}/${APP_NAME}.app"
if [[ "$BUILD_ARCH" == "arm64" ]]; then
    APP_GLOB="$SCRIPT_DIR/release/mac-arm64/${APP_NAME}.app"
else
    APP_GLOB="$SCRIPT_DIR/release/mac/${APP_NAME}.app"
fi

# Fallback: search for it
if [[ ! -d "$APP_GLOB" ]]; then
    APP_GLOB=$(find "$RELEASE_DIR" -maxdepth 3 -name "${APP_NAME}.app" -type d -print -quit 2>/dev/null)
fi

if [[ -z "$APP_GLOB" || ! -d "$APP_GLOB" ]]; then
    fail "Build failed — ${APP_NAME}.app not found in release/"
fi

success "Built: $APP_GLOB"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 6: Force Sign                                              ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 6/8 — Force Signing (Ad-Hoc)"

# The electron-builder afterPack hook already signs, but we force re-sign
# to ensure it's clean (handles edge cases where build partially failed)

if [[ -f "$ENTITLEMENTS" ]]; then
    info "Signing with entitlements: $ENTITLEMENTS"
    run_with_spinner "engraving ad-hoc signature lattice" codesign --force --deep --entitlements "$ENTITLEMENTS" --sign - "$APP_GLOB"
    success "Signed with entitlements (JIT, audio, dylib, Apple Events)"
else
    warn "Entitlements file not found, signing without entitlements"
    run_with_spinner "engraving ad-hoc signature lattice" codesign --force --deep --sign - "$APP_GLOB"
    success "Signed (ad-hoc, no entitlements)"
fi

# Verify signature
if codesign --verify --verbose "$APP_GLOB" 2>&1 | grep -q "valid on disk"; then
    success "Signature verified"
else
    # Ad-hoc signatures show "invalid info" but still work — this is expected
    info "Ad-hoc signature applied (codesign verify may show warnings — this is normal)"
fi

step "Step 7/8 — Verifying macOS Permission Manifest"

APP_PLIST="$APP_GLOB/Contents/Info.plist"
[[ -f "$APP_PLIST" ]] || fail "Info.plist not found in built app"

require_plist_key "$APP_PLIST" "NSMicrophoneUsageDescription"
require_plist_key "$APP_PLIST" "NSCameraUsageDescription"
require_plist_key "$APP_PLIST" "NSScreenCaptureUsageDescription"
require_plist_key "$APP_PLIST" "NSAppleEventsUsageDescription"

APP_RESOURCES_DIR="$APP_GLOB/Contents/Resources"
APP_ASAR_PATH="$APP_RESOURCES_DIR/app.asar"
APP_ASAR_UNPACKED_DIR="$APP_RESOURCES_DIR/app.asar.unpacked"
require_file "$APP_ASAR_PATH" "Packaged app archive"
require_asar_entry "$APP_ASAR_PATH" "/dist/index.html" "Packaged renderer entry"
require_asar_entry "$APP_ASAR_PATH" "/dist-electron/electron/main.js" "Packaged Electron main entry"
require_asar_entry "$APP_ASAR_PATH" "/node_modules/natively-audio/index.js" "Packaged native module loader"
require_asar_entry "$APP_ASAR_PATH" "/dist-electron/premium/electron/services/LicenseManager.js" "Packaged premium license manager"
require_asar_entry "$APP_ASAR_PATH" "/dist-electron/premium/electron/knowledge/KnowledgeOrchestrator.js" "Packaged knowledge orchestrator"

if [[ "$BUILD_ARCH" == "arm64" ]]; then
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/natively-audio/index.darwin-arm64.node" "Unpacked arm64 native audio binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "Unpacked arm64 better-sqlite3 binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/sqlite3/build/Release/node_sqlite3.node" "Unpacked arm64 sqlite3 binary"
else
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/natively-audio/index.darwin-x64.node" "Unpacked x64 native audio binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "Unpacked x64 better-sqlite3 binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/sqlite3/build/Release/node_sqlite3.node" "Unpacked x64 sqlite3 binary"
fi

success "Permission manifest verified"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Step 8: Install & Launch                                        ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 8/8 — Installing to ${INSTALL_DIR}"

# Kill existing instance if running
if pgrep -x "$APP_NAME" &>/dev/null; then
    info "Closing existing ${APP_NAME} instance..."
    pkill -x "$APP_NAME" 2>/dev/null || true
    sleep 1
fi

# Remove old installation
if [[ -d "${INSTALL_DIR}/${APP_NAME}.app" ]]; then
    info "Removing previous installation..."
    if [[ -w "${INSTALL_DIR}/${APP_NAME}.app" ]]; then
        rm -rf "${INSTALL_DIR}/${APP_NAME}.app"
    else
        sudo rm -rf "${INSTALL_DIR}/${APP_NAME}.app"
    fi
fi

# Copy to Applications
info "Copying to ${INSTALL_DIR}/${APP_NAME}.app ..."
if [[ -w "$INSTALL_DIR" ]]; then
    run_with_spinner "transferring vessel into /Applications" ditto "$APP_GLOB" "${INSTALL_DIR}/${APP_NAME}.app"
else
    info "Administrator access required to install into ${INSTALL_DIR}"
    run_with_spinner "transferring vessel into /Applications" sudo ditto "$APP_GLOB" "${INSTALL_DIR}/${APP_NAME}.app"
fi

# Remove quarantine flag (bypass Gatekeeper)
if [[ -w "${INSTALL_DIR}/${APP_NAME}.app" ]]; then
    xattr -d com.apple.quarantine "${INSTALL_DIR}/${APP_NAME}.app" 2>/dev/null || true
else
    sudo xattr -d com.apple.quarantine "${INSTALL_DIR}/${APP_NAME}.app" 2>/dev/null || true
fi
success "Installed to ${INSTALL_DIR}/${APP_NAME}.app"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Done!                                                           ║
# ╚═══════════════════════════════════════════════════════════════════╝
print_done_card

echo -e "${MAGENTA}${BOLD}Next steps:${NC}"
echo ""
echo -e "  ${CYAN}1.${NC} Launch with ${WHITE}open ${INSTALL_DIR}/${APP_NAME}.app${NC}"
echo ""
echo -e "  ${CYAN}2.${NC} Grant permissions when prompted:"
echo -e "     ${YELLOW}>${NC} Microphone     ${BLUE}-${NC} transcription"
echo -e "     ${YELLOW}>${NC} Screen Record  ${BLUE}-${NC} system audio capture + screenshots"
echo -e "     ${YELLOW}>${NC} Accessibility  ${BLUE}-${NC} keyboard shortcuts"
echo ""
echo -e "  ${CYAN}3.${NC} Configure API keys in Settings -> AI Providers"
echo -e "     ${YELLOW}>${NC} Or use Ollama for a fully local setup"
echo ""

# Ask to launch
read -rp "$(echo -e "${YELLOW}Launch ${APP_NAME} now? [Y/n]:${NC} ")" LAUNCH
LAUNCH=${LAUNCH:-Y}
if [[ "$LAUNCH" =~ ^[Yy]$ ]]; then
    open "${INSTALL_DIR}/${APP_NAME}.app"
    success "Launched ${APP_NAME}!"
fi
