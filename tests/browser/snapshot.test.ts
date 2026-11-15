import test from 'node:test';
import assert from 'node:assert/strict';
import { takeSnapshot, SnapshotError } from '../../src/background/browser/snapshot.ts';

test('takeSnapshot - throws tab_gone on invalid or missing tabId', async () => {
  await assert.rejects(
    async () => takeSnapshot(0 as any, {}, { isTabInScope: async () => true }),
    (err: any) => err instanceof SnapshotError && /No target tab/.test(err.message)
  );
});

test('takeSnapshot - throws out_of_scope when tab is outside Tarka group', async () => {
  const prevChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    tabs: {
      get: (id: number, cb: (tab: any) => void) => cb({ id, url: 'https://example.com', title: 'Example' }),
    },
    runtime: { lastError: null },
  };

  try {
    await assert.rejects(
      async () => takeSnapshot(101, {}, { isTabInScope: async () => false }),
      (err: any) => err instanceof SnapshotError && /outside this session's Tarka group/.test(err.message)
    );
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});

test('takeSnapshot - throws restricted when tab is on a restricted URL', async () => {
  const prevChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    tabs: {
      get: (id: number, cb: (tab: any) => void) => cb({ id, url: 'chrome://extensions', title: 'Extensions' }),
    },
    runtime: { lastError: null },
  };

  try {
    await assert.rejects(
      async () => takeSnapshot(101, {}, { isTabInScope: async () => true }),
      (err: any) => err instanceof SnapshotError && /Tarka cannot read/.test(err.message)
    );
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});

test('takeSnapshot - captures snapshot successfully on first attempt', async () => {
  const prevChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    tabs: {
      get: (id: number, cb: (tab: any) => void) => cb({ id, url: 'https://example.com', title: 'Example' }),
      sendMessage: (id: number, msg: any, _opts: unknown, cb: (resp: any) => void) => {
        cb({
          success: true,
          data: { url: 'https://example.com', title: 'Example', elementsText: '[1] button "Search"' },
          docId: 'doc-42',
        });
      },
    },
    runtime: { lastError: null },
  };

  try {
    const snap = await takeSnapshot(101, { showBadges: true }, { isTabInScope: async () => true });
    assert.equal(snap.docId, 'doc-42');
    assert.equal(snap.url, 'https://example.com');
    assert.equal(snap.elementsText, '[1] button "Search"');
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});

test('takeSnapshot - performs injection fallback when primary attempt fails', async () => {
  const prevChrome = (globalThis as any).chrome;
  let attempts = 0;
  const injectedFiles: string[][] = [];

  (globalThis as any).chrome = {
    tabs: {
      get: (id: number, cb: (tab: any) => void) => cb({ id, url: 'https://example.com', title: 'Example' }),
      sendMessage: (id: number, msg: any, _opts: unknown, cb: (resp: any) => void) => {
        attempts++;
        if (attempts === 1) {
          cb(null); // Triggers primary error
        } else {
          cb({
            success: true,
            data: { url: 'https://example.com', title: 'Example (Injected)', elementsText: '[2] a "Home"' },
            docId: 'doc-99',
          });
        }
      },
    },
    scripting: {
      executeScript: (opts: any) => {
        injectedFiles.push(opts.files);
        return Promise.resolve([{ result: true }]);
      },
    },
    runtime: { lastError: null },
  };

  try {
    const snap = await takeSnapshot(101, {}, { isTabInScope: async () => true, sleep: async () => {} });
    assert.equal(attempts, 2);
    assert.equal(injectedFiles.length, 1); // the isolated content scripts, and nothing else
    assert.deepEqual(injectedFiles[0], ['content/domCompressor.js', 'content/actionExecutor.js', 'content/content.js'], 'the fallback injects the isolated content scripts');
    assert.equal(snap.docId, 'doc-99');
    assert.equal(snap.title, 'Example (Injected)');
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});
