
import { describeRestrictedUrl } from './tabs.ts';
import { checkWebUrl } from '../research/urlPolicy.ts';
import { inputDispatcher } from './input.ts';
import type { ExecResult, RunRuntime } from '../runner/runtimeRegistry.ts';
import type { EffectDetail, OneShot } from '../types.ts';

export interface ExecuteActionDeps {
  runRuntime?: RunRuntime;
  docId?: string;
  signal?: AbortSignal;
  dispatchAction?: (tabId: number, action: any, opts: any) => Promise<any>;
  tabInfo?: (tabId: number) => Promise<{ url: string; title: string; windowId: number; groupId: number; status: string } | null>;
  waitForTabComplete?: (tabId: number, ms: number, signal?: AbortSignal) => Promise<void>;
  watchLoadStart?: (tabId: number, ms: number, signal?: AbortSignal) => Promise<boolean>;
  waitDomQuiet?: (tabId: number, quietMs: number, maxMs: number) => Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  actionDelayMs?: number;
  readProbe?: (tabId: number) => Promise<EffectDetail | null>;
  isTabInScope?: (tabId: number) => Promise<boolean>;
}

export const LOAD_START_WINDOW_MS = 500;

export const LOAD_COMPLETE_MAX_MS = 4000;

export const SETTLE_QUIET_MAX_MS = 800;

// Chrome emits URL-only updates for SPA history changes without a document load event.
export function watchLoadStartWithChrome(tabId: number, ms: number, signal?: AbortSignal): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
      resolve(value);
    };
    const listener = (updatedTabId: number, changeInfo: { status?: string; url?: string }) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'loading') finish(true);
    };
    const timer = setTimeout(() => finish(false), ms);
    chrome.tabs.onUpdated.addListener(listener);
    signal?.addEventListener('abort', () => finish(false), { once: true });
  });
}

const OBSERVED_VERBS = new Set(['click', 'click_at', 'type', 'press_key', 'scroll']);

export function tabGoneText(tabId: number): string {
  return `The target tab [${tabId}] no longer exists (it was probably closed). Open the page you want automated and start the task again.`;
}

