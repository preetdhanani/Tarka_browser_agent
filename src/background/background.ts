
import { isGeminiStreamCut } from './boot/rejections.ts';
import { lastRuntimeError, isValidWebTab, isDisposableTab } from './browser/tabs.ts';
import { AgentRunner } from './runner/AgentRunner.ts';
import { partialResultEntry } from './mcp/historyEntries.ts';
import { callProvider, fetchAvailableModels, getFallbackModels } from './llm/index.ts';
import { resolveEffortSupport } from './llm/effort.ts';
import { getEffectiveContextWindow, DEFAULT_CONTEXT_WINDOW } from './llm/models.ts';
import { BUILTIN_PROVIDER_IDS } from '../shared/storage.ts';
import { Logger } from '../shared/logger.ts';
import { BUILD_STAMP } from '../shared/build.ts';
import { cdp } from './browser/cdp.ts';

self.addEventListener('error', (event: Event) => {
  const errEvent = event as ErrorEvent;
  Logger.error('Background', '[UNCAUGHT_ERROR] Uncaught exception in service worker', errEvent.error || errEvent.message);
});
self.addEventListener('unhandledrejection', (event: Event) => {
  const rejEvent = event as PromiseRejectionEvent;
  if (isGeminiStreamCut(rejEvent.reason)) {
    rejEvent.preventDefault();
    Logger.info('Background', '[GEMINI_STREAM_CUT] Ignored the Google SDK\'s unhandled rejection of a cut stream: the call itself already failed and was logged.');
    return;
  }
  Logger.error('Background', '[UNHANDLED_REJECTION] Unhandled promise rejection in service worker', rejEvent.reason);
});

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultIdleState(): Record<string, unknown> {
  return {
    status: 'idle',
    stepCount: 0,
    task: '',
    history: [],
    planSteps: [],
    currentPhase: '',
    pauseReason: null,
    pendingApproval: null,
    pendingConfirm: null,
    stateVersion: 0,
    bootId: '',
    tarkaGroupId: null,
    effort: null,
    effortProfile: null,
    runStats: null,
    chatId: null,
    context: { used: 0, window: DEFAULT_CONTEXT_WINDOW, windowSource: 'default', estimated: false, summarizedTurns: 0, hasEarlierTurn: false, compacting: false }
  };
}

export interface BackgroundSession {
  engine: AgentRunner;
  ports: Set<chrome.runtime.Port>;
  lastBroadcastHadNoListeners: boolean;
  ownerTabId: number;
}

const sessions = new Map<number, BackgroundSession>();

function adoptTabIntoSession(session: BackgroundSession, tabId?: number | null): void {
  if (!tabId || sessions.get(tabId) === session) return;
  sessions.set(tabId, session);
  Logger.debug('Background', `[SESSION_EXTENDED] Session from tab [${session.ownerTabId}] now also covers tab [${tabId}].`);
}

const START_URL = 'https://www.google.com';

function getOrCreateSession(tabId: number, windowId?: number): BackgroundSession {
  let session = sessions.get(tabId);
  if (session) return session;

  const engine = new AgentRunner(tabId, windowId);
  session = { engine, ports: new Set<chrome.runtime.Port>(), lastBroadcastHadNoListeners: false, ownerTabId: tabId };
  sessions.set(tabId, session);

  engine.setStateChangeCallback((state) => {
    broadcastToSession(session!, 'STATE_UPDATE', state);
    syncKeepaliveAlarm();
  });

  Logger.debug('Background', `[SESSION_CREATED] New session for tab [${tabId}].`);
  return session;
}

function endSessionForClosedTab(tabId: number): void {
  const session = sessions.get(tabId);
  if (!session) {
    AgentRunner.dropStoredState(tabId);
    return;
  }
  sessions.delete(tabId);

  if (session.ownerTabId !== tabId) {
    if (session.engine.activeTabId === tabId) {
      void returnRunToOwnerTab(session, tabId);
    }
    Logger.debug('Background', `[SESSION_TAB_CLOSED] Tab [${tabId}] closed, but its session lives on in its owner tab [${session.ownerTabId}].`);
    return;
  }

  for (const [otherTabId, other] of Array.from(sessions.entries())) {
    if (other === session) sessions.delete(otherTabId);
  }

  session.engine.endRun('stopped', partialResultEntry(TAB_CLOSED_TEXT, 'stopped'));
  AgentRunner.forgetSession(session.engine.sessionId);
  Logger.debug('Background', `[SESSION_CLOSED] Tab [${tabId}] closed. Its session and persisted state are gone.`);
  syncKeepaliveAlarm();
}

