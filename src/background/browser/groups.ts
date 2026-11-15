import { lastRuntimeError } from './tabs.ts';
import { Logger } from '../../shared/logger.ts';

export interface GroupContext {
  windowId?: number | 'default';
  groupIds: Map<number | 'default' | any, number>;
  persist(): void | Promise<void>;
}

export function groupIdForWindow(ctx: GroupContext, windowId: number | 'default'): number | null {
  if (typeof windowId === 'number') {
    return ctx.groupIds.get(windowId) ?? null;
  }
  const first = ctx.groupIds.values().next();
  return first.done ? null : first.value;
}

export async function isTabInScope(ctx: GroupContext, tabId: number): Promise<boolean> {
  if (!tabId) return false;
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.get) return true;

  const tab = await new Promise<chrome.tabs.Tab | null>((resolve, reject) => {
    const maybePromise: any = chrome.tabs.get(tabId, (t) => {
      lastRuntimeError();
      resolve(t ?? null);
    });
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(resolve, reject);
    }
  }).catch(() => null);

  if (!tab) return false;

  const windowKey = tab.windowId !== undefined ? tab.windowId : (ctx.windowId ?? 'default');
  // Chrome tab groups cannot span windows.
  const ownGroupForThatWindow = ctx.groupIds.get(windowKey);
  if (ownGroupForThatWindow === undefined || ownGroupForThatWindow === null) {
    return false;
  }
  return tab.groupId === ownGroupForThatWindow;
}

export async function ensureTarkaGroup(
  ctx: GroupContext,
  tabId: number,
  explicitWindowId?: number
): Promise<number | null> {
  if (!tabId || typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.group) return null;

  try {
    const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
      chrome.tabs.get(tabId, (t) => {
        lastRuntimeError();
        resolve(t ?? null);
      });
    });

    if (!tab) return null;

    const windowId = explicitWindowId !== undefined && explicitWindowId !== null
      ? explicitWindowId
      : (tab.windowId !== undefined ? tab.windowId : (ctx.windowId !== undefined ? ctx.windowId : 'default'));

    const TAB_GROUP_ID_NONE = (typeof chrome.tabGroups !== 'undefined' && chrome.tabGroups.TAB_GROUP_ID_NONE !== undefined)
      ? chrome.tabGroups.TAB_GROUP_ID_NONE
      : -1;

    let recordedGroupId: number | null | undefined = ctx.groupIds.get(windowId);
    if (recordedGroupId === undefined) recordedGroupId = null;

    let activeGroupValid = false;
    if (recordedGroupId && recordedGroupId !== TAB_GROUP_ID_NONE) {
      if (chrome.tabGroups && chrome.tabGroups.get) {
        const activeGrp = await new Promise<chrome.tabGroups.TabGroup | null>((resolve) => {
          chrome.tabGroups.get(recordedGroupId!, (g) => {
            lastRuntimeError();
            resolve(g ?? null);
          });
        });
        if (activeGrp) {
          activeGroupValid = true;
        }
      } else {
        activeGroupValid = true;
      }
    }

    if (!activeGroupValid) {
      recordedGroupId = null;
      ctx.groupIds.delete(windowId);
    }

    if (activeGroupValid && recordedGroupId) {
      if (tab.groupId !== recordedGroupId) {
        const rejoinErr = await new Promise<string | null>((resolve) => {
          chrome.tabs.group({ tabIds: tabId, groupId: recordedGroupId! }, () => {
            resolve(lastRuntimeError());
          });
        });
        if (rejoinErr) {
          Logger.warn('Browser', `[TAB_SANDBOX] Rejoining tab [${tabId}] to group ${recordedGroupId} failed: ${rejoinErr}. Creating a fresh group.`);
          recordedGroupId = null;
          ctx.groupIds.delete(windowId);
        } else {
          Logger.debug('Browser', `[TAB_SANDBOX] Tab [${tabId}] joined active 'Tarka' tab group (GroupID: ${recordedGroupId}, window [${windowId}])`);
          return recordedGroupId;
        }
      } else {
        Logger.debug('Browser', `[TAB_SANDBOX] Tab [${tabId}] joined active 'Tarka' tab group (GroupID: ${recordedGroupId}, window [${windowId}])`);
        return recordedGroupId;
      }
    }

    if (tab.groupId && tab.groupId !== TAB_GROUP_ID_NONE && chrome.tabGroups && chrome.tabGroups.get) {
      const currentGrp = await new Promise<chrome.tabGroups.TabGroup | null>((resolve) => {
        chrome.tabGroups.get(tab.groupId, (g) => {
          lastRuntimeError();
          resolve(g ?? null);
        });
      });
      if (currentGrp && currentGrp.title === 'Tarka') {
        ctx.groupIds.set(windowId, tab.groupId);
        try { ctx.persist(); } catch (_) {}
        return tab.groupId;
      }
    }

    const createProperties = tab.windowId !== undefined ? { windowId: tab.windowId } : undefined;
    const newGroupId = await new Promise<number | null>((resolve) => {
      chrome.tabs.group({ tabIds: tabId, ...(createProperties ? { createProperties } : {}) }, (gid) => {
        lastRuntimeError();
        resolve(typeof gid === 'number' ? gid : null);
      });
    });

    if (newGroupId) {
      if (chrome.tabGroups && chrome.tabGroups.update) {
        await new Promise<void>((resolve) => {
          chrome.tabGroups.update(newGroupId, { title: 'Tarka', color: 'orange' }, () => {
            lastRuntimeError();
            resolve();
          });
        });
      }

      ctx.groupIds.set(windowId, newGroupId);
      try { ctx.persist(); } catch (_) {}
      Logger.debug('Browser', `[TAB_SANDBOX] Created fresh 'Tarka' tab group (GroupID: ${newGroupId}) for tab [${tabId}] (window [${windowId}])`);
      return newGroupId;
    }

    return null;
  } catch (err: any) {
    Logger.warn('Browser', '[TAB_SANDBOX_WARN] Could not sandbox tab into Tarka group', err.message);
    return null;
  }
}
