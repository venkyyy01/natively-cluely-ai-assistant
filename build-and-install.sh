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
HELPER_ENTITLEMENTS="$SCRIPT_DIR/stealth-projects/macos-virtual-display-helper/entitlements.plist"
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

run_logged_command() {
    local label="$1"
    shift

    info "$label"
    "$@"
}

artifact_mtime() {
    local artifact_path="$1"
    stat -f "%m" "$artifact_path" 2>/dev/null || printf '0\n'
}

select_newest_path() {
    local newest_path=""
    local newest_mtime=0
    local candidate=""
    local candidate_mtime=0

    for candidate in "$@"; do
        [[ -e "$candidate" ]] || continue
        candidate_mtime=$(artifact_mtime "$candidate")
        if [[ -z "$newest_path" || "$candidate_mtime" -gt "$newest_mtime" ]]; then
            newest_path="$candidate"
            newest_mtime="$candidate_mtime"
        fi
    done

    printf '%s\n' "$newest_path"
}

find_newest_packaged_app() {
    local release_dir="$1"
    local app_name="${2:-$APP_NAME}"
    local candidates=()

    while IFS= read -r candidate; do
        candidates+=("$candidate")
    done < <(find "$release_dir" -maxdepth 3 -type d -name "${app_name}.app" -print 2>/dev/null)

    if [[ ${#candidates[@]} -eq 0 ]]; then
        return 1
    fi

    select_newest_path "${candidates[@]}"
}

find_packaged_app_for_arch() {
    local release_dir="$1"
    local app_name="${2:-$APP_NAME}"
    local build_arch="${3:-${BUILD_ARCH:-}}"
    local candidates=()
    local candidate=""

    case "$build_arch" in
        arm64)
            candidates=(
                "$release_dir/mac-arm64/${app_name}.app"
                "$release_dir/mac/${app_name}.app"
            )
            ;;
        x64)
            candidates=(
                "$release_dir/mac-x64/${app_name}.app"
                "$release_dir/mac/${app_name}.app"
            )
            ;;
        *)
            return 1
            ;;
    esac

    for candidate in "${candidates[@]}"; do
        if [[ -d "$candidate" ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    return 1
}

find_newest_release_archive() {
    local release_dir="$1"
    local extension="$2"
    local candidates=()

    while IFS= read -r candidate; do
        candidates+=("$candidate")
    done < <(find "$release_dir" -maxdepth 1 -type f -name "*.${extension}" -print 2>/dev/null)

    if [[ ${#candidates[@]} -eq 0 ]]; then
        printf '\n'
        return 0
    fi

    select_newest_path "${candidates[@]}"
}

collect_packaged_artifacts() {
    local release_dir="$1"
    local build_arch="${2:-${BUILD_ARCH:-}}"
    local packaged_app=""
    local packaged_dmg=""
    local packaged_zip=""

    packaged_app=$(find_packaged_app_for_arch "$release_dir" "$APP_NAME" "$build_arch" || true)
    if [[ -z "$packaged_app" ]]; then
        packaged_app=$(find_newest_packaged_app "$release_dir") || fail "Missing packaged app in $release_dir"
    fi

    packaged_dmg=$(find_newest_release_archive "$release_dir" dmg)
    packaged_zip=$(find_newest_release_archive "$release_dir" zip)

    printf '%s\n%s\n%s\n' "$packaged_app" "$packaged_dmg" "$packaged_zip"
}

print_packaged_artifacts() {
    local packaged_app="$1"
    local packaged_dmg="$2"
    local packaged_zip="$3"

    info "Fresh packaged artifacts:"
    echo -e "  ${CYAN}app${NC} ${WHITE}${packaged_app}${NC}"
    if [[ -n "$packaged_dmg" ]]; then
        echo -e "  ${CYAN}dmg${NC} ${WHITE}${packaged_dmg}${NC}"
    else
        warn "No DMG artifact found in $RELEASE_DIR"
    fi

    if [[ -n "$packaged_zip" ]]; then
        echo -e "  ${CYAN}zip${NC} ${WHITE}${packaged_zip}${NC}"
    else
        warn "No ZIP artifact found in $RELEASE_DIR"
    fi
}

clean_build_artifacts() {
    local required_paths=(
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
        "$SCRIPT_DIR/release/mac/${APP_NAME}.app"
        "$SCRIPT_DIR/release/mac-arm64/${APP_NAME}.app"
    )
    local optional_cache_paths=(
        "$HOME/Library/Caches/electron-builder"
        "$HOME/Library/Caches/electron"
    )
    local path=""

    info "Removing previous build artifacts and packaging caches..."
    for path in "${required_paths[@]}"; do
        [[ -e "$path" ]] || continue
        if ! rm -rf "$path"; then
            fail "Failed to remove build artifact: $path"
        fi
    done

    for path in "${optional_cache_paths[@]}"; do
        [[ -e "$path" ]] || continue
        if ! rm -rf "$path"; then
            warn "Skipping optional cache cleanup for $path"
        fi
    done

    info "Removing stale packaged artifacts..."
    rm -f "$SCRIPT_DIR"/*.dmg "$SCRIPT_DIR"/*.zip "$SCRIPT_DIR"/*.blockmap 2>/dev/null || true
    rm -f "$RELEASE_DIR"/*.dmg "$RELEASE_DIR"/*.zip "$RELEASE_DIR"/*.blockmap "$RELEASE_DIR"/*.yml 2>/dev/null || true

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

# Verify the packaged native-module exports the OCR symbols by spawning a
# Node process that loads the .node binary directly. Catches the
# regression where we ship a stale binary without recognizeTextMacos /
# recognizeTextWindows after a build glitch.
require_packaged_native_ocr_exports() {
    local unpacked_dir="$1"
    local bin_basename="$2"
    local platform_label="$3"
    local node_bin="${unpacked_dir}/node_modules/natively-audio/${bin_basename}"

    if [[ ! -f "$node_bin" ]]; then
        fail "Packaged native binary missing for OCR symbol probe: $node_bin"
    fi

    local probe_script
    probe_script='
        const path = require("path");
        const bin = path.resolve(process.argv[1]);
        const native = require(bin);
        const want = ["recognizeTextMacos", "recognizeTextWindows"];
        for (const name of want) {
          if (typeof native[name] !== "function") {
            console.error("MISSING:" + name);
            process.exit(2);
          }
        }
        console.log("OCR_EXPORTS_OK");
    '

    local probe_output
    if probe_output=$(node -e "$probe_script" "$node_bin" 2>&1); then
        if [[ "$probe_output" == *"OCR_EXPORTS_OK"* ]]; then
            success "Packaged native module exports OCR symbols (${platform_label})"
        else
            warn "Native OCR probe returned unexpected output (${platform_label}): $probe_output"
        fi
    else
        fail "Packaged native module is missing OCR exports (${platform_label}): $probe_output"
    fi
}

is_truthy_flag() {
    local value="${1:-}"
    case "$value" in
        1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn])
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

run_packaged_launch_probe() {
    local mode_label="$1"
    local app_binary="$2"
    local disable_helper="$3"
    local log_file
    local pid

    log_file=$(mktemp)
    if [[ "$disable_helper" == "1" ]]; then
        NATIVELY_DISABLE_MACOS_VIRTUAL_DISPLAY_HELPER=1 "$app_binary" >"$log_file" 2>&1 &
    else
        "$app_binary" >"$log_file" 2>&1 &
    fi
    pid=$!

    sleep 4
    if ! kill -0 "$pid" 2>/dev/null; then
        echo -e "${RED}${BOLD}--- launch log (${mode_label}) -------------------------------------------------${NC}"
        sed -n '1,160p' "$log_file"
        rm -f "$log_file"
        fail "Packaged launch probe failed (${mode_label})"
    fi

    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    rm -f "$log_file"
    success "Packaged launch probe passed (${mode_label})"
}

validate_packaged_helper_launch_modes() {
    local app_bundle="$1"
    local app_binary="$2"
    local helper_binary="$app_bundle/Contents/XPCServices/macos-full-stealth-helper.xpc/Contents/MacOS/macos-full-stealth-helper"

    require_file "$helper_binary" "Installed macOS full stealth XPC helper"
    run_packaged_launch_probe "with-helper" "$app_binary" "0"
    run_packaged_launch_probe "without-helper" "$app_binary" "1"
    success "Packaged helper launch validation passed (with and without helper)"
}

if [[ "${BUILD_AND_INSTALL_LIB:-0}" == "1" ]]; then
    return 0 2>/dev/null || exit 0
fi

# ── Detect Architecture ──
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
    BUILD_ARCH="arm64"
    ARCH_LABEL="Apple Silicon"
    BUILD_COMMAND=(npm run app:build:arm64)
elif [[ "$ARCH" == "x86_64" ]]; then
    BUILD_ARCH="x64"
    ARCH_LABEL="Intel"
    BUILD_COMMAND=(npm run app:build:x64)
else
    fail "Unsupported architecture: $ARCH"
fi

# ── macOS version check ──
MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo 'unknown')"
info "macOS version: $MACOS_VERSION ($ARCH_LABEL)"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║  Prerequisite Auto-Install                                       ║
# ╚═══════════════════════════════════════════════════════════════════╝

# ── Xcode Command Line Tools (required for git, compilers) ──
if ! xcode-select -p &>/dev/null; then
    warn "Xcode Command Line Tools not found — installing (this may take a few minutes)..."
    xcode-select --install 2>/dev/null || true
    # Wait for the install to complete (user must click through the dialog)
    until xcode-select -p &>/dev/null; do
        sleep 5
    done
    success "Xcode Command Line Tools installed"
else
    success "Xcode Command Line Tools found: $(xcode-select -p)"
fi

# ── Homebrew ──
if command -v brew &>/dev/null; then
    success "Homebrew found: $(brew --version | head -1)"
else
    warn "Homebrew not found — installing..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add brew to PATH for this session (Apple Silicon vs Intel paths)
    if [[ -f "/opt/homebrew/bin/brew" ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -f "/usr/local/bin/brew" ]]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi
    if command -v brew &>/dev/null; then
        success "Homebrew installed"
    else
        fail "Homebrew installation failed. Install manually from https://brew.sh"
    fi
fi

# ── Node.js ──
if command -v node &>/dev/null; then
    NODE_VERSION="$(node --version 2>/dev/null)"
    success "Node.js found: $NODE_VERSION"
    NODE_MAJOR="${NODE_VERSION#v}"
    NODE_MAJOR="${NODE_MAJOR%%.*}"
    if [[ "$NODE_MAJOR" -lt 18 ]]; then
        warn "Node.js $NODE_VERSION is below v18. Recommend upgrading: brew upgrade node"
    fi
else
    warn "Node.js not found — installing via Homebrew..."
    brew install node
    if command -v node &>/dev/null; then
        success "Node.js installed: $(node --version)"
    else
        fail "Node.js installation failed. Install manually: brew install node"
    fi
fi

# ── npm ──
if command -v npm &>/dev/null; then
    success "npm found: $(npm --version 2>/dev/null)"
else
    fail "npm not found. It ships with Node.js — reinstall Node.js: brew reinstall node"
fi

# ── Git ──
if command -v git &>/dev/null; then
    success "Git found: $(git --version 2>/dev/null)"
else
    warn "Git not found — installing via Homebrew..."
    brew install git
    if command -v git &>/dev/null; then
        success "Git installed: $(git --version)"
    else
        fail "Git installation failed. Install manually: brew install git"
    fi
fi

# ── Rust / Cargo ──
if command -v cargo &>/dev/null; then
    HAS_RUST="true"
    success "Rust found: $(cargo --version 2>/dev/null)"
else
    warn "Rust/Cargo not found — installing via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y 2>/dev/null
    # Source cargo env for this session
    [[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
    if command -v cargo &>/dev/null; then
        HAS_RUST="true"
        success "Rust installed: $(cargo --version)"
    else
        HAS_RUST="false"
        warn "Rust installation failed — native module Rust tests will be skipped"
        warn "Install manually from https://rustup.rs"
    fi
fi

# ╔═══════════════════════════════════════════════════════════════════╗
# ║ Check for Uncommitted Changes (warn user)                         ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 1/8 — Checking Source Code Status"

cd "$SCRIPT_DIR"

# Check for uncommitted changes
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    UNCOMMITTED=$(git status --porcelain 2>/dev/null | head -20 || true)
    if [[ -n "$UNCOMMITTED" ]]; then
        warn "Uncommitted changes detected in source:"
        echo "$UNCOMMITTED"
        echo ""
        warn "These changes will be included in the build."
        echo ""
    else
        success "Source code is clean"
    fi
    
    # Show current branch and commit
    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    info "Building from branch: $BRANCH (commit: $COMMIT)"
else
    warn "Not a git repository - cannot check source status"
fi

# ╔═══════════════════════════════════════════════════════════════════╗
# ║ Banner ║
# ╚═══════════════════════════════════════════════════════════════════╝
print_banner
boot_sequence

# ╔═══════════════════════════════════════════════════════════════════╗
# ║ Step 3: Clean Build Artifacts ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 2/8 — Cleaning Build Artifacts"
clean_build_artifacts

# ╔═══════════════════════════════════════════════════════════════════╗
# ║ Step 4: Install Dependencies                                        ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 3/8 — Installing Dependencies"

cd "$SCRIPT_DIR"

DEPENDENCY_TOOLCHAIN_COMPLETE=true
if [[ -d "node_modules" ]]; then
    for required_path in \
        "node_modules/electron/package.json" \
        "node_modules/electron-builder/package.json" \
        "node_modules/.bin/tsc"; do
        if [[ ! -e "$required_path" ]]; then
            DEPENDENCY_TOOLCHAIN_COMPLETE=false
            break
        fi
    done
else
    DEPENDENCY_TOOLCHAIN_COMPLETE=false
fi

INSTALL_COMMAND=(npm install)
if [[ -f "package-lock.json" && ( ! -d "node_modules" || "${FORCE_DEPENDENCY_SYNC:-0}" == "1" ) ]]; then
    INSTALL_COMMAND=(npm ci)
fi

if [[ -d "node_modules" && "$DEPENDENCY_TOOLCHAIN_COMPLETE" == true && "${FORCE_DEPENDENCY_SYNC:-0}" != "1" ]]; then
    info "Using existing node_modules; set FORCE_DEPENDENCY_SYNC=1 to force a clean dependency reinstall."
else
    if [[ -d "node_modules" ]]; then
        info "node_modules exists but the build toolchain is incomplete, syncing dependencies with ${INSTALL_COMMAND[*]}..."
    else
        info "Fresh install — this may take a few minutes..."
    fi

    run_with_spinner "syncing npm dependency matrix" "${INSTALL_COMMAND[@]}"
    success "Dependencies installed"
fi

# ╔═══════════════════════════════════════════════════════════════════╗
# ║ Step 4: Run Quality Gates                                        
# ╚═══════════════════════════════════════════════════════════════════╝
QUALITY_GATES_RAN=false
QUALITY_GATE_TIMEOUT="${QUALITY_GATE_TIMEOUT:-300}" # seconds per gate, default 5min

# Locate a working timeout binary (coreutils `timeout` or macOS `gtimeout`).
# These exec-replace the child process, so they work correctly when
# run_with_spinner backgrounds the command.
TIMEOUT_CMD=""
if command -v gtimeout &>/dev/null; then
    TIMEOUT_CMD="gtimeout"
elif command -v timeout &>/dev/null && timeout --version &>/dev/null 2>&1; then
    # Ensure it's GNU timeout (not a shell built-in alias)
    TIMEOUT_CMD="timeout"
fi

# run_gate <label> <command...>
# Runs a quality-gate command with a spinner and an optional hard timeout.
# On failure the last 200 lines of output are printed before the script exits.
run_gate() {
    local label="$1"
    shift
    local rc=0

    # Build the command: optionally prepend timeout
    local cmd=()
    if [[ -n "$TIMEOUT_CMD" ]]; then
        cmd+=("$TIMEOUT_CMD" "$QUALITY_GATE_TIMEOUT")
    fi
    cmd+=("$@")

    # Use set +e / set -e so we capture the exit code without triggering
    # the global set -e trap, then call fail() at top level where exit works.
    set +e
    run_with_spinner "$label" "${cmd[@]}"
    rc=$?
    set -e

    if [[ $rc -ne 0 ]]; then
        if [[ -n "$TIMEOUT_CMD" && $rc -eq 124 ]]; then
            fail "$label timed out after ${QUALITY_GATE_TIMEOUT}s"
        else
            fail "$label failed"
        fi
    fi
}

if [[ "${SKIP_QUALITY_GATES:-0}" == "0" ]]; then
    step "Step 4/8 — Running Production Quality Gates"

    if [[ -n "$TIMEOUT_CMD" ]]; then
        info "Each gate has a ${QUALITY_GATE_TIMEOUT}s timeout (set QUALITY_GATE_TIMEOUT to override)"
    else
        warn "No timeout command found (install coreutils for gtimeout). Gates will run without a timeout."
    fi

    # Ensure local node_modules/.bin is on PATH for sub-shells
    export PATH="$SCRIPT_DIR/node_modules/.bin:$PATH"

    # ── Gate 1: Compile Electron TypeScript ──
    run_gate "[1/5] Compiling Electron TypeScript" \
        bash -c 'cd "'"$SCRIPT_DIR"'" && rimraf dist-electron/electron/tests && tsc -p electron/tsconfig.json'
    success "Electron TypeScript compiled"

    # ── Gate 2: Run Electron tests ──
    run_gate "[2/5] Running Electron tests" \
        bash -c 'cd "'"$SCRIPT_DIR"'" && node --test dist-electron/electron/tests/*.test.js'
    success "Electron tests passed"

    # ── Gate 3–5: Production verification (decomposed — skip redundant tsc) ──
    # typecheck is skipped: tsc -p electron/tsconfig.json already ran in gate 1.
    info "Skipping redundant typecheck (already compiled in gate 1)"

    run_gate "[3/5] Verifying Electron test coverage" \
        node scripts/verify-electron-coverage.js
    success "Electron coverage verified"

    run_gate "[4/5] Verifying renderer test coverage" \
        node scripts/verify-renderer-coverage.js
    success "Renderer coverage verified"

    if [[ "$HAS_RUST" == "true" ]]; then
        run_gate "[5/5] Running Rust native module tests" \
            cargo test --manifest-path native-module/Cargo.toml
        success "Rust native module tests passed"
    else
        warn "[5/5] Skipping Rust tests (cargo not found)"
    fi

    QUALITY_GATES_RAN=true
    success "All quality gates passed"
else
    info "Skipping visible quality gates (set SKIP_QUALITY_GATES=0 to run them before packaging)"
    info "Package-level production verification remains enabled"
fi

# ╔═══════════════════════════════════════════════════════════════════╗
# ║ Step 5: Build & Package                                         ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 5/8 — Building & Packaging (${ARCH_LABEL})"

info "Running ${BUILD_ARCH}-only build pipeline (renderer, native addon, electron, packaging)..."
if [[ "$QUALITY_GATES_RAN" == "true" ]]; then
    run_with_spinner "building and packaging ${BUILD_ARCH} release" env SKIP_PRODUCTION_VERIFY=1 "${BUILD_COMMAND[@]}"
else
    run_with_spinner "building and packaging ${BUILD_ARCH} release" "${BUILD_COMMAND[@]}"
fi

success "Build & packaging complete"

PACKAGED_ARTIFACTS=()
while IFS= read -r artifact_path; do
    PACKAGED_ARTIFACTS+=("$artifact_path")
done < <(collect_packaged_artifacts "$RELEASE_DIR")
APP_GLOB="${PACKAGED_ARTIFACTS[0]}"
PACKAGED_DMG="${PACKAGED_ARTIFACTS[1]}"
PACKAGED_ZIP="${PACKAGED_ARTIFACTS[2]}"

success "Built: $APP_GLOB"
print_packaged_artifacts "$APP_GLOB" "$PACKAGED_DMG" "$PACKAGED_ZIP"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║ Step 8: Force Sign                                              ║
# ╚═══════════════════════════════════════════════════════════════════╝
step "Step 6/8 — Force Signing (Ad-Hoc)"

# The electron-builder afterPack hook already signs, but we force re-sign
# to ensure it's clean (handles edge cases where build partially failed)

PACKAGED_HELPER="$APP_GLOB/Contents/Resources/bin/macos/stealth-virtual-display-helper"
PACKAGED_FOUNDATION_INTENT_HELPER="$APP_GLOB/Contents/Resources/bin/macos/foundation-intent-helper"
PACKAGED_FULL_STEALTH_XPC="$APP_GLOB/Contents/XPCServices/macos-full-stealth-helper.xpc"

if [[ -f "$PACKAGED_HELPER" ]]; then
    if [[ -f "$HELPER_ENTITLEMENTS" ]]; then
        info "Signing packaged macOS virtual display helper with helper entitlements: $HELPER_ENTITLEMENTS"
        run_with_spinner "signing packaged virtual display helper" codesign --force --options runtime --entitlements "$HELPER_ENTITLEMENTS" --sign - "$PACKAGED_HELPER"
        success "Packaged macOS virtual display helper signed"
    else
        warn "Helper entitlements file not found, signing packaged helper without helper entitlements"
        run_with_spinner "signing packaged virtual display helper" codesign --force --sign - "$PACKAGED_HELPER"
        success "Packaged macOS virtual display helper signed (ad-hoc, no helper entitlements)"
    fi
else
    warn "Packaged macOS virtual display helper not found before app signing"
fi

if [[ -f "$PACKAGED_FOUNDATION_INTENT_HELPER" ]]; then
    if [[ -f "$ENTITLEMENTS" ]]; then
        info "Signing packaged foundation intent helper with app entitlements: $ENTITLEMENTS"
        run_with_spinner "signing packaged foundation intent helper" codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign - "$PACKAGED_FOUNDATION_INTENT_HELPER"
        success "Packaged foundation intent helper signed"
    else
        warn "App entitlements file not found, signing packaged foundation intent helper without entitlements"
        run_with_spinner "signing packaged foundation intent helper" codesign --force --sign - "$PACKAGED_FOUNDATION_INTENT_HELPER"
        success "Packaged foundation intent helper signed (ad-hoc, no entitlements)"
    fi
else
    warn "Packaged foundation intent helper not found before app signing"
fi

if [[ -d "$PACKAGED_FULL_STEALTH_XPC" ]]; then
    if [[ -f "$ENTITLEMENTS" ]]; then
        info "Signing packaged macOS full stealth XPC bundle with app entitlements: $ENTITLEMENTS"
        run_with_spinner "signing packaged full stealth xpc bundle" codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign - "$PACKAGED_FULL_STEALTH_XPC"
        success "Packaged macOS full stealth XPC bundle signed"
    else
        warn "App entitlements file not found, signing packaged XPC bundle without entitlements"
        run_with_spinner "signing packaged full stealth xpc bundle" codesign --force --sign - "$PACKAGED_FULL_STEALTH_XPC"
        success "Packaged macOS full stealth XPC bundle signed (ad-hoc, no entitlements)"
    fi
else
    warn "Packaged macOS full stealth XPC bundle not found before app signing"
fi

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
require_asar_entry "$APP_ASAR_PATH" "/electron/renderer/shell.html" "Packaged stealth shell HTML"
require_asar_entry "$APP_ASAR_PATH" "/node_modules/natively-audio/index.js" "Packaged native module loader"
require_asar_entry "$APP_ASAR_PATH" "/dist-electron/premium/electron/services/LicenseManager.js" "Packaged premium license manager"
require_asar_entry "$APP_ASAR_PATH" "/dist-electron/premium/electron/knowledge/KnowledgeOrchestrator.js" "Packaged knowledge orchestrator"
require_file "$APP_RESOURCES_DIR/bin/macos/stealth-virtual-display-helper" "Packaged macOS virtual display helper"
require_file "$APP_RESOURCES_DIR/bin/macos/foundation-intent-helper" "Packaged foundation intent helper"
require_file "$APP_GLOB/Contents/XPCServices/macos-full-stealth-helper.xpc/Contents/MacOS/macos-full-stealth-helper" "Packaged macOS full stealth XPC helper"

if [[ "$BUILD_ARCH" == "arm64" ]]; then
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/natively-audio/index.darwin-arm64.node" "Unpacked arm64 native audio binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "Unpacked arm64 better-sqlite3 binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/sqlite3/build/Release/node_sqlite3.node" "Unpacked arm64 sqlite3 binary"
    require_packaged_native_ocr_exports "$APP_ASAR_UNPACKED_DIR" "index.darwin-arm64.node" "darwin-arm64"
else
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/natively-audio/index.darwin-x64.node" "Unpacked x64 native audio binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "Unpacked x64 better-sqlite3 binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/sqlite3/build/Release/node_sqlite3.node" "Unpacked x64 sqlite3 binary"
    require_packaged_native_ocr_exports "$APP_ASAR_UNPACKED_DIR" "index.darwin-x64.node" "darwin-x64"
fi

# OCR cascade ships three providers: Apple Vision (native), Windows OCR
# (native, no-op on darwin), and Tesseract.js (universal fallback). The
# fallback provider lives in tesseract.js inside the packaged asar; if
# it's missing the cascade still runs but degrades to native-only. Warn
# rather than fail because Tesseract is optional on platforms where the
# native provider works.
if npx asar list "$APP_ASAR_PATH" 2>/dev/null | grep -Fxq "/node_modules/tesseract.js/package.json"; then
    success "Packaged Tesseract.js fallback present"
else
    warn "Packaged Tesseract.js fallback missing — OCR cascade will rely on Apple Vision only"
fi

# Ensure the OcrService cascade modules made it into the asar.
require_asar_entry "$APP_ASAR_PATH" "/dist-electron/electron/ocr/OcrService.js" "Packaged OcrService"
require_asar_entry "$APP_ASAR_PATH" "/dist-electron/electron/ocr/providers/AppleVisionOcrProvider.js" "Packaged Apple Vision OCR provider"
require_asar_entry "$APP_ASAR_PATH" "/dist-electron/electron/ocr/providers/WindowsOcrProvider.js" "Packaged Windows OCR provider"
require_asar_entry "$APP_ASAR_PATH" "/dist-electron/electron/ocr/providers/TesseractOcrProvider.js" "Packaged Tesseract OCR provider"

success "Permission manifest verified"

if [[ "${SKIP_INSTALL:-0}" == "1" ]]; then
    info "SKIP_INSTALL=1 set; install skipped after packaging verification"
    exit 0
fi

# ╔═══════════════════════════════════════════════════════════════════╗
# ║ Step 8: Install & Launch                                        ║
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
    run_with_spinner "transferring vessel into /Applications" cp -R "$APP_GLOB" "${INSTALL_DIR}/${APP_NAME}.app"
else
    info "Administrator access required to install into ${INSTALL_DIR}"
    run_with_spinner "transferring vessel into /Applications" sudo cp -R "$APP_GLOB" "${INSTALL_DIR}/${APP_NAME}.app"
fi

# Remove quarantine flag (bypass Gatekeeper)
if [[ -w "${INSTALL_DIR}/${APP_NAME}.app" ]]; then
    xattr -d com.apple.quarantine "${INSTALL_DIR}/${APP_NAME}.app" 2>/dev/null || true
else
    sudo xattr -d com.apple.quarantine "${INSTALL_DIR}/${APP_NAME}.app" 2>/dev/null || true
fi
success "Installed to ${INSTALL_DIR}/${APP_NAME}.app"

# ── Reset Accessibility / Screen Recording TCC entries ──
# macOS ties Accessibility permission to the code signature hash. Ad-hoc
# signed dev builds get a new hash on every rebuild, which silently
# revokes the permission. By resetting the TCC entry here, macOS will
# re-prompt on first launch and the fresh binary gets authorized.
# This only affects the Natively bundle ID — other apps are untouched.
BUNDLE_ID="com.electron.meeting-notes"
info "Resetting macOS TCC permissions for ${BUNDLE_ID} (ensures fresh binary is authorized)..."
# tccutil reset requires the service name and bundle ID.
# Accessibility = kTCCServiceAccessibility
# ScreenCapture = kTCCServiceScreenCapture
tccutil reset Accessibility "$BUNDLE_ID" 2>/dev/null || true
tccutil reset ScreenCapture "$BUNDLE_ID" 2>/dev/null || true
success "TCC permissions reset — macOS will re-prompt on first launch"

# Verify installed app binary exists and matches expected architecture
INSTALLED_BINARY="${INSTALL_DIR}/${APP_NAME}.app/Contents/MacOS/${APP_NAME}"
require_file "$INSTALLED_BINARY" "Installed app binary"
if file "$INSTALLED_BINARY" | grep -q "$BUILD_ARCH"; then
    success "Installed binary architecture verified (${BUILD_ARCH})"
else
    fail "Installed binary architecture does not match expected ${BUILD_ARCH}"
fi

if is_truthy_flag "${NATIVELY_VALIDATE_PACKAGED_HELPER_LAUNCH:-0}"; then
    step "Step 9/9 — Validating packaged helper launch modes"
    validate_packaged_helper_launch_modes "${INSTALL_DIR}/${APP_NAME}.app" "$INSTALLED_BINARY"
else
    info "Skipping packaged helper launch validation (set NATIVELY_VALIDATE_PACKAGED_HELPER_LAUNCH=1 to enable)"
fi

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

# Ask to launch only in interactive terminals
if [[ "$IS_TTY" == true ]]; then
    read -rp "$(echo -e "${YELLOW}Launch ${APP_NAME} now? [Y/n]:${NC} ")" LAUNCH
    LAUNCH=${LAUNCH:-Y}
    if [[ "$LAUNCH" =~ ^[Yy]$ ]]; then
        open "${INSTALL_DIR}/${APP_NAME}.app"
        success "Launched ${APP_NAME}!"
    fi
else
    info "Non-interactive shell detected; skipping launch prompt"
fi