const TAB_CLOSED_TEXT = 'The tab of this run was closed, so the run stopped.';

function moveSessionToReplacedTab(addedTabId: number, removedTabId: number): void {
  const session = sessions.get(removedTabId);
  if (!session) return;
  sessions.delete(removedTabId);
  sessions.set(addedTabId, session);
  if (session.ownerTabId === removedTabId) session.ownerTabId = addedTabId;
  session.engine.replaceTab(removedTabId, addedTabId);
  Logger.info('Background', `[TAB_REPLACED] Chrome replaced tab [${removedTabId}] with tab [${addedTabId}]; its session moved with it.`);
}

function tabStillExists(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.get) return resolve(true);
    const maybePromise: any = chrome.tabs.get(tabId, (t: chrome.tabs.Tab | undefined) => {
      resolve(Boolean(t) && !lastRuntimeError());
    });
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then((t: chrome.tabs.Tab | undefined) => resolve(Boolean(t)), () => resolve(false));
    }
  });
}

async function returnRunToOwnerTab(session: BackgroundSession, closedTabId: number): Promise<void> {
  const ownerTabId = session.ownerTabId;
  if (!(await tabStillExists(ownerTabId))) return;
  session.engine.activeTabId = ownerTabId;
  Logger.info('Background', `[TAB_FALLBACK] The working tab [${closedTabId}] closed. The run continues on the owner tab [${ownerTabId}].`);
}

if (typeof chrome !== 'undefined') {
  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId: number) => {
      void cdp.detach(tabId);
      endSessionForClosedTab(tabId);
    });
  }

  if (chrome.tabs && chrome.tabs.onReplaced) {
    chrome.tabs.onReplaced.addListener((addedTabId: number, removedTabId: number) => {
      void cdp.detach(removedTabId);
      moveSessionToReplacedTab(addedTabId, removedTabId);
    });
  }

  if (chrome.tabGroups && chrome.tabGroups.onRemoved) {
    chrome.tabGroups.onRemoved.addListener((group: chrome.tabGroups.TabGroup) => {
      if (!group) return;
      for (const session of new Set(sessions.values())) {
        for (const [windowId, groupId] of Array.from(session.engine.tarkaGroupIds.entries())) {
          if (groupId !== group.id) continue;
          Logger.debug('Background', `[TAB_SANDBOX] Tarka tab group [${group.id}] was closed by user (window [${windowId}]).`);
          session.engine.tarkaGroupIds.delete(windowId);
          void session.engine.persistState();
        }
      }
    });
  }
}

Logger.setBroadcastCallback((logEntry: unknown) => {
  broadcastToAllSidepanels('LOG_ENTRY', logEntry);
});


// Chrome's default panel path is browser-wide; this app scopes the panel per tab.
if (typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

if (typeof chrome !== 'undefined' && chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
    if (!(tab && tab.id)) return;

    setPanelVisibility(tab.id, true);

    if (chrome.sidePanel && chrome.sidePanel.open) {
      // Chrome accepts open() only while the click gesture remains synchronous.
      chrome.sidePanel.open({ tabId: tab.id }).catch((err: unknown) => {
        Logger.warn('Background', '[SIDEPANEL_OPEN_FAILED] chrome.sidePanel.open() was rejected', err);
      });
    }

    getOrCreateSession(tab.id, tab.windowId);

  });
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onConnect) {
  chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    const match = port.name.match(/^(tarka_sidepanel(?:_fresh)?)(?::(-?\d+))?$/);
    if (!match) return;
    if (match[2] === undefined) {
      Logger.warn('Background', '[PORT_CONNECT] Sidepanel UI connected without a tab id in the port name; ignoring the port until the panel resolves its tab.');
      return;
    }

    const tabId = Number(match[2]);

    const session = getOrCreateSession(tabId);
    session.ports.add(port);
    session.lastBroadcastHadNoListeners = false;
    Logger.debug('Background', `[PORT_CONNECT] Sidepanel UI connected to tab [${tabId}]. Active ports for this tab: ${session.ports.size}`);

    port.onDisconnect.addListener(() => {
      session.ports.delete(port);
      Logger.debug('Background', `[PORT_DISCONNECT] Sidepanel UI disconnected from tab [${tabId}]. Active ports for this tab: ${session.ports.size}`);
    });

    if (chrome.tabs && chrome.tabs.get) {
      chrome.tabs.get(tabId, (t: chrome.tabs.Tab) => {
        lastRuntimeError();
        if (t && t.windowId !== undefined) session.engine.windowId = t.windowId;
      });
    }

    (async () => {
      try {
        await session.engine.restorePromise;
      } catch (err) {
        Logger.warn('Background', '[PORT_CONNECT] Session restore failed; proceeding with a clean state', err);
      }

      try {
        port.postMessage({ type: 'STATE_UPDATE', payload: session.engine.getState() });
      } catch (err) {
        Logger.warn('Background', 'Failed sending initial state update on port connect', err);
      }
    })();

    setPanelVisibility(tabId, true);
  });
}

