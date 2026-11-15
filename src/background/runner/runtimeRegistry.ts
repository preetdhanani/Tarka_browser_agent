import type { Settings } from '../../shared/storage.ts';
import type {
  ControlSnapshot, Effect, EffectDetail, HistoryEntry, NodeName, PolicyMode, TrailEntry,
  OneShot, PageSig, GateContext, GateDecision,
} from '../types.ts';

export interface RunControl {
  pauseRequested: boolean;
  stopRequested: boolean;
  stepSignal(): AbortSignal;
  abortStep(reason: 'user_pause' | 'user_stop'): void;
  isUserAbort(err: unknown, signal?: AbortSignal): boolean;
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
  effectDetail?: EffectDetail;
  fieldText?: string | null;
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

export interface ActionConfirmationRequest {
  id: string;
  toolName: string;
  serializedArgs: string;
  tabId: number;
  frameUrl: string;
  targetOrigin: string;
  elementId?: number;
  elementLabel?: string;
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
  requestActionConfirmation?: (req: ActionConfirmationRequest) => Promise<boolean>;
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
