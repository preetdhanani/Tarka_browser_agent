# Agent instructions for Tarka

These rules apply to every agent session in this repository.
A rule marked (enforced) is checked by a test or a script.
When a check blocks you, fix the code, never the check.

## Commands

- Everything cheap, in one command: `npm run verify`.
- Unit tests only: `npm test`. Syntax only: `npm run check`. Types only: `npm run typecheck`. Quality floors only: `npm run quality`.
- Test-count floor: `npm run check:tests`, raise it with `npm run check:tests -- --update`, never lower it.
- Real-model e2e: `npm run test:e2e`.
- Held-out tasks: `npm run test:e2e -- --held-out`. Sealed tasks: `npm run test:e2e -- --sealed`.
- Setup, every flag, the task list and the screenshot names are in `tests/e2e/README.md`. This file does not repeat them.

## Verification (highest priority)

- Nothing lands without a test that can fail.
- A change is accepted only when both layers pass: the unit tests and the real-model Chromium run on a real model.
- Run both layers after every change and fix until both are green. A change is not done while a layer is red.
- A change to `*.md` files only is the one exception: `npm run verify` is enough, the model layer cannot see a sentence.
- Never tune code, prompts or heuristics against held-out or sealed tasks. They are the only evidence the agent generalises.
- Run `-- --held-out` after every change to behaviour, to show it helps in general and not just on the tasks you edited against.
- No code, prompt or heuristic may name a fixture, a task or a test site. A failing task is a finding about the agent, never a reason to special-case the page it runs on (enforced for fixture file names).
- There is no scripted mock model and no tamper run: every e2e task is a real model taking real actions.
- New behaviour gets a unit test, and a real-model task wherever the model can show it (history rows, side panel DOM, screenshots).
- Confirm a new test fails on code that lacks the behaviour, before you call it a check.
- Never read a sealed task's trace, and never run `-- --repeat` unless Prit asks for it.
- Every Chromium run saves screenshots for every test case, both the panel steps and the end state of the page, and the report prints the paths.
- The harness loads `dist/` into a fresh temp Chromium profile and never Prit's personal Chrome.
- Nothing of the harness may reach a user: `tests/e2e/`, `driver.html` and the fixtures stay out of `dist/` and out of the zip. The build self-check fails it and `npm run zip` refuses it (enforced).

## Fixing bugs

- Reproduce first, in a unit test or a real-model task, as close to how a user hits it as possible.
- Fix the root cause. No workarounds, no "temporary" patch, no special case for one input.
- Ask why the code allowed the bug, and close that door, not only this instance.
- When the same kind of mistake happens twice, add a test or a script for it. Do not add a sentence to this file for it.

## No escape hatches

- Never add a lint-disable comment, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `@noEmit`, a skipped test, or `.only(`.
- The ban covers `src/`, `sidepanel/`, `content/` and `scripts/` for the directives, and `*.test.js` / `*.test.ts` for the skip and the focus (enforced).
- The sites that are exempt all suppress a missing declaration for an untyped `.mjs` module. They are named in the guard in `tests/architectureBoundaries.test.ts`, which fails if the list and the code ever disagree. A new one needs a reason.
- Never weaken an assertion or delete a test to turn a run green. Deleting tests trips the floor (enforced).
- `: any` / `: unknown`, an `as` cast and an empty `catch {}` are a ratchet and not a ban: never add one, lower the numbers when you can.
- The floors live in `tests/quality-floor.json`, in one command: `npm run quality`. It counts comments out, and counts a `catch {}` written across lines as one.

## Patterns to copy

- The TypeScript modules under `src/`: small module, one job, types spelled out, a Chrome API behind a narrow helper, a failing test next to it.
- The modules under `src/background/llm/` and `src/background/browser/` are the shape to copy. A new file stays small on its first day, call it 100 lines, and grows by splitting rather than by accretion.
- `sidepanel/sidepanel.js` and `content/content.js` are hand-written plain JS with no module system of their own, bundled into `dist/`. Live code, not legacy, and not the pattern for new code.
- New UI logic goes in a TypeScript module under `src/` with its own test, and `sidepanel/sidepanel.js` only wires it to the DOM. The bundler carries it: that is how the panel already reaches `src/background/llm/settings.ts`. Such an import is a new edge, so name it in the boundary test's allowlist in the same commit.
- Keep changes small and focused. Unrelated cleanup goes in its own commit.

## Contexts (enforced)

- `src/background/`: the MV3 service worker. No page DOM.
- `src/content/`: content scripts in TypeScript, with their own DOM tsconfig. May not import `src/background/` at runtime.
- `src/shared/`: code both sides use. May not import `src/background/`.
- `src/background/` may not import `src/content/` at runtime. `import type` is the legal form, and the boundary test lists the edges that exist.
- `content/` is plain JS too: `content/content.js` is one IIFE with no `import` at all, so it imports nothing by construction. It is not type-checked, because the root tsconfig has no DOM lib and `src/content/tsconfig.json` covers `*.ts` only.
- The UI in `sidepanel/` shares no module with the worker except the one edge in the allowlist. Requests go out over `chrome.runtime.sendMessage` and updates come back over the port from `chrome.runtime.connect`.
- A few edges from `shared/` and `sidepanel/` into `src/background/` stay, named in the allowlist of `tests/architectureBoundaries.test.ts`. A new edge fails that test.
- The content-script file list is declared twice, in `public/manifest.json` and in `src/background/browser/contentFiles.ts`, and both must agree (enforced by `tests/contentFiles.test.ts`).

## Before you finish

1. `npm run verify` is green, and the real-model run is green for anything the model can show.
2. Open the screenshots. If anything looks off, even something unrelated to your task, write it down and fix it in a separate commit.
3. In your final message, state what you verified, and what you could not verify and why.

## Style and housekeeping

- Never use the em dash. Use a plain dash.
- Never manually modify `CHANGELOG.md` or auto-generated files.
- In long Markdown files, put each full sentence on its own line.
- Implementation plans are reviewed by an independent subagent in a separate context before execution.

## Known fragile areas

- `sidepanel/sidepanel.js` and `sidepanel/sidepanel.css`: the whole UI in one file each, so every change lands in the same few thousand lines. Ask before restructuring either.
- `src/background/runner/AgentRunner.ts` and `src/background/mcp/client.ts`: the loop a run lives in. A change here needs a real-model task, not only a unit test.
- `src/shared/storage.ts`: the `local` area holds a user's settings and saved chats, so one bad migration loses them. Touch it with a migration test.
- `chrome.sidePanel.open()` and its gesture rules: the measured facts are in `tests/e2e/README.md`.
- The sealed e2e set: never read a trace, or the set is burned and must be replaced.

## Desktop automation

Use `agent-desktop` to see and operate desktop apps. Before the first use, run
`agent-desktop skills get desktop` and `agent-desktop skills get platform`, and follow them.