export function broadcastToSession(session: BackgroundSession, type: string, payload: unknown): void {
  if (session.ports.size === 0) {
    if (!session.lastBroadcastHadNoListeners) {
      session.lastBroadcastHadNoListeners = true;
      Logger.debugSilent('Background', `[BROADCAST_DROPPED] No sidepanel connected for tab [${session.engine.sessionId}] - "${type}" updates are being generated but nothing can receive them until that tab's panel reconnects.`);
    }
    return;
  }
  session.lastBroadcastHadNoListeners = false;
  for (const port of Array.from(session.ports)) {
    try {
      port.postMessage({ type, payload });
    } catch (err) {
      session.ports.delete(port);
      const errMsg = errorText(err);
      Logger.debugSilent('Background', `[BROADCAST_ERROR] Dropped a dead sidepanel port for tab [${session.engine.sessionId}] while sending "${type}": ${errMsg}. Active ports for this tab: ${session.ports.size}`);
    }
  }
}

let isBroadcastingToAll = false;

function broadcastToAllSidepanels(type: string, payload: unknown): void {
  if (isBroadcastingToAll) return;
  isBroadcastingToAll = true;
  try {
    for (const session of sessions.values()) {
      broadcastToSession(session, type, payload);
    }
  } finally {
    isBroadcastingToAll = false;
  }
}

const KEEPALIVE_ALARM_NAME = 'tarka_keepalive';
// Chrome may terminate an MV3 worker while it awaits model work.
const KEEPALIVE_INTERVAL_MS = 20000;
let keepaliveIntervalId: ReturnType<typeof setInterval> | null = null;

function anySessionActive(): boolean {
  for (const session of sessions.values()) {
    if (session.engine.status === 'running' || session.engine.status === 'paused') return true;
  }
  return false;
}

function syncKeepaliveAlarm(): void {
  const shouldRun = anySessionActive();

  if (shouldRun && keepaliveIntervalId === null) {
    keepaliveIntervalId = setInterval(() => {
      try {
        chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; });
      } catch (err) {
        Logger.warn('Background', '[KEEPALIVE] Idle-timer ping failed', err);
      }
    }, KEEPALIVE_INTERVAL_MS);
    if (typeof (keepaliveIntervalId as any)?.unref === 'function') {
      (keepaliveIntervalId as any).unref();
    }
    Logger.debug('Background', '[KEEPALIVE_ON] A task is active somewhere - holding the service worker awake.');
  } else if (!shouldRun && keepaliveIntervalId !== null) {
    clearInterval(keepaliveIntervalId);
    keepaliveIntervalId = null;
    Logger.debug('Background', '[KEEPALIVE_OFF] No task active in any window - releasing the service worker.');
  }

  if (typeof chrome === 'undefined' || !chrome.alarms) return;
  try {
    if (shouldRun) {
      chrome.alarms.get(KEEPALIVE_ALARM_NAME, (alarm: chrome.alarms.Alarm | undefined) => {
        if (chrome.runtime.lastError) {
          Logger.warn('Background', '[KEEPALIVE] Could not read keepalive alarm', chrome.runtime.lastError.message);
          return;
        }
        if (!alarm) chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.5 });
      });
    } else {
      chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    }
  } catch (err) {
    Logger.warn('Background', '[KEEPALIVE] Could not sync keepalive alarm', err);
  }
}

