# ThinkDrop AI

ThinkDrop is a macOS desktop AI assistant that lives in a floating overlay. You type (or speak) a natural language request and ThinkDrop plans and executes it — automating browser tasks, running custom skills, managing your schedule, and more — all without switching context from what you're working on.

## Requirements

- **macOS** 12 Monterey or later
- **Node.js v18+** — required to build and run skills. ThinkDrop will prompt you to install it on first launch if missing. Download: https://nodejs.org/en/download/
- **npm** — bundled with Node.js
- **Python 3.10+** — required for the coreference resolution service. Download: https://python.org/downloads/

## Architecture

### Electron App

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ThinkDrop Electron App                        │
│                                                                      │
│  ┌─────────────────────────┐       ┌──────────────────────────────┐  │
│  │   Prompt Capture Window │       │      Results Window          │  │
│  │   (floating overlay)    │       │   (progress + output)        │  │
│  │                         │       │                              │  │
│  │  - Text / voice input   │       │  - Automation progress       │  │
│  │  - Global hotkey        │       │  - Skill build progress      │  │
│  │  - Clipboard highlight  │       │  - Streaming LLM output      │  │
│  └──────────┬──────────────┘       └──────────────▲───────────────┘  │
│             │ IPC                                   │ IPC            │
│             └───────────────────┬───────────────────┘                │
│                                 │                                    │
│                    ┌────────────▼────────────┐                       │
│                    │   Main Process (main.js) │                      │
│                    │   StateGraph pipeline    │                      │
│                    └────────────┬────────────┘                       │
└─────────────────────────────────┼────────────────────────────────────┘
                                  │ MCP (HTTP/JSON)
                                  ▼
                         (see MCP Services below)
```

### StateGraph Pipeline

Every prompt runs through a directed graph of AI nodes:

```
START
  │
  ▼
resolveReferences ──→ parseSkill ──→ parseIntent ──→ enrichIntent
                                                          │
               ┌──────────────────────┬──────────────────┤
               │                      │                  │
    command_automate           skill_build      web_search / question / screen_intelligence
               │                      │                  │
               ▼                      │          (see Query Pipeline below)
          planSkills ◄────────────────┘
          (agent-aware:                │ LLM plans steps using
           injects healthy             │ installed skills +
           agent descriptors)          │ agent capabilities
               │
               ▼
         executeCommand ◄─────────────────────────────────────────┐
               │                                                  │
               │  step type?                                      │
               ├── shell.run / browser.act / ui.* ──→ MCP call   │
               │                                                  │
               ├── external.skill ──→ skill file exists? ──────── │ yes → run it
               │                              │ no                │
               │                              ▼                   │
               │                    [ON-DEMAND SKILL BUILD]       │
               │                    show skill_build_confirm ──→ user approves?
               │                              │ yes               │ no → skip
               │                              ▼                   │
               │                    [AGENT AUTO-BUILD]            │
               │                    cli.agent or browser.agent    │
               │                    builds service descriptor ─── │
               │                    (LLM-driven, DuckDB cached)   │
               │                              │                   │
               │                              ▼                   │
               ├── needs_skill ──────────→ buildSkill ────────────┘
               │   (LLM-named,            (with agent descriptors
               │    auto-triggers          injected into prompt)
               │    build pipeline)               │
               │                                  ▼
               │                           validateSkill
               │                    (static + LLM intent + npm research)
               │                                  │ PASS
               │                                  ▼
               │                           installSkill
               │                    (LLM secret detection →
               │                     cli.agent silent resolve →
               │                     browser.agent OAuth delegate →
               │                     user prompt with enriched hint →
               │                     Keychain store → npm install →
               │                     smoke test → launchd plist →
               │                     DB registration)
               │                                  │
               │              ┌───────────────────┴───────────────┐
               │              │                                   │
               │       skillBuiltOnDemand?              smoke test FAIL?
               │              │ yes                               │ yes
               │              ▼                                   ▼
               │       resume original plan              buildSkill (fix round)
               │       at cursor+1 (no loop)             (up to 5 rounds total)
               │              │
               │       [back to executeCommand]
               │
               ├── step failed ──→ recoverSkill
               │                       │
               │          ┌────────────┼────────────┐
               │          │            │            │
               │     AUTO_PATCH     REPLAN      ASK_USER
               │          │            │            │
               │          ▼            ▼            ▼
               │   executeCommand  evaluateSkills  logConversation
               │   (patched step)       │          (paused for user)
               │                   FIX / PASS
               │                        │
               │                   planSkills
               │
               └── plan complete ──→ evaluateSkills ──→ logConversation
                                      (LLM verdict)           │
                                                       journalProgress ──→ END


