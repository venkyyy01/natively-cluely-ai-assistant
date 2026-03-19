# Natively — macOS Deployment Guide

Complete instructions to build, sign, and install Natively as a standalone macOS application.

---

## Prerequisites

| Requirement | Minimum Version | Check Command |
|-------------|----------------|---------------|
| **macOS** | 12.0 (Monterey) | `sw_vers` |
| **Node.js** | 18.x | `node -v` |
| **npm** | 9.x | `npm -v` |
| **Xcode CLI Tools** | Latest | `xcode-select -p` |
| **Python** | 3.x (for node-gyp) | `python3 --version` |
| **Rust** (optional) | Latest stable | `rustc --version` |

### Install Prerequisites

```bash
# Xcode Command Line Tools (required for native compilation)
xcode-select --install

# Node.js via Homebrew
brew install node@18

# Rust (only needed if building native audio module)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

---

## Step 1 — Clone & Install Dependencies

```bash
# Clone the repository
git clone https://github.com/evinjohnn/natively-cluely-ai-assistant.git
cd natively-cluely-ai-assistant

# Install all dependencies (this also downloads ML models + rebuilds native modules)
npm install
```

> [!NOTE]
> `npm install` automatically runs `postinstall` which:
> 1. Rebuilds `sharp` for your architecture
> 2. Downloads embedding models (`all-MiniLM-L6-v2`, `mobilebert-uncased-mnli`) to `resources/models/`
> 3. Ensures `sqlite-vec` native binary exists

> [!WARNING]
> If `npm install` fails on `better-sqlite3` or `sharp`, run:
> ```bash
> npm rebuild better-sqlite3 --build-from-source
> SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm rebuild sharp
> ```

---

## Step 2 — Configure Environment

Create a `.env` file in the project root. **You need at least one AI provider API key** for the app to function:

```bash
cp .env.example .env  # or create manually
```

```env
# ── Cloud AI Providers (at least one required) ──
GEMINI_API_KEY=your_gemini_key_here
GROQ_API_KEY=your_groq_key_here
OPENAI_API_KEY=your_openai_key_here
CLAUDE_API_KEY=your_claude_key_here

# ── Speech Provider (at least one required for transcription) ──
DEEPGRAM_API_KEY=your_deepgram_key_here

# ── Local AI via Ollama (optional, free alternative) ──
USE_OLLAMA=true
OLLAMA_MODEL=llama3.2
OLLAMA_URL=http://localhost:11434

# ── Default Model ──
DEFAULT_MODEL=gemini-3.1-flash-lite-preview
```

### Where to Get API Keys

| Provider | URL | Free Tier |
|----------|-----|-----------|
| **Google Gemini** | [aistudio.google.com](https://aistudio.google.com) | ✅ Generous |
| **Groq** | [console.groq.com](https://console.groq.com) | ✅ Free |
| **OpenAI** | [platform.openai.com](https://platform.openai.com) | ❌ Paid |
| **Anthropic Claude** | [console.anthropic.com](https://console.anthropic.com) | ❌ Paid |
| **Deepgram** | [console.deepgram.com](https://console.deepgram.com) | ✅ $200 credit |

### Using Ollama (100% Free, Local)

If you prefer fully local AI with no API keys:

```bash
# Install Ollama
brew install ollama

# Start Ollama server
ollama serve

# Pull a model (in another terminal)
ollama pull llama3.2
```

Then set `USE_OLLAMA=true` in your `.env`.

---

## Step 3 — Test in Development Mode

Before building, verify everything works:

```bash
# Run the full Electron app in dev mode
npm start
# This is equivalent to: npm run app:dev
```

This starts:
1. Vite dev server on `http://localhost:5180`
2. Electron app connecting to the dev server

> [!TIP]
> If you only want to test the frontend UI without Electron:
> ```bash
> npm run dev
> # Then open http://localhost:5180 in your browser
> ```

---

## Step 4 — Build the Production App

```bash
# Full production build → outputs to ./release/
npm run dist
```

This executes the following pipeline:

```
npm run clean          →  Removes dist/ and dist-electron/
tsc                    →  Compiles TypeScript (React frontend)
vite build             →  Bundles the frontend into dist/
tsc -p electron/       →  Compiles Electron main process into dist-electron/
electron-builder       →  Packages into .app → signs → creates DMG + ZIP
```

### Build Output

After a successful build, you'll find these in `./release/`:

```
release/
├── Natively-2.0.6-arm64.dmg        # Apple Silicon installer
├── Natively-2.0.6-x64.dmg          # Intel Mac installer
├── Natively-2.0.6-arm64-mac.zip    # Apple Silicon portable
├── Natively-2.0.6-x64-mac.zip      # Intel Mac portable
└── mac-arm64/                       # Unpackaged .app
    └── Natively.app
```

> [!IMPORTANT]
> The build targets **both architectures** by default. To build only for your current architecture:
> ```bash
> # Apple Silicon only
> npx electron-builder --mac --arm64
>
> # Intel only
> npx electron-builder --mac --x64
> ```

---

## Step 5 — Code Signing (Automatic)

### Ad-Hoc Signing (Default — No Apple Developer Account Needed)

The build automatically runs `scripts/ad-hoc-sign.js` as an `afterPack` hook. This performs:

```bash
codesign --force --deep --entitlements assets/entitlements.mac.plist --sign - "Natively.app"
```

**What it does:**
- `--sign -` → Ad-hoc signature (no Apple Developer ID required)
- `--force` → Replaces any existing signature
- `--deep` → Signs all nested frameworks and helpers
- `--entitlements` → Grants these permissions:

