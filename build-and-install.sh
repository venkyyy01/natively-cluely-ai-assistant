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
APP_SUPPORT_DIR="${HOME}/Library/Application Support/natively"
APP_LOG_DIR="${APP_SUPPORT_DIR}/Logs"
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

enable_default_app_logging() {
    mkdir -p "$APP_LOG_DIR"
    export NATIVELY_DEBUG_LOG=1
    if command -v launchctl >/dev/null 2>&1; then
        if launchctl setenv NATIVELY_DEBUG_LOG 1; then
            success "Enabled default app logging for LaunchServices"
        else
            warn "Could not set LaunchServices logging environment; shell launch will still inherit NATIVELY_DEBUG_LOG=1"
        fi
    else
        warn "launchctl not found; shell launch will still inherit NATIVELY_DEBUG_LOG=1"
    fi
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

resolve_macos_virtual_display_helper_binary() {
    local helper_dir="$1"
    local candidate=""
    local candidates=(
        "$helper_dir/system-services-helper"
        "$helper_dir/stealth-virtual-display-helper"
    )

    for candidate in "${candidates[@]}"; do
        if [[ -f "$candidate" ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    return 1
}

require_macos_virtual_display_helper() {
    local helper_dir="$1"
    local helper_path=""

    helper_path=$(resolve_macos_virtual_display_helper_binary "$helper_dir" || true)
    if [[ -n "$helper_path" ]]; then
        success "Packaged macOS virtual display helper present ($(basename "$helper_path"))"
    else
        fail "Missing required file: $helper_dir/{system-services-helper,stealth-virtual-display-helper}"
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

# ── Detect Rust ──
if command -v cargo &>/dev/null; then
HAS_RUST="true"
else
HAS_RUST="false"
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

# Ensure native dependencies match the target architecture
run_with_spinner "verifying native dependencies for ${BUILD_ARCH}" node scripts/ensure-electron-native-deps.js
success "Native dependencies ready for ${BUILD_ARCH}"

# ╔═══════════════════════════════════════════════════════════════════╗
# ║ Step 4: Run Quality Gates                                        
# ╚═══════════════════════════════════════════════════════════════════╝
QUALITY_GATES_RAN=false
if [[ "${SKIP_QUALITY_GATES:-0}" == "0" ]]; then
    step "Step 4/8 — Running Production Quality Gates"

    info "Running quality gates in visible stages so long-running checks do not look frozen..."

    FOUNDATION_RELEASE_VERIFY_ENABLED=false
    if [[ "$BUILD_ARCH" == "arm64" && "${SKIP_FOUNDATION_INTENT_RELEASE_VERIFY:-0}" == "0" ]]; then
        FOUNDATION_RELEASE_VERIFY_ENABLED=true
    fi

    if [[ "$FOUNDATION_RELEASE_VERIFY_ENABLED" == "true" ]]; then
        QUALITY_GATE_TEST_LABEL="[1/3] Running Electron tests (this may take a minute)..."
        QUALITY_GATE_VERIFY_LABEL="[2/3] Running production verification..."
        QUALITY_GATE_FOUNDATION_LABEL="[3/3] Running Apple Silicon Foundation intent release verification..."
    else
        QUALITY_GATE_TEST_LABEL="[1/2] Running Electron tests (this may take a minute)..."
        QUALITY_GATE_VERIFY_LABEL="[2/2] Running production verification..."
        QUALITY_GATE_FOUNDATION_LABEL=""
    fi

    run_logged_command "$QUALITY_GATE_TEST_LABEL" npm run test:electron
    success "Electron tests passed"

    run_logged_command "$QUALITY_GATE_VERIFY_LABEL" npm run verify:production
    success "Production verification passed"

    if [[ "$FOUNDATION_RELEASE_VERIFY_ENABLED" == "true" ]]; then
        run_logged_command "$QUALITY_GATE_FOUNDATION_LABEL" npm run verify:foundation-intent-release
        success "Apple Silicon Foundation intent release verification passed"
    else
        info "Skipping Apple Silicon Foundation intent release verification (requires arm64 build host; set SKIP_FOUNDATION_INTENT_RELEASE_VERIFY=1 to silence this message on Apple Silicon)"
    fi

    QUALITY_GATES_RAN=true
    success "Quality gates passed"
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

PACKAGED_HELPER_DIR="$APP_GLOB/Contents/Resources/bin/macos"
PACKAGED_HELPER=$(resolve_macos_virtual_display_helper_binary "$PACKAGED_HELPER_DIR" || true)
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
    warn "Packaged macOS virtual display helper not found before app signing (looked for system-services-helper and stealth-virtual-display-helper)"
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
require_macos_virtual_display_helper "$APP_RESOURCES_DIR/bin/macos"
require_file "$APP_RESOURCES_DIR/bin/macos/foundation-intent-helper" "Packaged foundation intent helper"
require_file "$APP_GLOB/Contents/XPCServices/macos-full-stealth-helper.xpc/Contents/MacOS/macos-full-stealth-helper" "Packaged macOS full stealth XPC helper"

if [[ "$BUILD_ARCH" == "arm64" ]]; then
    require_file "$APP_ASAR_UNPACKED_DIR/dist-electron/electron/preload.js" "Unpacked renderer preload"
    require_file "$APP_ASAR_UNPACKED_DIR/dist-electron/electron/stealth/shellPreload.js" "Unpacked stealth shell preload"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/natively-audio/index.darwin-arm64.node" "Unpacked arm64 native audio binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "Unpacked arm64 better-sqlite3 binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/sqlite3/build/Release/node_sqlite3.node" "Unpacked arm64 sqlite3 binary"
else
    require_file "$APP_ASAR_UNPACKED_DIR/dist-electron/electron/preload.js" "Unpacked renderer preload"
    require_file "$APP_ASAR_UNPACKED_DIR/dist-electron/electron/stealth/shellPreload.js" "Unpacked stealth shell preload"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/natively-audio/index.darwin-x64.node" "Unpacked x64 native audio binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "Unpacked x64 better-sqlite3 binary"
    require_file "$APP_ASAR_UNPACKED_DIR/node_modules/sqlite3/build/Release/node_sqlite3.node" "Unpacked x64 sqlite3 binary"
fi

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

enable_default_app_logging

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
echo -e "  ${CYAN}4.${NC} Logs are on by default for this launch session:"
echo -e "     ${YELLOW}>${NC} ${APP_LOG_DIR}/natively-$(date +%F).log"
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