Query Pipeline (enrichIntent → web_search / question / screen_intelligence):

          enrichIntent
               │
    ┌──────────┴──────────┐
    │                     │
 web_search /        screen_intelligence
 question                 │
    │              (has answer?) no
    ▼                     ▼
 webSearch           vision / answer
    │
    ▼
 retrieveMemory ──→ answer
    │                  │
    │             synthesize
    └──────┬────────────┘
           │
   memory_store / memory_retrieve
           │                 │
      storeMemory      retrieveMemory
           └──────┬──────────┘
                  ▼
           logConversation ──→ journalProgress ──→ END
```

**Agent Factory Layer** (runs inside command-service, not StateGraph nodes):

```
cli.agent                          browser.agent
    │                                   │
    │  build_agent(service)             │  build_agent(service)
    │  ─────────────────────            │  ─────────────────────
    │  1. resolveCLIMeta (LLM)          │  1. resolveBrowserMeta (LLM)
    │     → DuckDB cli_meta_cache       │     → DuckDB browser_meta_cache
    │  2. which/brew verify             │  2. Playwright waitForAuth
    │  3. infer capabilities (LLM)      │  3. infer capabilities (LLM)
    │  4. write .md descriptor          │  4. write .md descriptor
    │  5. upsert DuckDB agents table    │  5. upsert DuckDB agents table
    │                                   │
    │  validate_agent(id)               │  validate_agent(id)
    │  ─────────────────────            │  ─────────────────────
    │  LLM probe → auto-patch           │  LLM DOM check → selector fix
    │  write status/failure_log         │  write status/failure_log
    │                                   │
    └───────────────┬───────────────────┘
                    │ DuckDB agents table
                    │ (id, type, service, cli_tool,
                    │  capabilities[], descriptor,
                    │  status, last_validated, failure_log)
                    │
              planSkills reads ──→ injects healthy agent
              buildSkill reads       descriptors into LLM prompt
              installSkill reads ──→ silent credential resolution
