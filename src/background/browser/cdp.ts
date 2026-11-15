
import { describeRestrictedUrl } from './tabs.ts';

async function restrictedReasonFor(tabId: number): Promise<string | null> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.get) return null;
  return new Promise((resolve) => {
    try {
      const maybe = (chrome.tabs.get as any)(tabId, (tab: any) => {
        void chrome.runtime.lastError;
        resolve(tab ? describeRestrictedUrl(tab.url ?? '') : null);
      });
      if (maybe && typeof maybe.then === 'function') {
        maybe.then((tab: any) => resolve(tab ? describeRestrictedUrl(tab.url ?? '') : null), () => resolve(null));
      }
    } catch (_) {
      resolve(null);
    }
  });
}

export interface AttachedTabInfo {
  attachedAt: number;
  lastUsedAt?: number;
  userDetached?: boolean;
}

export interface CDPManagerOptions {
  attachTimeoutMs?: number;
  commandTimeoutMs?: number;
  recentUseGraceMs?: number;
  clockSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type KeepTabs = ReadonlySet<number> | ((tabId: number) => boolean);

const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_RECENT_USE_GRACE_MS = 5 * 60 * 1000;
const FOREIGN_ATTACH_TRIES = 4;
const FOREIGN_ATTACH_BACKOFF_MS = 100;

class CdpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpTimeoutError';
  }
}

export class CDPManager {
  private attachedTabs = new Map<number, AttachedTabInfo>();
  private initialized = false;
  private attachTimeoutMs: number;
  private commandTimeoutMs: number;
  private recentUseGraceMs: number;
  private clockSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  private detachedMidAttach = new Map<number, string>();
  private attaching = new Map<number, Promise<void>>();
  private inAttach = new Set<number>();

  constructor(options: CDPManagerOptions = {}) {
    this.attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.recentUseGraceMs = options.recentUseGraceMs ?? DEFAULT_RECENT_USE_GRACE_MS;
    this.clockSleep = options.clockSleep;
    this.setupListeners();
  }

  private hasDebugger(): boolean {
    return typeof chrome !== 'undefined' && 'debugger' in chrome && Boolean(chrome.debugger);
  }

  private setupListeners(): void {
    if (this.initialized) return;
    if (this.hasDebugger() && chrome.debugger.onDetach) {
      chrome.debugger.onDetach.addListener((source, reason) => {
        if (source.tabId !== undefined) {
          if (this.attaching.has(source.tabId)) {
            this.detachedMidAttach.set(source.tabId, String(reason));
          }
          const info = this.attachedTabs.get(source.tabId);
          if (info) {
            if (reason === 'canceled_by_user') {
              info.userDetached = true;
            } else {
              this.attachedTabs.delete(source.tabId);
            }
          }
        }
      });
      this.initialized = true;
    }
  }

  isAttached(tabId: number): boolean {
    const info = this.attachedTabs.get(tabId);
    return !!info && !info.userDetached;
  }

  isUserDetached(tabId: number): boolean {
    const info = this.attachedTabs.get(tabId);
    return !!info && !!info.userDetached;
  }

  async attach(tabId: number): Promise<void> {
    if (!this.hasDebugger()) {
      throw new Error('chrome.debugger API is not available in this environment.');
    }

    const restricted = await restrictedReasonFor(tabId);
    if (restricted) {
      throw new Error(`Refused by security policy: the debugger is not attached to a restricted page (${restricted})`);
    }

    this.setupListeners();

    if (this.isUserDetached(tabId)) {
      return;
    }

    const inFlight = this.attaching.get(tabId);
    if (inFlight) {
      return await inFlight;
    }

    if (this.isAttached(tabId)) {
      return;
    }

    const round = this.attachRound(tabId).finally(() => {
      this.attaching.delete(tabId);
      this.inAttach.delete(tabId);
    });
    this.attaching.set(tabId, round);
    this.inAttach.add(tabId);
    return await round;
  }

