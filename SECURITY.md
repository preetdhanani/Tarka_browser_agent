# Security Policy

This document describes what Tarka is trusted with, where the trust boundaries are, which defenses are enforced in code, and how to report a vulnerability.

## What Tarka is trusted with

Tarka is an autonomous browser agent that runs inside the user's real browser profile with powerful permissions:

- `debugger` (Chrome DevTools Protocol): trusted hardware-level input events, screenshots, layout reads, on the tabs a run works in.
- `tabs`, `tabGroups`, `scripting`: reading tab state, opening and grouping tabs, injecting the content scripts.
- `<all_urls>` host access: the content scripts and the debugger reach every http(s) page the run visits.
- `storage`: settings, API keys, chat history and logs, in `chrome.storage.local` and `chrome.storage.session`.

The assets this protects: the user's credentials (typed or autofilled), the provider API keys in storage, the privacy of the pages the agent reads, and the integrity of the actions taken in the user's logged-in browser.

## Trust boundaries

```
web page (untrusted)
      |  DOM text, injected instructions, network traffic
      v
content scripts (isolated world)
      |  chrome.runtime messages (extension-origin only)
      v
service worker (privileged: debugger, tabs, storage, fetch)
      |  page text, screenshots, tool results
      v
model provider (external service, user-configured endpoint)
      |  tool calls (model output)
      v
service worker -> back to the page (actions)
```

- Web pages have no direct channel into the extension: there is no `externally_connectable` and no `web_accessible_resources`.
- The side panel and the service worker trust each other (same extension origin).
- The model provider is treated as an untrusted output source: its tool calls pass the same code-enforced gates as everything else.

## Mechanical defenses (enforced in code, covered by tests)

- **Sensitive-field redaction:** password, payment-card and one-time-code fields are classified everywhere they are read. Their values never enter the element list, the effect probe or a tool result; a populated masked field is reported only as populated (`[REDACTED: populated]`).
- **Typing and clicking refusal:** a click or a type whose target resolves to a masked field is refused before any input is dispatched, and a security refusal never falls back to the synthetic DOM path.
- **Action-bound confirmation:** a click or a submitting type that targets a checkout/payment/destructive control, a form holding masked fields, a cross-origin form action, or a form whose submit control carries such a label pauses the run with a confirmation card. The card binds the approval to the tool name, the serialized arguments, the tab, the frame URL, the target origin and the element id. The action dispatches only on an explicit approval of that binding, and remembering an approved origin is an unticked box the user must tick.
- **Pre-press re-verification:** immediately before every mouse press, the point is asked of the page again and the tab's origin is compared with the one the action began on. A mismatch aborts the click.
- **Bot-check refusal:** CAPTCHA and "verify you are human" controls are never clicked, typed into or waited out, by element or by coordinate.
- **Background-fetch network policy:** `fetch_url` refuses loopback, private-range, link-local and cloud-metadata addresses, follows no redirects (so no unchecked address is ever contacted), and sends no cookies or credentials.
- **Restricted pages:** `chrome://`, `file:`, the Web Store and other internal pages are never scripted, screenshotted or attached to with the debugger.
- **Fail-closed screenshot privacy:** sensitive fields and unreadable cross-origin frames are covered before a capture, and a capture whose covers do not verifiably hold is discarded.
- **Prompt-injection containment:** page text, search results and fetched documents are wrapped in untrusted-content envelopes, and every gate above holds regardless of what those envelopes contain.
- **Log redaction:** log messages, log details and model-message previews pass redaction before they are kept in memory or persisted.
- **No remote code:** MV3 CSP, no eval or `Function` in shipped code (build-time scan), no dynamic code loading, no remote scripts in the panel.

## Known limits, stated honestly

- The model's judgment is still a defense layer: the untrusted-content envelope asks the model to treat page text as data. The mechanical gates above are what bounds the damage when a page talks the model into something anyway.
- `fetch_url`'s private-address rule checks host names and IP literals. It cannot resolve DNS, so a public host name that resolves to a private address (DNS rebinding) is out of its reach; an extension has no DNS API, and closing the gap through a third-party resolver would tell that resolver the host of every fetch. It follows no redirects, so nothing but a checked address is contacted.
- API keys are stored in `chrome.storage.local` in plain text, which is the standard for Chrome extensions; anything that can read that storage (malware on the machine, another profile's attacker) can read them.

## Reporting a vulnerability

- Email: use the contact address on the repository's GitHub page (see the repository owner's profile), or open a GitHub Security Advisory on this repository ("Report a vulnerability" on the Security tab).
- Please include: the affected files or paths, a minimal reproduction, and the impact you see. Do not include real credentials or personal data in the report.
- Please do not test against third-party services or real accounts, and do not exfiltrate data from anyone's browser.
- You will get an acknowledgement within 7 days. Fixes are released as soon as possible, and credit is given unless you prefer otherwise.

## What is in scope

- Any way for a web page to trigger privileged actions without the user's confirmation.
- Any path that sends credential values, API keys or unredacted secrets off the device.
- Any way for a page or a model response to bypass the confirmation gate, the masked-field refusals, the bot-check refusal or the network policy.
- The packaging: secrets, harness files or source maps in the shipped zip.

## What is out of scope

- Prompt-injection results that end in a visible refusal, a confirmation card, or an action the user's own task asked for.
- Attacks that require malware already running on the machine with the user's privileges.
- Social engineering of the user (the human is the trust anchor for every confirmation).
