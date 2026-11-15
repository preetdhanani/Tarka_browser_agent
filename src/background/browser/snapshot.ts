
import { describeRestrictedUrl, lastRuntimeError } from './tabs.ts';
import { TOP_FRAME } from './frames.ts';
import { CONTENT_SCRIPT_FILES } from './contentFiles.ts';
import { Logger } from '../../shared/logger.ts';

export interface SnapshotOptions {
  showBadges?: boolean;
  maxElements?: number;
}

export interface SnapshotDeps {
  isTabInScope: (tabId: number) => Promise<boolean>;
  clearBadges?: (tabId: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface SnapshotResult {
  url?: string;
  title?: string;
  elementsText?: string;
  pageText?: string;
  refs?: number[];
  shownRefs?: number[];
  elementInfo?: Record<number, any>;
  elementCount?: number;
  scrollState?: {
    scrollY?: number;
    pageHeight?: number;
    viewportHeight?: number;
  };
  docId: string;
  data?: any;
  [key: string]: any;
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export async function takeSnapshot(
  tabId: number,
  opts: SnapshotOptions = {},
  deps: SnapshotDeps
): Promise<SnapshotResult> {
  if (!tabId || typeof tabId !== 'number') {
    throw new SnapshotError('No target tab was selected for this task.');
  }

  let tab: chrome.tabs.Tab | null = null;
  if (typeof chrome !== 'undefined' && chrome.tabs?.get) {
    try {
      tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
        const maybePromise: any = chrome.tabs.get(tabId, (t) => {
          const rErr = lastRuntimeError();
          if (rErr || !t) resolve(null);
          else resolve(t);
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then((t: any) => resolve(t ?? null), () => resolve(null));
        }
      });
    } catch {
      tab = null;
    }
  } else {
    tab = { id: tabId, url: 'https://example.com', title: 'Example' } as chrome.tabs.Tab;
  }

  if (!tab) {
    throw new SnapshotError(
      `The target tab [${tabId}] no longer exists (it was probably closed). Open the page you want automated and start the task again.`
    );
  }

  const inScope = await deps.isTabInScope(tabId);
  if (!inScope) {
    throw new SnapshotError(
      `Tab [${tabId}] is outside this session's Tarka group and cannot be automated from here. Each window's Tarka session only acts on tabs within its own group.`
  );
  }

  const restriction = describeRestrictedUrl(tab.url || '');
  if (restriction) {
    throw new SnapshotError(restriction);
  }

  if (opts.showBadges === false && deps.clearBadges) {
    await deps.clearBadges(tabId).catch(() => {});
  }

  const sendSnapshotMessage = (tId: number): Promise<any> => {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) {
        return resolve({
          success: true,
          data: { url: tab?.url || '', title: tab?.title || '', elementsText: '', refs: [] },
          docId: 'doc-1',
        });
      }
      chrome.tabs.sendMessage(
        tId,
        {
          action: 'GET_DOM_SNAPSHOT',
          payload: {
            maxElements: opts.maxElements ?? 120,
            showBadges: opts.showBadges === true,
          },
        },
        TOP_FRAME,
        (resp) => {
          const err = lastRuntimeError();
          if (err) {
            reject(new Error(err));
          } else if (resp && resp.success === false) {
            reject(new SnapshotError(resp.error || 'DOM snapshot failed'));
          } else if (!resp) {
            reject(new Error('No response from content script'));
          } else {
            resolve(resp);
          }
        }
      );
    });
  };

  try {
    const resp = await sendSnapshotMessage(tabId);
    const data = resp?.data ?? resp;
    const docId = resp?.docId ?? data?.docId ?? 'doc-1';
    return {
      ...data,
      data,
      docId,
    };
  } catch (primaryErr: any) {
    if (primaryErr instanceof SnapshotError) {
      throw primaryErr;
    }
    Logger.debug('Browser', `[INJECT] Content script not active on tab [${tabId}] (${tab.url}). Injecting script dependencies...`);

    try {
      if (typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [...CONTENT_SCRIPT_FILES],
        });
      }

      if (deps.sleep) {
        await deps.sleep(400);
      } else {
        await new Promise((r) => setTimeout(r, 400));
      }

      const retryResp = await sendSnapshotMessage(tabId);
      const data = retryResp?.data ?? retryResp;
      const docId = retryResp?.docId ?? data?.docId ?? 'doc-1';
      return {
        ...data,
        data,
        docId,
      };
    } catch (injectErr: any) {
      if (injectErr instanceof SnapshotError) {
        throw injectErr;
      }
      Logger.error('Browser', `[INJECT_FAILED] Could not inject page scripts into tab [${tabId}] (${tab.url})`, injectErr);
      throw new SnapshotError(
        `Could not read the page at ${tab.url} - ${injectErr.message}. Reload that tab (Cmd+R) and start the task again.`
      );
    }
  }
}