function tabsInUse(): Set<number> {
  const ids = new Set<number>(sessions.keys());
  for (const session of sessions.values()) {
    const active = session.engine.activeTabId;
    if (typeof active === 'number') ids.add(active);
  }
  return ids;
}

if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm: chrome.alarms.Alarm) => {
    if (alarm.name === KEEPALIVE_ALARM_NAME) {
      void cdp.reconcileLeakedTargets(tabsInUse());
      if (anySessionActive() && keepaliveIntervalId === null) {
        syncKeepaliveAlarm();
      }
    }
  });
}

Logger.debug('Background', `[WORKER_BOOT] Service worker started (build ${BUILD_STAMP}). MV3 restarts the worker frequently - this line marks a fresh incarnation.`);
void cdp.reconcileLeakedTargets(tabsInUse());

function releaseUserTabFromGroup(tab: chrome.tabs.Tab, groupIdForThisWindow?: number): void {
  if (!groupIdForThisWindow || typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.ungroup || typeof tab.id !== 'number') return;
  if (tab.groupId !== groupIdForThisWindow) return;
  chrome.tabs.ungroup(tab.id, () => {
    lastRuntimeError();
    Logger.debug('Background', `[TAB_RELEASED] Chrome auto-added the user's new Tab ID [${tab.id}] to the 'Tarka' group [${groupIdForThisWindow}] because it was opened from a grouped tab. Removed it again - the group only ever holds tabs the agent itself opened (window [${tab.windowId}]).`);
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs) {
  if (chrome.tabs.onCreated) {
    chrome.tabs.onCreated.addListener((tab: chrome.tabs.Tab) => {
      const session = tab.openerTabId !== undefined ? sessions.get(tab.openerTabId) : undefined;
      if (!session) return;

      if (session.engine.windowId !== 'default' && tab.windowId !== session.engine.windowId) return;

      const groupIdForThisWindow = session.engine.groupIdForWindow(tab.windowId);

      const openedByThisSession = tab.openerTabId !== undefined
        && tab.openerTabId === session.engine.activeTabId
        && session.engine.status === 'running';
      if (!openedByThisSession) {
        if (groupIdForThisWindow) {
          Logger.debug('Background', `[TAB_LEFT_ALONE] Tab [${tab.id}] was opened by the user, not by automation - keeping it outside the 'Tarka' group (window [${tab.windowId}]).`);
          releaseUserTabFromGroup(tab, groupIdForThisWindow);
        }
        return;
      }

      if (typeof tab.id === 'number') {
        adoptTabIntoSession(session, tab.id);
      }

      if (groupIdForThisWindow && typeof chrome.tabs.group === 'function' && typeof tab.id === 'number') {
        chrome.tabs.group({ tabIds: tab.id, groupId: groupIdForThisWindow }, () => {
          lastRuntimeError();
          Logger.debug('Background', `[TAB_SANDBOX] Auto-grouped newly created Tab ID [${tab.id}] into 'Tarka' tab group [${groupIdForThisWindow}] (window [${tab.windowId}])`);
        });
      }

      if (typeof tab.id === 'number') setPanelVisibility(tab.id, true);

      if (session.engine.status === 'running' && typeof tab.id === 'number') {
        const newlyCreatedTabId = tab.id;
        setTimeout(() => {
          chrome.tabs.get(newlyCreatedTabId, (createdTab: chrome.tabs.Tab) => {
            if (lastRuntimeError()) return;
            if (createdTab && isValidWebTab(createdTab) && typeof createdTab.id === 'number') {
              Logger.debug('Background', `[NEW_TAB_DETECTED] Automation switching to newly opened Tab ID [${createdTab.id}] (window [${tab.windowId}])`);
              session.engine.activeTabId = createdTab.id;
            }
          });
        }, 500);
      }
    });
  }

  if (chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener((activeInfo: chrome.tabs.OnActivatedInfo) => {
      setPanelVisibility(activeInfo.tabId, sessions.has(activeInfo.tabId));
    });
  }
}

function setPanelVisibility(tabId: number, shouldShow: boolean): void {
  if (!tabId || typeof chrome === 'undefined' || !chrome.sidePanel || !chrome.sidePanel.setOptions) return;
  const opts = shouldShow
    ? { tabId, path: 'sidepanel/sidepanel.html', enabled: true }
    : { tabId, enabled: false };
  chrome.sidePanel.setOptions(opts, () => {
    lastRuntimeError();
  });
}

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.agent_settings && !changes.models_ctx_cache)) return;
    for (const session of new Set(sessions.values())) void session.engine.refreshContext();
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
    let handled: boolean;
    try {
      handled = routeMessage(request, sender, sendResponse);
    } catch (err) {
      Logger.error('Background', `[MESSAGE_ROUTER_ERROR] Uncaught exception handling action [${request?.action}]`, err);
      try {
        const errMsg = errorText(err);
        sendResponse({ success: false, error: `Internal error: ${errMsg}` });
      } catch (_) {
      }
      return false;
    }
    return handled;
  });
}

