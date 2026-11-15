# Tarka: Autonomous Browser Runtime for Local and Cloud AI

Tarka is an open-source autonomous browser agent implemented as a Chrome Manifest V3 extension.
It executes complex, multi-step web workflows by operating inside Google Chrome's native Side Panel.
Unlike cloud-hosted headless browser wrappers, Tarka runs directly inside the user's authentic browser context, executing actions via Chrome DevTools Protocol (CDP) trusted hardware events and extracting semantic accessibility trees.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime](https://img.shields.io/badge/Node.js-%3E%3D22.18-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/Chrome-Manifest%20V3-orange.svg)](public/manifest.json)
[![Security Check](https://img.shields.io/badge/CSP-Zero%20Eval%20Enforced-blueviolet.svg)](scripts/evalscan.mjs)

---

## Architectural Highlights

### 1. Dual Input Dispatch Engine (Hardware CDP + Fallback)
Tarka routes input events through `chrome.debugger` to produce real OS-level dispatch sequences rather than fragile JavaScript synthetic clicks.
- **Trusted Events:** Emits genuine `Input.dispatchMouseEvent` (hover, mouse-down, mouse-up, click) and `Input.dispatchKeyEvent` sequences.
- **Bot Trap Resilience:** Defeats anti-automation barriers that reject `isTrusted: false` synthetic events.
- **Selective Fallback:** Falls back to safe DOM dispatch on restricted internal schemes (`chrome://`) or native `<select>` dropdown controls.
- **Focus Emulation:** Emulates tab window focus state across background tasks, preventing pages from throttling inactive tabs.

### 2. Viewport-Ordered Perception Pipeline
Passing raw HTML or massive DOM trees to LLMs quickly saturates prompt budgets and pollutes context.
- **Semantic Compression (`DOMCompressor`):** Extracts an accessibility-oriented snapshot ordered by visual viewport coordinates.
- **Stable References:** Generates ephemeral integer reference IDs for interactive controls (`[12]`) that survive DOM reflows.
- **Deterministic Off-Screen Matching (`find_element`):** Employs weighted heuristic scoring across text, ARIA attributes, placeholders, names, and roles to resolve targets located beyond the active scroll window.
- **Embedded Frame Agent (`frameAgent`):** Injects dedicated frame agents across nested cross-origin iframes, computing absolute coordinate offsets and boundary masks.

### 3. Code-Enforced Safety Gates
The safety rules that matter are enforced in code, not only in the model's prompt.
- **Sensitive-Field Redaction:** Password, payment-card and one-time-code fields are classified on every read. Their values never enter the element list, the effect probe or a tool result; a populated masked field is reported only as "populated".
- **Typing and Clicking Refusal:** The dispatcher refuses, before any input is sent, a click or a type whose target resolves to a masked field.
- **Action-Bound Confirmation:** A click or a submitting type that targets a checkout/payment/destructive control, a form holding masked fields, or a cross-origin form action pauses the run with a confirmation card bound to the exact tool, arguments, tab and origin. The action dispatches only on an explicit approval, re-verified at dispatch time.
- **Bot-Check Refusal:** CAPTCHAs and "verify you are human" controls are never clicked or solved, by element or by coordinate; the run stops and hands the page to the user.
- **Pre-Press Re-Verification (TOCTOU):** Immediately before every mouse press, the point is asked of the page again and the tab's origin is compared with the one the action began on. A page that moved, covered or swapped its content, or navigated away, aborts the click.
- **Background-Fetch Network Policy:** `fetch_url` refuses loopback, private-range, link-local and cloud-metadata addresses, and re-checks the address a redirect landed on before the body is read.
- **Fail-Closed Screenshot Privacy:** Sensitive fields and unreadable cross-origin frames are covered before a capture; a capture whose covers do not verifiably hold is thrown away.

### 4. Heterogeneous Vision Coordinate Reconciliation
Different visual frontier models disagree on coordinate spaces.
Claude and GPT emit absolute pixel coordinates, while Nemotron, Qwen-VL, and Gemini emit normalized 0-1000 per-mille or 0-1 fractional values.
- **Dynamic Tool Schema Rewriting:** Rewrites tool definitions per active provider (`clickToolFor`).
- **Coordinate Space Normalizer:** Detects the model's coordinate convention and applies scale normalization into physical hardware device pixels.
- **Sub-pixel Snapping:** Corrects near-miss clicks within bounding box tolerances before dispatch.

### 5. KV-Cache-Friendly Memory and Compaction
Context exhaustion is managed with architectural awareness of LLM provider prefix caching.
- **Staggered Block Compaction:** Compaction triggers in fixed historical blocks, preserving stable prompt prefixes to maintain provider KV-cache hits.
- **Image Budget Pruning:** Retains only the most recent visual screenshots, dropping historical picture buffers from model payloads.
- **Untrusted Content Envelopes:** Wraps all extracted web content and external search outputs inside strict untrusted demarcation blocks to mitigate indirect prompt injection attacks.

### 6. Blink-Style Quadratic HTML Protection (`parse5`)
During background research, untrusted external pages can attempt denial-of-service via adversarial tag nesting.
- **Linear Depth Capping:** Flattens HTML nesting exceeding 512 levels using a linear tokenizer pre-pass.
- **Fast WHATWG Compliance:** Guarantees standard WHATWG compliance without leaking attributes or Stimulus/React metadata into model context.

---

## Core Execution Loop

Tarka operates an explicit perception-action loop driven by the Model Context Protocol (MCP):

```
       ┌───────────────────────────────┐
       │   1. Observe Current State    │
       │  (DOMCompressor + FrameAgent) │
       └──────────────┬────────────────┘
                      ▼
       ┌───────────────────────────────┐
       │  2. Reason & Tool Selection   │
       │  (LLM Provider + Context Ring)│
       └──────────────┬────────────────┘
                      ▼
       ┌───────────────────────────────┐
       │  3. Execute via Trusted Path  │
       │    (CDP Hardware Dispatch)    │
       └──────────────┬────────────────┘
                      ▼
       ┌───────────────────────────────┐
       │  4. Probe Effect & Log Record │
       │     (Measured Observation)    │
       └──────────────┬────────────────┘
                      ▼
       ┌───────────────────────────────┐
       │   5. Answer With an Outcome   │
       │  (done / partial / blocked)   │
       └───────────────────────────────┘
```

---

## Real-World Workflows

### Autonomous Multi-Site Sourcing
- Dispatches web research via DuckDuckGo or self-hosted SearXNG instances.
- Paginates large web documents cleanly through background workers without navigating the user's primary tab.
- Reconciles conflicting information across tabs into structured, typed markdown tables.

### Deep Application Workflows
- Interacts with single-page applications, custom design systems, shadow DOMs, and nested frame architectures.
- Performs multi-step form completion, table sorting, keyboard navigation, and file preview extraction.

### Resumable Long-Horizon Tasks
- Saves task states and session snapshots incrementally in local extension storage.
- Allows users to pause, inspect DOM steps, and resume task execution seamlessly.
- A bot check or a login the agent must not touch pauses the run for the user, by design.

---

## Supported Model Infrastructure

Tarka supports any OpenAI-compatible API format, as well as native integrations, all called over direct HTTP fetch.

The model picker fetches the live list from the provider you configure. The column below is the fallback list the picker shows when that fetch fails or answers nothing (`getFallbackModels` in `src/background/llm/models.ts`); a user-added endpoint falls back to the model ids you saved for it.

| Provider | Runtime Mode | Fallback model list |
| --- | --- | --- |
| **Ollama** | Local / Offline | `qwen3.8:27b-mlx`, `qwen2.5:14b`, `llama3.1:8b`, `gemma2:9b` |
| **Google Gemini** | Cloud API | `gemini-2.0-flash`, `gemini-2.0-flash-lite`, `gemini-1.5-flash`, `gemini-1.5-pro`, `gemini-2.0-pro-exp-02-05`, `gemini-1.5-flash-8b` |
| **Anthropic** | Cloud API | `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022` |
| **OpenAI / OpenAI-compatible** | Cloud API (Groq is the compatible default) | `gpt-4o`, `gpt-4o-mini`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` |
| **NVIDIA NIM** | Enterprise / Cloud | `meta/llama-3.3-70b-instruct`, `deepseek-ai/deepseek-r1`, `nvidia/llama-3.1-nemotron-70b-instruct`, `meta/llama-3.1-405b-instruct`, `mistralai/mixtral-8x22b-instruct`, `qwen/qwen2.5-72b-instruct`, `nvidia/nemotron-4-340b-instruct` |
| **OpenRouter** | Multi-Provider Gateway | `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.3-70b-instruct`, `google/gemini-2.0-flash-001`, `deepseek/deepseek-r1`, `deepseek/deepseek-chat`, `openai/gpt-4o-mini` |
| **AgentRouter** | Multi-Provider Gateway | `claude-3-5-sonnet`, `gpt-4o`, `deepseek-r1`, `llama-3.3-70b`, `claude-3-haiku` |
| **Custom Endpoints** | Local or Hosted | The model ids you save in the "Custom model API" dialog (self-hosted vLLM, SGLang, LISA, or custom proxies) |

---

## Installation & Development Setup

### Requirements
- Google Chrome (or modern Chromium equivalent).
- Node.js 22.18 or higher.
- npm.

### Quickstart

1. **Clone the repository:**
   ```bash
   git clone https://github.com/preetdhanani/Tarka_browser_agent.git
   cd Tarka_browser_agent
   ```

2. **Install dependencies:**
   ```bash
   npm ci
   ```

3. **Build the extension:**
   ```bash
   npm run build
   ```

4. **Load into Google Chrome:**
   - Open Chrome and navigate to `chrome://extensions`.
   - Toggle **Developer mode** in the top right.
   - Click **Load unpacked**.
   - Select the `dist/` directory generated by the build.

5. **Open Side Panel:**
   - Click the Tarka icon in Chrome's toolbar to launch the Side Panel.
   - Open **Settings**, configure your desired LLM endpoint, and begin.

---

## Security Model

The full threat model and the reporting process live in [SECURITY.md](SECURITY.md). The short version:

- **Zero Remote Code Execution:** Built strictly under Chrome MV3 CSP, with a build-time scan for `eval` and `Function`.
- **Sensitive Fields Never Leave the Page as Text:** Password, card and one-time-code fields are redacted in the element list and the effect probe, refused for clicks and typing, and masked in screenshots before the picture leaves the browser.
- **Risky Actions Ask First:** A click or submit that can pay, order or destroy asks the user on a card bound to the exact action; a declined action is never retried or worked around.
- **Prompt Injection Containment:** External page content and search results are demarcated inside untrusted boundary tags, and the gates above hold even when a page talks the model into something.
- **No CAPTCHA Tampering:** Refuses automated bot bypasses, pausing execution for human intervention.
- **Background Fetch Network Policy:** `fetch_url` cannot reach loopback, private networks or cloud metadata endpoints, and re-checks redirect destinations.
- **Honest Transport:** Requests identify themselves as Tarka; no other client's User-Agent is spoofed. A key-bearing custom endpoint over plain http is refused unless the host is loopback or the user opts in explicitly.
- **Device-Local Data Ownership:** Session histories, logs and API credentials are kept strictly inside local browser storage, and log content is redacted before it is persisted.

---

## Contributing

We welcome contributions from systems engineers, browser automation specialists, and AI researchers.
Please review:
- [CONTRIBUTING.md](CONTRIBUTING.md) for code submission standards.
- [DEVELOPMENT.md](DEVELOPMENT.md) for complete architecture, debugging, and bundle analysis guidelines.
- [AGENTS.md](AGENTS.md) for verification and testing requirements.

---

## License

Tarka AI Browser Agent is open-source software licensed under the [MIT License](LICENSE).
