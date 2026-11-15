import { takeSnapshot } from '../browser/snapshot.ts';
import { TOP_FRAME, readFrameTexts } from '../browser/frames.ts';
import { executeAction } from '../browser/execute.ts';
import { cdp } from '../browser/cdp.ts';
import { captureScreenshot, ScreenshotError, chromePagePort, type ScreenshotDeps } from '../browser/screenshot.ts';
import { checkFrame, imageToViewport, isInsideFrame, makeFrame, outOfFrameMessage, type CoordinateFrame } from '../browser/screenshotFrame.ts';
import { Logger } from '../../shared/logger.ts';
import { toPicturePixels, type CoordinateSpace } from '../llm/coordinates.ts';
import { resolveKey } from '../browser/input.ts';
import type { ExecResult, RunRuntime } from '../runner/runtimeRegistry.ts';
import type { EffectDetail } from '../types.ts';
import { RESEARCH_TOOL_NAMES, TOOL_MAP } from './tools.ts';
import { sourceOf, wrapUntrusted } from './untrusted.ts';
import { finishOutcomeOf, type FinishOutcome } from './historyEntries.ts';
import { webSearch } from '../research/search.ts';
import { fetchUrl } from '../research/fetchText.ts';
import { Storage, normalizeResearch } from '../../shared/storage.ts';
import { MASKED_FIELD_KINDS } from '../../shared/maskedFields.ts';
import type { ActionConfirmationRequest } from '../runner/runtimeRegistry.ts';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mediaType: 'image/jpeg' | 'image/png';
  imageId: string;
  imageWidth: number;
  imageHeight: number;
}

export interface CallToolResult {
  content: Array<TextContent | ImageContent>;
  isError?: boolean;
}

export interface ToolOutcome {
  text: string;
  image?: ImageContent;
  table?: { columns: string[]; rows: string[][] };
  outcome?: FinishOutcome;
  isError?: boolean;
  label?: string;
}

export const PICTURE_KEEP = 8;

export function coordinateClickRefusal(args: Record<string, any>): string | null {
  const hasX = args?.x !== undefined && args?.x !== null;
  const hasY = args?.y !== undefined && args?.y !== null;
  const hasId = args?.element_id !== undefined && args?.element_id !== null;
  if (hasId) return null;
  if (hasX && hasY) return null;
  if (hasX || hasY) {
    return 'Error: a coordinate click needs both x and y. Give both, or use element_id from get_page_elements or find.';
  }
  return 'Error: click needs either an element_id from get_page_elements or find, or both x and y read off a take_screenshot picture.';
}

export { BOT_CHECK_PATTERN, MASKED_TYPE_REFUSAL, MASKED_CLICK_REFUSAL } from '../../shared/safetyPatterns.ts';
import { BOT_CHECK_PATTERN, HIGH_RISK_ACTION_PATTERN, MASKED_TYPE_REFUSAL, MASKED_CLICK_REFUSAL } from '../../shared/safetyPatterns.ts';

export function botCheckRefusal(elementId: unknown, label: string): string {
  return `Refused: element [${elementId}] is a bot check (${label.trim().slice(0, 80)}). Tarka never clicks or solves bot checks or CAPTCHAs. Call finish now and tell the user the page is behind a bot check that a person has to pass.`;
}

export function botCheckPointRefusal(what: string): string {
  return `Refused: that point is on a bot check (${what.trim().slice(0, 80)}). Tarka never clicks or solves bot checks or CAPTCHAs. Call finish now and tell the user the page is behind a bot check that a person has to pass.`;
}

export const CONFIRM_DECLINED_TEXT = 'Refused: the user declined this action. Do not try to work around the decision, and do not repeat it. Say what you could not do and finish, or take a different path that needs no such action.';

export const FINISH_TABLE_ERROR = 'Error: finish needs table as {"columns": ["Header"], "rows": [["cell"]]}: columns a list of header strings, rows a list of rows where every cell is a string. Call finish again with the same answer and the table in that shape, or without table.';

export function finishTableOf(table: unknown): { columns: string[]; rows: string[][] } | null | string {
  if (table === undefined || table === null) return null;
  const t = table as any;
  const ok = typeof table === 'object' && !Array.isArray(table)
    && Array.isArray(t.columns) && t.columns.length > 0 && t.columns.every((c: unknown) => typeof c === 'string')
    && Array.isArray(t.rows) && t.rows.every((row: unknown) => Array.isArray(row) && row.every((cell: unknown) => typeof cell === 'string'));
  if (!ok) return FINISH_TABLE_ERROR;
  return { columns: t.columns, rows: t.rows };
}

const CONFIRM_UNAVAILABLE_TEXT = 'Refused by security policy: this action needs your confirmation, but the confirmation card could not be shown. Ask the user to do this step manually.';

export interface ElementSecurity {
  tag?: string;
  type?: string;
  fieldKind?: string;
  isSubmitControl?: boolean;
  formTarget?: { formActionHost?: string; formMethod?: 'get' };
  formHasMaskedField?: boolean;
  formSubmitLabel?: string;
  label?: string;
  text?: string;
}

export interface SensitiveActionDecision {
  refuse?: string;
  confirm?: { variant: 'purchase' | 'submit'; actionSummary: string; reason: string };
}

const GATE_REASON = 'This action can submit a form, start a payment or change account data. Tarka asks you before it acts.';