function routeMessage(
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean {
  const { action, payload } = request || {};

  if (action === 'CLIENT_ERROR') {
    Logger.error('ClientError', `[${payload?.source || 'unknown'}] ${payload?.message || 'Unspecified client error'}`, payload?.stack || null);
    sendResponse({ success: true });
    return true;
  }

  if (action === 'FETCH_MODELS') {
    const providerId = payload?.provider;
    if (!providerId || (!BUILTIN_PROVIDER_IDS.includes(providerId) && !payload?.customProviders?.[providerId])) {
      sendResponse({ success: false, error: `Provider ${providerId ? `"${providerId}" ` : ''}is not configured for a model fetch. Open Settings and pick or add a provider.`, models: [] });
      return true;
    }
    const forceRefresh = !!payload?.forceRefresh;
    const fetchMeta: { filteredCount?: number } = {};
    fetchAvailableModels(payload, forceRefresh, fetchMeta)
      .then((models) => sendResponse({ success: true, models, filteredCount: fetchMeta.filteredCount }))
      .catch((err) => {
        const savedCustom = payload?.customProviders?.[payload?.provider]?.models;
        const fallbacks = Array.isArray(savedCustom) ? savedCustom : getFallbackModels(providerId);
        sendResponse({ success: false, error: errorText(err), status: (err as { status?: number })?.status, models: fallbacks });
      });
    return true;
  }

  if (action === 'GET_BUILD') {
    sendResponse({ success: true, build: BUILD_STAMP });
    return true;
  }

  if (action === 'GET_EFFORT_SUPPORT') {
    resolveEffortSupport(payload || {})
      .then((support) => sendResponse({ success: true, support }))
      .catch((err) => sendResponse({ success: false, error: errorText(err) }));
    return true;
  }

  if (action === 'GET_CONTEXT_WINDOW') {
    getEffectiveContextWindow(payload || {})
      .then((window) => sendResponse({ success: true, window }))
      .catch((err) => sendResponse({ success: false, error: errorText(err) }));
    return true;
  }

  if (action === 'TEST_PROVIDER') {
    const probeSignal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20000) : undefined;
    const startedAt = Date.now();
    callProvider(
      payload?.provider,
      payload,
      [{ role: 'user', content: 'Reply with the single word: ok' }],
      'You are a connection test. Reply with the single word: ok.',
      { signal: probeSignal }
    )
      .then((reply) => sendResponse({ success: true, reply: reply.slice(0, 200), latencyMs: Date.now() - startedAt }))
      .catch((err) => sendResponse({ success: false, error: errorText(err), latencyMs: Date.now() - startedAt }));
    return true;
  }

  if (action === 'CLEAR_LOGS') {
    Logger.clearLogs();
    sendResponse({ success: true });
    return true;
  }

  const TAB_ACTIONS = new Set([
    'GET_AGENT_STATE',
    'START_TASK',
    'PAUSE_TASK',
    'RESUME_TASK',
    'STOP_TASK',
    'APPROVE_PLAN',
    'CONFIRM_ACTION',
    'CLEAR_HISTORY',
    'GET_SCREENSHOT',
    'COMPACT_CHAT',
    'LOAD_CHAT'
  ]);

  if (TAB_ACTIONS.has(action)) {
    const targetTabId: number | null = request.tabId != null
      ? request.tabId
      : (sender?.tab?.id !== undefined ? sender.tab.id : (sessions.size > 0 ? (sessions.keys().next().value ?? 0) : null));

    if (targetTabId === null) {
      if (action === 'GET_AGENT_STATE') {
        Logger.logsRestored().then(() => {
          sendResponse({ ...defaultIdleState(), logs: Logger.getLogsHistory() });
        });
        return true;
      }
      Logger.warn('Background', `[TAB_ACTION] ${action} without a tab id and without any open session: refused.`);
      sendResponse({ success: false, error: 'No Tarka session is open on any tab. Open the panel on a tab first.' });
      return true;
    }

    const session = getOrCreateSession(targetTabId);
    const runner = session.engine;

    if (action === 'GET_AGENT_STATE') {
      Promise.all([Logger.logsRestored(), runner.restorePromise.catch(() => {})]).then(() => {
        sendResponse({ ...runner.getState(), logs: Logger.getLogsHistory() });
        void runner.refreshContext();
      });
      return true;
    }

    if (action === 'COMPACT_CHAT') {
      const claim = runner.claimForTask();
      if (!claim.success) {
        sendResponse({ success: false, error: 'Stop the task before you compact the chat.' });
        return true;
      }
      runner.compactChat()
        .then((result) => sendResponse(result), (err) => sendResponse({ success: false, error: errorText(err) }))
        .finally(() => runner.releaseTaskClaim());
      return true;
    }

    if (action === 'START_TASK') {
      const claim = runner.claimForTask();
      if (!claim.success) {
        sendResponse(claim);
        return true;
      }

      getActiveTab(session, targetTabId)
        .then((tab) => {
          if (!tab || typeof tab.id !== 'number') {
            runner.releaseTaskClaim();
            throw new Error('No automatable tab found. Tarka cannot script Chrome\'s internal pages (chrome://…) - open a normal website such as https://google.com and try again.');
          }
          runner.startTask(payload.prompt, tab.id, payload.effort, payload.autoApprove ?? true).catch((err) => {
            Logger.error('Background', '[START_TASK_ERROR] Uncaught exception starting task', err);
          });
          sendResponse({ success: true, tabId: tab.id, tabUrl: tab.url, tabTitle: tab.title });
        })
        .catch((err) => {
          runner.releaseTaskClaim();
          Logger.error('Background', 'Failed to start task', err);
          sendResponse({ success: false, error: errorText(err) });
        });
      return true;
    }

    if (action === 'PAUSE_TASK') {
      sendResponse(runner.pause());
      return true;
    }

    if (action === 'RESUME_TASK') {
      sendResponse(runner.resume());
      return true;
    }

    if (action === 'STOP_TASK') {
      sendResponse(runner.stop());
      return true;
    }

    const replyWhenDone = (work: Promise<unknown>): true => {
      work.then(() => sendResponse({ success: true }), (err) => sendResponse({ success: false, error: errorText(err) }));
      return true;
    };

    if (action === 'APPROVE_PLAN') return replyWhenDone(runner.approvePlan(payload));
    if (action === 'CONFIRM_ACTION') return replyWhenDone(Promise.resolve(runner.confirmAction(payload?.decision, payload?.remember)));

    if (action === 'GET_SCREENSHOT') {
      runner.getScreenshot(String(payload?.imageId || '')).then((held) => {
        sendResponse(held ? { success: true, data: held.data, mediaType: held.mediaType } : { success: false, error: 'That picture is no longer kept.' });
      }, (err) => sendResponse({ success: false, error: errorText(err) }));
      return true;
    }

    if (action === 'CLEAR_HISTORY') {
      runner.clearHistory();
      sendResponse({ success: true });
      return true;
    }

    if (action === 'LOAD_CHAT') {
      const chatId = String(payload?.sessionId || '');
      const holder = [...new Set(sessions.values())].find((other) => other !== session && other.engine.chatId === chatId && other.engine.history.length > 0);
      if (holder) {
        sendResponse({ success: false, error: 'This chat is open in another tab. Start a new chat there first, or keep working on it in that tab.' });
        return true;
      }
      runner.loadChat(chatId).then(sendResponse, (err) => sendResponse({ success: false, error: errorText(err) }));
      return true;
    }
  }

  Logger.warn('Background', `[UNKNOWN_ACTION] Received an unrecognised message action: "${action}". Ignoring.`);
  sendResponse({ success: false, error: `Unknown action: ${action}` });
  return true;
}

