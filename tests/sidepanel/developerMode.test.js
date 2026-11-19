import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { install, settle } from './fakePanelDom.js';

const { getEl, storage, sent } = install({ models: ['test-model-1'] });

const navChat = getEl('__nav_chat');
navChat.setAttribute('data-tab', 'chat');
navChat.classList.add('active');
const navSettings = getEl('__nav_settings');
navSettings.setAttribute('data-tab', 'settings');
const navLogs = getEl('__nav_logs');
navLogs.setAttribute('data-tab', 'logs');
navLogs.hidden = true;

for (const btn of [navChat, navSettings, navLogs]) {
  btn.click = () => { void btn.dispatchEvent('click'); };
}

const tabChat = getEl('tab-chat');
tabChat.classList.add('active');
const tabSettings = getEl('tab-settings');
const tabLogs = getEl('tab-logs');

const storageListeners = [];
let fireOnSet = false;
let workerLogs = [
  { id: 'w1', timestamp: '12:00:00', level: 'INFO', kind: 'agent', module: 'Runner', message: 'Worker log line', data: null }
];

globalThis.document.querySelector = (sel) => {
  if (sel === '.nav-btn[data-tab="logs"]') return navLogs;
  if (sel === '.nav-btn[data-tab="chat"]') return navChat;
  return null;
};
globalThis.document.querySelectorAll = (sel) => {
  if (sel === '.nav-btn') return [navChat, navSettings, navLogs];
  if (sel === '.tab-panel') return [tabChat, tabSettings, tabLogs];
  return [];
};
globalThis.document.body = getEl('__body');

const originalSet = globalThis.chrome.storage.local.set;
globalThis.chrome.storage.local.set = (data, cb) => {
  const prev = storage.data.agent_settings ? structuredClone(storage.data.agent_settings) : undefined;
  originalSet(data, () => {
    if (fireOnSet && data.agent_settings) {
      for (const fn of storageListeners) {
        fn({ agent_settings: { oldValue: prev, newValue: structuredClone(data.agent_settings) } }, 'local');
      }
    }
    cb?.();
  });
};
globalThis.chrome.storage.onChanged = {
  addListener(fn) { storageListeners.push(fn); }
};
globalThis.chrome.runtime.sendMessage = (msg, cb) => {
  sent.push(msg);
  if (msg.action === 'GET_AGENT_STATE') {
    cb?.({
      success: true,
      status: 'idle',
      stepCount: 0,
      task: '',
      history: [],
      planSteps: [],
      currentPhase: '',
      pauseReason: null,
      pendingApproval: null,
      pendingConfirm: null,
      stateVersion: 1,
      bootId: 'boot-1',
      tarkaGroupId: null,
      effort: null,
      effortProfile: null,
      runStats: null,
      chatId: null,
      context: { used: 0, window: 262144, windowSource: 'default', estimated: false, summarizedTurns: 0, hasEarlierTurn: false, compacting: false },
      logs: workerLogs
    });
    return;
  }
  cb?.({ success: true, models: ['test-model-1'] });
};

const {
  loadSettings,
  initTabs,
  initEventListeners,
  setDeveloperModeUI,
  resyncAgentState,
  followSavedSessionChanges
} = await import('../../sidepanel/sidepanel.js');

initTabs();
initEventListeners();
followSavedSessionChanges();

