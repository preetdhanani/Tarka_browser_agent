
import { cdp as defaultCdp, CDPManager } from './cdp.ts';
import { describeRestrictedUrl } from './tabs.ts';
import type { ResolvePointResponse } from '../../content/types.ts';
import { Logger } from '../../shared/logger.ts';
import { MASKED_CLICK_REFUSAL, MASKED_TYPE_REFUSAL, BOT_CHECK_PATTERN, HIGH_RISK_ACTION_PATTERN } from '../../shared/safetyPatterns.ts';
import { MASKED_FIELD_KINDS } from '../../shared/maskedFields.ts';
import { TOP_FRAME, FRAME_ANSWER_MS, chromeFramePort, frameIdAtPath, type FramePort } from './frames.ts';
import type { EffectDetail, KeyModifier } from '../types.ts';

export class SecurityRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityRefusal';
  }
}

export function pressKeySubmitRefusal(keyLabel: string): string {
  return `Refused by security policy: pressing ${keyLabel} here would submit a form that holds masked fields, sends the form to another site, or has a submit button whose action needs your confirmation (a payment, an order or an account change). Click the submit button instead: that click is checked and asks the user before anything is submitted.`;
}

export function typeSubmitRefusal(): string {
  return 'Refused by security policy: pressing Enter after this type would submit a form that holds masked fields, sends the form to another site, or has a submit button whose action needs your confirmation (a payment, an order or an account change). Type the text without submitting, then click the submit button instead: that click is checked and asks the user before anything is submitted.';
}

export function frameSubmitRefusal(): string {
  return 'Refused by security policy: the focus is inside an embedded frame, and a form inside it cannot be checked from here (it may hold masked fields or send the data to another site). Enter is not pressed: ask the user to finish this part of the page, and go on outside the frame.';
}

function isFrameFocus(focus: { tag?: string } | null | undefined): boolean {
  const tag = String(focus?.tag || '').toLowerCase();
  return tag === 'iframe' || tag === 'frame';
}

const NON_SUBMITTING_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden']);

function enterSubmitsImplicitly(
  focus: { isSubmitControl?: boolean; tag?: string; inputType?: string } | null | undefined
): boolean {
  if (!focus) return false;
  if (focus.isSubmitControl === true) return true;
  if (focus.tag === 'input') {
    return !NON_SUBMITTING_INPUT_TYPES.has(String(focus.inputType || 'text').toLowerCase());
  }
  return false;
}

function focusFormIsRisky(
  focus: { formHasMaskedField?: boolean; formTarget?: { formActionHost?: string }; formSubmitLabel?: string } | null | undefined,
  pageUrl: string | undefined
): boolean {
  if (!focus) return false;
  if (focus.formHasMaskedField === true) return true;
  if (formTargetsOtherHost(focus.formTarget, pageUrl)) return true;
  const submitLabel = String(focus.formSubmitLabel || '');
  return Boolean(submitLabel) && HIGH_RISK_ACTION_PATTERN.test(submitLabel);
}

function formTargetsOtherHost(formTarget: { formActionHost?: string } | undefined | null, pageUrl: string | undefined): boolean {
  const targetHost = String(formTarget?.formActionHost || '').toLowerCase();
  if (!targetHost) return false;
  let pageHost = '';
  try {
    pageHost = new URL(String(pageUrl || '')).host.toLowerCase();
  } catch (_) {
    return true;
  }
  return targetHost !== pageHost;
}

function originOf(url: string | undefined | null): string {
  if (!url) return '';
  try { return new URL(url).origin; } catch (_) { return ''; }
}

export interface DispatchOptions {
  docId?: string;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal };
}

export const TAB_ANSWER_TIMEOUT_MS = 8000;

function answerDeadlineText(ms: number): string {
  const wait = ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
  return `The page did not answer within ${wait}, so the request was given up. The tab may be busy, hidden or gone: wait a moment, take the page in again (a fresh snapshot) if it stays silent, and then try the action once more.`;
}

export interface DispatchResult {
  success: boolean;
  message?: string;
  error?: string;
  label?: string | null;
  submitted?: boolean;
  result?: unknown;
  results?: unknown;
  via: 'cdp' | 'synthetic' | 'background';
  effect?: string;
  urlAfter?: string;
  stale?: boolean;
  obscuredBy?: string;
  syntheticReason?: string;
  effectDetail?: EffectDetail;
  fieldText?: string | null;
  securityRefusal?: boolean;
}

interface ScrollReading {
  top: number;
  max: number;
  height: number;
  atTop: boolean;
  atBottom: boolean;
}

function pickReading(raw: any): ScrollReading {
  return {
    top: Number(raw?.top) || 0,
    max: Number(raw?.max) || 0,
    height: Number(raw?.height) || 0,
    atTop: raw?.atTop === true,
    atBottom: raw?.atBottom === true
  };
}

interface KeyDefinition {
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
}

const SPECIAL_KEYS: Record<string, KeyDefinition> = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34 },
  PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33 },
  Home: { code: 'Home', windowsVirtualKeyCode: 36 },
  End: { code: 'End', windowsVirtualKeyCode: 35 },
  Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { code: 'Space', windowsVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' }
};