  private async attachRound(tabId: number): Promise<void> {
    const target = { tabId };
    let lastForeignError: Error | undefined;

    this.detachedMidAttach.delete(tabId);

    for (let attempt = 1; attempt <= FOREIGN_ATTACH_TRIES; attempt++) {
      // Chrome allows only one debugger attachment per tab.
      const pending = Promise.resolve(chrome.debugger.attach(target, '1.3')) as Promise<void>;
      try {
        await this.withTimeout(
          pending,
          this.attachTimeoutMs,
          `Debugger attach timed out after ${Math.round(this.attachTimeoutMs / 1000)} s (DevTools may be open or the renderer crashed).`
        );
      } catch (err: any) {
        if (err instanceof CdpTimeoutError) {
          pending.then(
            () => {
              Promise.resolve(chrome.debugger.detach(target)).catch(() => {});
            },
            () => {}
          );
          throw err;
        }
        const msg = (err && err.message) || String(err);
        if (!msg.includes('Another debugger is already attached')) {
          throw err;
        }
        lastForeignError = new Error(
          'Debugger could not attach: another debugger (DevTools or another extension) is attached to this tab.'
        );
        if (attempt < FOREIGN_ATTACH_TRIES) {
          await this.sleepDelay(FOREIGN_ATTACH_BACKOFF_MS * attempt);
          continue;
        }
        throw lastForeignError;
      }

      try {
        await this.sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      } catch (_) {
      }

      try {
        await this.sendCommand(tabId, 'Page.enable', {});
      } catch (_) {
      }

      // Chrome's debugger warning bar changes viewport height after attach.
      await this.waitForYellowBarSettle(tabId);

      const endedReason = this.detachedMidAttach.get(tabId);
      this.detachedMidAttach.delete(tabId);
      if (endedReason !== undefined) {
        if (endedReason === 'canceled_by_user') {
          this.attachedTabs.set(tabId, { attachedAt: Date.now(), userDetached: true });
          return;
        }
        throw new Error(`Debugger detached from the tab while attaching (${endedReason}).`);
      }
      const now = Date.now();
      this.attachedTabs.set(tabId, { attachedAt: now, lastUsedAt: now });
      return;
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpTimeoutError(message)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  async detach(tabId: number): Promise<void> {
    this.attachedTabs.delete(tabId);

    if (!this.hasDebugger()) {
      return;
    }

    try {
      await chrome.debugger.detach({ tabId });
    } catch (err: any) {
      const msg = (err && err.message) || String(err);
      if (!msg.includes('Debugger is not attached') && !msg.includes('No tab with given id')) {
      }
    }
  }

  async detachAll(): Promise<void> {
    const tabIds = Array.from(this.attachedTabs.keys());
    await Promise.allSettled(tabIds.map((tabId) => this.detach(tabId)));
  }

  async sendCommand(
    tabId: number,
    method: string,
    params: Record<string, unknown> = {},
    control?: { signal?: AbortSignal; stopRequested?: boolean; pauseRequested?: boolean },
    retried = false
  ): Promise<any> {
    if (!this.hasDebugger()) {
      throw new Error('chrome.debugger API is not available.');
    }

    const isExempt =
      (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') ||
      (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp');

    const used = this.attachedTabs.get(tabId);
    if (used) used.lastUsedAt = Date.now();

    if (!isExempt) {
      if (control?.signal?.aborted || control?.stopRequested || control?.pauseRequested) {
        throw new Error(`CDP command ${method} aborted: stop or pause requested.`);
      }
    }

    try {
      return await this.withTimeout(
        Promise.resolve(chrome.debugger.sendCommand({ tabId }, method, params)) as Promise<any>,
        this.commandTimeoutMs,
        `CDP command ${method} timed out after ${Math.round(this.commandTimeoutMs / 1000)} s (the renderer may have crashed or the debugger detached).`
      );
    } catch (err: any) {
      const msg = (err && err.message) || String(err);
      const detached = /not attached|detached while handling|detachedFromTarget/i.test(msg);
      if (
        retried ||
        !detached ||
        this.inAttach.has(tabId) ||
        (control?.signal?.aborted || control?.stopRequested || control?.pauseRequested)
      ) {
        throw err;
      }
      await this.attach(tabId);
      return await this.sendCommand(tabId, method, params, control, true);
    }
  }

  private async sleepDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.clockSleep) {
      await this.clockSleep(ms, signal);
    } else {
      await new Promise((r) => setTimeout(r, ms));
    }
  }

  async reconcileLeakedTargets(keep: KeepTabs): Promise<void> {
    if (!this.hasDebugger() || !chrome.debugger.getTargets) {
      return;
    }

    const kept = typeof keep === 'function' ? keep : (tabId: number) => keep.has(tabId);
    const inUse = (tabId: number): boolean => {
      if (this.attaching.has(tabId)) return true;
      const info = this.attachedTabs.get(tabId);
      const lastUsedAt = info?.lastUsedAt ?? info?.attachedAt;
      return lastUsedAt !== undefined && Date.now() - lastUsedAt < this.recentUseGraceMs;
    };

    try {
      const targets = await chrome.debugger.getTargets();
      for (const target of targets) {
        if (target.attached && target.tabId !== undefined) {
          if (!kept(target.tabId) && !inUse(target.tabId)) {
            try {
              await chrome.debugger.detach({ tabId: target.tabId });
            } catch (_) {}
            this.attachedTabs.delete(target.tabId);
          }
        }
      }
    } catch (_) {}
  }

  private async waitForYellowBarSettle(tabId: number): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.scripting || !chrome.scripting.executeScript) {
      return;
    }

    const readHeight = async (): Promise<number> => {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => (globalThis as any).innerHeight
        });
        return (results && results[0] && typeof results[0].result === 'number') ? results[0].result : 0;
      } catch (_) {
        return 0;
      }
    };

    const initialHeight = await readHeight();
    if (initialHeight === 0) return;

    const start = Date.now();
    const TIMEOUT_MS = 1500;

    while (Date.now() - start < TIMEOUT_MS) {
      await this.sleepDelay(100);
      const current = await readHeight();
      if (current > 0 && current < initialHeight) {
        await this.sleepDelay(250);
        return;
      }
    }
  }
}

export const cdp = new CDPManager();