```

**Background jobs** (run in main process):

| Job | Schedule | What it does |
|---|---|---|
| Skill daemon re-registration | App startup (+8s) | Re-loads any `~/Library/LaunchAgents/com.thinkdrop.skill.*.plist` not active in launchd |
| Nightly agent validation | 3am daily | Runs `validate_agent` for every registered agent, auto-patches descriptors |
| Nightly skill health check | 3am daily | Probe-runs each installed skill, writes `status`/`last_run`/`error_log` to user-memory |

**All StateGraph nodes** (20 total):

| Node | Role |
|---|---|
| `resolveReferences` | Resolve pronouns + co-references via coreference-service |
| `parseSkill` | Detect if prompt matches an installed skill |
| `parseIntent` | Classify intent type (command_automate, skill_build, answer, etc.) |
| `enrichIntent` | Fill profile gaps, re-route based on enriched intent |
| `planSkills` | LLM step planner with RAG context + healthy agent descriptors injected |
| `executeCommand` | Dispatch skill steps via MCP; on-demand build for missing skills |
| `recoverSkill` | Handle step failures: AUTO_PATCH, REPLAN, ASK_USER |
| `evaluateSkills` | LLM judge — post-run verdict or failure rule derivation |
| `buildSkill` | Creator Agent — LLM generates `.cjs` skill code with agent descriptor context |
| `validateSkill` | 3-layer validator — static + intent fulfillment + npm research + corrective feedback |
| `installSkill` | LLM secret detection → agent resolution → Keychain → npm install → launchd daemon → smoke test |
| `webSearch` | Search via DuckDuckGo / Brave / SearXNG / NewsAPI |
| `retrieveMemory` | Fetch relevant memories from user-memory-service |
| `storeMemory` | Save new memory to user-memory-service |
| `screenIntelligence` | Screenshot capture + OCR via screen-intelligence-service |
| `vision` | Visual analysis via LLM vision API |
| `answer` | Direct LLM response (greetings, general knowledge) |
| `synthesize` | Compose final response from multi-step context |
| `logConversation` | Persist conversation turn to conversation-service |
| `journalProgress` | Write StateGraph status to voice-journal for voice-service sync |

### MCP Services

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MCP Services Layer                             │
│                                                                             │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ command-      │  │ user-memory  │  │conversation  │  │  voice-service  │ │
│  │ service       │  │ service      │  │ service      │  │                 │ │
│  │ (port 3007)   │  │ (port 3001)  │  │ (port 3004)  │  │ (port 3006)     │ │
│  │               │  │              │  │              │  │                 │ │
│  │ browser.act   │  │ Skills DB    │  │ Sessions     │  │ STT (Whisper)   │ │
│  │ shell.run     │  │ Agent DB     │  │ Messages     │  │ TTS (Inworld)   │ │
│  │ ui.*          │  │ Context rules│  │              │  │ VAD, wake word  │ │
│  │ external.*    │  │ User profile │  │              │  │                 │ │
│  │ cli.agent     │  │ (DuckDB)     │  │              │  │                 │ │
│  │ browser.agent │  │              │  │              │  │                 │ │
│  └───────────────┘  └──────────────┘  └──────────────┘  └─────────────────┘ │
│                                                                             │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ phi4-service  │  │ web-search   │  │ coreference  │  │ screen-intelli- │ │
│  │               │  │ service      │  │ service      │  │ gence-service   │ │
│  │ (port 3003)   │  │ (port 3002)  │  │ (port 3005)  │  │ (port 3008)     │ │
│  │               │  │              │  │              │  │                 │ │
│  │ Intent class. │  │ DuckDuckGo   │  │ Pronoun/ref  │  │ Screenshot OCR  │ │
│  │ DistilBERT    │  │ Brave, News  │  │ resolution   │  │ Active window   │ │
│  │ embeddings    │  │ SearXNG      │  │ (Python NLP) │  │ detection       │ │
│  └───────────────┘  └──────────────┘  └──────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Skill Build Loop** (`buildSkill` → `validateSkill` → `installSkill`):
1. `buildSkill` — LLM generates a `.cjs` skill file; agent descriptors from DuckDB injected into prompt so CLI commands and API patterns are exact
2. `validateSkill` — 3-layer validator: static security checks → intent fulfillment (LLM) → npm registry research. Failures inject rich `FIX [CATEGORY]:` instructions back to `buildSkill`
3. `installSkill` — LLM-driven secret detection → `cli.agent` silent credential extraction (or `browser.agent` OAuth delegation) → Keychain store → `npm install` → smoke test → launchd daemon plist registration → user-memory DB registration
4. Smoke test failures route back to `buildSkill` for another fix cycle (up to 5 rounds total)
5. On completion, `postBuildResumeCursor` advances to the step *after* the trigger so the original plan resumes without re-triggering the build

## Skills

Skills are user-installable Node.js modules stored in `~/.thinkdrop/skills/<name>/index.cjs`. Each skill:
- Exports `module.exports = async (args) => { ... }`
- Uses `keytar` for secret storage (macOS Keychain)
- Gets its own `package.json` + `node_modules/` — dependencies auto-installed on build
- Is registered in the user-memory service DB for discovery

**Always-available in skills** (no install needed):
- All Node.js built-ins (`fs`, `https`, `path`, `crypto`, etc.)
- `keytar` — macOS Keychain access
- `node-cron` — cron scheduling

**Auto-installed per skill** (detector scans `require()` calls):
- `twilio`, `googleapis`, `nodemailer`, `axios`, `openai`, `node-fetch`, and more

## MCP Services

Each service is an independent process with its own dependencies:

| Service | Port | Runtime | Purpose |
|---|---|---|---|
| `command-service` | 3007 | Node.js | Browser automation (Playwright), shell, UI control, external skill execution, `cli.agent` + `browser.agent` factory |
| `user-memory-service` | 3001 | Node.js | Skills DB, context rules, user profile (DuckDB) |
| `conversation-service` | 3004 | Node.js | Session history, message store |
| `voice-service` | 3006 | Node.js | STT (Groq Whisper), TTS (Inworld/ElevenLabs), VAD, wake word |
| `phi4-service` | 3003 | Node.js | Intent classification, DistilBERT embeddings |
| `web-search` | 3002 | Node.js | Web search via DuckDuckGo, Brave, NewsAPI, SearXNG |
| `coreference-service` | 3005 | Python | Pronoun + reference resolution (NLP) |
| `screen-intelligence-service` | 3008 | Node.js | Screenshot OCR, active window detection |

## Getting Started

### Prerequisites

```bash
# Install Node.js v18+ from https://nodejs.org
node --version   # should be v18.0.0 or later
npm --version
```

### Install & Run (Development)

```bash
# 1. Clone and install root dependencies
git clone <repo>
cd thinkdrop
yarn install

# 2. Install MCP service dependencies (Node.js services)
cd mcp-services/command-service && npm install && cd ../..
cd mcp-services/thinkdrop-user-memory-service && npm install && cd ../..
cd mcp-services/conversation-service && npm install && cd ../..
cd mcp-services/voice-service && npm install && cd ../..
cd mcp-services/thinkdrop-phi4-service && npm install && cd ../..
cd mcp-services/thinkdrop-web-search && npm install && cd ../..
cd mcp-services/screen-intelligence-service && npm install && cd ../..

# 3. Install coreference service (Python)
cd mcp-services/coreference-service
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt && cd ../..

# 4. Install stategraph module
cd stategraph-module && npm install && cd ..

# 5. Start all services (separate terminals or use a process manager)
# Terminal 1 — main app
yarn dev

