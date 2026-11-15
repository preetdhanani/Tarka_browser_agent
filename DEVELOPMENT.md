# 🛠️ Development & Chrome Publishing Guide

> Developer guidelines for building, testing, and submitting **Tarka AI Browser Agent** to the Chrome Web Store.

---

## 1. Local Development Workflow

### Setup
You need Node.js 22.18 or newer and Chrome.
Follow **Quick Setup** in [README.md](README.md): `npm ci`, `npm run build`, then **Load unpacked** on the `dist/` folder (not the repository folder).

### Extension Reloading
Chrome runs the built files in `dist/`, not the sources, so build again after every code change.
When modifying background scripts, content scripts, or sidepanel UI:
1. Run `npm run build`.
2. Go to `chrome://extensions`.
3. Locate **Tarka AI Browser Agent** (the `name` field in `public/manifest.json`).
4. Click the **Reload (🔄)** icon on the extension card.
5. If testing content script DOM changes, refresh the target web page tab as well.

**Which build is loaded?**
The loaded extension is whatever was last built AND reloaded, which is not always what is in the editor.
Every build carries a stamp (the build time and the git short hash, with `-dirty` when `git status` shows anything, untracked files included; `no-git` when git is missing or does not answer within 5 seconds).
It is printed in the Logs tab on the `[WORKER_BOOT]` line and on every `[NEW_SESSION_RUN]` line, so a pasted log shows which build ran.
If the build time is older than your last edit, the extension was not rebuilt or not reloaded.
With nothing committed, `-dirty` is the same for every build, so the time is what tells builds apart.

### Scripts
| Script | What it does |
| --- | --- |
| `npm run build` | Builds the extension into `dist/` with Vite, then checks that `dist/` can be loaded (manifest paths, one-file worker, classic content scripts, that every function passed to `executeScript({ func })` uses only its own names and page globals, reserved `_` names, page references). Any bundler warning that is not on the short list in `vite.config.mjs` fails it. It prints the size of every file, raw and gzip. |
| `npm run check` | Runs `node --check` on the plain JavaScript source files the script globs (`content/*.js`, `sidepanel/*.js`, 7 files today). The `.ts` files are covered by `typecheck`. |
| `npm run typecheck` | Runs `tsc --noEmit` three times (TypeScript 7): over `src/` with `tsconfig.json`, over the content scripts with `src/content/tsconfig.json`, and over the tests, their helpers and `src/` again with `tests/tsconfig.json`. |
| `npm test` | Runs the unit tests (`tests/**/*.test.js` and `tests/**/*.test.ts`) with `node --test`, no browser and no build step needed: Node runs the `.ts` files by stripping their types. |
| `npm run evalscan` | Fails when `dist/` calls `eval`, `new Function` or `Function()` (hits are allowed only through the 4 library entries of `ALLOWLIST` in `scripts/evalscan.mjs`, see "Worker Bundle and CSP" in section 3), so run `npm run build` first. |
| `npm run zip` | Zips the contents of `dist/` into `tarka-chrome-extension.zip` in the repository root, without sourcemaps, so run `npm run build` first. |
| `npm run test:e2e` | Builds, then runs the real-model tasks in Chromium on LISA (`lisa-pro`, an OpenAI-compatible custom endpoint the run adds through the "Custom model API" dialog): the open-web tasks start on a neutral page with only a question, and the model picks and opens the real websites itself; five more run on local fixture pages (`notebook.html`, `credentials.html`, `cookie-banner.html`). Needs `LISA_API_KEY` in the shell or `LISA_API` in the repo `.env` (one-time setup, see "E2E Smoke" in section 3). Add `-- --held-out` for the held-out tasks, `-- --sealed` for the sealed ones, or `-- --provider=nvidia` for NVIDIA NIM. |

### CI
`.github/workflows/ci.yml` runs on every push to `main` or `dev` and on every pull request into them, on Node 22.x.
It runs `npm ci`, `npm run check`, `npm run typecheck`, `npm test`, `npm run check:tests`, `npm run build`, `npm run evalscan` and `npm run zip`.
On a push, the Node 22.x run uploads the zip as the `tarka-chrome-extension` artifact.
Flaky tests are fixed, never retried.