export const SPECIAL_KEY_NAMES = Object.keys(SPECIAL_KEYS);

export const KEY_MODIFIER_BITS: Record<KeyModifier, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

export const SELECT_ALL_KEY = 'select_all';

const KEY_ALIASES: Record<string, string> = { return: 'Enter', esc: 'Escape', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

const PUNCTUATION: Record<string, [string, number]> = {
  '-': ['Minus', 189], '_': ['Minus', 189], '=': ['Equal', 187], '+': ['Equal', 187],
  '[': ['BracketLeft', 219], '{': ['BracketLeft', 219], ']': ['BracketRight', 221], '}': ['BracketRight', 221],
  '\\': ['Backslash', 220], '|': ['Backslash', 220], ';': ['Semicolon', 186], ':': ['Semicolon', 186],
  "'": ['Quote', 222], '"': ['Quote', 222], ',': ['Comma', 188], '<': ['Comma', 188],
  '.': ['Period', 190], '>': ['Period', 190], '/': ['Slash', 191], '?': ['Slash', 191],
  '`': ['Backquote', 192], '~': ['Backquote', 192],
  '!': ['Digit1', 49], '@': ['Digit2', 50], '#': ['Digit3', 51], '$': ['Digit4', 52], '%': ['Digit5', 53],
  '^': ['Digit6', 54], '&': ['Digit7', 55], '*': ['Digit8', 56], '(': ['Digit9', 57], ')': ['Digit0', 48],
  ' ': ['Space', 32]
};

const SHORTCUT_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

export interface ResolvedKey {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  modifiers: number;
  commands?: string[];
  label: string;
}

export const PRESS_KEY_FORMS =
  `a key name (${SPECIAL_KEY_NAMES.join(', ')}), a single printable character such as "a" or "5", or "${SELECT_ALL_KEY}"`;

function isPrintableChar(key: string): boolean {
  const chars = [...key];
  if (chars.length !== 1) return false;
  const cp = chars[0].codePointAt(0) ?? 0;
  return cp >= 0x20 && cp !== 0x7f;
}

export function resolveKey(rawKey: unknown, rawModifiers: unknown = [], { mac = false }: { mac?: boolean } = {}): ResolvedKey | { error: string } {
  const key = typeof rawKey === 'string' ? rawKey : '';
  const mods = Array.isArray(rawModifiers) ? rawModifiers : rawModifiers === undefined || rawModifiers === null ? [] : null;
  if (!mods) return { error: 'Error: press_key modifiers must be an array of "ctrl", "shift", "alt" or "meta".' };
  const bad = mods.filter((m) => !Object.prototype.hasOwnProperty.call(KEY_MODIFIER_BITS, String(m)));
  if (bad.length) return { error: `Error: press_key does not know the modifier ${JSON.stringify(bad[0])}. Use "ctrl", "shift", "alt" or "meta".` };
  const held = new Set(mods as KeyModifier[]);

  if (key === SELECT_ALL_KEY) {
    const primary: KeyModifier = mac ? 'meta' : 'ctrl';
    held.add(primary);
    return {
      key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
      modifiers: bitsOf(held), commands: ['selectAll'],
      label: `${labelOf(held, 'A')} (select all)`
    };
  }

  let name = SPECIAL_KEYS[key] ? key : '';
  if (!name && key.length > 1) {
    const lower = key.toLowerCase();
    name = SPECIAL_KEY_NAMES.find((n) => n.toLowerCase() === lower) || KEY_ALIASES[lower] || '';
  }
  let def: KeyDefinition;
  let eventKey: string;
  if (name) {
    def = SPECIAL_KEYS[name];
    eventKey = name === 'Space' ? ' ' : name;
  } else if (isPrintableChar(key)) {
    const shifted = held.has('shift') && /^[a-z]$/.test(key);
    eventKey = shifted ? key.toUpperCase() : key;
    if (/^[a-z]$/i.test(key)) def = { code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
    else if (/^[0-9]$/.test(key)) def = { code: `Digit${key}`, windowsVirtualKeyCode: 48 + Number(key) };
    else if (PUNCTUATION[key]) def = { code: PUNCTUATION[key][0], windowsVirtualKeyCode: PUNCTUATION[key][1] };
    else def = { code: '', windowsVirtualKeyCode: 0 };
    def = { ...def, text: eventKey, unmodifiedText: eventKey };
  } else {
    return { error: `Error: press_key does not know the key ${JSON.stringify(key)}. Use ${PRESS_KEY_FORMS}, with modifiers for a combination (key "a" with modifiers ["ctrl"]).` };
  }

  const shortcut = held.has('ctrl') || held.has('meta') || held.has('alt');
  const resolved: ResolvedKey = {
    key: eventKey,
    code: def.code,
    windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    modifiers: bitsOf(held),
    label: labelOf(held, name || (eventKey.length === 1 && /[a-z]/i.test(eventKey) ? eventKey.toUpperCase() : eventKey))
  };
  if (!shortcut && def.text) resolved.text = def.text;
  if ((held.has('ctrl') || held.has('meta')) && !held.has('alt')) {
    const lower = eventKey.toLowerCase();
    const command = lower === 'z' && held.has('shift') ? 'redo' : SHORTCUT_COMMANDS[lower];
    if (command) resolved.commands = [command];
  }
  return resolved;
}

function bitsOf(held: Set<KeyModifier>): number {
  let bits = 0;
  for (const m of held) bits |= KEY_MODIFIER_BITS[m];
  return bits;
}

function labelOf(held: Set<KeyModifier>, keyName: string): string {
  const order: KeyModifier[] = ['ctrl', 'alt', 'shift', 'meta'];
  const names: Record<KeyModifier, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
  return [...order.filter((m) => held.has(m)).map((m) => names[m]), keyName].join('+');
}

export function isMacPlatform(): boolean {
  const nav: any = typeof navigator !== 'undefined' ? navigator : null;
  const platform = String(nav?.userAgentData?.platform || nav?.platform || '');
  return /mac/i.test(platform);
}

export class InputDispatcher {
  private cdp: CDPManager;
  private mac: boolean;
  private frames: FramePort;
  private tabAnswerMs: number;
  private frameScroll = new Map<number, { frameId: number; label: string; top: number }>();

  constructor(cdp: CDPManager = defaultCdp, { mac, frames, tabAnswerMs }: { mac?: boolean; frames?: FramePort; tabAnswerMs?: number } = {}) {
    this.cdp = cdp;
    this.mac = mac ?? isMacPlatform();
    this.frames = frames ?? chromeFramePort();
    this.tabAnswerMs = tabAnswerMs ?? TAB_ANSWER_TIMEOUT_MS;
  }

  async dispatchAction(
    tabId: number,
    actionPayload: Record<string, any>,
    options: DispatchOptions = {}
  ): Promise<DispatchResult> {
    const { signal, docId, sleep, control } = options;
    this.frameScroll.delete(tabId);

    if (signal?.aborted || control?.stopRequested || control?.pauseRequested) {
      return {
        success: false,
        error: 'Action aborted before execution.',
        via: 'synthetic'
      };
    }

    try {
      const tab = await this.getTab(tabId);
      if (!tab) {
        return {
          success: false,
          error: `The target tab [${tabId}] no longer exists (it was probably closed). Open the page you want automated and start the task again.`,
          via: 'synthetic'
        };
      }
      const restricted = describeRestrictedUrl(tab.url ?? '');
      if (restricted) {
        return { success: false, error: `Refused by security policy: ${restricted}`, via: 'synthetic' };
      }
    } catch (_) {
      return { success: false, error: 'Refused by security policy: the tab could not be read, so no action was sent to it.', via: 'synthetic' };
    }

    const action = actionPayload.action;

    switch (action) {
      case 'click':
        return await this.handleClick(tabId, actionPayload, docId, signal, sleep, control);

      case 'click_at':
        return await this.handleClickAt(tabId, actionPayload, signal, sleep, control);

      case 'type':
        return await this.handleType(tabId, actionPayload, docId, signal, sleep, control);

      case 'select':
        // Native select popups are not reliable through trusted debugger clicks.
        return await this.fallbackToSynthetic(tabId, actionPayload, 'native select element');

      case 'press_key':
      case 'keypress':
        return await this.handlePressKey(tabId, actionPayload, signal, sleep, control);

      case 'scroll':
        return await this.handleScroll(tabId, actionPayload, control);

      default:
        return await this.fallbackToSynthetic(tabId, actionPayload);
    }
  }

  private async handleClick(
    tabId: number,
    payload: Record<string, any>,
    docId?: string,
    signal?: AbortSignal,
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<DispatchResult> {
    const targetId = payload.element_id ?? payload.index ?? payload.elementId;
    if (targetId === undefined || targetId === null) {
      return {
        success: false,
        error: 'Click action requires an element_id.',
        via: 'synthetic'
      };
    }

    let urlBefore = '';
    try {
      const tab = await this.getTab(tabId);
      urlBefore = tab?.url || '';
    } catch (_) {}

    const attach = await this.ensureCdpAttached(tabId);
    if (!attach.ok) {
      return await this.syntheticWithUrlChange(tabId, payload, attach.reason, urlBefore);
    }

    const resolveRes = await this.resolvePoint(tabId, targetId, docId);
    if (!resolveRes.success) {
      if (resolveRes.stale || resolveRes.obscuredBy) {
        return {
          success: false,
          error: resolveRes.error,
          stale: resolveRes.stale,
          obscuredBy: resolveRes.obscuredBy,
          via: 'cdp'
        };
      }
      return await this.syntheticWithUrlChange(
        tabId,
        payload,
        `element point could not be resolved: ${resolveRes.error}`,
        urlBefore
      );
    }

    if (resolveRes.tag === 'select') {
      return await this.syntheticWithUrlChange(tabId, payload, 'native select element', urlBefore);
    }

    if (resolveRes.fieldKind && MASKED_FIELD_KINDS.has(resolveRes.fieldKind)) {
      return { success: false, error: MASKED_CLICK_REFUSAL, via: 'cdp', securityRefusal: true };
    }

    await this.probeBegin(tabId);

    try {
      await this.clickCoordinates(tabId, resolveRes.point.x, resolveRes.point.y, signal, sleep, control, {
        elementId: Number(targetId),
        expectedOrigin: originOf(urlBefore)
      });
    } catch (err: any) {
      if (err instanceof SecurityRefusalError) {
        return { success: false, error: err.message, via: 'cdp', securityRefusal: true };
      }
      if (signal?.aborted || control?.stopRequested || control?.pauseRequested) {
        return {
          success: false,
          error: err.message || 'Action aborted',
          via: 'cdp'
        };
      }
      return await this.syntheticWithUrlChange(tabId, payload, `CDP click failed: ${err.message || err}`, urlBefore);
    }

    if (sleep) {
      await sleep(300, signal);
    } else {
      await new Promise((r) => setTimeout(r, 300));
    }

    const probe = await this.probeEnd(tabId);
    let effect = probe.effect;
    let urlAfter = '';
    try {
      const tab = await this.getTab(tabId);
      urlAfter = tab?.url || '';
    } catch (_) {}
    if (urlAfter && urlBefore !== urlAfter) {
      effect = 'url_changed';
    }

    const label = resolveRes.text || null;
    const message = `Clicked element [${targetId}]${label ? ` ("${label}")` : ''}`;

    return {
      success: true,
      label,
      message,
      effect,
      urlAfter: urlAfter || undefined,
      via: 'cdp',
      ...(probe.detail ? { effectDetail: probe.detail } : {})
    };
  }

  private async handleClickAt(
    tabId: number,
    payload: Record<string, any>,
    signal?: AbortSignal,
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<DispatchResult> {
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { success: false, error: 'A coordinate click needs a numeric x and y.', via: 'synthetic' };
    }

    let urlBefore = '';
    try {
      const tab = await this.getTab(tabId);
      urlBefore = tab?.url || '';
    } catch (_) {}

    const attach = await this.ensureCdpAttached(tabId);
    if (!attach.ok) {
      return {
        success: false,
        error: `A coordinate click needs the debugger, which could not attach: ${attach.reason}. Use click with an element_id instead.`,
        via: 'synthetic',
        syntheticReason: attach.reason
      };
    }

    await this.probeBegin(tabId);
    try {
      await this.clickCoordinates(tabId, x, y, signal, sleep, control, { expectedOrigin: originOf(urlBefore) });
    } catch (err: any) {
      if (err instanceof SecurityRefusalError) {
        return { success: false, error: err.message, via: 'cdp', securityRefusal: true };
      }
      return { success: false, error: err.message || 'The coordinate click failed.', via: 'cdp' };
    }

    if (sleep) {
      await sleep(300, signal);
    } else {
      await new Promise((r) => setTimeout(r, 300));
    }

    const probe = await this.probeEnd(tabId);
    let effect = probe.effect;
    let urlAfter = '';
    try {
      const tab = await this.getTab(tabId);
      urlAfter = tab?.url || '';
    } catch (_) {}
    if (urlAfter && urlBefore !== urlAfter) effect = 'url_changed';

    return {
      success: true,
      message: `Clicked at (${Math.round(x)}, ${Math.round(y)})`,
      effect,
      urlAfter: urlAfter || undefined,
      via: 'cdp',
      ...(probe.detail ? { effectDetail: probe.detail } : {})
    };
  }

  private async syntheticWithUrlChange(
    tabId: number,
    payload: Record<string, any>,
    reason: string,
    urlBefore: string
  ): Promise<DispatchResult> {
    const res = await this.fallbackToSynthetic(tabId, payload, reason);
    let urlAfter = '';
    try {
      const tab = await this.getTab(tabId);
      urlAfter = tab?.url || '';
    } catch (_) {}
    if (urlAfter && urlBefore !== urlAfter) {
      res.effect = 'url_changed';
      res.urlAfter = urlAfter;
    }
    return res;
  }

  private async handleType(
    tabId: number,
    payload: Record<string, any>,
    docId?: string,
    signal?: AbortSignal,
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<DispatchResult> {
    const targetId = payload.element_id ?? payload.index ?? payload.elementId;
    const text = payload.text == null ? '' : String(payload.text);
    const submit = Boolean(payload.submit);
    const append = payload.mode === 'append';
    const hasTarget = targetId !== undefined && targetId !== null;

    let urlBefore = '';
    try {
      const tab = await this.getTab(tabId);
      urlBefore = tab?.url || '';
    } catch (_) {}

    const attach = await this.ensureCdpAttached(tabId);
    if (!attach.ok) {
      if (!hasTarget) {
        return {
          success: false,
          error: `Typing into the focused element needs the debugger, which could not attach: ${attach.reason}. Nothing was typed. Give an element_id instead.`,
          via: 'cdp',
          syntheticReason: attach.reason
        };
      }
      return await this.syntheticWithUrlChange(tabId, payload, attach.reason, urlBefore);
    }

    let label: string | null = null;
    let point: { x: number; y: number } | null = null;
    if (hasTarget) {
      const resolveRes = await this.resolvePoint(tabId, targetId, docId);
      if (!resolveRes.success) {
        return {
          success: false,
          error: resolveRes.error,
          stale: resolveRes.stale,
          obscuredBy: resolveRes.obscuredBy,
          via: 'cdp'
        };
      }
      if (resolveRes.fieldKind && MASKED_FIELD_KINDS.has(resolveRes.fieldKind)) {
        return { success: false, error: MASKED_TYPE_REFUSAL, via: 'cdp', securityRefusal: true };
      }
      if (resolveRes.tag === 'select') {
        return await this.syntheticWithUrlChange(tabId, payload, 'native select element', urlBefore);
      }
      label = resolveRes.text || null;
      point = resolveRes.point;
    }

    const baseline = await this.probeBegin(tabId);
    if (!hasTarget) {
      const focus = baseline?.focus;
      if (baseline && (!focus || focus.editable === false)) {
        return {
          success: false,
          error: `Nothing editable has focus${focus?.label ? ` (focus is on ${focus.label})` : ''}, so nothing was typed. Click into the field first, then call type without element_id, or give the element_id of the field.`,
          via: 'cdp'
        };
      }
      if (focus?.fieldKind && MASKED_FIELD_KINDS.has(String(focus.fieldKind))) {
        return { success: false, error: MASKED_TYPE_REFUSAL, via: 'cdp', securityRefusal: true };
      }
      if (submit && enterSubmitsImplicitly(focus) && focusFormIsRisky(focus, baseline?.url)) {
        return { success: false, error: typeSubmitRefusal(), via: 'cdp', securityRefusal: true };
      }
      if (submit && isFrameFocus(focus)) {
        return { success: false, error: frameSubmitRefusal(), via: 'cdp', securityRefusal: true };
      }
      label = focus?.label || null;
    }

    let fieldText: string | null = null;
    try {
      if (point) await this.clickCoordinates(tabId, point.x, point.y, signal, sleep, control, {
        elementId: hasTarget ? Number(targetId) : undefined,
        expectedOrigin: originOf(urlBefore)
      });

      if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');

      const primary = this.mac ? KEY_MODIFIER_BITS.meta : KEY_MODIFIER_BITS.ctrl;
      const prepare = append
        ? { key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: primary, commands: ['moveToEndOfDocument'] }
        : { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] };
      let prepareDownSent = false;
      try {
        await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...prepare }, control);
        prepareDownSent = true;
      } finally {
        if (prepareDownSent) {
          try {
            const { commands: _commands, ...up } = prepare as any;
            await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...up }, control);
          } catch (_) {}
        }
      }

      if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');

      await this.cdp.sendCommand(tabId, 'Input.insertText', { text }, control);

      const readBack = await this.probeEnd(tabId);
      fieldText = readBack.detail?.focus && typeof readBack.detail.focus.text === 'string' ? readBack.detail.focus.text : null;

      if (submit) {
        if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');
        let enterDownSent = false;
        try {
          await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            text: '\r',
            unmodifiedText: '\r'
          }, control);
          enterDownSent = true;
        } finally {
          if (enterDownSent) {
            try {
              await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: 'Enter',
                code: 'Enter',
                windowsVirtualKeyCode: 13
              }, control);
            } catch (_) {}
          }
        }
      }
    } catch (err: any) {
      if (err instanceof SecurityRefusalError) {
        return { success: false, error: err.message, via: 'cdp', securityRefusal: true };
      }
      return {
        success: false,
        error: err.message || 'CDP type failed.',
        via: 'cdp'
      };
    }

    if (submit) {
      if (sleep) {
        await sleep(300, signal);
      } else {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const probe = await this.probeEnd(tabId);
    let effect = probe.effect;
    let urlAfter = '';
    try {
      const tab = await this.getTab(tabId);
      urlAfter = tab?.url || '';
    } catch (_) {}
    if (urlAfter && urlBefore !== urlAfter) {
      effect = 'url_changed';
    }

    const where = hasTarget ? `element [${targetId}]` : 'the focused element';
    const message = `Typed "${text}" into ${where}${label ? ` ("${label}")` : ''}`;

    return {
      success: true,
      label,
      submitted: submit,
      message,
      effect,
      urlAfter: urlAfter || undefined,
      via: 'cdp',
      fieldText,
      ...(probe.detail ? { effectDetail: probe.detail } : {})
    };
  }

  private async handlePressKey(
    tabId: number,
    payload: Record<string, any>,
    signal?: AbortSignal,
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<DispatchResult> {
    const key = payload.key;
    if (!key) {
      return {
        success: false,
        error: 'press_key action requires a "key" parameter.',
        via: 'cdp'
      };
    }
    const resolved = resolveKey(key, payload.modifiers, { mac: this.mac });
    if ('error' in resolved) return { success: false, error: resolved.error, via: 'cdp' };

    const attach = await this.ensureCdpAttached(tabId);
    if (!attach.ok) {
      return {
        success: false,
        error: `press_key needs the debugger for a real key press, and it could not attach: ${attach.reason}. Nothing was pressed.`,
        via: 'cdp',
        syntheticReason: attach.reason
      };
    }

    const baseline = await this.probeBegin(tabId);
    const focus = baseline?.focus ?? null;

    const insertsCharacter = resolved.text !== undefined && resolved.key !== 'Enter';
    if (focus?.fieldKind && MASKED_FIELD_KINDS.has(String(focus.fieldKind)) && insertsCharacter) {
      return { success: false, error: MASKED_TYPE_REFUSAL, via: 'cdp', securityRefusal: true };
    }

    if (resolved.key === 'Enter' && enterSubmitsImplicitly(focus) && focusFormIsRisky(focus, baseline?.url)) {
      return { success: false, error: pressKeySubmitRefusal(resolved.label), via: 'cdp', securityRefusal: true };
    }
    if (resolved.key === 'Enter' && isFrameFocus(focus)) {
      return { success: false, error: frameSubmitRefusal(), via: 'cdp', securityRefusal: true };
    }

    try {
      await this.sendResolvedKey(tabId, resolved, signal, control);
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'CDP keypress failed.',
        via: 'cdp'
      };
    }

    if (sleep) await sleep(300, signal);
    else await new Promise((r) => setTimeout(r, 300));

    const probe = await this.probeEnd(tabId);
    return {
      success: true,
      message: `Pressed ${resolved.label}`,
      label: resolved.label,
      effect: probe.effect,
      via: 'cdp',
      ...(probe.detail ? { effectDetail: probe.detail } : {})
    };
  }

  private async handleScroll(
    tabId: number,
    payload: Record<string, any>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<DispatchResult> {
    const direction = payload.direction === 'up' ? 'up' : 'down';
    let frameId = 0;
    const ask = async (body: Record<string, unknown>): Promise<any> => {
      if (frameId !== 0) {
        const answer = await this.frames.send(tabId, { frameId }, { action: 'FRAME_SCROLL', payload: body }, FRAME_ANSWER_MS);
        return answer ?? { success: false, error: 'The embedded frame did not answer. Nothing was scrolled.' };
      }
      try {
        return await this.sendToTab<any>(tabId, { action: 'EXECUTE_ACTION', payload: body });
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    };
    let target = await ask({
      action: 'scroll_target',
      direction,
      ...(payload.element_id !== undefined && payload.element_id !== null ? { element_id: payload.element_id } : {}),
      ...(Number.isFinite(Number(payload.x)) && Number.isFinite(Number(payload.y)) && payload.x !== undefined && payload.y !== undefined ? { x: Number(payload.x), y: Number(payload.y) } : {})
    });
    const offset = { left: 0, top: 0 };
    const topAnswer = target;
    for (let hops = 0; target?.success && target.result?.frame && hops < 8; hops++) {
      const route = target.result.frame;
      const before = target;
      frameId = (await frameIdAtPath(tabId, String(route.path || ''), this.frames).catch(() => null)) ?? -1;
      offset.left += Number(route.offset?.left) || 0;
      offset.top += Number(route.offset?.top) || 0;
      target = frameId > 0 ? await ask({ action: 'scroll_target', direction, ...(route.point ? { x: route.point.x, y: route.point.y } : {}) }) : null;
      if (!target?.success || !target.result) {
        frameId = 0;
        offset.left = 0;
        offset.top = 0;
        target = { ...topAnswer, result: { ...topAnswer.result, frame: undefined } };
        break;
      }
    }
    if (!target?.success || !target.result) {
      return { success: false, error: target?.error || 'The page did not answer, so it is not known what to scroll. Nothing was scrolled.', via: 'cdp' };
    }
    const { label, step } = target.result;
    const point = { x: (Number(target.result.point?.x) || 0) + offset.left, y: (Number(target.result.point?.y) || 0) + offset.top };
    const before: ScrollReading = pickReading(target.result);
    await this.probeBegin(tabId);

    const atEdge = (p: ScrollReading) => (direction === 'down' ? p.atBottom : p.atTop);
    const delta = (direction === 'down' ? 1 : -1) * (Number(step) || 400);
    let after = before;
    let via: DispatchResult['via'] = 'cdp';
    let syntheticReason: string | undefined;
    if (!atEdge(before)) {
      const measured = await this.wheelAndMeasure(tabId, point, delta, before, control, ask);
      after = measured.after;
      syntheticReason = measured.reason;
      if (after.top === before.top && !atEdge(after)) {
        const moved = await ask({ action: 'scroll_fallback', delta });
        if (moved?.success && moved.result) after = pickReading(moved.result);
        via = 'synthetic';
        syntheticReason = syntheticReason || 'the mouse wheel did not move it';
      }
    }

    if (frameId > 0) this.frameScroll.set(tabId, { frameId, label, top: before.top });
    const probe = await this.probeEnd(tabId);
    const moved = after.top - before.top;
    return {
      success: true,
      via,
      ...(syntheticReason ? { syntheticReason } : {}),
      effect: probe.effect,
      message: moved !== 0 ? `Scrolled ${label} ${moved > 0 ? 'down' : 'up'} ${Math.abs(moved)}px` : `Did not move ${label}`,
      result: { moved, label, direction, fallback: via === 'synthetic', ...after },
      ...(probe.detail ? { effectDetail: probe.detail } : {})
    };
  }

  private async wheelAndMeasure(
    tabId: number,
    point: { x: number; y: number },
    delta: number,
    before: ScrollReading,
    control: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal } | undefined,
    ask: (body: Record<string, unknown>) => Promise<any>
  ): Promise<{ after: ScrollReading; reason?: string }> {
    const attach = await this.ensureCdpAttached(tabId);
    if (!attach.ok) return { after: before, reason: attach.reason };
    try {
      await this.cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.round(point?.x ?? 0), y: Math.round(point?.y ?? 0), deltaX: 0, deltaY: delta
      }, control);
    } catch (err: any) {
      return { after: before, reason: `the mouse wheel failed: ${err?.message || err}` };
    }
    const measured = await ask({ action: 'scroll_measure' });
    return { after: measured?.success && measured.result ? pickReading(measured.result) : before };
  }

  private async verifyClickPoint(
    tabId: number,
    x: number,
    y: number,
    verify?: { elementId?: number; expectedOrigin?: string }
  ): Promise<void> {
    let check: any = null;
    try {
      check = await this.sendToTab(tabId, {
        action: 'VERIFY_CLICK_POINT',
        payload: { x, y, ...(verify?.elementId !== undefined ? { element_id: verify.elementId } : {}) }
      });
    } catch (_) {
      check = null;
    }
    if (!check || check.success !== true) {
      throw new SecurityRefusalError('Refused by security policy: the click point could not be re-verified right before the press, so the click was not sent.');
    }
    if (check.fieldKind && MASKED_FIELD_KINDS.has(String(check.fieldKind))) {
      throw new SecurityRefusalError(MASKED_CLICK_REFUSAL);
    }
    const what = String(check.what || '');
    if (what && BOT_CHECK_PATTERN.test(what)) {
      throw new SecurityRefusalError(`Refused by security policy: the point now sits on a bot check (${what.trim().slice(0, 80)}). Tarka never clicks or solves bot checks or CAPTCHAs.`);
    }
    if (verify?.elementId !== undefined && check.withinTarget === false) {
      throw new SecurityRefusalError('Refused by security policy: the point no longer hits the element it was aimed at (the page changed under it), so the click was not sent.');
    }
    if (verify?.expectedOrigin) {
      const tab = await this.getTab(tabId).catch(() => null);
      const now = originOf(tab?.url || '');
      if (now && now !== verify.expectedOrigin) {
        throw new SecurityRefusalError('Refused by security policy: the page navigated while the click was being prepared, so the click was not sent.');
      }
    }
  }

  async clickCoordinates(
    tabId: number,
    x: number,
    y: number,
    signal?: AbortSignal,
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal },
    verify?: { elementId?: number; expectedOrigin?: string }
  ): Promise<void> {
    if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');

    const doSleep = sleep
      ? (ms: number) => sleep(ms, signal)
      : (ms: number) => new Promise((r) => setTimeout(r, ms));

    try {
      await this.sendToTab(tabId, { action: 'SHOW_CLICK_ANIMATION', payload: { x, y } });
    } catch (_) {
    }

    await this.cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y
    }, control);

    await doSleep(30);
    if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');

    await this.verifyClickPoint(tabId, x, y, verify);

    let mousePressed = false;
    try {
      await this.cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        buttons: 1,
        clickCount: 1,
        x,
        y
      }, control);
      mousePressed = true;

      await doSleep(50);
      if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');
    } finally {
      if (mousePressed) {
        try {
          await this.cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button: 'left',
            buttons: 0,
            clickCount: 1,
            x,
            y
          }, control);
        } catch (_) {
        }
      }
    }
  }

  async sendKey(
    tabId: number,
    key: string,
    signal?: AbortSignal,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal },
    modifiers: KeyModifier[] = []
  ): Promise<void> {
    const resolved = resolveKey(key, modifiers, { mac: this.mac });
    if ('error' in resolved) throw new Error(resolved.error);
    await this.sendResolvedKey(tabId, resolved, signal, control);
  }

  private async sendResolvedKey(
    tabId: number,
    def: ResolvedKey,
    signal?: AbortSignal,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<void> {
    if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');

    const downParams: Record<string, unknown> = {
      type: def.text ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode
    };
    if (def.modifiers) downParams.modifiers = def.modifiers;
    if (def.text) {
      downParams.text = def.text;
      downParams.unmodifiedText = def.text;
    }
      // CDP's commands field carries editing shortcuts for some focus targets.
      if (def.commands?.length) downParams.commands = def.commands;

    let keyDownSent = false;
    try {
      // Chromium emits keypress for text-bearing keyDown events, not rawKeyDown events.
      await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', downParams, control);
      keyDownSent = true;
    } finally {
      if (keyDownSent) {
        try {
          await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: def.key,
            code: def.code,
            windowsVirtualKeyCode: def.windowsVirtualKeyCode,
            ...(def.modifiers ? { modifiers: def.modifiers } : {})
          }, control);
        } catch (_) {}
      }
    }
  }

  private async resolvePoint(
    tabId: number,
    elementId: number,
    docId?: string
  ): Promise<ResolvePointResponse> {
    try {
      const response = await this.sendToTab<ResolvePointResponse>(tabId, {
        action: 'RESOLVE_ELEMENT_POINT',
        payload: { docId, element_id: elementId }
      });
      return response;
    } catch (err: any) {
      return {
        success: false,
        error: err.message || `Failed to resolve point for element [${elementId}].`
      };
    }
  }

  private async ensureCdpAttached(tabId: number): Promise<{ ok: boolean; reason: string }> {
    if (this.cdp.isUserDetached(tabId)) {
      return { ok: false, reason: 'debugger detached by user' };
    }
    if (this.cdp.isAttached(tabId)) {
      return { ok: true, reason: '' };
    }
    try {
      await this.cdp.attach(tabId);
      return { ok: true, reason: '' };
    } catch (err: any) {
      const detail = err?.message || String(err);
      Logger.info('InputDispatcher', `CDP attach failed on tab [${tabId}], falling back to synthetic.`, err);
      return { ok: false, reason: `debugger could not attach: ${detail}` };
    }
  }

  private async probeBegin(tabId: number): Promise<{
    url?: string;
    focus?: {
      label: string;
      editable: boolean;
      fieldKind?: string;
      tag?: string;
      inputType?: string;
      isSubmitControl?: boolean;
      formHasMaskedField?: boolean;
      formTarget?: { formActionHost?: string; formMethod?: string };
      formSubmitLabel?: string;
    } | null;
  } | null> {
    try {
      const res = await this.sendToTab<{ success: boolean; baseline?: any }>(tabId, { action: 'EFFECT_PROBE_BEGIN' });
      return res?.success && res.baseline && typeof res.baseline === 'object' ? res.baseline : null;
    } catch (_) {
      return null;
    }
  }

  private async probeEnd(tabId: number): Promise<{ effect: string; detail?: EffectDetail }> {
    try {
      const res = await this.sendToTab<{ success: boolean; effect?: string; detail?: EffectDetail }>(tabId, {
        action: 'EFFECT_PROBE_END'
      });
      let detail = res?.detail && typeof res.detail === 'object' ? res.detail : undefined;
      const inFrame = this.frameScroll.get(tabId);
      if (detail && detail.base && inFrame) {
        const read = await this.frames.send(tabId, { frameId: inFrame.frameId }, { action: 'FRAME_SCROLL', payload: { action: 'scroll_measure', quietMs: 80, maxMs: 600 } }, FRAME_ANSWER_MS);
        const top = Number(read?.result?.top);
        if (read?.success && Number.isFinite(top)) detail = { ...detail, container: { label: inFrame.label, top, moved: top - inFrame.top } };
      }
      return { effect: res?.effect || 'none', ...(detail ? { detail } : {}) };
    } catch (_) {
      return { effect: 'unknown' };
    }
  }

  async readProbe(tabId: number): Promise<EffectDetail | null> {
    const probe = await this.probeEnd(tabId);
    return probe.detail ?? null;
  }

  async fallbackToSynthetic(
    tabId: number,
    actionPayload: Record<string, any>,
    reason?: string
  ): Promise<DispatchResult> {
    await this.probeBegin(tabId);
    try {
      const response = await this.sendToTab<any>(tabId, {
        action: 'EXECUTE_ACTION',
        payload: actionPayload
      });
      if (!response) {
        return {
          success: false,
          error: 'The content script did not answer the synthetic action request.',
          via: 'synthetic',
          ...(reason ? { syntheticReason: reason } : {})
        };
      }
      const probe = await this.probeEnd(tabId);
      return {
        ...response,
        via: 'synthetic',
        ...(reason ? { syntheticReason: reason } : {}),
        ...(probe.effect !== 'unknown' ? { effect: probe.effect } : {}),
        ...(probe.detail ? { effectDetail: probe.detail } : {})
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Synthetic action execution failed.',
        via: 'synthetic',
        ...(reason ? { syntheticReason: reason } : {})
      };
    }
  }

  private getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.get) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime?.lastError || !tab) resolve(null);
        else resolve(tab);
      });
    });
  }

  private sendToTab<T = any>(tabId: number, message: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.sendMessage) {
        return reject(new Error('chrome.tabs.sendMessage is not available.'));
      }
      const timer = setTimeout(() => reject(new Error(answerDeadlineText(this.tabAnswerMs))), this.tabAnswerMs);
      chrome.tabs.sendMessage(tabId, message, TOP_FRAME, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(response);
      });
    });
  }
}

export const inputDispatcher = new InputDispatcher();
