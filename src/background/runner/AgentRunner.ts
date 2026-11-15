

import { Storage, type SavedSession, type Settings } from '../../shared/storage.ts';
import { Logger } from '../../shared/logger.ts';
import { BUILD_STAMP } from '../../shared/build.ts';
import { SessionRunnerMeta } from './runnerMeta.ts';
import { CLOSED_TEXT, RunSnapshotStore, fitSnapshot, restoredRun, runSnapshotKey, withRunData, type RunSnapshot } from './runSnapshot.ts';
import { CHAT_MAX_CHARS, ChatSaver } from './chatSaver.ts';
import { runtimeRegistry, type RunRuntime } from './runtimeRegistry.ts';
import { generateCompletion } from '../llm/index.ts';
import { inputDispatcher } from '../browser/input.ts';
import { cdp } from '../browser/cdp.ts';
import { lastRuntimeError } from '../browser/tabs.ts';
import { TOP_FRAME } from '../browser/frames.ts';
import { ensureTarkaGroup, isTabInScope, groupIdForWindow } from '../browser/groups.ts';
import { takeSnapshot } from '../browser/snapshot.ts';
import { TarkaMCPClient, idleRequestTokens, type CallUsage } from '../mcp/client.ts';
import { STOPPED_TEXT, partialResultEntry } from '../mcp/historyEntries.ts';
import { CHAIN_WINDOW_SHARE, COMPACT_PROMPT, COMPACT_SYSTEM, chainTokens, chainTurns, compactionInput, hasEarlierTurn, lastSummary } from '../mcp/chatChain.ts';
import { normalizeEffort } from '../llm/effort.ts';
import { DEFAULT_CONTEXT_WINDOW, getEffectiveContextWindow, type ContextWindow, type ContextWindowSource } from '../llm/models.ts';
import { CHARS_PER_TOKEN } from '../../shared/tokens.ts';
import type { ActionConfirmationRequest } from './runtimeRegistry.ts';
import type { RunStatus, HistoryEntry, Limits, EffortChoice, EffortProfile, RunStats, Level } from '../types.ts';


export interface ContextState {
  used: number;
  window: number;
  windowSource: ContextWindowSource;
  estimated: boolean;
  summarizedTurns: number;
  hasEarlierTurn: boolean;
  compacting: boolean;
}


export interface CompactResult {
  success: boolean;
  error?: string;
  summary?: string;
}


function stepCountOf(history: HistoryEntry[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const type = history[i]?.type;
    if (type === 'agent_response') count += 1;
    else if (type === 'user_goal') break;
  }
  return count;
}

export class AgentRunner {
  public threadId: string;
  public ownerTabId: number;
  public sessionId: number | string;
  public windowId: number | 'default';
  public bootId: string;
  public stateVersion = 0;
  public dirty = false;
  public restorePromise: Promise<void>;

  public status: RunStatus = 'idle';
  public stepCount = 0;
  public currentTask = '';
  public history: HistoryEntry[] = [];
  public planSteps: any[] = [];
  public currentPhase = '';
  public pendingApproval: any | null = null;
  public pendingConfirm: any | null = null;
  public pauseReason: 'user' | null = null;
  public effort: EffortChoice | null = null;
  public effortProfile: EffortProfile | null = null;
  public runStats: RunStats | null = null;