---

## 2. Testing Extension Logic

### Service Worker Logs
To inspect background service worker output:
1. Navigate to `chrome://extensions`.
2. Find the Tarka AI Browser Agent extension.
3. Click **service worker** link under "Inspect views".
4. Developer Tools console will open for the background worker.

The worker is one bundled file, `background/sw.js`, built from `src/background/background.ts` and the modules it imports (the runner, the MCP client and server, the LLM calls, the browser layer).
DevTools shows `background/sw.js`.
The code is not minified, so it stays readable, and the `//#region` comments in it name the original source file of most parts.
It measured 769 KB raw and 204 KB gzip on 2026-11-15, and the build prints the size of every file, raw and gzip, so the numbers of the current build are in its log.
The build also writes sourcemaps next to the files (`sourcemap: 'hidden'`), but they are kept only for `npm run evalscan`, which uses them to name the original file and line of a hit.
The built files have no `sourceMappingURL` line and the zip has no maps, so DevTools does not load them and debugging works on the built code.

### SidePanel UI Logs
Right-click anywhere inside the SidePanel UI and select **Inspect** to open DevTools for `sidepanel.html`.

---

## 3. Running the Automated Test Suite

### Test Suite
Run the full suite with:
```bash
npm test
```
This runs `node --test` on `tests/**/*.test.js` and `tests/**/*.test.ts`.
None of it needs a real browser.
The size of the suite is pinned by a floor (`tests/test-count-floor.json`): `npm run check:tests` fails when the count drops below it, and CI runs that check on every push, so a refactor cannot quietly delete tests.

### Syntax Check
```bash
npm run check
```
Runs `node --check` across the plain JavaScript source files the script globs (`content/*.js`, `sidepanel/*.js`, 7 files today), catching a syntax error before it ever reaches a browser reload.

### Type Check
```bash
npm run typecheck
```
Runs `tsc --noEmit` in three projects.
`tsconfig.json` covers `src/` except `src/content`, the worker-side code of the extension.
It runs in the MV3 service worker, so it has the WebWorker lib and the `chrome` types, and nothing from Node or from a page: `Buffer`, `process`, `NodeJS.Timeout` and `document` do not compile there.
`src/content/tsconfig.json` covers the content scripts with the `DOM` lib and the `chrome` types, and without the Node globals or the WebWorker-only APIs.
`tests/tsconfig.json` extends the root project for the tests, the test helpers and the Node scripts, which run in Node, and adds the `node` types.
It also adds the `DOM` lib alongside `WebWorker` on purpose: content-script code and its tests (`domCompressor.ts`, the action executor, the cursor overlay) use `document`, `HTMLElement` and friends, so the DOM types must compile somewhere the tests can see them.
The tradeoff to know: a worker-side test that accidentally uses `document` or `window` now typechecks but is `undefined` at runtime in Node.

TypeScript files use erasable syntax only (no `enum`, `namespace` or constructor parameter properties) and explicit `.ts` extensions in imports, because Node runs them directly by stripping types.
Nothing in `tsc` or Vite enforces the extensions (they accept `./name` and `./name.js` for `name.ts`, and Node does not), so `tests/importSpecifiers.test.ts` reads every relative import and fails when it names a file that is not there exactly as written.

