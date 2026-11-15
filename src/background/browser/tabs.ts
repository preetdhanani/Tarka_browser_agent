
export function lastRuntimeError(): string | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
      return chrome.runtime.lastError.message ?? 'Unknown chrome error';
    }
  } catch (_) {
  }
  return null;
}

// Chrome blocks extensions from scripting internal pages, extension pages and the Web Store.
export function describeRestrictedUrl(url: string | null | undefined): string | null {
  if (!url) {
    return 'That tab has not finished loading a page yet. Wait for it to load, then start the task again.';
  }
  if (/^chrome:\/\//i.test(url) || /^edge:\/\//i.test(url) || /^about:/i.test(url) || /^brave:\/\//i.test(url)) {
    return `Tarka cannot read ${url} - Chrome blocks all extensions from accessing its own internal pages, so no extension can automate this screen. Switch to a normal website tab (anything starting with http:// or https://) and start the task again.`;
  }
  if (/^chrome-extension:\/\//i.test(url) || /^moz-extension:\/\//i.test(url)) {
    return `Tarka cannot read ${url} - browsers block extensions from scripting other extensions' pages. Switch to a normal website tab and start the task again.`;
  }
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url) || /^https:\/\/chrome\.google\.com\/webstore/i.test(url)) {
    return 'Tarka cannot read the Chrome Web Store - Chrome blocks extensions from scripting it. Switch to another site and start the task again.';
  }
  if (/^(file|view-source|devtools|data):/i.test(url)) {
    return `Tarka cannot read ${url.split(':')[0]}: pages. Switch to a normal website tab and start the task again.`;
  }
  return null;
}

export function isValidWebTab(tab: { url?: string | null } | null | undefined): boolean {
  if (!tab || !tab.url) return false;
  return describeRestrictedUrl(tab.url) === null;
}

export function isDisposableTab(tab: { url?: string | null; pendingUrl?: string | null } | null | undefined): boolean {
  const url = tab && (tab.url || tab.pendingUrl);
  if (!url) return false;
  return url === 'about:blank' || /^(chrome|edge|brave):\/\/(newtab|new-tab-page)\/?$/i.test(url);
}

export function getTab(
  tabId: number,
  callback?: (tab: chrome.tabs.Tab | null) => void
): Promise<chrome.tabs.Tab | null> {
  const promise = new Promise<chrome.tabs.Tab | null>((resolve) => {
    try {
      if (!tabId || typeof chrome === 'undefined' || !chrome.tabs?.get) {
        resolve(null);
        return;
      }
      const maybePromise: any = (chrome.tabs.get as any)(tabId, (t: chrome.tabs.Tab) => {
        lastRuntimeError();
        resolve(t || null);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(
          (t: chrome.tabs.Tab | null) => resolve(t || null),
          () => resolve(null)
        );
      }
    } catch (_) {
      resolve(null);
    }
  });

  if (callback) {
    promise.then((t) => callback(t)).catch(() => callback(null));
  }
  return promise;
}

export async function liveTabUrl(tabId: number, fallback = ''): Promise<string> {
  try {
    if (!tabId || typeof chrome === 'undefined' || !chrome.tabs?.get) return fallback;
    const tab = await getTab(tabId);
    return tab && typeof tab.url === 'string' && tab.url !== '' ? tab.url : fallback;
  } catch (_) {
    return fallback;
  }
}