function activateTab(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.update) return resolve();
    chrome.tabs.update(tabId, { active: true }, () => {
      lastRuntimeError();
      resolve();
    });
  });
}

function sessionTabIds(session: BackgroundSession): number[] {
  const ids: number[] = [];
  for (const [tabId, s] of sessions.entries()) {
    if (s === session && typeof tabId === 'number') ids.push(tabId);
  }
  return ids;
}

async function getActiveTab(session: BackgroundSession, requestingTabId?: number): Promise<chrome.tabs.Tab | null> {
  if (!session) return null;

  try {
    await session.engine.restorePromise;
  } catch (err) {
    Logger.warn('Background', '[TAB_PICK] Session restore failed; picking a tab from a clean state', err);
  }

  const candidates = await Promise.all(sessionTabIds(session).map((id) => new Promise<chrome.tabs.Tab | null>((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.get) return resolve(null);
    chrome.tabs.get(id, (t) => { lastRuntimeError(); resolve(t || null); });
  })));
  const live = candidates.filter((t): t is chrome.tabs.Tab => Boolean(t));
  const focused = live.find((t) => t.active) || live.find((t) => t.id === session.ownerTabId) || live[0] || null;

  if (focused && isValidWebTab(focused)) {
    return focused;
  }

  if (focused && typeof focused.id === 'number' && isDisposableTab(focused) && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.update) {
    const focusedTabId = focused.id;
    Logger.debug('Background', `[TAB_REUSED] The session's tab [${focusedTabId}] (${focused.url}) is an empty page, so this task runs in it rather than opening another tab beside it.`);
    try {
      await session.engine.ensureTarkaGroup(focusedTabId, focused.windowId);
    } catch (err) {
      Logger.warn('Background', '[TAB_SANDBOX_ERROR] Could not group the reused tab', err);
    }
    setPanelVisibility(focusedTabId, true);
    await new Promise<void>((resolve) => {
      chrome.tabs.update(focusedTabId, { url: START_URL }, () => {
        lastRuntimeError();
        resolve();
      });
    });
    await session.engine.waitForTabComplete(focusedTabId, 4000);
    return { ...focused, url: START_URL };
  }

  if (focused) {
    Logger.warn('Background', `[TAB_NOT_AUTOMATABLE] The session's tab (${focused.url || 'unknown URL'}) cannot be automated - browsers block extensions from scripting internal pages. Opening a fresh tab next to it instead.`);
  }
  Logger.info('Background', `[AUTO_CREATE_TAB] Opening a fresh tab to ${START_URL} for this task.`);
  const newTab = await new Promise<chrome.tabs.Tab>((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      const createOpts: chrome.tabs.CreateProperties = { url: START_URL, active: false };
      if (focused && typeof focused.windowId === 'number') createOpts.windowId = focused.windowId;
      if (focused && typeof focused.index === 'number') createOpts.index = focused.index + 1;
      chrome.tabs.create(createOpts, (t) => {
        lastRuntimeError();
        resolve(t);
      });
    } else {
      resolve({ id: 999, url: START_URL } as chrome.tabs.Tab);
    }
  });

  if (typeof newTab.id === 'number') {
    adoptTabIntoSession(session, newTab.id);
  }

  if (typeof newTab.id === 'number') {
    try {
      await session.engine.ensureTarkaGroup(newTab.id, newTab.windowId);
    } catch (err) {
      Logger.warn('Background', '[TAB_SANDBOX_ERROR] Could not group the freshly opened tab', err);
    }
    setPanelVisibility(newTab.id, true);
    await activateTab(newTab.id);
  }

  broadcastToSession(session, 'PANEL_HANDOFF', { tabId: newTab.id, fromTabId: requestingTabId });

  if (typeof newTab.id === 'number') {
    await session.engine.waitForTabComplete(newTab.id, 4000);
  }

  return { ...newTab, url: newTab.url || newTab.pendingUrl || START_URL, active: true };
}