### LLM Providers
Every provider call is a native `fetch` built for that one call: there is no LangChain and no vendor SDK (`src/background/llm/factory.ts`).
A call object (`ProviderCall`) is built per request and dropped after it, so nothing about a call (its key, its base URL, its abort signal) can leak into the next one, and the settings are read again each time.
`temperature` is `settings.temperature ?? 0.1`, and `stream: false` everywhere except Gemini, which streams SSE so a Pause or Stop really cuts the request.
OpenRouter, OpenAI, OpenAI-compatible servers (Groq is the default base URL of `openai_compatible`), and NVIDIA NIM (`integrate.api.nvidia.com/v1`, Bearer `nvapi-...` tokens) share the OpenAI `/chat/completions` shape in `openaiFamilyCall`.
Anthropic is `anthropicCall` on `api.anthropic.com/v1/messages` (`x-api-key`, `anthropic-version`, `anthropic-dangerous-direct-browser-access`).
Gemini is `geminiCall` on `generativelanguage.googleapis.com/v1beta` (`streamGenerateContent?alt=sse`, the key in the `x-goog-api-key` header), and the SSE lines are joined into one text.
Ollama is `ollama.ts`, a native `/api/chat` call: the action or plan schema goes out as `format`, with `think:false`, `num_ctx` (the effective context window) and `num_predict`.
It keeps the two fallbacks, a model that rejects `think` and a server older than 0.5 that rejects a schema, and each is remembered for the life of the worker.
Ollama always streams, and its own abort is broken, so its fetch is wrapped to carry the call's signal.
AgentRouter is `agentRouter.ts`: `/v1/messages` (the Anthropic format) first, and `/v1/chat/completions` when the first fails in a way another endpoint might not, or answers 200 with no text.
A 401, an `unauthorized_client_error` body, an abort and a network error do not fall back, and the first error is logged.
Every AgentRouter request carries the CLI wire image (`agentRouterHeaders` in `models.ts`), because the gateway only lets requests through that look like the Claude CLI.
The requests identify themselves as Tarka: no other client's User-Agent is spoofed, and there is no declarativeNetRequest rule behind it any more.
`deadline.ts` gives every call a deadline (`llmTimeoutMs`) and joins it with the task's abort signal, so a timeout, Pause and Stop really cancel the request.
Pause and Stop abort with a reason tagged `{ tarka: 'user' }`, and that tag, never the text of an error, tells them from a timeout.
NVIDIA NIM defaults to a 300s timeout (`DEFAULT_NVIDIA_LLM_TIMEOUT_MS`) to handle cold-start and queue latency on hosted 70B+ models, while other providers default to 120s.
`errors.ts` keeps the user-facing error texts, `models.ts` keeps the model lists and their cache, and API keys are taken out of every error text.
Every provider call keeps the raw text of a failed reply for its error text and tells "nobody answered" from "the client could not read the answer".
The second is an `UnreadableReplyError` with the status of the answer, so a 200 that is no chat reply reads `API Error (200): not a chat reply: <what the server said>` and not an internal TypeError.
The key is scrubbed out of an error body before it is surfaced, and Gemini's error is scrubbed where the request is made.
The custom endpoints do it through the shared `watchFetch` (`factory.ts`), which also refuses a redirect that leaves the endpoint's origin.
`tests/llm/keys.test.ts` runs every provider against a server that echoes its headers, and `tests/helpers/llmWire.ts` is the fetch spy the provider tests capture requests with.
A user-added endpoint (the panel's "Custom model API" dialog) is a provider too: its descriptor (`id`, display name, protocol, base URL, saved model list) lives in `settings.customProviders` and its credential in `providerConfigs[id].apiKey`, like every credential.
`createCustomProviderCall` (`factory.ts`) builds the call by the descriptor's protocol - OpenAI on `{base}/chat/completions` (with a `/responses` retry when the server says it only speaks the Responses API) or Anthropic on `{base}/v1/messages` - behind the same `watchFetch` as the built-ins, with error texts that name the provider, the protocol and the URL host and never the key.
A key-bearing custom endpoint over plain http is refused unless the host is loopback or the user opted in for that server (`allowInsecureHttp` on the provider's descriptor), on the completion path and on the tool path alike (`assertSecureCustomTransport`).
The URL rules (`customChatUrl`, `customModelsUrl`, and the two normalizers in `llm/settings.ts`) are shared by the sender and by the form's live preview, so the preview cannot disagree with what is sent; they strip a pasted endpoint path (`/chat/completions`, `/messages`, `/models`), add `/v1` only to a bare host, and never rewrite a custom mount.
A provider the code does not know gets no model list: `getFallbackModels` answers `[]` for it, so a custom endpoint falls back to the list its user saved (which may be empty).
Changing the host of a saved provider clears its stored key at save time (the origin rule in `saveCustomProvider`), because nothing stored may be sent to a host the user did not choose.

### Worker Bundle and CSP
The worker bundle measured 769 KB raw and 204 KB gzip on 2026-11-15.
The build prints the size of every file, raw and gzip, and CI runs the build, so a jump in the worker shows in the log.
Minify stays off, and `vite.config.mjs` has the reasons that do not depend on a size: the readable `dist/`, and the `//#region` comments that name the original file of every part.

The extension CSP (`script-src 'self'`) forbids `eval` and `new Function`, and Chromium reports even a caught `new Function('')` as a CSP violation.
No dependency that ships in the bundles probes them (zod, which did, is gone from the dependencies), and `npm run evalscan` fails the build on any hit, so a dependency that would probe shows up before it ships.
The smoke test watches the worker's CSP violations too, which Chromium reports only to the CDP Audits domain and not as a console message.

`npm run evalscan` reads the map of a built file from `<file>.map` only, and refuses a built file that ends in a `sourceMappingURL` comment, because the build writes hidden maps and a string of our own code must not be able to name a map.
`ALLOWLIST` in `scripts/evalscan.mjs` is empty, so every hit fails the scan and no entry can hide a hit anywhere, and `tests/evalscan.test.js` pins that.
The `execute_js` action and its `new Function` are gone, so no entry names our own code, and one must never be added.
A library entry needs a reason and the version that was read; versions are exact pins, so a changed line fails loudly.
A fresh build scans with 0 hits.

The build also fails on every bundler warning that is not on a short list.
The list is empty today: the provider calls are native fetch, and no bundled library imports a Node built-in any more, so every externalized-built-in warning fails the build.
Warnings are recorded and the build fails after the pass, because a throw from the bundler's `onLog` is swallowed for a warning of a plugin (the build used to exit 0 for a new `import fs from 'node:fs'`).
`tests/buildWarnings.test.js` covers the gate.

Chrome only wakes a worker for the listeners that were registered in the first run of the script.
All ten `chrome.*` listeners of `src/background/background.ts` (tabs, tabGroups, action, runtime connect and message, alarms, storage) are registered at the top level of the module, outside any handler, which is what that rule asks for.

The worker's `unhandledrejection` handler ignores exactly the Gemini stream-cut error texts (`src/background/boot/rejections.ts`) and logs every other one as an error.

### Finishing a run
The model ends a run with the `finish` tool, and the finish must say how it went: `outcome` is `done` when the task was done, `partial` when only part of it was done or the answer could not be checked, and `blocked` when the run could not go on (`src/background/mcp/client.ts`).
A finish without an outcome does not end the run: the model is asked again (`FINISH_OUTCOME_TEXT`), and at the step limit such a finish ends the run as `partial`.
A finish that hands over a table must shape it as `{ columns: string[], rows: string[][] }`; a malformed table is refused with an error the model is asked again with (`finishTableOf` in `src/background/mcp/server.ts`).
The files a finish hands over are validated too: `records_file` writes the run's `save_data` records to a `.json` or `.csv` file, and the model-written `files` are at most 3 files and 20,000 characters in all, with plain names and valid JSON where JSON is promised.
A run that answers in plain text after it has taken steps is asked once to call `finish` with an outcome (`TEXT_ANSWER_TEXT`); a second text reply ends the run as before.
The step limit and two stalled rounds in a row force a finish-only round: the model may only call `finish`, and a run that still does not ends as `partial` with what it found.
The panel renders the outcome on the finish card: a green Done for `done`, "Partly done" for `partial`, "Could not finish" for `blocked`, a red Failed card when a step of the run failed.
There is no answer audit any more: what keeps an answer honest is the outcome the model must name and the prompt rules that tell it to say what it did not check, not a gate that rewrites answers.

### Effort: the model's reasoning level
Effort sets how hard the model thinks, never how many steps a run takes (that is `maxSteps`).
`src/background/llm/effort.ts` maps one level (`auto`, `off`, `low`, `medium`, `high`, `max`) onto each provider's own request fields.
It resolves what a model takes in this order: a custom endpoint takes nothing; a model that refused the fields at run time takes nothing; what the endpoint reported wins (OpenRouter `supported_parameters` and `reasoning.supported_efforts`, Gemini `thinking`, Anthropic `capabilities`, Ollama `capabilities` and `thinking.values`); then the built-in list of model families.
Discovery is kept in `chrome.storage.local` under `effort_capabilities`.
The tool calls in `src/background/llm/index.ts` apply the fields, and a 400 that refuses one is sent again without it, or with a value from the "expected one of" list of the error.
The tool loop (`src/background/mcp/client.ts`) sends the chosen level on the first round, after a failed tool and at the step limit, and one level less on routine rounds unless `effortAdaptive` is false.
Each "Model call" log event carries the effort as chosen and as sent, and the model's reasoning text when the provider returns it.
The side panel asks `GET_EFFORT_SUPPORT` whenever the model changes and offers only the supported levels.
Tests: `tests/llm/effort.test.ts`, and the effort wire check of `tests/e2e/smoke.mjs`.

The loop keeps the model useful without a graph engine: a tool block whose steps changed nothing on the page earns a reflection note that asks for a different approach or an honest finish (`REFLECTION_TEXT` in `src/background/mcp/progress.ts`), steps that bring no new data and finish no plan step earn a stall note, and a second stall in a row starts a finish-only round that ends the run with what it has.
There is no orchestrator, no replanning and no per-site budget any more: one runner per tab drives one tool loop from the first step to the finish.

### Side Panel Cards
The side panel renders a run as cards in one timeline (`sidepanel/sidepanel.js`, `sidepanel/cards.js`):
- **Action Confirmation Card (`sidepanel/cards.js`)**: renders when a gated action waits for the user.
  It shows a variant tag (`purchase` or `submit`), the action summary with its target, the page and origin the action is bound to, an optional "Remember domain" checkbox, and Confirm/Deny buttons.
  The gate that raises it is code, in `src/background/mcp/server.ts` (`sensitiveActionDecision`): a masked field is refused outright, a high-risk label (pay, purchase, checkout, delete account and friends) asks, a submit control of a form that holds masked fields or sends to another host asks, and a declined action is refused to the model (`CONFIRM_DECLINED_TEXT`), never retried.
- **Plan Approval Card (`sidepanel/sidepanel.js`)**: the renderer exists, but a normal run never shows it: every task starts with `autoApprove:true`, so the runner approves the plan in code.
  Only a direct `START_TASK` with `autoApprove:false` (tests, tools) still holds, and the panel's approval mode setting (auto by default) sends that flag.
- **Finish Card**: the card at the end of a turn.
  Its title follows the outcome the model named (`done`, `partial`, `blocked`), a failed step turns it red, and a compact runStats line (model calls, steps, tokens in and out) sits with it.
- **Partial Card**: the card of a run that ended before it finished (a Stop, the step cap, a blocked site, a worker restart).
  It is never "Done" and never gets the complete icon: the subtitle says why the run ended, and a stopped or interrupted run gets a Resume button that sends "Resume the unfinished task." like a typed prompt.
- **Studio Mono Theme (`sidepanel/sidepanel.css`)**: monospace typography and status indicators, using the `--surface` variable for hover and active states.
- **Settings**: model and provider, context window, step limit (up to 1,000), delay, Ollama num_predict, LLM timeout, the default effort, and whether routine steps think one level less (`effortAdaptive`).
  There are no planner or reflect model overrides: the agent plans and acts with the same model.
- **Message Dispatch**: `src/background/background.ts` handles `CONFIRM_ACTION` and `APPROVE_PLAN` from the side panel, forwarding the decision into the runner.
Tests in `tests/sidepanel/cards.test.js` cover the card HTML rendering and event handlers.

### Test Approach
`chrome.*` APIs are hand-mocked per test file, not a real browser.
New tests should use the shared fakes described under "Test Helpers" instead of a new hand-made mock.
Whole runs are driven through the real background code: `tests/helpers/routerRig.ts` loads the router over fakeChrome and injects a scripted model at the fetch layer (the provider's own wire format, OpenAI-shaped tool calls), so a test starts a task with START_TASK and reads what the panel was shown, without the network.

### Test Helpers
The shared fakes in `tests/helpers/` are for new tests:
- `fakeChrome.ts` builds the `chrome.*` surface (tabs, tabGroups, windows, storage, runtime, sidePanel, scripting, debugger, alarms and more).
  You declare only what a test needs, and touching any other API throws, so a missing API cannot give a false green.
- `fakeStorageSession.ts` fakes `chrome.storage.session` and `chrome.storage.local`, with byte counting and quota errors.
  A service worker restart in a test is a new connection to the same store.
- `fakeLlm.ts` is a scripted model.
  A script is a list of replies (a string, or `{ text, reasoning, delayMs, error }`, or a function that answers by what the model was shown).
  `generateCompletion` returns them in order, `install()` puts it in place of the real client, and every call is recorded with its settings, messages, schema and how it ended (`text`, `error` or `aborted`).
  An abort rejects the way `fetch` does, and a script that runs out throws.
  `port()` is the runner's `LlmPort` seam (`src/background/runner/runtimeRegistry.ts`): per-node queues answer a call by the node that made it, and an empty queue is a test mistake, never a silent fall-through.
- `routerRig.ts` is the whole background router in Node: fakeChrome underneath, a panel port, a `send()` round trip, the icon click, and the scripted model of `fakeLlm` injected through `runtimeRegistry`.
  `shopPages.ts` holds the small shop the rig's examples run on.
- `llmWire.ts` is a fetch spy for the provider tests.
  `spyFetch(t)` replaces `globalThis.fetch` until the test ends and records every request as it was built (URL, lower-case headers, parsed JSON body, signal).
  It answers with a real `Response` in the wire format of the endpoint (`textReply`, and `ollamaReply` for what Ollama streams), or with what the test returns (`jsonResponse`, an HTTP error, a fetch that never answers).
- `slowServer.ts` is a local HTTP server that answers late or never (or sends the first piece of a streamed reply and stalls), and remembers whether the client hung up first.
  That is the proof that a request was really cancelled and not only abandoned.
  `redirectFetch` sends the fixed hosts of Anthropic and Gemini to it.
- `fakeDom.ts` builds page snapshots and a fake content script from a small description of a site.
  `pageSnapshot(page)` is what `content/domCompressor.js` returns, and `fakeDom({ pages }).attach(fc, tabId)` answers `GET_DOM_SNAPSHOT` and `EXECUTE_ACTION` for the page the tab is on: clicks, typing, scrolling, links that open pages, and the other verbs of the content script except `browser_batch` and typing into a `<select>`, which throw so a test can script them.

The older tests were not moved to these helpers.
The helpers have their own tests: `tests/fakeChrome.test.js`, `tests/fakeStorageSession.test.js` and `tests/fakeDom.test.ts`.
`fakeDom` is pinned to the real content scripts there: the same page description must give exactly what the real `DOMCompressor` returns and the same reply as the real `doType`, `doScroll` and `doPressKey`.
The helpers are TypeScript files, and Node runs them directly through type stripping, which is on by default from Node 22.18.
Tests need no build step.

### E2E Smoke
The E2E smoke test loads the built extension (`dist/`) into Chromium and runs tasks with a real model through the real background code: the open-web tasks start on a neutral page with only a question, and five run on local fixture pages the harness serves from `tests/fixtures/site`.
There is no offline mock model: the run talks to a real endpoint, LISA by default (`lisa-pro`, an OpenAI-compatible custom endpoint), or NVIDIA NIM or a local Ollama with `--provider`.
It is not part of `npm test`.

One-time setup:
```bash
(cd tests/e2e && npm ci)
```
You also need a Chromium binary, because branded Chrome ignores `--load-extension`.
Set `CHROMIUM_PATH` if it is not at the macOS default (`/Applications/Chromium.app/Contents/MacOS/Chromium`).

Run (on LISA, with your key in the shell or as `LISA_API` in the repo `.env`):
```bash
export LISA_API_KEY=...
npm run test:e2e
```
The key stays in the harness: a local proxy adds it to each request, and the extension only holds a placeholder.
It builds first, runs the tasks, and ends with `SMOKE PASSED` or `SMOKE FAILED`.
It fails on a console error or an exception in the worker, on a CSP violation in the worker or in the side panel, and on an error on a fixture page.
See [tests/e2e/README.md](tests/e2e/README.md) for all options and what a run checks.
CI does not run it: it needs a model key.

---

## 4. Chrome Web Store Publishing Checklist

Before packaging for the Chrome Web Store:
1. **Manifest V3 Verification**: Ensure `"manifest_version": 3` in `public/manifest.json`.
2. **Permissions Audit**: `public/manifest.json` currently requests `sidePanel`, `scripting`, `storage`, `tabs`, `tabGroups`, `alarms`, and `debugger`, plus `host_permissions: ["<all_urls>"]`.
   Confirm each is still used before submitting.
   Store reviewers question `<all_urls>` and `debugger` most often, so have a justification ready for them.
   The `debugger` permission is required for real clicks via Chrome DevTools Protocol (CDP Input events).
3. **Icons Audit**: Ensure `icon16.png`, `icon48.png`, and `icon128.png` are present in `public/icons/`.
   The build copies them into `dist/icons/`.
   The icons are the project's own brand mark, the yantra that `sidepanel/brand.js` also draws in the panel, and the manifest points at them twice: in `icons` and in `action.default_icon` (the toolbar button).
   `scripts/build.mjs` validates both.
4. **Eval Scan**: Run `npm run build && npm run evalscan`.
   The extension's Content Security Policy blocks `eval`, `new Function` and `Function()`, so the scan fails on any call to them in `dist/`.
   Hits are allowed only through the 4 entries of `ALLOWLIST` in `scripts/evalscan.mjs`, listed in "Worker Bundle and CSP" in section 3.
   Every entry names a file under `node_modules/`, so a hit in our own code can never be allowed, and the current bundle produces no hit at all.
5. **Create Zip Package**:
   ```bash
   npm run build && npm run zip
   ```
   This writes `tarka-chrome-extension.zip` in the repository root.
   It holds the contents of `dist/`, with `manifest.json` at the root of the zip, and no sourcemaps.
6. Upload `tarka-chrome-extension.zip` to [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).

---

## 5. Build Foundation and What Comes Next

> Status: the extension is the MCP tool loop with the confirmation gate, built on the shared TypeScript core.
> See section 3 of [PRD.md](PRD.md) for architecture and roadmap details.

What is true today:
- `npm run build` bundles the extension with Vite into `dist/`, and you load `dist/` unpacked in `chrome://extensions`, not the repository folder.
- The manifest and the icons live in `public/`, and the build copies them into `dist/`.
- `public/manifest.json` requests the `debugger` permission for real CDP input events.
  During a task, Chrome shows a yellow "is debugging this browser" bar, which is expected.
- The shared core, the provider calls, the input dispatcher and the runner in `src/` are TypeScript.
- The agent is the MCP tool loop: `AgentRunner` (one per tab) drives `TarkaMCPClient`, which calls the model over native fetch (`src/background/llm/factory.ts` and its provider modules) and executes the chosen tools through `TarkaMCPServer` and the browser layer.
- There is no graph engine, no legacy engine, and no answer-audit gate any more; a run ends with the `finish` tool and its `done` / `partial` / `blocked` outcome.
- The content scripts and the side panel are plain JavaScript ES modules.
- CI zips the built `dist/`, not the raw source folders.

Planned, not built yet:
- The content scripts and the side panel move to TypeScript in later phases.
- Real-site benchmark evaluation and additional multi-turn recovery strategies for the tool loop.