| Entitlement | Purpose |
|-------------|---------|
| `allow-jit` | V8 JavaScript engine on Apple Silicon |
| `allow-unsigned-executable-memory` | Native module execution |
| `disable-library-validation` | Load `better-sqlite3`, `sharp` .node files |
| `device.audio-input` | Microphone access for transcription |
| `automation.apple-events` | System automation for stealth features |
| `allow-dyld-environment-variables` | Dynamic library loading |

> [!NOTE]
> You do **not** need an Apple Developer account ($99/year) for personal use. Ad-hoc signing works perfectly for running on your own Mac.

---

## Step 6 — Install the App

### Option A: DMG Installer (Recommended)

1. Open `release/Natively-2.0.6-arm64.dmg` (or `x64` for Intel)
2. Drag **Natively** into the **Applications** folder
3. Eject the DMG

### Option B: Direct Copy

```bash
# Copy the .app directly to Applications
cp -R release/mac-arm64/Natively.app /Applications/
```

### Option C: ZIP (Portable)

1. Unzip `Natively-2.0.6-arm64-mac.zip`
2. Move `Natively.app` anywhere you like
3. Run directly — no installation needed

---

## Step 7 — First Launch (Bypass Gatekeeper)

Since the app is ad-hoc signed (not notarized with Apple), macOS Gatekeeper will block it on first launch. Here's how to bypass it:

### Method 1: Right-Click → Open (Easiest)

1. Open **Finder** → **Applications** (or wherever you placed the app)
2. **Right-click** (or Control-click) on **Natively.app**
3. Click **Open** from the context menu
4. Click **Open** again in the dialog that says "macOS cannot verify the developer"

> After the first launch, it opens normally from then on.

### Method 2: System Settings

1. Try to open the app normally (it will be blocked)
2. Go to **System Settings** → **Privacy & Security**
3. Scroll down — you'll see a message: *"Natively" was blocked from use because it is not from an identified developer*
4. Click **Open Anyway**
5. Enter your password

### Method 3: Terminal (Most Reliable)

```bash
# Remove the quarantine attribute set by macOS
xattr -cr /Applications/Natively.app

# Then open normally
open /Applications/Natively.app
```

> [!CAUTION]
> If you get `"Natively.app" is damaged and can't be opened`:
> ```bash
> # This is a false positive from Gatekeeper, not actual corruption
> xattr -cr /Applications/Natively.app
> codesign --force --deep --sign - /Applications/Natively.app
> ```

---

## Step 8 — Grant Permissions

On first launch, macOS will ask for these permissions. **Grant all of them** for full functionality:

| Permission | What It's For | Where to Enable |
|------------|---------------|-----------------|
| **Microphone** | Live meeting transcription | System Settings → Privacy → Microphone |
| **Screen Recording** | Screenshot capture & analysis | System Settings → Privacy → Screen Recording |
| **Accessibility** | Keyboard shortcuts & overlay | System Settings → Privacy → Accessibility |

> [!TIP]
> If the permission dialogs don't appear, manually add Natively in:
> **System Settings → Privacy & Security → [Permission Type] → + → Select Natively.app**

---

## Troubleshooting

### Build Fails: `better-sqlite3` compilation error

```bash
npm rebuild better-sqlite3 --build-from-source
```

### Build Fails: `sharp` error

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm rebuild sharp
```

### Build Fails: Native audio module (Rust)

The native audio module is **optional**. If Rust compilation fails:

```bash
# Skip it — the app falls back to JavaScript audio processing
npm install --ignore-scripts
npm run postinstall  # manually run only model downloads
```

### App Won't Open: "damaged" error

```bash
xattr -cr /Applications/Natively.app
codesign --force --deep --sign - /Applications/Natively.app
```

### App Won't Open: Code signature invalid

```bash
# Re-sign with entitlements
codesign --force --deep \
  --entitlements assets/entitlements.mac.plist \
  --sign - /Applications/Natively.app
```

### No Audio / Microphone Not Working

1. Check **System Settings → Privacy → Microphone** — Natively must be listed and enabled
2. Restart the app after granting permission
3. Verify a speech API key is configured (Deepgram, or use built-in Soniox)

### Model Download Fails

```bash
# Manually re-download ML models
node scripts/download-models.js
```

---

## Quick Reference

```bash
# ── Development ──
npm install              # Install dependencies + download models
npm start                # Run Electron app in dev mode
npm run dev              # Run frontend only (browser mode)

# ── Production ──
npm run dist             # Full build → release/ folder
npm run build            # Build frontend only (no Electron packaging)

# ── After Build ──
xattr -cr release/mac-arm64/Natively.app           # Remove quarantine
cp -R release/mac-arm64/Natively.app /Applications/ # Install
open /Applications/Natively.app                     # Launch
```

---

## Architecture Summary

```
┌──────────────────────────────────────────┐
│              Natively.app                │
├──────────────────────────────────────────┤
│  Electron Main Process                   │
│  ├── Audio Capture (native module/JS)    │
│  ├── Speech-to-Text (Deepgram/Soniox)   │
│  ├── LLM Integration (Gemini/GPT/etc)   │
│  ├── Local RAG (SQLite-vec + MiniLM)     │
│  └── Profile Intelligence Engine         │
├──────────────────────────────────────────┤
│  React Frontend (Vite-bundled)           │
│  ├── Launcher Dashboard                  │
│  ├── Live Interview Overlay              │
│  ├── Settings & Configuration            │
│  └── Meeting Notes History               │
└──────────────────────────────────────────┘
```
