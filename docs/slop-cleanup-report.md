# Tarka slop cleanup report

## Status

- Phase 0 and Phase 1 are complete, and Phase 2 is incomplete because the stylesheet cleanup and LLM cleanup were reverted after their required checks failed twice.
- Phases 3, 4, and 5 were not started because Phase 2 is not green.
- The Phase 1 to 5 plan is in `docs/slop-cleanup-plan.md` and was independently reviewed before execution.
- The baseline `npm run verify` passed after retrying with permission for the local test listener; the first sandboxed attempt was blocked by `listen EPERM`.

## Phase 0 metrics

- Comment counts include `.ts`, `.js`, `.mjs`, `.css`, and `.html` files under the listed directories; type and timer counts use script sources, and largest-file sizes use `.ts`, `.js`, `.mjs`, and `.css` files.
- Before counts use the Phase 0 source snapshot, and after counts use the current source tree.

| Metric | Before | After |
| --- | ---: | ---: |
| Comments in `src/` | 2637 | 487 |
| Comments in `sidepanel/` | 647 | 94 |
| Comments in `content/` | 87 | 1 |
| Comments in `scripts/` | 113 | 0 |
| Total comments | 3484 | 582 |
| `: any` | 176 | 176 |
| `: unknown` | 147 | 144 |
| `as` casts | 291 | 289 |
| `as unknown as` casts | 24 | 24 |
| Empty catches | 69 | 69 |
| `setTimeout` outside named timing helpers | 46 | 46 |
| `setInterval` outside named timing helpers | 1 | 1 |
| `requestAnimationFrame` outside named timing helpers | 3 | 3 |
| `TODO` in comments | 0 | 0 |
| `FIXME` in comments | 0 | 0 |
| `HACK` in comments | 0 | 0 |
| `workaround` in comments | 1 | 0 |
| `temporary` in comments | 1 | 0 |
| `for now` in comments | 0 | 0 |

| Largest-file rank | Before | After |
| ---: | --- | --- |
| 1 | `sidepanel/sidepanel.js` 206364 bytes | `sidepanel/sidepanel.js` 149406 bytes |
| 2 | `src/background/mcp/client.ts` 77672 bytes | `sidepanel/sidepanel.css` 73459 bytes |
| 3 | `sidepanel/sidepanel.css` 73459 bytes | `src/background/mcp/client.ts` 55026 bytes |
| 4 | `src/background/browser/input.ts` 61844 bytes | `src/background/browser/input.ts` 44573 bytes |
| 5 | `src/background/mcp/server.ts` 60449 bytes | `src/background/mcp/server.ts` 44144 bytes |
| 6 | `src/background/background.ts` 58617 bytes | `src/background/runner/AgentRunner.ts` 38807 bytes |
| 7 | `src/background/runner/AgentRunner.ts` 55351 bytes | `content/content.js` 38213 bytes |
| 8 | `content/content.js` 47048 bytes | `src/background/llm/index.ts` 34950 bytes |
| 9 | `src/shared/storage.ts` 37283 bytes | `src/background/llm/effort.ts` 33424 bytes |
| 10 | `src/background/llm/index.ts` 34950 bytes | `src/background/background.ts` 29739 bytes |

- The repository has no unused-export or unused-file scanner, so those counts are unmeasured; propose Knip before adding a tool.
- The repository has no duplicate-block scanner, so duplicate counts are unmeasured; propose jscpd before adding a tool.
- Comment retention is 582 of 3484 baseline comments, or about 16.7 percent, so the target of fewer than 1 percent is not met.

## Guardrails and cleanup

- Phase 1 added comment, cast, banned-name, em-dash and CHANGELOG, and raw-timer checks to `npm run verify`.
- A throwaway violation for each new check made `npm run verify` fail, and each violation was removed before a green run.
- The banned-name check reads its protected-name list from `tests/e2e/README.md`, and no such names were added to source.
- Comment-only commits lowered the comment floor in `tests/quality-floor.json` and kept the output check separate from type and code refactors.
- The stylesheet comment cleanup was reverted after two verification failures caused by tests that used comment headings to locate CSS sections.
- A test helper was changed to locate selectors without depending on one comment heading; its assertions were not weakened, and the change remains.
- The LLM comment cleanup was reverted after two real-model cases timed out waiting for the configured provider.
- The latest minified runtime check matched all 6 JavaScript outputs after normalizing only the generated build stamp, and the CSS output matched unchanged.
- The minified Phase 0 JavaScript and CSS files are saved under `/private/tmp/tarka-phase0-minified`, and the source-equivalent Phase 0 build is `/private/tmp/tarka-phase2-start/dist`.
- The repository build output preserves comments and generated build metadata, so raw bundle files and source maps are not byte-identical even when minified runtime code is unchanged.

## Findings

- Line references below refer to the Phase 0 source snapshot because the explanatory comments were removed.
- `src/background/background.ts:290` described an old global panel-disable workaround; the likely root cause was global panel visibility interacting with programmatic opening, and the current per-tab setup already avoids that path.
- `src/background/boot/rejections.ts:4` described an upstream Gemini SDK split-stream rejection after an abort; the existing exact error filter handles it, and no code change was needed.
- `src/background/research/htmlDocument.ts:204` recorded that parse5 8 does not expose declarative shadow-root template content; the suspected root cause is parser support, and the gap remains.
- `src/content/cursor.ts:170` called the visual highlight ring temporary; it is an intended transient effect restored after its timeout, not a temporary code patch.
- `src/background/runner/runnerMeta.ts:76` described a stale-closure bug; current code stores the latest payload and `tests/runner/runnerMeta.test.ts` covers it, so this historical issue is resolved.

## Fragile areas and verification

- `sidepanel/sidepanel.js`, `src/background/runner/AgentRunner.ts`, `src/background/mcp/client.ts`, and `src/shared/storage.ts` received only mechanical comment removal in separate commits, with no restructuring.
- `sidepanel/sidepanel.css` cleanup was reverted; retry only after its tests locate selectors without section comments, and do not restructure the file.
- LLM comments remain after their cleanup was reverted; retry only when the configured real-model provider is available.
- `npm run verify` passed after every retained cleanup commit and after each revert; the stylesheet cleanup commits failed twice before revert.
- The final report commit passed `npm run verify`, with all 8 steps green and 1841 unit tests passing.
- A completed real-model run passed 11 of 11 cases after the storage comment cleanup, and its screenshots were reviewed without visible layout issues.
- The later real-model run timed out on two cases waiting for the configured provider and was stopped; it did not complete, and its cleanup commit was reverted.
- Held-out tasks were not run because no behavior changed, and no sealed task trace was read.
- The latest source tree was compared with the Phase 0 build after minification; only generated build stamps differed, and all non-generated minified JavaScript and CSS output matched.
- Phase 3, Phase 4, and Phase 5 remain unverified because Phase 2 did not finish.