# Terminal 2 — command service
cd mcp-services/command-service && npm start

# Terminal 3 — user memory service
cd mcp-services/thinkdrop-user-memory-service && npm start

# Terminal 4 — conversation service
cd mcp-services/conversation-service && npm start

# Terminal 5 — voice service
cd mcp-services/voice-service && npm start

# Terminal 6 — phi4 service
cd mcp-services/thinkdrop-phi4-service && npm start

# Terminal 7 — web search service
cd mcp-services/thinkdrop-web-search && npm start

# Terminal 8 — coreference service (Python)
cd mcp-services/coreference-service && source venv/bin/activate && python server.py

# Terminal 9 — screen intelligence service
cd mcp-services/screen-intelligence-service && npm start
```

### Global Hotkey

`Cmd+Shift+Space` — show/hide the prompt capture window from anywhere on macOS.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+Space` | Show / hide prompt window |
| `Enter` | Submit prompt |
| `Shift+Enter` | New line |
| `Esc` | Close windows |
| `Cmd+C` (text selected) | Add highlighted text as context tag |

## Project Structure

```
thinkdrop/
├── src/
│   ├── main/
│   │   ├── main.js              # Electron main process, IPC, StateGraph init
│   │   ├── preload.js           # Context bridge — IPC channel whitelist
│   │   └── scheduler.js         # launchd-based persistent task scheduler
│   └── renderer/
│       ├── components/
│       │   ├── AutomationProgress.tsx   # Live step-by-step automation UI
│       │   ├── SkillBuildProgress.tsx   # Skill build pipeline UI
│       │   └── ResultsWindow.tsx        # Results + progress host
│       └── utils/
├── stategraph-module/
│   └── src/
│       ├── StateGraphBuilder.js         # Graph wiring + routing logic
│       ├── nodes/
│       │   ├── buildSkill.js            # Creator Agent — generates skill code
│       │   ├── validateSkill.js         # Validator Agent — 3-layer review + corrective feedback
│       │   ├── installSkill.js          # Installer — deps, Keychain, smoke test, registration
│       │   ├── planSkills.js            # Planner — LLM step generation with RAG
│       │   ├── evaluateSkills.js        # Judge — post-run verdict, saves context rules
│       │   ├── executeCommand.js        # Dispatcher — runs skill steps, on-demand skill build trigger
│       │   └── recoverSkill.js          # Recovery — AUTO_PATCH, REPLAN, ASK_USER
│       └── prompts/                     # System prompt markdown files
└── mcp-services/
    ├── command-service/                 # Playwright, shell, UI, external skills, cli.agent, browser.agent (port 3007)
    ├── thinkdrop-user-memory-service/   # DuckDB — skills, context rules, profile (port 3001)
    ├── conversation-service/            # Session + message history (port 3004)
    ├── voice-service/                   # STT/TTS/VAD pipeline (port 3006)
    ├── thinkdrop-phi4-service/          # Intent classification, DistilBERT (port 3003)
    ├── thinkdrop-web-search/            # Web search — DuckDuckGo, Brave, SearXNG (port 3002)
    ├── coreference-service/             # Pronoun/ref resolution — Python/FastAPI (port 3005)
    └── screen-intelligence-service/     # Screenshot OCR, active window detection (port 3008)
```

## Troubleshooting

### Node.js not detected at startup
ThinkDrop shows a dialog on launch if `node` is not in PATH. Install Node.js v18+ from https://nodejs.org and restart the app.

### Skill build fails repeatedly
Check the validator feedback shown in the build progress UI. Each failed round injects corrective `FIX [CATEGORY]:` instructions into the next build attempt. After 5 failed rounds the build aborts with an error summary.

### `Cannot find module 'keytar'`
Run `npm install` in `mcp-services/command-service/` — `keytar` must be installed there since it's the process that loads and runs user skills.

### Screen recording / accessibility permissions
ThinkDrop needs screen recording permission for screenshot capture and accessibility permission for UI automation (nut.js). Grant both in **System Settings → Privacy & Security**.

### MCP service not responding
Each MCP service must be running independently. Check that the service processes are active on their expected ports (3001, 3004, 3006, 3007).

## Technical Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| UI | React 18 + TypeScript + Vite |
| Styling | TailwindCSS |
| AI pipeline | Custom StateGraph (directed node graph) |
| LLM bridge | VS Code WebSocket LLM backend (port 4000) |
| Browser automation | Playwright |
| UI automation | nut.js |
| Secret storage | keytar (macOS Keychain) |
| Skill scheduling | node-cron + launchd |
| Persistence | DuckDB (user-memory-service) |
| Voice STT | Groq Whisper (whisper-large-v3-turbo) |
| Voice TTS | Inworld AI / ElevenLabs / macOS native |

## License

MIT
