// src/background/runner/runtimeRegistry.ts
// Non-serializable per-thread dependencies. The MCP client and browser APIs look them up by
// thread_id. Nothing with functions, keys or signals is ever placed in a checkpoint or trace.
import type { Settings } from '../../shared/storage.ts';
import type {
  ControlSnapshot, Effect, EffectDetail, HistoryEntry, NodeName, PolicyMode, TrailEntry,
  OneShot, PageSig, GateContext, GateDecision,
} from '../types.ts';

export interface RunControl {
  pauseRequested: boolean;
  stopRequested: boolean;
  stepSignal(): AbortSignal;                            // fresh AbortController per LLM call or wait
  abortStep(reason: 'user_pause' | 'user_stop'): void;  // signal.reason = { tarka: 'user', reason }
  isUserAbort(err: unknown, signal?: AbortSignal): boolean; // checks the reason tag, never error text
  snapshot(): ControlSnapshot;
}

export interface LlmPort {
  complete(req: {
    node: string;
    mode?: string;
    role: string;
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    schema: object | null;
    signal: AbortSignal;
    callbacks?: unknown;
  }): Promise<{
    text: string;
    provider: string;
    model: string;
    usage?: { tokensIn: number; tokensOut: number };
    meta: Record<string, unknown>;
  }>;
}

export interface ExecResult {
  success: boolean;
  message?: string;
  error?: string;
  label?: string;
  submitted?: boolean;
  result?: unknown;
  resultData?: unknown;
  via: 'cdp' | 'synthetic' | 'background';
  effect: Effect;
  urlAfter?: string;
  syntheticReason?: string;
  oneShot?: OneShot;
  /** The facts the effect probe measured around the action (see EffectDetail). */
  effectDetail?: EffectDetail;
  /** The text of the field a type wrote into, read back right after typing; null when it could not be read. */
  fieldText?: string | null;
  /** W2-B5: the dispatch's own verdicts, carried into the result the model and the panel read. */
  securityRefusal?: boolean;
  stale?: boolean;
  obscuredBy?: string;
}

export interface BrowserPort {
  tabInfo(tabId: number): Promise<{ url: string; title: string; windowId: number; groupId: number; status: string } | null>;
  snapshot(tabId: number, opts: { showBadges: boolean; maxElements: number }): Promise<unknown>;
  navigate(tabId: number, url: string): Promise<void>;
  reload(tabId: number): Promise<void>;
  goBack(tabId: number): Promise<void>;
  waitForTabComplete(tabId: number, ms: number): Promise<void>;
  waitDomQuiet(tabId: number, quietMs: number, maxMs: number): Promise<void>;
  cdp: {
    ensureAttached(tabId: number): Promise<{ mode: 'cdp' | 'synthetic'; reason: string | null }>;
  };
  clearBadges(tabId: number): Promise<void>;
  isTabInScope(tabId: number): Promise<boolean>;
}

/**
 * What the server asks the runner to publish when a tool call needs the user's confirmation:
 * the exact action (tool, serialized arguments, tab, frame, origin, element), so the approval is
 * bound to this one call and nothing else.
 */
export interface ActionConfirmationRequest {
  id: string;
  toolName: string;
  serializedArgs: string;
  tabId: number;
  frameUrl: string;
  targetOrigin: string;
  elementId?: number;
  elementLabel?: string;
  /** The card's variant: 'purchase' or 'submit'. */
  variant: string;
  actionSummary: string;
  reason: string;
  pageUrl: string;
  detail?: { formActionHost?: string };
}

export interface RunRuntime {
  threadId: string;
  ownerTabId: number;
  bootId: string;
  control: RunControl;
  tabs: { activeTabId: number | null; ownerTabId: number };
  windowId: number | 'default';
  tarkaGroupIds: Map<number, number>;
  resumedAfterRestart: boolean;
  settings(): Promise<Settings>;
  llm: LlmPort;
  browser: BrowserPort;
  emit: {
    enterNode(n: string, graph: string, phase?: string): void;
    setPhase(text: string): void;
  };
  clock: {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
  };
  finishPolicy?: (ctx: GateContext) => GateDecision;
  /**
   * Asks the user to confirm one exact action (SEC-2). The server awaits it before dispatching a
   * sensitive click or a submitting type; false or a missing channel refuses the action.
   */
  requestActionConfirmation?: (req: ActionConfirmationRequest) => Promise<boolean>;
  /**
   * CONTRACT-REMEMBER: whether the user approved an action on this origin with "remember for
   * this run" ticked. The gate consults it before it raises a card; a remembered origin raises
   * no card. The trust lasts one run (the runner clears it in startTask/clearHistory/loadChat).
   */
  isOriginApproved?: (origin: string) => boolean;
  typedTexts?: string[];
  navigatedFrom?: { site: string; before: string } | null;
}

const registry = new Map<string, RunRuntime>();

export const runtimeRegistry = {
  set(rt: RunRuntime): void {
    registry.set(rt.threadId, rt);
  },
  get(threadId: string): RunRuntime | undefined {
    return registry.get(threadId);
  },
  delete(threadId: string): void {
    registry.delete(threadId);
  },
  clear(): void {
    registry.clear();
  },
};