export function sensitiveActionDecision(input: {
  tool: 'click' | 'type';
  sec: ElementSecurity | null | undefined;
  label?: string;
  submitting?: boolean;
  requiresApproval?: boolean;
}): SensitiveActionDecision {
  const sec = input.sec ?? null;
  if (sec?.fieldKind && MASKED_FIELD_KINDS.has(sec.fieldKind)) {
    return { refuse: input.tool === 'type' ? MASKED_TYPE_REFUSAL : MASKED_CLICK_REFUSAL };
  }
  const name = `${input.label || ''} ${sec?.label || ''} ${sec?.text || ''}`.trim();
  const summaryTarget = sec?.label || sec?.text || input.label || 'the element';
  const confirm = (variant: 'purchase' | 'submit', actionSummary: string): SensitiveActionDecision =>
    ({ confirm: { variant, actionSummary, reason: GATE_REASON } });
  if (input.requiresApproval) {
    return confirm('submit', `${input.tool === 'type' ? 'Type into' : 'Click'} ${summaryTarget}`);
  }
  if (HIGH_RISK_ACTION_PATTERN.test(name)) {
    const money = /\b(pay|purchase|buy now|checkout|place order|submit order|transfer)\b/i.test(name);
    return confirm(money ? 'purchase' : 'submit', `${input.tool === 'type' ? 'Type into' : 'Click'} ${summaryTarget}`);
  }
  const submitting = input.tool === 'type' && input.submitting === true;
  const submitLabel = String(sec?.formSubmitLabel || '');
  const implicitSubmitIsHighRisk = submitting && Boolean(submitLabel) && HIGH_RISK_ACTION_PATTERN.test(submitLabel);
  const riskyForm = Boolean(sec?.isSubmitControl || submitting)
    && Boolean(sec && (sec.formHasMaskedField || sec.formTarget?.formActionHost || implicitSubmitIsHighRisk));
  if (riskyForm) {
    const money = implicitSubmitIsHighRisk && /\b(pay|purchase|buy now|checkout|place order|submit order|transfer)\b/i.test(submitLabel);
    return confirm(money ? 'purchase' : 'submit', `${submitting ? 'Type into' : 'Click'} ${summaryTarget}${submitting ? ' and submit the form' : ''}`);
  }
  return {};
}

export function linkNotOpenedNote(elementLine: string): string {
  const path = /\(.*?\bhref="([^"]+)"/.exec(elementLine)?.[1];
  return path
    ? `\nNote: the link did not open its page (${path}) in this tab: it may have opened in a new tab, or something may be blocking clicks, such as a cookie or consent banner. Answer a banner first if there is one, or navigate to the link's address.`
    : '';
}

export const LARGE_TEXT_CHANGE_CHARS = 300;

export const OBSERVATION_PREFIX = 'Observation:';

export const SAME_PICTURE_NOTE = 'Same picture as your last screenshot.';

export const SAME_TEXT_NOTE = 'Same text as your last read.';

function quoted(text: string, max = 120): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}

export function observationLine(detail: EffectDetail | undefined | null, urlAfter?: string): string {
  if (!detail) {
    return urlAfter
      ? `${OBSERVATION_PREFIX} url now ${urlAfter}; the rest is unknown (the page did not answer)`
      : `${OBSERVATION_PREFIX} unknown (the page did not answer the effect probe)`;
  }
  const urlChanged = urlAfter ? true : detail.urlChanged;
  const url = urlAfter || detail.url;
  if (!detail.base) {
    return `${OBSERVATION_PREFIX} url ${urlChanged === false ? 'unchanged' : `now ${url}`}; a new page loaded, so what changed in view is unknown`;
  }
  const focus = detail.focus;
  const caret = focus && focus.editable && typeof focus.caretLine === 'string' && !isRedactedFieldText(focus.caretLine)
    ? `, caret line ${quoted(focus.caretLine)}`
    : '';
  const containerMoved = detail.container && typeof detail.container.moved === 'number' && detail.container.moved !== 0;
  const quiet = detail.textChanged === false && detail.focusChanged === false && detail.scrollChanged === false
    && !containerMoved && urlChanged === false;
  if (quiet) return `${OBSERVATION_PREFIX} nothing in view changed; focus unchanged${caret}; url unchanged`;

  const parts: string[] = [];
  if (detail.focusChanged === null) parts.push('focus unknown');
  else if (!focus) parts.push(detail.focusChanged ? 'focus left the element (nothing focused)' : 'nothing focused');
  else parts.push(`${detail.focusChanged ? 'focus moved to' : 'focus still on'} ${quoted(focus.label, 80)}${caret}`);

  if (detail.textChanged === null) parts.push('text in view unknown');
  else if (!detail.textChanged) parts.push('text in view unchanged');
  else {
    const diff = [detail.added ? `+${quoted(detail.added, 400)}` : '', detail.removed ? `-${quoted(detail.removed, 400)}` : ''].filter(Boolean).join(' ');
    parts.push(`text in view changed${diff ? ` (${diff})` : ''}`);
  }

  if (detail.scrollChanged) parts.push(`page scrolled to x=${detail.scroll.x}, y=${detail.scroll.y}`);
  if (containerMoved) parts.push(`${quoted(detail.container!.label, 60)} scrolled ${detail.container!.moved! > 0 ? 'down' : 'up'} ${Math.abs(detail.container!.moved!)}px (now at ${detail.container!.top})`);
  if (detail.scrollChanged === false && !containerMoved) parts.push('scroll unchanged');
  else if (detail.scrollChanged === null) parts.push('scroll unknown');

  parts.push(urlChanged === null ? 'url unknown' : urlChanged ? `url now ${url}` : 'url unchanged');
  return `${OBSERVATION_PREFIX} ${parts.join('; ')}`;
}

