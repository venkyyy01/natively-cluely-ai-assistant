# Natively

**Free, open-source AI interview copilot and meeting assistant.**

Real-time answers, rolling conversational context, screenshot understanding, speech-to-text transcription, and smart follow-up suggestions — all in an invisible, always-on-top overlay that stays private and runs entirely on your machine.

[![License](https://img.shields.io/badge/License-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-blueviolet?style=flat-square)](https://github.com/evinjohnn/natively-cluely-ai-assistant/releases)
[![Stars](https://img.shields.io/github/stars/evinjohnn/natively-cluely-ai-assistant?style=flat-square&color=gold)](https://github.com/evinjohnn/natively-cluely-ai-assistant)

---

## What Natively Does

- **Live interview copilot** — Real-time speech-to-text with sub-500ms latency. Get instant, context-aware answers as questions are asked.
- **Screenshot problem capture** — OCR any visible coding problem (LeetCode, HackerRank, CoderPad, etc.) and receive full solutions through the overlay.
- **Rolling context memory** — A sliding context window keeps the AI aware of the full conversation. Local RAG (via SQLite + sqlite-vec) lets you ask questions across all past meetings.
- **Dual audio channels** — System audio captures what colleagues say; a separate microphone channel handles your voice commands.
- **Stealth mode** — Instantly hide from the dock/taskbar, disguise the process as a harmless system utility, and stay invisible during screen sharing.
- **Meetings dashboard** — Search, review, and export full transcripts from every meeting to Markdown, JSON, or plain text.

Natively is a direct replacement for Final Round AI ($149/mo), LockedIn AI ($70/mo), and Cluely ($20/mo, breached 83k users in 2025) — at $0, open-source, and with zero data breaches.

---

## Quick Start

### 1. Download

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | [Natively-2.0.9-arm64.dmg](https://github.com/evinjohnn/natively-cluely-ai-assistant/releases/latest) |
| macOS (Intel) | [Natively-2.0.9-x64.dmg](https://github.com/evinjohnn/natively-cluely-ai-assistant/releases/latest) |
| Windows | [Natively Setup 2.0.9.exe](https://github.com/evinjohnn/natively-cluely-ai-assistant/releases/tag/v2.0.5) |

Requires macOS 12+ or Windows 10/11.

### 2. Install

**macOS:** Open the DMG, drag Natively into Applications. On first launch, right-click the app and choose Open (or run `xattr -cr /Applications/Natively.app` in Terminal).

**Windows:** Run the installer or use the portable `.exe`.

### 3. Configure

On first launch, enter your API keys in Settings. You only need **one** provider to start.

**AI Providers** (you need one):

| Provider | Recommended Model | Notes |
|----------|-------------------|-------|
| Google Gemini | `gemini-3.1-flash-lite-preview` | Best speed/cost balance |
| OpenAI | `gpt-4.5` or `o3` | High reasoning |
| Anthropic | `claude-sonnet-4-6` | Coding & nuance |
| Groq | `llama-3.3-70b` | Fastest inference |
| Ollama (local) | `llama3.2` | 100% offline — no API needed |
| Custom | Any OpenAI-compatible endpoint | OpenRouter, LM Studio, vLLM, etc. |

**Speech Providers** (you need one):

| Provider | Notes |
|----------|-------|
| Google STT | Recommended for real-time performance |
| Deepgram | Fast streaming |
| Groq | Whisper-based, very fast |
| OpenAI Whisper | High accuracy |
| ElevenLabs | Voice-grade accuracy |

### 4. Use

| Action | Shortcut |
|--------|----------|
| Toggle overlay | `Cmd+Option+Shift+V` |
| Full screenshot | `Cmd+Option+Shift+S` |
| Selective screenshot | `Cmd+Option+Shift+A` |
| Click-through mode | `Cmd+Shift+M` |

Default shortcuts are chosen to avoid collisions with Zoom, Teams, Meet, and browser shortcuts.

---

## Key Features

### Interview & Meeting Copilot
- Real-time speech-to-text with rolling context window and epoch summarization
- Context-aware answers using profile data (resume, job description, company dossier)
- Provenance-verified answers that reject unsupported claims before delivery
- Answer shape planner — chooses the right response structure (direct, tradeoff defense, metric-backed, example, etc.) before generation

### Coding Interview Mode
- Screenshot + OCR captures problems from LeetCode, HackerRank, CoderPad, Codility, HackerEarth, Karat, and any browser-based coding environment
- Smart fallback to Groq Llama 4 Scout if the primary vision model fails
- Multi-screenshot support for multi-part problems

### Stealth & Privacy
- **Undetectable mode** — hide from dock/taskbar with a visually locked selector
- **Process disguise** — rename the app to Terminal, System Settings, Activity Monitor, or other utilities to evade screen-share detection
- API keys stored in the system keychain, scrubbed from memory on quit
- 100% local data — transcripts and embeddings stay on your machine (SQLite + sqlite-vec)
- Zero backend servers, zero data breaches

### Meeting Intelligence Dashboard
- Full transcript archive with semantic search across all past meetings
- One-click export to Markdown, JSON, or plain text
- Usage statistics and token cost tracking
- Separate volume controls for system audio and microphone input

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Inputs                                                  │
│  System audio + mic ─► Rust native module (napi-rs)     │
│  Screenshots ─► Sharp + Tesseract OCR                   │
│  Global shortcuts, tray, IPC ─► electron main           │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Electron Main Process                                   │
│  AppState · WindowFacade · RuntimeCoordinator           │
│  SessionTracker (rolling context, phase detection)      │
│  ProcessingHelper + IntelligenceManager                 │
│  MeetingPersistence + RAGManager                        │
│  StealthManager (dock hide, process disguise, watchdogs)│
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Stealth Surface Runtime                                 │
│  Offscreen content window (React UI)                     │
│  FrameBridge → visible shell window (paint forwarding)  │
│  InputBridge ← shell input routing back                 │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Providers & Storage                                     │
│  STT: Deepgram, Google, Groq, Whisper, Soniox           │
│  LLM: OpenAI, Anthropic, Gemini, Groq, Ollama, Custom   │
│  DB: SQLite + sqlite-vec (local RAG)                    │
└─────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Vite, TypeScript, TailwindCSS, Radix UI, Framer Motion |
| Desktop | Electron 41 |
| Native audio | Rust (`napi-rs`, zero-copy ABI via `napi::Buffer`) |
| Database | SQLite (`better-sqlite3`) + `sqlite-vec` for vector search |
| OCR | Tesseract.js + Sharp |
| State | React Query, electron-store |

---

## Building from Source

### Prerequisites

- Node.js 20+
- Rust (optional — only needed to rebuild the native audio module; pre-built binaries included)
- macOS: Xcode CLI tools (`xcode-select --install`)
- Windows: Visual Studio Build Tools with "Desktop development with C++"

### Build

```bash
git clone https://github.com/evinjohnn/natively-cluely-ai-assistant.git
cd natively-cluely-ai-assistant
npm install

# Create .env with at least one AI provider key
echo "GEMINI_API_KEY=your_key_here" > .env
echo "DEFAULT_MODEL=gemini-3.1-flash-lite-preview" >> .env

# Development
npm start

# Production build → ./release/
npm run dist
```

See the [full build documentation](https://github.com/evinjohnn/natively-cluely-ai-assistant#building-from-source) for Windows details, entitlements, code signing, and troubleshooting.

---

## Comparison

| | Natively | Cluely | Final Round AI | LockedIn AI |
|-|----------|--------|----------------|-------------|
| Price | **Free** (BYOK) | $20/mo | $149/mo | $55–70/mo |
| Open source | **Yes** | No | No | No |
| Data stored | **Local** | Cloud | Cloud | Cloud |
| Any LLM | **Yes** | No | No | No |
| Local AI (offline) | **Ollama** | No | No | No |
| Real-time latency | **<500ms** | 5–90s | Slowest | ~116ms |
| Dual audio channels | **Yes** | No | No | No |
| Local RAG memory | **Yes** | No | No | No |
| Stealth mode | **Yes** | No | Visible | No |
| Data breach history | **None** | 83k users exposed | None | None |

---

## Privacy

- AGPL-3.0 open source — entire codebase auditable
- Bring your own API keys — keys never leave your machine
- All data stored locally — SQLite on your machine, no cloud servers
- Optional Ollama mode — 100% offline, zero network calls
- API keys scrubbed from memory on app quit
- No backend, no server to breach

---

## Project Structure

```
natively-cluely-ai-assistant/
├── electron/                  # Electron main process
│   ├── main.ts                # Entry point, supervisors, IPC wiring
│   ├── stealth/               # StealthManager, process disguise, dock hide
│   ├── conscious/             # Rolling context, answer planner, provenance verifier
│   ├── rag/                   # RAG system (chunking, embedding, vector search)
│   ├── db/                    # SQLite + sqlite-vec layer
│   ├── llm/                   # Multi-provider LLM routing
│   ├── runtime/               # Audio, STT, Inference, Window, Settings facades
│   └── services/              # Settings, credentials, calendar managers
├── native-module/             # Rust native audio capture (napi-rs)
├── src/                       # React frontend (renderer)
│   ├── components/            # UI components
│   ├── hooks/                 # React hooks
│   ├── lib/                   # Utilities, feature flags
│   └── types/                 # TypeScript types
├── renderer/                  # Renderer-side tests
├── scripts/                   # Build, model download, verification scripts
├── shared/                    # Shared types/utilities
└── package.json               # Dependencies and scripts
```

---

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start dev server + Electron |
| `npm run dev` | Vite dev server only |
| `npm run dist` | Production build |
| `npm run typecheck` | TypeScript checking |
| `npm run test` | Electron + Rust tests |
| `npm run eval:conscious` | Conscious mode evaluation |
| `npm run verify:production` | Full production verification gate |

---

## Known Limitations

- No Linux support yet
- Full desktop screen share: stealth is best-effort; prefer window or browser tab share for strongest coverage
- Not designed to bypass dedicated proctoring software (Pearson VUE, ProctorU, Respondus Lockdown Browser)

---

## License

[GNU Affero General Public License v3.0](LICENSE)

---

## Contributing

Contributions welcome — bug fixes, features, documentation, UI/UX, new AI integrations. See [CONTRIBUTING.md](CONTRIBUTING.md).