  public contextWindow: ContextWindow = { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' };

  private contextBase = 0;

  private lastCall: CallUsage | null = null;

  private compacting = false;

  private chatGeneration = 0;

  private compactAbort: AbortController | null = null;

  private contextRefreshes = 0;


  public chatId: string = AgentRunner.newChatId();

  private chatTitle = '';

  private runModel: { provider: string; model: string } | null = null;

  private runRecords: Array<Record<string, unknown>> = [];

  private runPageUrl = '';

  private chatSaver = new ChatSaver();

  public tarkaGroupIds = new Map<number, number>();
  public autoApprovePlan = true;

  private taskClaimed = false;
  private stopDuringClaim = false;
  private pauseDuringClaim = false;


  private pauseAfterConfirm = false;

  private confirmResolvers = new Map<string, (approved: boolean) => void>();


  private approvedOrigins = new Set<string>();
  private _activeTabId: number | null = null;
  private onStateChangeCb: ((state: Record<string, any>) => void) | null = null;

  private meta: SessionRunnerMeta;

  private snapshots: RunSnapshotStore;
  private runtime: RunRuntime;


  private mcpClient: TarkaMCPClient | null = null;

  constructor(ownerTabId: number, windowId: number | 'default' = 'default') {
    this.ownerTabId = ownerTabId;
    this.sessionId = ownerTabId;
    this.threadId = String(ownerTabId);
    this.windowId = windowId;
    this._activeTabId = ownerTabId;

    this.bootId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `boot_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

    this.meta = new SessionRunnerMeta(this.threadId);
    this.snapshots = new RunSnapshotStore(this.threadId);

    this.runtime = this.createRuntime();
    runtimeRegistry.set(this.runtime);

    this.restorePromise = this.restoreState();
    Logger.debug('AgentRunner', `[INIT] Session ${this.sessionId} created (build ${BUILD_STAMP})`);
  }

  get activeTabId(): number | null {
    return this._activeTabId;
  }


  getScreenshot(imageId: string): Promise<{ data: string; mediaType: string } | null> {
    return this.mcpClient ? this.mcpClient.getScreenshot(imageId) : Promise.resolve(null);
  }

  set activeTabId(tabId: number | null) {
    this._activeTabId = tabId;
    this.runtime.tabs.activeTabId = tabId;
  }

  get tarkaGroupId(): number | null {
    return groupIdForWindow(
      { windowId: this.windowId, groupIds: this.tarkaGroupIds, persist: () => this.persistState() },
      this.windowId
    );
  }

  private createRuntime(): RunRuntime {
    let pauseReq = false;
    let stopReq = false;
    let activeStepAbort: AbortController | null = null;

    const control = {
      get pauseRequested() { return pauseReq; },
      set pauseRequested(v: boolean) { pauseReq = v; },
      get stopRequested() { return stopReq; },
      set stopRequested(v: boolean) { stopReq = v; },
      stepSignal: () => {
        activeStepAbort = new AbortController();
        if (pauseReq || stopReq) {
          activeStepAbort.abort({ tarka: 'user', reason: stopReq ? 'user_stop' : 'user_pause' });
        }
        return activeStepAbort.signal;
      },
      abortStep: (reason: string) => {
        if (reason === 'user_pause') pauseReq = true;
        if (reason === 'user_stop') stopReq = true;
        activeStepAbort?.abort({ tarka: 'user', reason });
      },
      isUserAbort: (err: any, signal: AbortSignal) => {
        if (signal?.aborted) {
          const reason = signal.reason as any;
          if (reason?.tarka === 'user') return true;
        }
        return false;
      },
      snapshot: () => ({ pauseRequested: pauseReq, stopRequested: stopReq })
    };

    const llm = {
      complete: async (req: any) => {
        const settings = await Storage.getSettings();
        const chatMessages = req.messages.map((m: any) => ({ role: m.role, content: m.content }));
        const extra = settings.systemInstructions?.trim();
        const systemPrompt = extra ? `${extra}\n\n${req.system}` : req.system;
        const text = await generateCompletion(settings, chatMessages, systemPrompt, {
          signal: req.signal,
          schema: req.schema,
          callbacks: req.callbacks
        });
        return { text, provider: settings.provider, model: settings.model, meta: {} };
      }
    };

    const browser = {
      tabInfo: async (tabId: number) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.get) return null;
        return new Promise<{ url: string; title: string; windowId: number; groupId: number; status: string } | null>((resolve) => {
          chrome.tabs.get(tabId, (tab) => {
            if (lastRuntimeError() || !tab) resolve(null);
            else resolve({ url: tab.url ?? '', title: tab.title ?? '', windowId: tab.windowId, groupId: tab.groupId, status: tab.status ?? 'complete' });
          });
        });
      },
      snapshot: async (tabId: number, opts: any) => {
        return await takeSnapshot(tabId, opts, {
          isTabInScope: async (id) => browser.isTabInScope(id),
          clearBadges: async (id) => browser.clearBadges(id),
          sleep: (ms) => this.runtime.clock.sleep(ms)
        });
      },
      navigate: async (tabId: number, url: string) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.update) return;
        await chrome.tabs.update(tabId, { url });
      },
      reload: async (tabId: number) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.reload) return;
        await chrome.tabs.reload(tabId);
      },
      goBack: async (tabId: number) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.goBack) return;
        await chrome.tabs.goBack(tabId);
      },
      waitForTabComplete: async (tabId: number, timeoutMs: number) => {
        await this.waitForTabComplete(tabId, timeoutMs, control.stepSignal());
      },
      waitDomQuiet: async (tabId: number, quietMs: number, maxMs: number) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return;
        await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'WAIT_DOM_QUIET', payload: { quietMs, maxWaitMs: maxMs } }, TOP_FRAME, () => {
            lastRuntimeError();
            resolve(undefined);
          });
        });
      },
      cdp: {
        ensureAttached: async (tabId: number) => {
          try {
            await cdp.attach(tabId);
            return { mode: 'cdp' as const, reason: null };
          } catch (err: any) {
            return { mode: 'synthetic' as const, reason: err.message };
          }
        }
      },
      clearBadges: async (tabId: number) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return;
        return new Promise<void>((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'CLEAR_BADGES' }, TOP_FRAME, () => {
            lastRuntimeError();
            resolve();
          });
        });
      },
      isTabInScope: async (tabId: number) => {
        if (tabId === this.ownerTabId && this.tarkaGroupIds.size === 0) return true;
        return await isTabInScope(
          { windowId: this.windowId, groupIds: this.tarkaGroupIds, persist: () => this.persistState() },
          tabId
        );
      }
    };

    const runtime: RunRuntime = {
      threadId: this.threadId,
      ownerTabId: this.ownerTabId,
      bootId: this.bootId,
      control,
      tabs: { activeTabId: this._activeTabId, ownerTabId: this.ownerTabId },
      windowId: this.windowId,
      tarkaGroupIds: this.tarkaGroupIds,
      resumedAfterRestart: false,
      settings: () => Storage.getSettings(),
      llm,
      browser,
      requestActionConfirmation: (req) => this.requestActionConfirmation(req),
      isOriginApproved: (origin: string) => Boolean(origin) && this.approvedOrigins.has(origin),
      emit: {
        enterNode: (name: string) => {
          this.currentPhase = name;
          this.notifyStateChange();
        },
        setPhase: (text: string) => {
          this.currentPhase = text;
          this.notifyStateChange();
        }
      },
      clock: {
        now: () => Date.now(),
        sleep: async (ms: number, signal?: AbortSignal) => {
          if (signal?.aborted) return;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
      },
      typedTexts: [],
      navigatedFrom: null
    };

    return runtime;
  }


  recordEntry(entry: HistoryEntry): void {
    this.dirty = true;
    this.history.push(entry);
    this.stepCount = stepCountOf(this.history);
    this.notifyStateChange();
  }


  setRunStatus(status: RunStatus, pauseReason: 'user' | null = null): void {
    this.dirty = true;
    this.status = status;
    this.pauseReason = status === 'paused' ? pauseReason : null;
    this.notifyStateChange();
    void this.detachIfDone();
  }


  noteRunData(data: { records?: Array<Record<string, unknown>>; pageUrl?: string }): void {
    if (Array.isArray(data.records)) this.runRecords = data.records.slice();
    if (typeof data.pageUrl === 'string' && data.pageUrl) this.runPageUrl = data.pageUrl;
  }


  setPlanSteps(steps: Array<{ text: string; status: string }>): void {
    this.dirty = true;
    this.planSteps = steps;
    this.notifyStateChange();
  }


  setPendingApproval(value: any): void {
    this.dirty = true;
    this.pendingApproval = value;
    this.notifyStateChange();
  }


  resolvePendingApproval(status: RunStatus, pauseReason: 'user' | null = null): void {
    this.dirty = true;
    this.pendingApproval = null;
    this.status = status;
    this.pauseReason = status === 'paused' ? pauseReason : null;
    this.notifyStateChange();
    void this.detachIfDone();
  }

  claimForTask() {
    if (this.status === 'running' || this.status === 'paused' || this.taskClaimed) {
      return { success: false, error: 'A task is already active or paused.' };
    }
    this.taskClaimed = true;
    this.stopDuringClaim = false;
    this.pauseDuringClaim = false;
    this.pauseAfterConfirm = false;
    return { success: true };
  }


  releaseTaskClaim() {
    this.taskClaimed = false;
    this.pauseDuringClaim = false;
  }

  async startTask(userPrompt: string, tabId: number, requestedEffort?: string, autoApprove?: boolean) {
    if (!userPrompt?.trim()) {
      this.releaseTaskClaim();
      return { success: false, error: 'Cannot start empty prompt.' };
    }


    try {
      await this.restorePromise;
      this.dirty = true;
      this.activeTabId = tabId;
      this.currentTask = userPrompt.trim();

      if (!this.chatTitle || !this.history.some((row) => row.type === 'user_goal')) this.chatTitle = this.currentTask;
      Logger.event('agent', 'AgentRunner', `Started the task "${this.currentTask}" on tab [${tabId}]`, { task: this.currentTask, tabId, autoApprovePlan: autoApprove !== false });

      await this.ensureTarkaGroup(tabId);


      await this.refreshContext();
      if (!this.stopDuringClaim) await this.autoCompactIfLong();

      const stopLanded = this.stopDuringClaim;
      const pauseLanded = this.pauseDuringClaim;
      this.stopDuringClaim = false;
      this.pauseDuringClaim = false;
      if (stopLanded) {
        this.status = 'stopped';
        this.currentTask = '';
        this.notifyStateChange({ stopped: true });
        return { success: false, error: 'Task stopped before it started.' };
      }


      this.status = pauseLanded ? 'paused' : 'running';
      this.pauseReason = pauseLanded ? 'user' : null;
      this.stepCount = 0;


      this.autoApprovePlan = autoApprove !== false;
      this.pendingApproval = null;
      this.runtime.control.stopRequested = false;
      this.runtime.control.pauseRequested = false;


      const settings = await Storage.getSettings();


      if (this.stopDuringClaim || (this.status !== 'running' && this.status !== 'paused')) {


        this.currentTask = '';
        this.notifyStateChange({ stopped: true });
        return { success: false, error: 'Task stopped before it started.' };
      }
      this.runModel = { provider: String(settings.provider || ''), model: String(settings.providerConfigs?.[settings.provider]?.model || settings.model || '') };
      this.runRecords = [];
      this.runPageUrl = '';
      const level = normalizeEffort(requestedEffort ?? settings.effortDefault);
      this.effort = { requested: level, level, suggestedBy: requestedEffort ? 'user' : 'default' };

      this.lastCall = null;

      this.approvedOrigins.clear();
      this.runStats = { level: level as Level, modelCalls: 0, stepsUsed: 0, tokensIn: 0, tokensOut: 0 };
      this.mcpClient = new TarkaMCPClient(this.runtime, this);


      await this.mcpClient.startTask(userPrompt, { startPaused: this.status === 'paused', effort: level });

      return { success: true };
    } finally {
      this.releaseTaskClaim();
    }
  }


  private async detachIfDone(): Promise<void> {
    if (this.status === 'running' || this.status === 'paused') return;
    const ids = new Set<number>([this.ownerTabId]);
    if (typeof this._activeTabId === 'number') ids.add(this._activeTabId);


    await Promise.allSettled(Array.from(ids).map((id) => cdp.detach(id)));
  }

  pause(): { success: boolean; error?: string } {
    if (this.status !== 'running') {


      if (this.confirmResolvers.size > 0) {
        this.pauseAfterConfirm = true;
        this.dirty = true;
        this.notifyStateChange({ paused: true });
        return { success: true };
      }
      if (this.taskClaimed) {
        this.pauseDuringClaim = true;
        this.notifyStateChange({ paused: true });
        return { success: true };
      }
      return { success: false, error: `Cannot pause when status is "${this.status}".` };
    }
    this.dirty = true;
    this.status = 'paused';
    this.pauseReason = 'user';
    this.runtime.control.abortStep('user_pause');
    this.mcpClient?.stop();
    this.notifyStateChange({ paused: true });
    return { success: true };
  }

  resume(): { success: boolean; error?: string } {
    if (this.status !== 'paused') {
      return { success: false, error: `Cannot resume when status is "${this.status}".` };
    }
    if (this.confirmResolvers.size > 0) {
      return { success: false, error: 'A confirmation card is waiting. Approve or decline it first.' };
    }
    this.dirty = true;
    this.status = 'running';
    this.pauseReason = null;
    this.runtime.control.pauseRequested = false;
    this.notifyStateChange({ resumed: true });

    this.mcpClient?.resume();
    return { success: true };
  }

  stop(): { success: boolean; error?: string } {
    if (!this.endRun('stopped', partialResultEntry(STOPPED_TEXT, 'stopped'))) {
      if (this.taskClaimed) {
        this.stopDuringClaim = true;

        this.compactAbort?.abort({ tarka: 'user', reason: 'user_stop' });
        this.notifyStateChange({ stopped: true });
        return { success: true };
      }
      return { success: false, error: 'No task is running or paused.' };
    }

    const targetTabId = this._activeTabId ?? this.ownerTabId;
    if (targetTabId) {
      this.runtime.browser.clearBadges(targetTabId);
    }
    return { success: true };
  }

  answerQuestion(_answerText: string): { success: boolean; error?: string } {
    return { success: false, error: 'Not supported in MCP mode' };
  }

  async approvePlan(decision: any) {

    if (this.mcpClient) {
      this.mcpClient.handleApprovePlan(decision?.decision === 'approve');
    }
  }


  async requestActionConfirmation(req: ActionConfirmationRequest): Promise<boolean> {
    if (this.status !== 'running') return false;


    if (req.targetOrigin && this.approvedOrigins.has(req.targetOrigin)) return true;
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `confirm_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    this.pendingConfirm = {
      id,
      toolName: req.toolName,
      actionSummary: req.actionSummary,
      elementLabel: req.elementLabel || '',
      variant: req.variant,
      reason: req.reason,
      pageUrl: req.pageUrl,
      detail: req.detail || {},
      tabId: req.tabId,
      targetOrigin: req.targetOrigin,
      elementId: req.elementId,
    };
    this.dirty = true;
    this.status = 'paused';
    this.pauseReason = null;
    this.notifyStateChange();
    const approved = await new Promise<boolean>((resolve) => {
      this.confirmResolvers.set(id, resolve);
    });
    this.confirmResolvers.delete(id);
    if (this.pendingConfirm && (this.pendingConfirm as any).id === id) {
      this.pendingConfirm = null;
    }
    if (!this.isRunLive()) return false;


    if (this.status !== 'paused') return false;


    if (this.pauseAfterConfirm) {
      this.pauseAfterConfirm = false;
      this.dirty = true;
      this.status = 'paused';
      this.pauseReason = 'user';
      this.mcpClient?.stop();
      this.notifyStateChange({ paused: true });
      return false;
    }


    this.status = 'running';
    this.pauseReason = null;
    this.notifyStateChange();
    return approved;
  }


  private isRunLive(): boolean {
    return this.status === 'running' || this.status === 'paused' || this.taskClaimed;
  }


  confirmAction(decision: 'approve' | 'reject', remember?: 'site'): { success: boolean; error?: string } {
    const ids = Array.from(this.confirmResolvers.keys());
    const id = ids.at(-1);
    if (!id) return { success: false, error: 'There is no action waiting for a confirmation.' };
    const resolve = this.confirmResolvers.get(id)!;
    this.confirmResolvers.delete(id);
    const card = this.pendingConfirm && (this.pendingConfirm as any).id === id ? this.pendingConfirm : null;
    if (decision === 'approve' && remember === 'site' && card?.targetOrigin) {
      this.approvedOrigins.add(String(card.targetOrigin));
    }
    if (card) {
      this.recordEntry({
        type: 'confirm_review',
        variant: String(card.variant || ''),
        actionSummary: String(card.actionSummary || ''),
        decision: decision === 'approve' ? 'approved' : 'denied',
        ...(decision === 'approve' && remember === 'site' ? { remembered: true } : {})
      });
    }
    resolve(decision === 'approve');
    return { success: true };
  }


  private releasePendingConfirms(): void {
    for (const [, resolve] of Array.from(this.confirmResolvers.entries())) {
      resolve(false);
    }
    this.confirmResolvers.clear();
    this.pendingConfirm = null;
    this.pauseAfterConfirm = false;
  }


  endRun(status: 'idle' | 'stopped' | 'error', row: HistoryEntry | null): boolean {
    if (this.status !== 'running' && this.status !== 'paused') return false;
    this.runtime.control.abortStep('user_stop');
    this.mcpClient?.stop();
    this.releasePendingConfirms();
    this.dirty = true;


    if (row) this.history.push(withRunData(row, { records: this.runRecords, planSteps: this.planSteps, pageUrl: this.runPageUrl, runStats: this.runStats }));
    this.runRecords = [];
    this.status = status;
    this.pauseReason = null;
    this.pendingApproval = null;
    this.notifyStateChange(status === 'stopped' ? { stopped: true } : undefined);
    void this.detachIfDone();
    return true;
  }

  // Chrome replaces a prerendered tab with a new ID.
  replaceTab(oldTabId: number, newTabId: number): void {
    if (this.ownerTabId === oldTabId) {
      this.ownerTabId = newTabId;
      this.runtime.ownerTabId = newTabId;
      this.runtime.tabs.ownerTabId = newTabId;
      this.rekeyThread(newTabId);
    }
    if (this._activeTabId === oldTabId) this.activeTabId = newTabId;
  }


  private rekeyThread(newTabId: number): void {
    const previous = this.threadId;
    const next = String(newTabId);
    if (previous === next) return;
    runtimeRegistry.delete(previous);
    this.threadId = next;
    this.sessionId = newTabId;
    this.runtime.threadId = next;
    runtimeRegistry.set(this.runtime);

    this.snapshots.discard();
    this.meta = new SessionRunnerMeta(next);
    this.snapshots = new RunSnapshotStore(next);
    this.snapshots.save(this.runSnapshot(), true);
    void this.persistState();
    AgentRunner.dropStoredState(previous);
  }

  clearHistory() {

    const ended = this.endRun('idle', null);
    this.releasePendingConfirms();


    if (!ended) this.mcpClient?.stop();
    this.mcpClient = null;
    this.dirty = true;

    this.chatGeneration += 1;
    this.lastCall = null;
    this.runStats = null;
    this.approvedOrigins.clear();


    void this.chatSaver.flush();
    this.chatId = AgentRunner.newChatId();
    this.chatTitle = '';
    this.runModel = null;
    this.runRecords = [];
    this.runPageUrl = '';
    this.history = [];
    this.currentTask = '';
    this.planSteps = [];
    this.pendingApproval = null;
    this.status = 'idle';
    this.pauseReason = null;
    this.stepCount = 0;
    this.stateVersion = 0;
    this.runtime.typedTexts = [];
    this.runtime.navigatedFrom = null;
    void this.meta.clear();
    void this.snapshots.clear();
    this.notifyStateChange();
  }

  getState(): Record<string, any> {
    return {
      status: this.status,
      stepCount: this.stepCount,
      task: this.currentTask,
      history: this.history,
      planSteps: this.planSteps,
      currentPhase: this.currentPhase,
      pauseReason: this.pauseReason,
      pendingApproval: this.pendingApproval,
      pendingConfirm: this.pendingConfirm,
      stateVersion: this.stateVersion,
      bootId: this.bootId,
      tarkaGroupId: this.tarkaGroupId,
      effort: this.effort,
      effortProfile: this.effortProfile,
      runStats: this.runStats,
      chatId: this.chatId,
      context: this.contextState()
    };
  }


  static newChatId(): string {
    const rand = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.floor(Math.random() * 1e9).toString(36);
    return `chat_${Date.now()}_${rand}`;
  }


  async loadChat(chatId: string): Promise<{ success: boolean; error?: string }> {
    await this.restorePromise;
    const busy = () => this.status === 'running' || this.status === 'paused' || this.taskClaimed || this.compacting;
    if (busy()) return { success: false, error: 'Stop the task before you open another chat.' };
    const saved = await Storage.getChat(String(chatId || ''));
    if (!saved || !Array.isArray(saved.history)) return { success: false, error: 'That chat is no longer saved.' };
    if (busy()) return { success: false, error: 'Stop the task before you open another chat.' };


    this.releasePendingConfirms();
    this.chatGeneration += 1;
    this.mcpClient = null;
    this.pendingApproval = null;
    this.pendingConfirm = null;
    this.lastCall = null;
    this.runStats = null;
    this.approvedOrigins.clear();
    this.runtime.typedTexts = [];
    this.runtime.navigatedFrom = null;

    const planSteps = Array.isArray(saved.planSteps) ? (saved.planSteps as Array<{ text: string; status: string }>) : [];
    let history = saved.history as HistoryEntry[];
    if (saved.status === 'running' || saved.status === 'paused') {
      history = [...history, withRunData(partialResultEntry(CLOSED_TEXT, 'closed'), { records: saved.records, planSteps, pageUrl: saved.pageUrl })];
    }
    this.chatId = saved.id;
    this.chatTitle = saved.task || '';
    this.runModel = saved.model || saved.provider ? { provider: saved.provider || '', model: saved.model || '' } : null;
    this.runRecords = [];
    this.runPageUrl = '';
    this.history = fitSnapshot({ ...this.runSnapshot(), history }).history;
    this.planSteps = planSteps;
    this.currentTask = saved.task || '';
    this.status = 'idle';
    this.pauseReason = null;
    this.stepCount = stepCountOf(this.history);
    this.dirty = true;
    Logger.event('agent', 'AgentRunner', `Opened the saved chat "${this.chatTitle}" on tab [${this.ownerTabId}]`, { chatId: this.chatId, rows: this.history.length, cutOff: saved.status === 'running' || saved.status === 'paused' });
    this.notifyStateChange();
    return { success: true };
  }


  contextState(): ContextState {
    const live = (this.status === 'running' || this.status === 'paused') && this.lastCall !== null;
    const empty = this.history.length === 0;
    return {
      used: live ? this.lastCall!.promptTokens : empty ? 0 : this.contextBase + chainTokens(this.history),
      window: this.contextWindow.tokens,
      windowSource: this.contextWindow.source,
      estimated: live ? this.lastCall!.estimated : !empty,
      summarizedTurns: lastSummary(this.history)?.summarizedTurns ?? 0,
      hasEarlierTurn: hasEarlierTurn(this.history),
      compacting: this.compacting
    };
  }


  noteUsage(usage: CallUsage): void {
    this.lastCall = { ...usage };
    if (this.runStats) {
      this.runStats = {
        ...this.runStats,
        modelCalls: this.runStats.modelCalls + 1,
        stepsUsed: this.stepCount,
        tokensIn: (this.runStats.tokensIn ?? 0) + usage.promptTokens,
        tokensOut: (this.runStats.tokensOut ?? 0) + usage.outputTokens
      };
    }
    this.dirty = true;
    this.notifyStateChange();
  }


  async refreshContext(): Promise<void> {
    const mine = ++this.contextRefreshes;
    try {
      const settings = await Storage.getSettings();
      const window = await getEffectiveContextWindow(settings);
      const base = idleRequestTokens({
        instructions: (settings.systemInstructions || '').trim(),
        autoApprovePlan: settings.autoApprove !== false,
        research: settings.research?.enabled !== false
      });
      if (mine !== this.contextRefreshes) return;
      const changed = window.tokens !== this.contextWindow.tokens || window.source !== this.contextWindow.source || base !== this.contextBase;
      this.contextWindow = window;
      this.contextBase = base;
      if (changed) this.notifyStateChange();
    } catch (err) {
      Logger.warn('AgentRunner', `[CONTEXT] Could not resolve the context window: ${err instanceof Error ? err.message : String(err)}`);
    }
  }


  async summarizeChat(input: string, signal?: AbortSignal): Promise<string> {
    const settings = await Storage.getSettings();
    return generateCompletion(settings, [{ role: 'user', content: `${COMPACT_PROMPT}\n\n${input}` }], COMPACT_SYSTEM, { signal });
  }


  async compactChat(options: { auto?: boolean; signal?: AbortSignal } = {}): Promise<CompactResult> {
    await this.restorePromise;
    if (this.status === 'running' || this.status === 'paused') return { success: false, error: 'Stop the task before you compact the chat.' };
    if (this.compacting) return { success: false, error: 'The chat is already being compacted.' };
    const turns = chainTurns(this.history);
    if (turns.length === 0) return { success: false, error: 'There is no earlier turn to compact.' };

    const generation = this.chatGeneration;
    const summarizedTurns = (lastSummary(this.history)?.summarizedTurns ?? 0) + turns.length;

    const maxChars = Math.max(8_000, Math.floor(this.contextWindow.tokens * CHARS_PER_TOKEN * 0.5));
    const input = compactionInput(this.history, maxChars);
    this.compacting = true;
    this.notifyStateChange();
    try {
      const summary = String(await this.summarizeChat(input, options.signal) || '').trim();
      if (generation !== this.chatGeneration) return { success: false, error: 'The chat was cleared while it was being compacted.' };
      if (options.signal?.aborted) return { success: false, error: 'The compaction was stopped.' };
      if (!summary) return { success: false, error: 'The model gave an empty summary, so the chat is unchanged.' };
      this.compacting = false;
      this.recordEntry({ type: 'chat_compacted', summary, summarizedTurns, ...(options.auto ? { auto: true } : {}), timestamp: new Date().toLocaleTimeString() });
      Logger.event('agent', 'AgentRunner', `Compacted the chat: ${summarizedTurns} turn${summarizedTurns === 1 ? '' : 's'} in a summary of ${summary.length} characters${options.auto ? ' (automatically, the chain was long)' : ''}`, { summarizedTurns, auto: !!options.auto, summary });
      return { success: true, summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.warn('AgentRunner', `[COMPACT] The chat could not be compacted: ${message}`);
      return { success: false, error: `The chat could not be compacted: ${message}` };
    } finally {
      if (this.compacting) {
        this.compacting = false;
        this.notifyStateChange();
      }
    }
  }


  private async autoCompactIfLong(): Promise<void> {
    if (!hasEarlierTurn(this.history)) return;
    const tokens = chainTokens(this.history);
    if (tokens <= this.contextWindow.tokens * CHAIN_WINDOW_SHARE) return;
    Logger.info('AgentRunner', `[COMPACT] The chain of this chat is ${tokens} tokens, over ${Math.round(CHAIN_WINDOW_SHARE * 100)}% of the ${this.contextWindow.tokens}-token window: compacting it before the task.`);
    this.compactAbort = new AbortController();
    try {
      const result = await this.compactChat({ auto: true, signal: this.compactAbort.signal });
      if (!result.success && !this.compactAbort.signal.aborted) {
        Logger.warn('AgentRunner', `[COMPACT] The task starts with the whole chain: ${result.error}`);
      }
    } finally {
      this.compactAbort = null;
    }
  }

  async persistState() {
    await this.meta.writeImmediate({
      stateVersion: this.stateVersion,
      tarkaGroupIds: Array.from(this.tarkaGroupIds.entries()) as [number, number][],
      aliases: [],
      pauseDetach: null,
      lastBeatAt: Date.now()
    });
  }


  async ensureTarkaGroup(tabId: number, explicitWindowId?: number) {
    return await ensureTarkaGroup(
      { windowId: this.windowId, groupIds: this.tarkaGroupIds, persist: () => this.persistState() },
      tabId,
      explicitWindowId
    );
  }

  async waitForTabComplete(tabId: number, timeoutMs = 15000, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Tab load timeout')), timeoutMs);
        const listener = (updatedTabId: number, changeInfo: any) => {
          if (updatedTabId !== tabId) return;
          if (changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        signal?.addEventListener('abort', () => {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        });
        // Chrome can finish loading before the listener is registered.
        chrome.tabs.get?.(tabId, (tab) => {
          if (chrome.runtime?.lastError) return;
          if (tab?.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
          }
        });
      });
    } catch {

    }
  }


  setStateChangeCallback(cb: (state: Record<string, any>) => void) {
    this.onStateChangeCb = cb;
  }


  static forgetSession(sessionId: number | string): void {
    runtimeRegistry.delete(String(sessionId));
    AgentRunner.dropStoredState(sessionId);
  }


  static dropStoredState(threadId: number | string): void {
    if (typeof chrome === 'undefined' || !chrome.storage?.session?.remove) return;
    void chrome.storage.session.remove([runSnapshotKey(threadId), `sf:meta:${threadId}`]).catch(() => {});
  }


  groupIdForWindow(windowId: number): number | null {
    return groupIdForWindow(
      { windowId: this.windowId, groupIds: this.tarkaGroupIds, persist: () => this.persistState() },
      windowId
    );
  }

  private notifyStateChange(extra?: Record<string, any>) {
    this.stateVersion++;
    // MV3 can stop the worker after an idle, paused, or waiting state.
    const resting = this.status !== 'running' || this.pendingApproval !== null;
    this.snapshots.save(this.runSnapshot(), resting);


    this.chatSaver.save(() => this.savedChat(), resting);
    if (this.onStateChangeCb) {
      this.onStateChangeCb({ ...this.getState(), ...extra });
    }
  }

  private runSnapshot(): RunSnapshot {
    return {
      status: this.status,
      task: this.currentTask,
      history: this.history,
      planSteps: this.planSteps,
      stepCount: this.stepCount,
      pauseReason: this.pauseReason,
      stateVersion: this.stateVersion,
      lastCall: this.lastCall,
      runStats: this.runStats,
      chatId: this.chatId,
      chatTitle: this.chatTitle,
      runModel: this.runModel,
      records: this.runRecords,
      pageUrl: this.runPageUrl,
      savedAt: Date.now()
    };
  }


  private savedChat(): SavedSession | null {
    if (!this.history.some((row) => row.type === 'user_goal')) return null;
    const live = this.status === 'running' || this.status === 'paused';
    const fitted = fitSnapshot({ ...this.runSnapshot(), records: [] }, CHAT_MAX_CHARS);
    return {
      id: this.chatId,
      task: this.chatTitle || this.currentTask,
      timestamp: new Date().toLocaleString(),
      model: this.runModel?.model || '',
      provider: this.runModel?.provider || '',
      history: fitted.history,
      planSteps: this.planSteps,
      status: this.status,
      ...(live && this.runRecords.length ? { records: this.runRecords.slice() } : {}),
      ...(live && this.runPageUrl ? { pageUrl: this.runPageUrl } : {}),
      savedAt: Date.now()
    };
  }


  private restoreGroupMap(entries: Array<[number, number]>): void {
    for (const [windowId, groupId] of entries) {
      if (typeof windowId === 'number' && typeof groupId === 'number' && !this.tarkaGroupIds.has(windowId)) {
        this.tarkaGroupIds.set(windowId, groupId);
      }
    }
  }

  private async restoreState(): Promise<void> {


    try {
      const kept = await this.snapshots.read();
      if (kept) {
        const run = restoredRun(kept);
        this.status = run.status;
        this.currentTask = run.task || '';
        this.history = Array.isArray(run.history) ? run.history : [];
        this.planSteps = Array.isArray(run.planSteps) ? run.planSteps : [];
        this.stepCount = Number(run.stepCount) || 0;
        this.pauseReason = run.pauseReason ?? null;
        this.stateVersion = Math.max(this.stateVersion, Number(run.stateVersion) || 0);
        this.lastCall = run.lastCall && typeof run.lastCall.promptTokens === 'number' ? run.lastCall : null;
        this.runStats = run.runStats ?? null;
        if (typeof run.chatId === 'string' && run.chatId) this.chatId = run.chatId;
        this.chatTitle = typeof run.chatTitle === 'string' ? run.chatTitle : '';
        this.runModel = run.runModel ?? null;
        this.runRecords = Array.isArray(run.records) ? run.records : [];
        this.runPageUrl = typeof run.pageUrl === 'string' ? run.pageUrl : '';
        if (run !== kept) {
          Logger.info('AgentRunner', `[RUN_RESTORED] The worker restarted during the run on tab [${this.ownerTabId}]; its steps are kept and the run is marked interrupted.`);
          this.snapshots.save(this.runSnapshot(), true);

          this.chatSaver.save(() => this.savedChat(), true);
        }
      }
    } catch {

    }
    try {
      const saved = await this.meta.read();


      if (saved) this.restoreGroupMap(saved.tarkaGroupIds || []);
    } catch {

    }
  }
}