export async function executeAction(
  tabId: number,
  action: any,
  deps: ExecuteActionDeps
): Promise<ExecResult> {
  const signal = deps.signal ?? deps.runRuntime?.control.stepSignal();
  const verb = action?.action;

  if (signal?.aborted) {
    return {
      success: false,
      error: 'Action aborted',
      via: verb === 'navigate' || verb === 'go_back' || verb === 'go_forward' ? 'background' : 'cdp',
      effect: 'none',
    };
  }

  const readTab = deps.tabInfo ?? (deps.runRuntime ? deps.runRuntime.browser.tabInfo : null);
  if (readTab) {
    const tabInfo = await readTab(tabId).catch(() => null);
    if (!tabInfo) {
      return { success: false, error: tabGoneText(tabId), via: 'background', effect: 'none' };
    }
    const restricted = describeRestrictedUrl(tabInfo.url ?? '');
    if (restricted) {
      return { success: false, error: `Refused by security policy: ${restricted}`, via: 'background', effect: 'none' };
    }
    const scopeCheck = deps.isTabInScope ?? deps.runRuntime?.browser.isTabInScope;
    if (scopeCheck && !(await scopeCheck(tabId).catch(() => false))) {
      return {
        success: false,
        error: 'Refused by security policy: that tab is outside this run\'s scope (it is not in the run\'s tab sandbox), so no action was sent to it.',
        via: 'background',
        effect: 'none',
      };
    }
  }

  if (verb === 'navigate' && action?.url) {
    const restriction = describeRestrictedUrl(action.url);
    if (restriction) {
      return {
        success: false,
        error: restriction,
        via: 'background',
        effect: 'none',
      };
    }

    const checked = checkWebUrl(action.url);
    if (!checked.ok) {
      return {
        success: false,
        error: `Navigate target refused: ${checked.error}`,
        via: 'background',
        effect: 'none',
      };
    }
  }

  if (verb === 'wait') {
    const rawWait = Number((action as any).amount ?? (action as any).seconds ?? 1);
    const waitSec = Number.isFinite(rawWait) ? Math.min(5, Math.max(1, rawWait)) : 1;
    const sleepFn =
      deps.sleep ??
      ((ms: number, sig?: AbortSignal) =>
        deps.runRuntime?.clock ? deps.runRuntime.clock.sleep(ms, sig) : new Promise<void>((r) => setTimeout(r, ms)));
    try {
      await sleepFn(waitSec * 1000, signal);
    } catch (err: any) {
      if (signal?.aborted) {
        return { success: false, error: 'Action aborted', via: 'background', effect: 'none' };
      }
      throw err;
    }
    return { success: true, message: `Waited ${waitSec}s`, via: 'background', effect: 'none' };
  }

  const getTabUrl = async (tId: number): Promise<string> => {
    if (deps.tabInfo) {
      const info = await deps.tabInfo(tId).catch(() => null);
      return info?.url ?? '';
    }
    if (deps.runRuntime) {
      const info = await deps.runRuntime.browser.tabInfo(tId).catch(() => null);
      return info?.url ?? '';
    }
    return '';
  };

  const waitComplete = async (tId: number, ms: number): Promise<void> => {
    if (deps.waitForTabComplete) {
      await deps.waitForTabComplete(tId, ms, signal).catch(() => {});
    } else if (deps.runRuntime) {
      await deps.runRuntime.browser.waitForTabComplete(tId, ms).catch(() => {});
    }
  };

  const waitQuiet = async (tId: number, quietMs: number, maxMs: number): Promise<void> => {
    if (deps.waitDomQuiet) {
      await deps.waitDomQuiet(tId, quietMs, maxMs).catch(() => {});
    } else if (deps.runRuntime) {
      await deps.runRuntime.browser.waitDomQuiet(tId, quietMs, maxMs).catch(() => {});
    }
  };

  const loadStarted = async (tId: number, urlBefore: string): Promise<boolean> => {
    const info = deps.tabInfo
      ? await deps.tabInfo(tId).catch(() => null)
      : deps.runRuntime
        ? await deps.runRuntime.browser.tabInfo(tId).catch(() => null)
        : null;
    if (info?.status === 'loading') return true;
    if (info?.url && urlBefore && info.url !== urlBefore) return info.status !== 'complete';
    const watch = deps.watchLoadStart ?? watchLoadStartWithChrome;
    return await watch(tId, LOAD_START_WINDOW_MS, signal).catch(() => false);
  };

  const doSleep = async (ms: number): Promise<void> => {
    if (deps.sleep) {
      await deps.sleep(ms, signal).catch(() => {});
    } else if (deps.runRuntime?.clock) {
      await deps.runRuntime.clock.sleep(ms, signal).catch(() => {});
    } else {
      await new Promise((r) => setTimeout(r, ms));
    }
  };

  try {
    const urlBefore = await getTabUrl(tabId);
    const isNav = verb === 'navigate' || verb === 'go_back' || verb === 'go_forward';

    const res = deps.dispatchAction
      ? await deps.dispatchAction(tabId, action, { docId: deps.docId, signal })
      : await inputDispatcher.dispatchAction(tabId, action, {
          docId: deps.docId,
          signal,
          sleep:
            deps.sleep ??
            ((ms, s) =>
              deps.runRuntime?.clock
                ? deps.runRuntime.clock.sleep(ms, s)
                : new Promise((r) => setTimeout(r, ms))),
          control: deps.runRuntime
            ? {
                stopRequested: deps.runRuntime.control.stopRequested,
                pauseRequested: deps.runRuntime.control.pauseRequested,
                signal,
              }
            : undefined,
        });

    const viaSynthetic = res.via === 'synthetic';
    let effect =
      (res.effect as ExecResult['effect']) ||
      (res.success && !viaSynthetic ? 'dom_changed' : 'none');
    if (verb === 'find_element' || verb === 'read_page') effect = 'none';
    const isClick = verb === 'click' || verb === 'click_at';
    const isTypeSubmit = verb === 'type' && (res.submitted || Boolean(action?.submit));
    const isPressNav = verb === 'press_key' && effect === 'url_changed';

    let urlAfter = '';
    if (res.success && (isNav || isClick || isTypeSubmit || isPressNav)) {
      if (!action?.expected_outcome && await loadStarted(tabId, urlBefore)) {
        await waitComplete(tabId, LOAD_COMPLETE_MAX_MS);
      }
      urlAfter = await getTabUrl(tabId);
      if (urlAfter && urlBefore !== urlAfter) {
        effect = 'url_changed';
      } else if (isNav) {
        effect = 'none';
      }
    }

    if (res.success && (isNav || isClick || isTypeSubmit || verb === 'scroll' || verb === 'press_key')) {
      await waitQuiet(tabId, 300, SETTLE_QUIET_MAX_MS);
    }

    let effectDetail: EffectDetail | undefined = res.effectDetail;
    if (res.success && OBSERVED_VERBS.has(verb)) {
      const reader = deps.readProbe ?? (deps.dispatchAction ? null : (tId: number) => inputDispatcher.readProbe(tId));
      const settled = reader ? await reader(tabId).catch(() => null) : null;
      if (settled) effectDetail = settled;
    }

    const delay = deps.actionDelayMs ?? 0;
    if (res.success && delay > 0) {
      await doSleep(delay);
    }

    let oneShot: OneShot | undefined = undefined;
    if (verb === 'read_page' && res.success) {
      const pageText = res.result?.pageText ?? res.pageText ?? res.message ?? '';
      const note = typeof res.result?.note === 'string' && res.result.note ? res.result.note : undefined;
      oneShot = { label: note ? `Page Text (${note})` : 'Page Text', text: pageText, step: action.step ?? 0, ...(note ? { note } : {}) };
    }

    const findMessage = res.message;
    if (verb === 'find_element' && res.success) {
      oneShot = { label: 'Element Matches', text: findMessage ?? '', step: action.step ?? 0 };
    }

    return {
      success: res.success,
      message: findMessage,
      error: res.error,
      label: res.label ?? undefined,
      submitted: res.submitted,
      result: res.result ?? res.results ?? undefined,
      resultData: res.result ?? res.results ?? undefined,
      via: isNav ? 'background' : (res.via ?? 'cdp'),
      effect,
      urlAfter: urlAfter || res.urlAfter || undefined,
      syntheticReason: (res as any).syntheticReason,
      oneShot,
      ...(res.stale ? { stale: res.stale } : {}),
      ...(res.obscuredBy ? { obscuredBy: res.obscuredBy } : {}),
      ...(res.securityRefusal ? { securityRefusal: res.securityRefusal } : {}),
      ...(effectDetail ? { effectDetail } : {}),
      ...(res.fieldText !== undefined ? { fieldText: res.fieldText } : {}),
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      via: verb === 'navigate' || verb === 'go_back' || verb === 'go_forward' ? 'background' : 'synthetic',
      effect: 'none',
    };
  }
}