test('Developer Mode toggle starts off and controls Logs visibility', async () => {
  const html = await readFile(new URL('../../sidepanel/sidepanel.html', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../../sidepanel/sidepanel.js', import.meta.url), 'utf8');
  assert.match(html, /id="btnDeveloperMode"[^>]*role="switch" aria-checked="false"/);
  assert.match(html, /data-tab="logs" hidden/);
  assert.match(panel, /Storage\.saveSettings\(\{ developerMode: enabled \}\)/);
  assert.match(panel, /logsTab\.hidden = !enabled/);
});

test('resyncAgentState ignores logs while Developer mode is off and setDeveloperModeUI(true) syncs state', async () => {
  fireOnSet = false;
  storage.data = { agent_settings: { provider: 'ollama', developerMode: false } };
  await loadSettings();
  await settle();

  resyncAgentState();
  await settle();
  assert.match(getEl('logOutput').innerHTML, /Developer mode is off\. Logs are not saved\./);
  assert.doesNotMatch(getEl('logOutput').innerHTML, /Worker log line/);

  setDeveloperModeUI(true);
  await settle();
  assert.equal(navLogs.hidden, false);
  assert.match(getEl('logOutput').innerHTML, /Nothing logged yet/);
});

test('clicking Developer mode toggle fires GET_AGENT_STATE once even when storage.onChanged fires first', async () => {
  fireOnSet = true;
  storage.data = { agent_settings: { provider: 'ollama', developerMode: false } };
  await loadSettings();
  await settle();

  sent.length = 0;
  await getEl('btnDeveloperMode').dispatchEvent('click');
  await settle(20);

  const stateGets = sent.filter((m) => m.action === 'GET_AGENT_STATE');
  assert.equal(stateGets.length, 1, 'GET_AGENT_STATE must be sent once when toggling Developer mode on');
  assert.match(getEl('logOutput').innerHTML, /Worker log line/);
  assert.equal(navLogs.hidden, false);
  assert.equal(getEl('btnDeveloperMode').getAttribute('aria-checked'), 'true');
});

test('chrome.storage.onChanged from another panel updates Developer mode UI, Logs tab, and logs cache', async () => {
  fireOnSet = false;
  storage.data = { agent_settings: { provider: 'ollama', developerMode: false } };
  await loadSettings();
  await settle();

  sent.length = 0;
  for (const fn of storageListeners) {
    fn({ agent_settings: { oldValue: { developerMode: false }, newValue: { developerMode: true } } }, 'local');
  }
  await settle(20);
  assert.equal(getEl('btnDeveloperMode').getAttribute('aria-checked'), 'true');
  assert.equal(navLogs.hidden, false);
  assert.equal(sent.filter((m) => m.action === 'GET_AGENT_STATE').length, 1);
  assert.match(getEl('logOutput').innerHTML, /Worker log line/);

  for (const fn of storageListeners) {
    fn({ agent_settings: { oldValue: { developerMode: true }, newValue: { developerMode: false } } }, 'local');
  }
  await settle(20);
  assert.equal(getEl('btnDeveloperMode').getAttribute('aria-checked'), 'false');
  assert.equal(navLogs.hidden, true);
  assert.doesNotMatch(getEl('logOutput').innerHTML, /Worker log line/);
});

test('initTabs is idempotent and does not bind duplicate click listeners', () => {
  initTabs();
  initTabs();
  const countBefore = (navSettings.listeners.click || []).length;
  initTabs();
  assert.equal((navSettings.listeners.click || []).length, countBefore);
});

test('btnCopyLogs handles clipboard rejection without an unhandled rejection', async () => {
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let unhandled = null;
  const onUnhandled = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: () => Promise.reject(new Error('Clipboard denied')) } },
    configurable: true
  });
  globalThis.document.execCommand = undefined;
  try {
    await getEl('btnCopyLogs').dispatchEvent('click');
    await settle(20);
    assert.equal(unhandled, null, 'rejected clipboard write must not cause an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    if (prevDescriptor) Object.defineProperty(globalThis, 'navigator', prevDescriptor);
    else delete globalThis.navigator;
  }
});

test('importing sidepanel.js with document.readyState === "interactive" runs initTabs cleanly without TDZ ReferenceError', () => {
  const panelUrl = pathToFileURL(fileURLToPath(new URL('../../sidepanel/sidepanel.js', import.meta.url))).href;
  const script = `
    const mk = () => ({ classList: { add() {}, remove() {}, contains: () => false }, addEventListener() {}, getAttribute: () => 'chat' });
    globalThis.window = { innerHeight: 800, addEventListener() {} };
    globalThis.document = {
      readyState: 'interactive',
      documentElement: { setAttribute() {}, removeAttribute() {} },
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [mk()]
    };
    await import(${JSON.stringify(panelUrl)});
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
});