export function isLargeChange(detail: EffectDetail | undefined | null): boolean {
  return !!detail && detail.base && detail.textChanged === true && detail.changedChars >= LARGE_TEXT_CHANGE_CHARS;
}

export const REDACTED_FIELD_MARKER = '[REDACTED: populated]';

export function isRedactedFieldText(text: unknown): boolean {
  return typeof text === 'string' && text.startsWith('[REDACTED');
}

export function fieldReadBack(fieldText: string | null | undefined, typed: string): string {
  if (isRedactedFieldText(fieldText)) {
    return '\nThis is a sensitive field (a password, card or one-time code field), so Tarka does not read its content back. The field holds a value.';
  }
  if (typeof fieldText !== 'string') return '\nThe field could not be read back, so it is not known what it holds now.';
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  const head = fieldText.replace(/\s+/g, ' ').trim().slice(0, 120);
  const want = norm(typed);
  const holds = !want || norm(fieldText).includes(want.slice(0, 1000));
  return `\nField now starts with: "${head}"${holds ? '' : '\nNote: the field does not contain the text you typed: the page may have refused or changed it.'}`;
}

export const EDITOR_LINES_NOTE = 'Note: a code editor here draws only the lines near the view (editor may hide off-screen lines). Scroll it into view to read the rest.';

export function normalizeElementId(args: any): any {
  if (!args || typeof args !== 'object' || !('element_id' in args)) return args;
  const raw = args.element_id;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  const { element_id: _dropped, ...rest } = args;
  return Number.isInteger(n) && n >= 1 ? { ...rest, element_id: n } : rest;
}

export function readPagePart(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export interface ScrollMeasurement {
  moved: number;
  label: string;
  direction?: 'up' | 'down';
  top: number;
  max: number;
  atTop: boolean;
  atBottom: boolean;
  fallback?: boolean;
}

export function scrollResultText(direction: 'up' | 'down', m: ScrollMeasurement | null | undefined): string {
  if (!m || typeof m.moved !== 'number') return `Scrolled ${direction}, but the page did not say how far, so whether anything moved is unknown.`;
  const label = m.label || 'the page';
  if (m.moved === 0) {
    const edge = direction === 'down' ? m.atBottom : m.atTop;
    return edge
      ? `Did not move: already at the ${direction === 'down' ? 'bottom' : 'top'} of ${label}.`
      : `Did not move: ${label} did not scroll. Give scroll an element_id inside the area you want to move, or x and y on it from a screenshot.`;
  }
  const where = m.atBottom ? ', the bottom' : m.atTop ? ', the top' : '';
  const how = m.fallback ? ' (the mouse wheel did not move it, so it was scrolled directly)' : '';
  return `Scrolled ${label} ${m.moved > 0 ? 'down' : 'up'} ${Math.abs(m.moved)}px, now at ${m.top} of ${m.max}px${where}${how}.`;
}

function textHash(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return `${h.toString(16)}:${text.length}`;
}

function elementLinesById(elementsText: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of String(elementsText || '').split('\n')) {
    const match = line.match(/^\s*\[(\d+)\]/);
    if (match) lines.set(Number(match[1]), line);
  }
  return lines;
}

export class TarkaMCPServer {
  private runtime: RunRuntime | null = null;
  private elementLines = new Map<number, Map<number, string>>();
  private frames = new Map<number, CoordinateFrame>();
  private visionUnavailable = false;
  private screenshotDeps: ((tabId: number) => ScreenshotDeps) | null = null;
  private mintedImages = 0;
  private images = new Map<string, { data: string; mediaType: string; tabId: number }>();

  setRuntime(runtime: RunRuntime) {
    this.runtime = runtime;
  }

  setScreenshotDeps(factory: ((tabId: number) => ScreenshotDeps) | null) {
    this.screenshotDeps = factory;
  }

  frameFor(tabId: number): CoordinateFrame | null {
    return this.frames.get(tabId) ?? null;
  }

  getScreenshot(imageId: string): { data: string; mediaType: string } | null {
    const held = this.images.get(String(imageId || ''));
    return held ? { data: held.data, mediaType: held.mediaType } : null;
  }

  setVisionUnavailable(): void {
    this.visionUnavailable = true;
  }

  isVisionUnavailable(): boolean {
    return this.visionUnavailable;
  }

  elementLabel(tabId: number | null | undefined, elementId: unknown): string {
    if (typeof tabId !== 'number' || elementId === undefined || elementId === null) return '';
    return this.elementLines.get(tabId)?.get(Number(elementId)) || '';
  }

  private researchFetch: typeof fetch | null = null;

  setResearchFetch(fetchImpl: typeof fetch | null) {
    this.researchFetch = fetchImpl;
  }

  async elementSecurity(tabId: number, elementId: unknown): Promise<ElementSecurity | null> {
    if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return null;
    const gateBlind = (why: string, level: 'warn' | 'info' = 'warn') =>
      Logger[level]('MCP Server', `The security gate could not read the risk facts of element [${String(elementId)}] (${why}), so it judged the action on the element line alone.`);
    try {
      const response: any = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 3000);
        try {
          chrome.tabs.sendMessage(tabId, { action: 'ELEMENT_SECURITY', payload: { element_id: elementId } }, TOP_FRAME, (resp: any) => {
            clearTimeout(timer);
            resolve(chrome.runtime?.lastError ? null : resp ?? null);
          });
        } catch (_) {
          clearTimeout(timer);
          resolve(null);
        }
      });
      if (!response) {
        gateBlind('the page did not answer in time');
        return null;
      }
      if (response.success === false) {
        gateBlind(String(response.error || 'the element is gone'), 'info');
        return null;
      }
      return response as ElementSecurity;
    } catch (err: any) {
      gateBlind(String(err?.message || 'the ask failed'));
      return null;
    }
  }

  private async requestConfirmation(req: ActionConfirmationRequest): Promise<boolean> {
    const ask = this.runtime?.requestActionConfirmation;
    if (!ask) {
      Logger.warn('MCP Server', `A sensitive action (${req.toolName}) needs user confirmation, but no confirmation channel is connected: the action was refused.`);
      return false;
    }
    try {
      return await ask(req);
    } catch (err: any) {
      Logger.warn('MCP Server', 'The confirmation ask failed; the action was refused.', err);
      return false;
    }
  }

  private originApproved(origin: string): boolean {
    if (!origin) return false;
    try {
      return this.runtime?.isOriginApproved?.(origin) === true;
    } catch (_) {
      return false;
    }
  }

  private async gateElementAction(
    tabId: number,
    tool: 'click' | 'type',
    args: Record<string, any>,
    label: string
  ): Promise<string | null> {
    const sec = await this.elementSecurity(tabId, args.element_id);
    const decision = sensitiveActionDecision({
      tool,
      sec,
      label,
      submitting: tool === 'type' && Boolean(args.submit),
      requiresApproval: TOOL_MAP.get(tool)?.requires_approval === true,
    });
    if (decision.refuse) return decision.refuse;
    if (decision.confirm) {
      const info = await (this.runtime?.browser.tabInfo(tabId).catch(() => null));
      const pageUrl = info?.url || '';
      let targetOrigin = '';
      try { targetOrigin = pageUrl ? new URL(pageUrl).origin : ''; } catch (_) { targetOrigin = ''; }
      if (!this.originApproved(targetOrigin)) {
        const approved = await this.requestConfirmation({
          id: '',
          toolName: tool,
          serializedArgs: JSON.stringify(args),
          tabId,
          frameUrl: pageUrl,
          targetOrigin,
          elementId: Number(args.element_id) || undefined,
          elementLabel: sec?.label || label || undefined,
          variant: decision.confirm.variant,
          actionSummary: decision.confirm.actionSummary,
          reason: decision.confirm.reason,
          pageUrl,
          detail: sec?.formTarget?.formActionHost ? { formActionHost: sec.formTarget.formActionHost } : undefined,
        });
        if (!approved) return CONFIRM_DECLINED_TEXT;
      }
    }
    return null;
  }

  async callTool(name: string, args: any): Promise<ToolOutcome> {
    if (RESEARCH_TOOL_NAMES.has(name)) return await this.research(name, args || {});

    if (!this.runtime) {
      return { text: 'Error: No active browser session', isError: true };
    }

    const tabId = this.runtime.tabs.activeTabId ?? this.runtime.tabs.ownerTabId;

    if (!tabId) {
      return { text: 'Error: No active tab', isError: true };
    }

    try {
      return await this.executeTool(name, normalizeElementId(args), tabId);
    } catch (err: any) {
      Logger.error('MCP Server', `Tool ${name} failed`, err);
      return { text: `Error: ${err.message}`, isError: true };
    }
  }

  private async executeTool(name: string, args: any, tabId: number): Promise<ToolOutcome> {
    const rt = this.runtime!;
    if (name !== 'type' && name !== 'click') this.lastTyped.delete(tabId);

    switch (name) {
      case 'read_page': {
        const part = readPagePart(args?.part);
        if (part === null) return { text: `Error: part must be a whole number from 1 up, got ${JSON.stringify(args?.part)}.`, isError: true };
        const hasId = args?.element_id !== undefined && args?.element_id !== null;
        const frames = hasId ? [] : await readFrameTexts(tabId).catch(() => []);
        const outcome = await this.run(tabId, { action: 'read_page', part, ...(hasId ? { element_id: args.element_id } : {}), ...(frames.length ? { frames } : {}) }, rt);
        if (!outcome.ok) return outcome.result;
        const read: any = outcome.exec?.result || {};
        const text = typeof read.pageText === 'string' && read.pageText ? read.pageText : '(no text)';
        const body = typeof read.links === 'string' && read.links ? `${text}\n\n${read.links}` : text;
        const editorNote = read.hidesLines ? `\n${EDITOR_LINES_NOTE}` : '';
        const head = `${hasId ? `Text of element [${args.element_id}]` : 'Page text'} (${read.note || `part ${part}`}):${editorNote}`;
        const url = (await rt.browser.tabInfo(tabId).catch(() => null))?.url || '';
        const hash = textHash(`${url}\n${hasId ? args.element_id : ''}\n${part}\n${body}`);
        const same = this.lastTextHash.get(tabId) === hash;
        this.lastTextHash.set(tabId, hash);
        return { text: `${same ? `${SAME_TEXT_NOTE}\n` : ''}${head}\n${wrapUntrusted(sourceOf(url), body)}` };
      }

      case 'get_page_elements': {
        const snapshot = await takeSnapshot(tabId, { showBadges: false, maxElements: 100 }, {
          isTabInScope: async () => true,
          sleep: (ms) => rt.clock.sleep(ms)
        });
        this.elementLines.set(tabId, elementLinesById(snapshot.elementsText || ''));
        return { text: snapshot.elementsText || '(no interactive elements found)' };
      }

      case 'find': {
        const query = String(args?.query ?? '').trim();
        if (!query) return { text: 'Error: find needs a query: the plain words to look for, such as "next page".', isError: true };
        const outcome = await this.run(tabId, { action: 'find_element', query }, rt);
        if (!outcome.ok) return outcome.result;
        const found: any = outcome.exec?.result || {};
        const known = this.elementLines.get(tabId) ?? new Map<number, string>();
        for (const m of Array.isArray(found.matches) ? found.matches : []) {
          if (Number.isFinite(Number(m?.id)) && typeof m?.line === 'string') known.set(Number(m.id), m.line);
        }
        this.elementLines.set(tabId, known);
        return { text: outcome.exec?.message || `No element on this page matches "${query}".` };
      }

      case 'take_screenshot': {
        return await this.takeScreenshot(tabId, args);
      }

      case 'click': {
        const refusal = coordinateClickRefusal(args);
        if (refusal) return { text: refusal, isError: true };
        if (args?.element_id === undefined || args?.element_id === null) {
          return await this.clickAtCoordinates(tabId, args, rt);
        }
        const target = this.elementLines.get(tabId)?.get(Number(args.element_id)) || '';
        if (BOT_CHECK_PATTERN.test(target)) return { text: botCheckRefusal(args.element_id, target), isError: true };
        const gateRefusal = await this.gateElementAction(tabId, 'click', args, target);
        if (gateRefusal) return { text: `Error: ${gateRefusal}`, isError: true };
        const outcome = await this.run(tabId, { action: 'click', element_id: args.element_id }, rt);
        if (!outcome.ok) return outcome.result;
        this.lastTyped.delete(tabId);
        const arrived = outcome.exec?.effect === 'url_changed' ? await this.arrivedPageText(tabId, rt) : linkNotOpenedNote(target);
        return await this.observed(tabId, `Clicked element [${args.element_id}]${args.reason ? `: ${args.reason}` : ''}${arrived}`, outcome.exec);
      }

      case 'type': {
        const hasId = args?.element_id !== undefined && args?.element_id !== null;
        const field = hasId ? this.elementLines.get(tabId)?.get(Number(args.element_id)) || '' : '';
        if (BOT_CHECK_PATTERN.test(field)) return { text: botCheckRefusal(args.element_id, field), isError: true };
        if (hasId) {
          const gateRefusal = await this.gateElementAction(tabId, 'type', args, field);
          if (gateRefusal) return { text: `Error: ${gateRefusal}`, isError: true };
        }
        const mode = args.mode === 'append' ? 'append' : 'replace';
        const outcome = await this.run(tabId, {
          action: 'type',
          ...(hasId ? { element_id: args.element_id } : {}),
          text: args.text,
          submit: args.submit,
          mode
        }, rt);
        if (!outcome.ok) return outcome.result;
        this.lastTyped.add(tabId);
        const arrived = outcome.exec?.effect === 'url_changed' ? await this.arrivedPageText(tabId, rt) : '';
        const where = hasId ? `element [${args.element_id}]` : `the focused element${outcome.exec?.label ? ` (${outcome.exec.label})` : ''}`;
        const how = mode === 'append' ? 'Appended to' : 'Typed into';
        const readBack = outcome.exec?.via === 'cdp' ? fieldReadBack(outcome.exec?.fieldText, String(args.text ?? '')) : '';
        return await this.observed(tabId, `${how} ${where}${mode === 'replace' ? ' (replaced its content)' : ''}${args.submit ? ' and pressed Enter' : ''}${args.reason ? `: ${args.reason}` : ''}${readBack}${arrived}`, outcome.exec);
      }

      case 'press_key': {
        const resolved = resolveKey(args?.key, args?.modifiers);
        if ('error' in resolved) return { text: resolved.error, isError: true };
        const outcome = await this.run(tabId, { action: 'press_key', key: args.key, modifiers: Array.isArray(args.modifiers) ? args.modifiers : [] }, rt);
        if (!outcome.ok) return outcome.result;
        const arrived = outcome.exec?.effect === 'url_changed' ? await this.arrivedPageText(tabId, rt) : '';
        const label = outcome.exec?.label || resolved.label;
        return await this.observed(tabId, `Pressed ${label}${args.reason ? `: ${args.reason}` : ''}${arrived}`, outcome.exec);
      }

      case 'scroll': {
        const direction = args?.direction === 'up' ? 'up' : 'down';
        const action: Record<string, unknown> = { action: 'scroll', direction };
        const hasX = args?.x !== undefined && args?.x !== null;
        const hasY = args?.y !== undefined && args?.y !== null;
        if (args?.element_id !== undefined && args?.element_id !== null) {
          action.element_id = args.element_id;
        } else if (hasX || hasY) {
          if (!(hasX && hasY)) return { text: 'Error: scroll at a point needs both x and y read off a take_screenshot picture.', isError: true };
          const mapped = this.pictureToViewport(tabId, args);
          if ('error' in mapped) return { text: mapped.error, isError: true };
          action.x = mapped.point.x;
          action.y = mapped.point.y;
        }
        const outcome = await this.run(tabId, action, rt);
        if (!outcome.ok) return outcome.result;
        const text = scrollResultText(direction, outcome.exec?.result as ScrollMeasurement | undefined);
        return await this.observed(tabId, `${text}${args?.reason ? ` Reason: ${args.reason}` : ''}`, outcome.exec);
      }

      case 'navigate': {
        const outcome = await this.run(tabId, { action: 'navigate', url: args.url }, rt);
        if (!outcome.ok) return outcome.result;
        return { text: `Navigated to ${args.url}${args.reason ? `: ${args.reason}` : ''}${await this.arrivedPageText(tabId, rt)}` };
      }

      case 'wait': {
        const outcome = await this.run(tabId, { action: 'wait', amount: args.amount }, rt);
        if (!outcome.ok) return outcome.result;
        const waited = outcome.exec?.message || 'Waited';
        return { text: `${waited}${args.reason ? `: ${args.reason}` : ''}` };
      }

      case 'go_back':
      case 'go_forward': {
        const back = name === 'go_back';
        const outcome = await this.run(tabId, { action: back ? 'go_back' : 'go_forward' }, rt);
        if (!outcome.ok) return outcome.result;
        if (outcome.exec?.effect !== 'url_changed') {
          return { text: back
            ? 'Did not move: there is no earlier page in this tab\'s history.'
            : 'Did not move: there is no later page in this tab\'s history.' };
        }
        const how = back ? 'Went back in history' : 'Went forward in history';
        return { text: `${how}${args?.reason ? `: ${args.reason}` : ''}${await this.arrivedPageText(tabId, rt)}` };
      }

      case 'finish': {
        const table = finishTableOf(args.table);
        if (typeof table === 'string') return { text: table, isError: true };
        return { text: `TASK_COMPLETE: ${args.answer}`, ...(table ? { table } : {}), outcome: finishOutcomeOf(args.outcome) };
      }

      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  }

  private async research(name: string, args: any): Promise<ToolOutcome> {
    const settings = await Promise.resolve(this.runtime?.settings ? this.runtime.settings() : Storage.getSettings()).catch(() => null);
    const research = normalizeResearch(settings?.research);
    if (!research.enabled) {
      return { text: `Error: web research is off in Settings > Research, so ${name} did not run. Use the tab, or tell the user.`, isError: true };
    }
    const deps = { fetchImpl: this.researchFetch ?? undefined, signal: this.runtime?.control.stepSignal() };
    try {
      if (name === 'web_search') {
        const out = await webSearch(args, research, deps);
        return { text: out.text, ...(out.isError ? { isError: true } : {}) };
      }
      const out = await fetchUrl(args, deps);
      return { text: out.text, ...(out.isError ? { isError: true } : {}), ...(out.label ? { label: out.label } : {}) };
    } catch (err: any) {
      Logger.error('MCP Server', `Tool ${name} failed`, err);
      return { text: `Error: ${err?.message || String(err)}`, isError: true };
    }
  }

  private screenshotDepsFor(tabId: number): ScreenshotDeps {
    if (this.screenshotDeps) return this.screenshotDeps(tabId);
    return {
      isTabInScope: (tId) => this.runtime!.browser.isTabInScope(tId),
      sendCommand: (tId, method, params, control) => this.sendCdp(tId, method, params, control),
      page: chromePagePort()
    };
  }

  private async sendCdp(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    control?: { signal?: AbortSignal; stopRequested?: boolean; pauseRequested?: boolean }
  ): Promise<any> {
    await cdp.attach(tabId);
    return cdp.sendCommand(tabId, method, params, control);
  }

  private async takeScreenshot(tabId: number, args: Record<string, any>): Promise<ToolOutcome> {
    if (this.visionUnavailable) {
      return {
        text: 'Error: this model cannot see pictures, so the screenshot was not taken. Use read_page instead.',
        isError: true
      };
    }
    try {
      const shot = await captureScreenshot(tabId, this.screenshotDepsFor(tabId));
      const tempFrame = makeFrame(
        {
          url: (await this.runtime!.browser.tabInfo(tabId))?.url ?? '',
          viewportWidth: shot.viewportWidth,
          viewportHeight: shot.viewportHeight,
          devicePixelRatio: shot.devicePixelRatio,
          scrollX: shot.scrollX,
          scrollY: shot.scrollY,
          sig: shot.sig
        },
        { width: shot.imageWidth, height: shot.imageHeight }
      );
      this.frames.set(tabId, tempFrame);
      const shotKey = shot.sig
        ? JSON.stringify([tempFrame.url, shot.sig.interactiveHash, shot.sig.textHash, shot.scrollX, shot.scrollY, shot.viewportWidth, shot.viewportHeight])
        : null;
      const samePicture = shotKey !== null && this.lastShotKey.get(tabId) === shotKey;
      if (shotKey) this.lastShotKey.set(tabId, shotKey);
      else this.lastShotKey.delete(tabId);
      this.mintedImages += 1;
      const imageId = `shot-${Date.now().toString(36)}-${this.mintedImages}`;
      this.images.set(imageId, { data: shot.base64, mediaType: shot.mediaType, tabId });
      while (this.images.size > PICTURE_KEEP) {
        const oldest = this.images.keys().next().value;
        if (oldest === undefined) break;
        this.images.delete(oldest);
      }
      const how = this.coordinateSpace === 'per-mille'
        ? 'To click on it, give x and y on a 0-1000 scale of this picture.'
        : 'Coordinates you read off this picture are pixels in this picture.';
      return {
        text: `${samePicture ? `${SAME_PICTURE_NOTE} ` : ''}Captured the visible page (${shot.imageWidth}x${shot.imageHeight}, ${shot.mediaType}). ${how}`,
        image: {
          type: 'image',
          data: shot.base64,
          mediaType: shot.mediaType,
          imageId,
          imageWidth: shot.imageWidth,
          imageHeight: shot.imageHeight
        }
      };
    } catch (err: any) {
      const why = err instanceof ScreenshotError ? err.message : `Error: the screenshot failed: ${err?.message || String(err)}`;
      Logger.info('MCP Server', `Screenshot failed: ${why}`);
      return { text: `${why} Read the page text with read_page instead.`, isError: true };
    }
  }

  private pictureToViewport(tabId: number, args: Record<string, any>): { point: { x: number; y: number }; frame: CoordinateFrame; reading: string } | { error: string } {
    const frame = this.frameFor(tabId);
    if (!frame) return { error: 'Error: no screenshot has been taken for this tab yet. Take one before using x and y.' };
    const read = toPicturePixels(this.coordinateSpace, Number(args.x), Number(args.y), { width: frame.imageWidth, height: frame.imageHeight });
    const scaleEnd = read.reading === 'fraction' ? 1 : 1000;
    const atEdge = (value: number, raw: number, size: number) => (read.reading !== 'pixels' && raw <= scaleEnd && value >= size ? size - 1 : value);
    const x = atEdge(read.x, Number(args.x), frame.imageWidth);
    const y = atEdge(read.y, Number(args.y), frame.imageHeight);
    if (!isInsideFrame(frame, x, y)) {
      return {
        error: this.coordinateSpace === 'per-mille'
          ? `Error: (${Number(args.x)}, ${Number(args.y)}) is outside the picture. x and y are positions from 0 to 1000 of the picture (${frame.imageWidth}x${frame.imageHeight}), not pixels. If the page changed, take a new screenshot first.`
          : outOfFrameMessage(frame, Number(args.x), Number(args.y))
      };
    }
    return { point: imageToViewport(frame, x, y), frame, reading: read.reading };
  }

  private async clickAtCoordinates(tabId: number, args: Record<string, any>, rt: RunRuntime): Promise<ToolOutcome> {
    const mapped = this.pictureToViewport(tabId, args);
    if ('error' in mapped) return { text: mapped.error, isError: true };
    const { frame } = mapped;

    const live = await this.readLiveState(tabId, rt, this.screenshotDepsFor(tabId));
    const check = checkFrame(frame, live);
    if (!check.ok) {
      return { text: check.reason || 'Error: the screenshot is out of date. Take a new one.', isError: true };
    }

    let point = mapped.point;

    const described = await this.describePointOnPage(tabId, point);
    if (described.refused) {
      return { text: described.refused, isError: true };
    }
    if (described.what && BOT_CHECK_PATTERN.test(described.what)) {
      return { text: botCheckPointRefusal(described.what), isError: true };
    }
    if (described.snapped) point = { x: described.snapped.x, y: described.snapped.y };

    const pointSec: ElementSecurity = {
      fieldKind: described.fieldKind,
      isSubmitControl: described.isSubmitControl,
      formTarget: described.formTarget,
      formHasMaskedField: described.formHasMaskedField,
      label: described.snapped?.what || described.what,
      text: '',
    };
    const pointDecision = sensitiveActionDecision({
      tool: 'click',
      sec: pointSec,
      label: described.snapped?.what || described.what,
      requiresApproval: TOOL_MAP.get('click')?.requires_approval === true,
    });
    if (pointDecision.refuse) return { text: `Error: ${pointDecision.refuse}`, isError: true };
    if (pointDecision.confirm) {
      const info = await (rt.browser.tabInfo(tabId).catch(() => null));
      const pageUrl = info?.url || '';
      let targetOrigin = '';
      try { targetOrigin = pageUrl ? new URL(pageUrl).origin : ''; } catch (_) { targetOrigin = ''; }
      if (!this.originApproved(targetOrigin)) {
        const approved = await this.requestConfirmation({
          id: '',
          toolName: 'click',
          serializedArgs: JSON.stringify(args),
          tabId,
          frameUrl: pageUrl,
          targetOrigin,
          elementLabel: pointSec.label || undefined,
          variant: pointDecision.confirm.variant,
          actionSummary: pointDecision.confirm.actionSummary,
          reason: pointDecision.confirm.reason,
          pageUrl,
          detail: pointSec.formTarget?.formActionHost ? { formActionHost: pointSec.formTarget.formActionHost } : undefined,
        });
        if (!approved) return { text: `Error: ${CONFIRM_DECLINED_TEXT}`, isError: true };
      }
    }

    const outcome = await this.run(tabId, { action: 'click_at', x: point.x, y: point.y }, rt);
    if (!outcome.ok) return outcome.result;
    this.lastTyped.delete(tabId);
    const arrived = outcome.exec?.effect === 'url_changed' ? await this.arrivedPageText(tabId, rt) : '';
    const where = `(${Number(args.x)}, ${Number(args.y)})${mapped.reading === 'pixels' ? ' in the picture' : mapped.reading === 'fraction' ? ' (a fraction of the picture)' : ' on the 0-1000 scale'}`;
    const snapped = described.snapped ? `, moved ${described.snapped.distance} px onto the control next to it` : '';
    const hit = described.what ? ` - ${described.what}${described.interactive ? '' : ', which is not a control'}` : '';
    return await this.observed(tabId, `Clicked at ${where}${snapped}${hit}${args.reason ? `: ${args.reason}` : ''}${arrived}`, outcome.exec);
  }

  private async observed(tabId: number, text: string, exec: ExecResult | undefined): Promise<ToolOutcome> {
    const urlAfter = exec?.effect === 'url_changed' && exec.urlAfter ? exec.urlAfter : undefined;
    const line = observationLine(exec?.effectDetail, urlAfter);
    const result: ToolOutcome = { text: `${text}\n${line}` };
    if (!this.visionUnavailable && isLargeChange(exec?.effectDetail)) {
      const shot = await this.takeScreenshot(tabId, {});
      if (shot.image && !shot.isError) {
        result.image = shot.image;
        result.text += '\nThe view changed a lot: a fresh screenshot of it is attached.';
      }
    }
    return result;
  }

  private coordinateSpace: CoordinateSpace = 'pixels';

  setCoordinateSpace(space: CoordinateSpace): void {
    this.coordinateSpace = space;
  }

  private async readLiveState(tabId: number, rt: RunRuntime, deps: ScreenshotDeps): Promise<{
    url: string; viewportWidth: number; viewportHeight: number; devicePixelRatio: number;
    scrollX: number; scrollY: number; sig: { interactiveHash: string; textHash: string; layoutHash?: string } | null;
  }> {
    const info = await rt.browser.tabInfo(tabId).catch(() => null);
    const probe = await deps.page.probe(tabId);
    const sig = await deps.page.signature(tabId);
    return {
      url: info?.url ?? (await deps.page.tabUrl(tabId)) ?? '',
      viewportWidth: probe.width,
      viewportHeight: probe.height,
      devicePixelRatio: probe.devicePixelRatio,
      scrollX: probe.scrollX,
      scrollY: probe.scrollY,
      sig
    };
  }

  private async describePointOnPage(
    tabId: number,
    point: { x: number; y: number }
  ): Promise<{
    what: string; interactive: boolean; refused?: string; snapped?: { x: number; y: number; distance: number; what?: string };
    fieldKind?: string; isSubmitControl?: boolean; formTarget?: { formActionHost?: string; formMethod?: 'get' }; formHasMaskedField?: boolean;
  }> {
    if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return { what: '', interactive: false };
    try {
      const response: any = await new Promise((resolve) => {
        try {
          chrome.tabs.sendMessage(tabId, { action: 'DESCRIBE_POINT', payload: { ...point, snap: true } }, TOP_FRAME, (resp) => {
            resolve(chrome.runtime?.lastError ? null : resp ?? null);
          });
        } catch (_) {
          resolve(null);
        }
      });
      if (!response) return { what: '', interactive: false };
      if (response.success === false) {
        return { what: String(response.what || ''), interactive: false, refused: String(response.error || 'Error: that point was refused.') };
      }
      const snap = response.snapped;
      const snapped = snap && Number.isFinite(Number(snap.x)) && Number.isFinite(Number(snap.y))
        ? { x: Number(snap.x), y: Number(snap.y), distance: Number(snap.distance) || 0 }
        : undefined;
      return {
        what: String(response.what || ''),
        interactive: response.interactive === true,
        ...(response.fieldKind ? { fieldKind: String(response.fieldKind) } : {}),
        ...(response.isSubmitControl !== undefined ? { isSubmitControl: response.isSubmitControl === true } : {}),
        ...(response.formTarget && typeof response.formTarget === 'object' ? { formTarget: response.formTarget } : {}),
        ...(response.formHasMaskedField !== undefined ? { formHasMaskedField: response.formHasMaskedField === true } : {}),
        ...(snapped ? { snapped } : {}),
      };
    } catch (_) {
      return { what: '', interactive: false };
    }
  }

  private lastTyped = new Set<number>();
  private lastTextHash = new Map<number, string>();
  private lastShotKey = new Map<number, string>();


  async pagePreview(): Promise<string> {
    const rt = this.runtime;
    const tabId = rt ? rt.tabs.activeTabId ?? rt.tabs.ownerTabId : null;
    if (!rt || !tabId) return '';
    try {
      const snapshot = await takeSnapshot(tabId, { showBadges: false, maxElements: 0 }, {
        isTabInScope: async () => true,
        sleep: (ms) => rt.clock.sleep(ms)
      });
      return snapshot.pageText || '(page has no text)';
    } catch (err: any) {
      return `Error: ${err?.message || String(err)}`;
    }
  }

  private async arrivedPageText(tabId: number, rt: RunRuntime): Promise<string> {
    try {
      const snapshot = await takeSnapshot(tabId, { showBadges: false, maxElements: 0 }, {
        isTabInScope: async () => true,
        sleep: (ms) => rt.clock.sleep(ms)
      });
      const head = `\n\nNOW ON: ${snapshot.title || 'Untitled'} (${snapshot.url || ''})`;
      return `${head}\nPAGE TEXT (no need to call read_page for the start of this page):\n${wrapUntrusted(sourceOf(snapshot.url || ''), snapshot.pageText || '(page has no text)')}`;
    } catch (_) {
      return '';
    }
  }

  private async run(
    tabId: number,
    action: Record<string, unknown>,
    rt: RunRuntime
  ): Promise<{ ok: boolean; result: ToolOutcome; exec?: ExecResult }> {
    const settings = await Promise.resolve(rt.settings?.()).catch(() => null);
    const outcome: ExecResult = await executeAction(tabId, action, {
      runRuntime: rt,
      signal: rt.control.stepSignal(),
      actionDelayMs: Number(settings?.actionDelayMs) > 0 ? Number(settings?.actionDelayMs) : undefined
    });
    if (outcome.success) return { ok: true, result: { text: '' }, exec: outcome };
    const why = outcome.error || outcome.message || 'the action did not go through';
    Logger.info('MCP Server', `Tool action "${String(action.action)}" failed: ${why}`);
    const hint = /is covered by/i.test(why) && this.lastTyped.has(tabId)
      ? ' You just typed into a field: to submit it, call type again with submit=true (it presses Enter) instead of clicking.'
      : '';
    return { ok: false, result: { text: `Error: ${why}${hint}`, isError: true }, exec: outcome };
  }
}
