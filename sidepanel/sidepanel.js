

import { Storage, DEFAULT_SETTINGS, DEFAULT_PROVIDER_CONFIGS, CHAT_INDEX_KEY } from '../src/shared/storage.ts';
import { extractReadableAnswer } from '../src/shared/answerText.ts';
import { BUILD_STAMP, IS_BUILD } from '../src/shared/build.ts';
import { renderActionConfirmationCard } from './cards.js';

import { BRAND_MARK } from './brand.js';
import { contextCardHtml, contextWindowHint, meterView, ringSvg } from './contextMeter.js';
import { formatTokens, parseTokenCount } from '../src/shared/tokens.ts';
import { logEntryHtml, logMatchesFilter, parseLogData, treeStateKey } from './logView.js';

import {
  initCustomProviderDialog,
  providerMeta,
  buildProviderOptions,
  isCustomProviderId,
  CUSTOM_TRIGGER_VALUE,
  CUSTOM_EMPTY_MODELS_TEXT
} from './customProvider.js';

let backgroundPort = null;
let currentSettings = { ...DEFAULT_SETTINGS };
let customProviderDialog = null;


let myTabId = null;


function sendBgMessage(msg, cb) {
  chrome.runtime.sendMessage({ ...msg, tabId: myTabId }, cb);
}

let currentSessionId = null;
let currentActiveLogFilter = 'all';
let rawLogsCache = [];
let apiKeyFetchDebounce = null;
let allFetchedModels = [];


let allFetchedModelsProvider = null;


let selectedModel = null;


const CUSTOM_MODEL_OPTION = '__custom__';

let customModelFieldOpen = false;
let currentEffort = 'auto';


let preferredEffort = 'auto';


let effortRunWasActive = false;
let effortSupport = { levels: ['auto', 'off', 'low', 'medium', 'high', 'max'], note: '' };


let approvalMode = 'auto';

let isSubmittingTask = false;


let isTaskActive = false;


let runModelSnapshot = null;
let portReconnectAttempts = 0;
let portReconnectTimer = null;


let hasConnectedBefore = false;


let lastRenderedStateVersion = -1;
let lastBootId = null;


let lastState = null;


let taskError = null;


const turnExpandOverride = new Map();
const expandedRows = new Set();


const openAuditDetails = new Set();

const openCompactSummaries = new Set();


let lastContextState = null;

let lastContextBusy = false;

let compactPending = false;


const shotCache = new Map();

const shotLoading = new Set();


const shotGone = new Set();

const closedAuditDetails = new Set();


let followTimeline = true;

const FOLLOW_SLACK_PX = 80;

let readerScrollAt = 0;
let readerOnScrollbar = false;

const READER_SCROLL_MS = 600;

let lastTimelineHtml = '';


const ICONS = {
  check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
  cross: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  dot: '<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>',
  circle: '<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  warning: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3L2 20h20L12 3z"/><line x1="12" y1="9" x2="12" y2="14"/><circle cx="12" cy="17.3" r="0.6" fill="currentColor" stroke="none"/></svg>',
  shield: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/></svg>',
  complete: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.3 2.3L16 10"/></svg>',
  clock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/></svg>',
  copy: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="1.5"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  search: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  star: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3l2.6 5.4 5.9.8-4.3 4.2 1 5.9L12 16.3 6.8 19.3l1-5.9-4.3-4.2 5.9-.8z"/></svg>',
  doc: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="17" y2="13"/><line x1="7" y1="17" x2="13" y2="17"/></svg>',
  globe: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.6 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.6-3.8-9s1.3-6.5 3.8-9z"/></svg>',
  eye: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  pointer: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M5 3l6.5 17 2.4-6.6 6.6-2.4z"/></svg>',
  camera: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.2-1.8h5l1.2 1.8h1.8A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/><circle cx="12" cy="12.5" r="3.2"/></svg>',
  keyboard: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" stroke-linecap="round"/></svg>',
  enter: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 5v6a3 3 0 0 1-3 3H5"/><polyline points="9 10 5 14 9 18"/></svg>',
  scrollIco: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 4 12 8 16 4"/><polyline points="8 20 12 16 16 20"/></svg>',
  back: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="10 5 4 11 10 17"/><path d="M4 11h10a6 6 0 0 1 6 6v2"/></svg>',
  layers: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 3 21 8 12 13 3 8"/><polyline points="3 13 12 18 21 13"/></svg>',
  ask: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.3 2.5c-.6.2-.9.7-.9 1.3v.4"/><circle cx="12" cy="16.6" r="0.6" fill="currentColor" stroke="none"/></svg>',
  chevron: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>',
  chevronRight: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 5 11 12 5 19"/></svg>',
  chevronDown: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="19 5 13 12 19 19"/></svg>',
  aim: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>',


  skip: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'
};


const MAX_PANEL_LOGS = 500;


const logTreeState = new Map();

const THEME_MODES = ['system', 'light', 'dark'];
const THEME_ICON = {
  system: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>',
  light: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>',
  dark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>'
};
const THEME_LABEL = { system: 'Auto (matches system)', light: 'Light', dark: 'Dark' };

function applyApprovalMode(mode) {
  approvalMode = mode === 'manual' ? 'manual' : 'auto';
  const btn = document.getElementById('btnApprovalMode');
  const icon = document.getElementById('approvalModeIcon');
  if (icon) icon.innerHTML = APPROVAL_ICON[approvalMode];
  if (btn) {
    btn.title = APPROVAL_TITLE[approvalMode];
    btn.setAttribute('aria-label', APPROVAL_TITLE[approvalMode]);
  }
  document.querySelectorAll('#approvalMenu .menu-item').forEach((item) => {
    const checked = item.getAttribute('data-approval') === approvalMode;
    const check = item.querySelector('.menu-check');
    if (check) check.innerHTML = checked ? MENU_CHECK : '';
    item.setAttribute('aria-checked', String(checked));
  });
}

const EFFORT_LABEL = { auto: 'Auto', off: 'Off', low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };
const EFFORT_ORDER = ['off', 'low', 'medium', 'high', 'max'];


function normalizeEffort(effort) {
  if (effort === 'xhigh') return 'max';
  return EFFORT_LABEL[effort] ? effort : 'auto';
}


function nearestSupportedEffort(effort, levels) {
  if (levels.includes(effort)) return effort;

  const thinking = levels.filter((level) => level !== 'auto' && (effort === 'off' || level !== 'off'));
  if (effort === 'auto' || thinking.length === 0) return 'auto';
  const want = EFFORT_ORDER.indexOf(effort);
  return thinking.reduce((best, level) => (Math.abs(EFFORT_ORDER.indexOf(level) - want) < Math.abs(EFFORT_ORDER.indexOf(best) - want) ? level : best), thinking[0]);
}

function setEffort(effort) {
  preferredEffort = normalizeEffort(effort);
  renderEffort();
}


function renderEffort() {
  const levels = effortSupport.levels && effortSupport.levels.length ? effortSupport.levels : ['auto'];
  currentEffort = nearestSupportedEffort(preferredEffort, levels);
  const onlyAuto = levels.length === 1;
  const btn = document.getElementById('btnEffort');
  if (btn) {
    btn.textContent = EFFORT_LABEL[currentEffort];
    btn.title = onlyAuto
      ? `Effort: ${effortSupport.note || 'this model has no reasoning setting.'}`
      : `Effort: how hard the model thinks before each step (${EFFORT_LABEL[currentEffort]})`;
  }
  document.querySelectorAll('#effortMenu .menu-item').forEach((item) => {
    const level = item.getAttribute('data-effort');
    item.hidden = !levels.includes(level);
    const checked = level === currentEffort;
    const check = item.querySelector('.menu-check');
    if (check) check.innerHTML = checked ? MENU_CHECK : '';
    item.setAttribute('aria-checked', String(checked));
  });
  const note = document.getElementById('effortMenuNote');
  if (note) note.textContent = effortSupport.note || '';
}


let effortSupportAsk = 0;
function refreshEffortSupport() {
  const provider = document.getElementById('providerSelect')?.value || currentSettings.provider;
  const model = selectedModel || currentSettings.providerConfigs?.[provider]?.model || currentSettings.model || '';
  const ask = ++effortSupportAsk;
  sendBgMessage({
    action: 'GET_EFFORT_SUPPORT',
    payload: {
      provider,
      model,
      baseUrl: currentSettings.providerConfigs?.[provider]?.baseUrl || (provider === currentSettings.provider ? currentSettings.baseUrl : ''),
      providerConfigs: currentSettings.providerConfigs,
      customProviders: currentSettings.customProviders
    }
  }, (res) => {
    if (ask !== effortSupportAsk || !res || !res.success || !res.support) return;
    effortSupport = res.support;
    renderEffort();
  });
}


function contextFieldTarget() {
  const provider = document.getElementById('providerSelect')?.value || currentSettings.provider;
  const model = (selectedModel && selectedModel !== CUSTOM_MODEL_OPTION ? selectedModel : '') || currentSettings.providerConfigs?.[provider]?.model || currentSettings.model || '';
  return { provider, model, key: `${provider}|${model}` };
}


let contextFieldAsk = 0;
function refreshContextWindowField() {
  const input = document.getElementById('contextWindowInput');
  const hint = document.getElementById('contextWindowHint');
  if (!input || !hint) return;
  const { provider, model, key } = contextFieldTarget();
  const own = Number(currentSettings.contextWindow?.[key]) || 0;
  if (document.activeElement !== input) input.value = own > 0 ? String(own) : '';
  const ask = ++contextFieldAsk;
  sendBgMessage({
    action: 'GET_CONTEXT_WINDOW',
    payload: {
      provider,
      model,
      baseUrl: currentSettings.providerConfigs?.[provider]?.baseUrl || (provider === currentSettings.provider ? currentSettings.baseUrl : ''),
      providerConfigs: currentSettings.providerConfigs,
      customProviders: currentSettings.customProviders,
      contextWindow: currentSettings.contextWindow,
      ollamaNumCtx: currentSettings.ollamaNumCtx
    }
  }, (res) => {
    if (ask !== contextFieldAsk) return;
    const window = !chrome.runtime.lastError && res && res.success ? res.window : null;
    hint.classList.remove('is-error');
    hint.textContent = contextWindowHint(window, provider);
  });
}


async function saveContextWindowField() {
  const input = document.getElementById('contextWindowInput');
  const hint = document.getElementById('contextWindowHint');
  if (!input) return;
  const { key } = contextFieldTarget();
  const raw = String(input.value || '').trim();
  const tokens = raw ? parseTokenCount(raw) : null;
  if (raw && !tokens) {
    if (hint) {
      hint.textContent = `"${raw}" is not a token count. Use a number like 200000, 200K or 1M, or leave the field empty.`;
      hint.classList.add('is-error');
    }
    return;
  }

  currentSettings = await Storage.saveSettings({ contextWindow: { [key]: tokens } });
  input.value = tokens ? String(tokens) : '';
  refreshContextWindowField();
}


function contextModelName() {
  if (lastContextBusy && runModelSnapshot && runModelSnapshot.model) return runModelSnapshot.model;
  return selectedModel || currentSettings.model || '';
}


function renderContextMeter() {
  const view = meterView(lastContextState, { busy: lastContextBusy, model: contextModelName(), pending: compactPending });
  const btn = document.getElementById('btnContext');
  const slot = document.getElementById('contextRing');
  const menu = document.getElementById('contextMenu');
  if (slot) slot.innerHTML = ringSvg(view);
  if (btn) {
    btn.setAttribute('aria-label', view.label);
    btn.title = view.label;
  }
  if (menu && !menu.hidden) menu.innerHTML = contextCardHtml(view);
  return view;
}


function compactChatFromPanel() {
  if (compactPending) return;
  compactPending = true;
  renderContextMeter();
  sendBgMessage({ action: 'COMPACT_CHAT' }, (res) => {
    compactPending = false;
    const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.success === false ? res.error : null);
    if (error || !res) {
      const text = error || 'The chat could not be compacted.';
      appendLocalLog('WARN', 'Sidepanel', `[COMPACT_FAILED] ${text}`);
      showToast(text, 'error');
    }
    renderContextMeter();
  });
}


function refreshComposerModel() {
  const el = document.getElementById('composerModel');
  if (!el) return;
  const label = selectedModel || currentSettings.model || 'model';
  el.textContent = label;
  el.title = `Model: ${label}. The models of the chosen provider are one click away.`;
}


const APPROVAL_ICON = {
  auto: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="4 4 12 12 4 20"/><polygon points="11 4 19 12 11 20"/></svg>',
  manual: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a1.5 1.5 0 0 0-3 0v4"/><path d="M15 10V4.5a1.5 1.5 0 0 0-3 0V10"/><path d="M12 10V6a1.5 1.5 0 0 0-3 0v8"/><path d="M9 14l-1.6-2.7a1.5 1.5 0 0 0-2.6 1.5L7.7 18A6 6 0 0 0 13 21h1a6 6 0 0 0 6-6v-3a1.5 1.5 0 0 0-2 0"/></svg>'
};
const APPROVAL_TITLE = {
  auto: 'Automatically approve - the agent runs without asking',
  manual: 'Manually approve - the agent shows its plan first'
};
const MENU_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4.5 12.5 9.5 17.5 19.5 7"/></svg>';


function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentElement) toast.remove();
  }, 3000);
}

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') {
    root.setAttribute('data-theme', mode);
  } else {
    root.removeAttribute('data-theme');
  }
  const btn = document.getElementById('btnThemeToggle');
  if (btn) {
    btn.innerHTML = THEME_ICON[mode] || THEME_ICON.system;
    btn.title = `Theme: ${THEME_LABEL[mode] || THEME_LABEL.system}`;
  }
}

document.addEventListener('DOMContentLoaded', async () => {


  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      const tabs = await new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => resolve(t || [])));
      myTabId = tabs && tabs[0] ? tabs[0].id : null;
    }
  } catch (err) {
    reportClientError('sidepanel:resolve-tab', err);
  }


  await loadSettings();
  initTabs();
  initTimelineInteraction();
  initLogInteractions();
  initPortConnection();
  initEventListeners();
  initCombobox();
  customProviderDialog = initCustomProviderDialog({
    getSettings: () => currentSettings,
    applySettings: (s) => { currentSettings = s; },
    sendBgMessage,
    showToast,


    providerSelected: async (id) => {
      document.getElementById('providerSelect').value = id;
      await applyProviderSelection(id);
    }
  });
  await loadSessionHistory();
  followSavedSessionChanges();
  await fetchDynamicModels(false);
});


function followSavedSessionChanges() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[CHAT_INDEX_KEY]) return;
    loadSessionHistory().catch((err) => reportClientError('sidepanel:session-history-sync', err));
  });
}


if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initTabs();
}


function providerOwnTimeoutOf(settings, provider) {
  const configMs = Number(settings?.providerConfigs?.[provider]?.llmTimeoutMs);
  if (configMs > 0) return configMs;
  const customMs = Number(settings?.customProviders?.[provider]?.llmTimeoutMs);
  if (customMs > 0) return customMs;
  return 0;
}


function timeoutShownFor(settings, provider) {
  const own = providerOwnTimeoutOf(settings, provider);
  if (own > 0) return own;

  const isCustom = isCustomProviderId(provider, settings);
  const defaultTimeout = isCustom ? DEFAULT_SETTINGS.llmTimeoutMs : (DEFAULT_PROVIDER_CONFIGS[provider]?.llmTimeoutMs || DEFAULT_SETTINGS.llmTimeoutMs);
  return provider === 'nvidia' ? defaultTimeout : (settings.llmTimeoutMs || defaultTimeout);
}


async function loadSettings() {
  currentSettings = await Storage.getSettings();
  applyTheme(currentSettings.theme || 'system');
  setDeveloperModeUI(currentSettings.developerMode === true);

  const activeProvider = currentSettings.provider || 'openrouter';
  const activeIsCustom = isCustomProviderId(activeProvider, currentSettings);
  const providerCfg = (currentSettings.providerConfigs && currentSettings.providerConfigs[activeProvider]) || (activeIsCustom ? {} : (DEFAULT_PROVIDER_CONFIGS[activeProvider] || {}));


  buildProviderOptions(document.getElementById('providerSelect'), currentSettings.customProviders);

  document.getElementById('providerSelect').value = activeProvider;
  document.getElementById('baseUrlInput').placeholder = activeIsCustom
    ? (providerCfg.baseUrl || '')
    : (DEFAULT_PROVIDER_CONFIGS[activeProvider]?.baseUrl || 'https://openrouter.ai/api/v1');
  document.getElementById('baseUrlInput').value = providerCfg.baseUrl || currentSettings.baseUrl || (DEFAULT_PROVIDER_CONFIGS[activeProvider]?.baseUrl || '');
  document.getElementById('apiKeyInput').value = providerCfg.apiKey || currentSettings.apiKey || '';
  document.getElementById('maxStepsInput').value = currentSettings.maxSteps || DEFAULT_SETTINGS.maxSteps;
  document.getElementById('delayInput').value = currentSettings.actionDelayMs || DEFAULT_SETTINGS.actionDelayMs;
  document.getElementById('ollamaNumPredictInput').value = currentSettings.ollamaNumPredict || DEFAULT_SETTINGS.ollamaNumPredict;
  document.getElementById('llmTimeoutInput').value = timeoutShownFor(currentSettings, activeProvider);
  const effortSelect = document.getElementById('effortDefaultSelect');
  if (effortSelect) {
    effortSelect.value = normalizeEffort(currentSettings.effortDefault || 'medium');
  }
  const effortAdaptiveSelect = document.getElementById('effortAdaptiveSelect');
  if (effortAdaptiveSelect) effortAdaptiveSelect.value = currentSettings.effortAdaptive === false ? 'off' : 'on';
  setEffort(currentSettings.effortDefault || 'medium');
  applyApprovalMode(currentSettings.autoApprove === false ? 'manual' : 'auto');


  const ollamaGroup = document.getElementById('ollamaNumPredictGroup');
  if (ollamaGroup) {
    ollamaGroup.style.display = activeProvider === 'ollama' ? 'flex' : 'none';
  }

  loadResearchSettings(currentSettings.research);

  syncCustomProviderActions(activeProvider);
  updateSelectedModel(providerCfg.model || currentSettings.model);
}


function loadResearchSettings(research) {
  const r = research || DEFAULT_SETTINGS.research;
  const enabled = document.getElementById('researchEnabledSelect');
  if (!enabled) return;
  enabled.value = r.enabled === false ? 'off' : 'on';
  document.getElementById('researchBackendSelect').value = r.backend === 'searxng' ? 'searxng' : 'duckduckgo';
  document.getElementById('searxngUrlInput').value = r.searxngUrl || '';
  syncResearchFields();
}


function syncResearchFields() {
  const on = document.getElementById('researchEnabledSelect')?.value !== 'off';
  const searxng = document.getElementById('researchBackendSelect')?.value === 'searxng';
  const backend = document.getElementById('researchBackendGroup');
  const urlGroup = document.getElementById('searxngUrlGroup');
  if (backend) backend.style.display = on ? 'flex' : 'none';
  if (urlGroup) urlGroup.style.display = on && searxng ? 'flex' : 'none';
  const hint = document.getElementById('searxngUrlHint');
  const url = (document.getElementById('searxngUrlInput')?.value || '').trim();
  const bad = on && searxng && !/^https?:\/\/[^\s/]+/i.test(url);
  if (hint) {
    hint.classList.toggle('is-error', bad);
    hint.textContent = bad
      ? (url ? 'Enter a full address that starts with https:// or http://.' : 'Enter the address of your SearXNG server. Until then web search has no results.')
      : 'The server must allow the JSON format (search: formats: [html, json]).';
  }
}


function researchFromForm() {
  return {
    enabled: document.getElementById('researchEnabledSelect')?.value !== 'off',
    backend: document.getElementById('researchBackendSelect')?.value === 'searxng' ? 'searxng' : 'duckduckgo',
    searxngUrl: (document.getElementById('searxngUrlInput')?.value || '').trim()
  };
}


function syncCustomProviderActions(providerId) {
  const actions = document.getElementById('customProviderActions');
  if (actions) actions.style.display = isCustomProviderId(providerId, currentSettings) ? 'flex' : 'none';
}


function updateSelectedModel(modelName) {
  if (modelName === CUSTOM_MODEL_OPTION) {
    setCustomModelFieldOpen(true);
    return;
  }
  const labelEl = document.getElementById('modelSelectedLabel');
  const selectEl = document.getElementById('modelSelect');

  selectedModel = modelName || null;

  if (labelEl) labelEl.textContent = modelName || 'Select a model...';
  if (selectEl) {


    if (modelName && !Array.from(selectEl.options).some(o => o.value === modelName)) {
      const opt = document.createElement('option');
      opt.value = modelName;
      opt.textContent = modelName;
      selectEl.appendChild(opt);
    }
    selectEl.value = modelName || '';
  }
  updateModelBadge(modelName);
  refreshComposerModel();
}


function setCustomModelFieldOpen(open) {
  const wasOpen = customModelFieldOpen;
  customModelFieldOpen = open;
  const customInput = document.getElementById('modelCustomInput');
  if (!customInput) return;
  customInput.style.display = open ? 'block' : 'none';
  if (open) {

    if (!wasOpen) customInput.value = '';
    customInput.focus();
  }
}


async function pickComboboxModel(value) {
  closeComboboxMenu();
  if (value === CUSTOM_MODEL_OPTION) {
    setCustomModelFieldOpen(true);
    return;
  }
  setCustomModelFieldOpen(false);
  updateSelectedModel(value);
  await autoSaveCurrentForm();
}


async function commitTypedModel() {
  const value = (document.getElementById('modelCustomInput')?.value || '').trim();
  if (!value) return;
  updateSelectedModel(value);
  await autoSaveCurrentForm();
}


function renderModelOptions(modelsList) {
  const selectEl = document.getElementById('modelSelect');
  const optionsContainer = document.getElementById('modelComboboxOptions');
  if (!optionsContainer) return;

  const activeProvider = document.getElementById('providerSelect')?.value || currentSettings.provider;
  const savedModel = currentSettings.providerConfigs?.[activeProvider]?.model || currentSettings.model;
  const currentSelected = (selectEl && selectEl.value) ? selectEl.value : savedModel;

  const combinedList = [...modelsList];
  if (savedModel && savedModel !== CUSTOM_MODEL_OPTION && !combinedList.includes(savedModel)) {
    combinedList.unshift(savedModel);
  }

  if (currentSelected && currentSelected !== CUSTOM_MODEL_OPTION && !combinedList.includes(currentSelected)) {
    combinedList.unshift(currentSelected);
  }

  if (selectEl) {
    selectEl.innerHTML = '';
    combinedList.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      selectEl.appendChild(opt);
    });
    const customOpt = document.createElement('option');
    customOpt.value = CUSTOM_MODEL_OPTION;
    customOpt.textContent = 'Custom model name…';
    selectEl.appendChild(customOpt);
  }

  if (combinedList.length === 0) {


    const emptySource = Array.isArray(modelsList) && modelsList.length === 0 && providerMeta(activeProvider, currentSettings).isCustom;
    optionsContainer.innerHTML = `<div class="subtext-hint" style="padding: 10px; text-align: center;">${emptySource ? CUSTOM_EMPTY_MODELS_TEXT : 'No matching models found.'}</div>`;
    return;
  }

  const activeModel = currentSelected || savedModel || combinedList[0];

  let html = combinedList.map(modelName => {
    const isSelected = modelName === activeModel;
    return `<div class="combobox-option-item ${isSelected ? 'selected' : ''}" data-value="${escapeHtml(modelName)}">${escapeHtml(modelName)}</div>`;
  }).join('');

  html += `<div class="combobox-option-item custom-option ${customModelFieldOpen ? 'selected' : ''}" data-value="${CUSTOM_MODEL_OPTION}">✏️ Enter custom model name...</div>`;

  optionsContainer.innerHTML = html;

  optionsContainer.querySelectorAll('.combobox-option-item').forEach(item => {
    item.addEventListener('click', () => pickComboboxModel(item.getAttribute('data-value')));
  });

  updateSelectedModel(activeModel);
}

function initCombobox() {
  const trigger = document.getElementById('modelComboboxTrigger');
  const menu = document.getElementById('modelComboboxMenu');
  const searchInput = document.getElementById('modelSearchInside');

  if (trigger && menu) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = menu.style.display === 'flex';
      if (isVisible) {
        closeComboboxMenu();
      } else {
        openComboboxMenu();
      }
    });
  }

  if (searchInput) {
    searchInput.addEventListener('click', (e) => e.stopPropagation());
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      if (!query) {
        renderModelOptions(allFetchedModels);
      } else {
        const filtered = allFetchedModels.filter(m => m.toLowerCase().includes(query));
        renderModelOptions(filtered);
      }
    });
  }

  document.addEventListener('click', () => {
    closeComboboxMenu();
  });
}

function openComboboxMenu() {
  const menu = document.getElementById('modelComboboxMenu');
  const combobox = document.getElementById('modelCombobox');
  const searchInput = document.getElementById('modelSearchInside');

  if (menu && combobox) {
    const triggerRect = combobox.getBoundingClientRect();
    const spaceBelow = window.innerHeight - triggerRect.bottom;

    if (spaceBelow < 260 && triggerRect.top > 260) {
      menu.style.top = 'auto';
      menu.style.bottom = '100%';
      menu.style.borderTop = '1px solid var(--accent)';
      menu.style.borderBottom = 'none';
      menu.style.borderTopLeftRadius = '9px';
      menu.style.borderTopRightRadius = '9px';
      menu.style.borderBottomLeftRadius = '0';
      menu.style.borderBottomRightRadius = '0';
      menu.style.boxShadow = '0 -10px 25px rgba(0, 0, 0, 0.25)';
    } else {
      menu.style.top = '100%';
      menu.style.bottom = 'auto';
      menu.style.borderTop = 'none';
      menu.style.borderBottom = '1px solid var(--accent)';
      menu.style.borderTopLeftRadius = '0';
      menu.style.borderTopRightRadius = '0';
      menu.style.borderBottomLeftRadius = '9px';
      menu.style.borderBottomRightRadius = '9px';
      menu.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.25)';
    }

    menu.style.display = 'flex';
    combobox.classList.add('open');
    const trigger = document.getElementById('modelComboboxTrigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    if (!allFetchedModels || allFetchedModels.length === 0) {
      fetchDynamicModels(false);
    }
    if (searchInput) {
      searchInput.value = '';
      renderModelOptions(allFetchedModels);
      setTimeout(() => searchInput.focus(), 50);
    }
  }
}

function closeComboboxMenu() {
  const menu = document.getElementById('modelComboboxMenu');
  const combobox = document.getElementById('modelCombobox');
  if (menu && combobox) {
    menu.style.display = 'none';
    combobox.classList.remove('open');
    const trigger = document.getElementById('modelComboboxTrigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
}


async function autoSaveCurrentForm() {
  const provider = document.getElementById('providerSelect').value;


  const finalModel = (selectedModel && selectedModel !== CUSTOM_MODEL_OPTION) ? selectedModel : '';

  const apiKey = document.getElementById('apiKeyInput').value.trim();
  const baseUrl = document.getElementById('baseUrlInput').value.trim();

  const previousModel = (currentSettings.providerConfigs && currentSettings.providerConfigs[provider]
    && currentSettings.providerConfigs[provider].model) || '';


  const llmTimeoutMs = Math.max(5000, parseInt(document.getElementById('llmTimeoutInput').value, 10) || (DEFAULT_PROVIDER_CONFIGS[provider]?.llmTimeoutMs || DEFAULT_SETTINGS.llmTimeoutMs));

  const newSettings = {
    provider,
    baseUrl,
    apiKey,


    model: finalModel || previousModel,
    maxSteps: parseInt(document.getElementById('maxStepsInput').value, 10) || DEFAULT_SETTINGS.maxSteps,
    actionDelayMs: parseInt(document.getElementById('delayInput').value, 10) || DEFAULT_SETTINGS.actionDelayMs,
    ollamaNumPredict: parseInt(document.getElementById('ollamaNumPredictInput').value, 10) || DEFAULT_SETTINGS.ollamaNumPredict,
    llmTimeoutMs,

    screenshots: true,
    effortDefault: document.getElementById('effortDefaultSelect')?.value || currentSettings.effortDefault || 'medium',
    effortAdaptive: (document.getElementById('effortAdaptiveSelect')?.value || 'on') !== 'off',
    research: researchFromForm()
  };


  if (provider !== 'nvidia' && providerOwnTimeoutOf(currentSettings, provider) > 0) {
    delete newSettings.llmTimeoutMs;
    newSettings.providerConfigs = {
      [provider]: { ...(currentSettings.providerConfigs?.[provider] || {}), llmTimeoutMs }
    };

    const descriptor = currentSettings.customProviders?.[provider];
    if (descriptor) {
      newSettings.customProviders = { ...currentSettings.customProviders, [provider]: { ...descriptor, llmTimeoutMs } };
    }
  }

  currentSettings = await Storage.saveSettings(newSettings);


  document.getElementById('llmTimeoutInput').value = timeoutShownFor(currentSettings, provider);
  updateModelBadge(newSettings.model);
}


async function fetchDynamicModels(forceRefresh = false) {
  const statusEl = document.getElementById('modelFetchStatus');
  const btnFetch = document.getElementById('btnFetchModels');

  if (statusEl) {
    statusEl.textContent = forceRefresh ? 'Fetching fresh models from API...' : 'Loading cached models...';
  }
  if (btnFetch) btnFetch.disabled = true;

  const tempSettings = {
    provider: document.getElementById('providerSelect').value,
    baseUrl: document.getElementById('baseUrlInput').value.trim(),
    apiKey: document.getElementById('apiKeyInput').value.trim(),
    forceRefresh,


    providerConfigs: currentSettings.providerConfigs,
    customProviders: currentSettings.customProviders
  };
  const activeMeta = providerMeta(tempSettings.provider, currentSettings);

  return new Promise((resolve) => {
    sendBgMessage({ action: 'FETCH_MODELS', payload: tempSettings }, (res) => {
      if (btnFetch) btnFetch.disabled = false;

      if (res && res.success && Array.isArray(res.models)) {
        allFetchedModels = res.models;
        allFetchedModelsProvider = tempSettings.provider;
        renderModelOptions(allFetchedModels);

        if (statusEl) {
          if (res.models.length > 0) {
            statusEl.textContent = forceRefresh
              ? `Retrieved ${res.models.length} model(s) fresh from API!`
              : `Loaded ${res.models.length} model(s) from local cache (${allFetchedModels.length} total).`;
          } else if (activeMeta.isCustom) {
            statusEl.textContent = CUSTOM_EMPTY_MODELS_TEXT;
          } else {
            statusEl.textContent = 'No models available.';
          }
        }
        resolve(res.models);
      } else {
        if (statusEl) statusEl.textContent = `Could not fetch models (${res?.error || 'Unreachable'}). Using fallbacks.`;
        allFetchedModels = (res && res.models && res.models.length > 0)
          ? res.models
          : (activeMeta.isCustom
            ? activeMeta.savedModels
            : (DEFAULT_PROVIDER_CONFIGS[tempSettings.provider]?.model ? [DEFAULT_PROVIDER_CONFIGS[tempSettings.provider].model] : []));
        allFetchedModelsProvider = tempSettings.provider;
        renderModelOptions(allFetchedModels);
        resolve(allFetchedModels);
      }
    });
  });
}


let lastModelAskKey = null;

function updateModelBadge(modelName) {


  const provider = document.getElementById('providerSelect')?.value || currentSettings.provider;
  const askKey = `${provider}|${modelName || ''}`;
  if (askKey !== lastModelAskKey) {
    lastModelAskKey = askKey;
    refreshEffortSupport();
    refreshContextWindowField();
  }
  renderContextMeter();
  const badge = document.getElementById('currentModelBadge');
  if (badge) {
    badge.textContent = modelName || 'Model';

    badge.title = modelName || '';
  }
}

function initTabs() {
  const navBtns = document.querySelectorAll('.nav-btn');
  const panels = document.querySelectorAll('.tab-panel');

  if (navBtns.length === 0 || panels.length === 0) {
    console.warn('[Sidepanel] initTabs: Navigation buttons or tab panels not found in DOM.');
    return;
  }

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      if (!targetTab) return;

      navBtns.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPanel = document.getElementById(`tab-${targetTab}`);
      if (targetPanel) {
        targetPanel.classList.add('active');
      } else {
        console.error(`[Sidepanel] Tab panel #${targetTab} not found.`);
      }
    });
  });
}

function setDeveloperModeUI(enabled) {
  const toggle = document.getElementById('btnDeveloperMode');
  const query = typeof document.querySelector === 'function' ? document.querySelector.bind(document) : null;
  const logsTab = query ? query('.nav-btn[data-tab="logs"]') : null;
  if (toggle) toggle.setAttribute('aria-checked', String(enabled));
  if (!enabled && logsTab?.classList.contains('active')) {
    query?.('.nav-btn[data-tab="chat"]')?.click?.();
  }
  if (logsTab) logsTab.hidden = !enabled;
  if (!enabled) {
    rawLogsCache = [];
    const logOutput = document.getElementById('logOutput');
    if (logOutput) logOutput.textContent = 'Developer mode is off. Logs are not saved.';
  } else {
    renderFilteredLogs();
  }
}


function initPortConnection() {
  connectPort();
}


async function resolveMyTabId() {
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      const tabs = await new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => resolve(t || [])));
      const id = tabs && tabs[0] ? tabs[0].id : null;
      if (id !== null && id !== undefined) {
        myTabId = id;
        return id;
      }
    }
  } catch (err) {
    reportClientError('sidepanel:resolve-tab', err);
  }
  return null;
}

function connectPort() {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;


  const doConnect = () => {
    try {


      const base = hasConnectedBefore ? 'tarka_sidepanel' : 'tarka_sidepanel_fresh';
      hasConnectedBefore = true;
      const portName = myTabId !== null ? `${base}:${myTabId}` : base;
      backgroundPort = chrome.runtime.connect({ name: portName });
    } catch (err) {
      reportClientError('sidepanel:port-connect', err);
      setConnectionBanner(true);
      scheduleReconnect();
      return;
    }

  backgroundPort.onMessage.addListener((msg) => {
    try {
      if (msg.type === 'STATE_UPDATE') {
        receiveState(msg.payload);
      } else if (msg.type === 'LOG_ENTRY') {
        addLogEntry(msg.payload);
      } else if (msg.type === 'PANEL_HANDOFF') {
        followRunToTab(msg.payload);
      }
    } catch (err) {
      reportClientError('sidepanel:port-message', err);
    }
  });

  backgroundPort.onDisconnect.addListener(() => {
    // chrome.runtime.lastError must be read here or Chrome logs an unchecked-error warning.
    const reason = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'service worker terminated';
    backgroundPort = null;
    appendLocalLog('WARN', 'Sidepanel', `[PORT_LOST] Connection to the background worker dropped (${reason}). Reconnecting…`);
    setConnectionBanner(true);
    scheduleReconnect();
  });

  if (portReconnectTimer) {
    clearTimeout(portReconnectTimer);
    portReconnectTimer = null;
  }
  setConnectionBanner(false);
  resyncAgentState();
  };

  if (myTabId === null) {
    void resolveMyTabId().then(() => doConnect());
  } else {
    doConnect();
  }
}

// Chrome requires a user gesture for sidePanel.open().
function followRunToTab(payload) {
  if (!payload || typeof payload.tabId !== 'number' || payload.fromTabId !== myTabId) return;
  if (!chrome.sidePanel || !chrome.sidePanel.open) return;
  chrome.sidePanel.open({ tabId: payload.tabId }).catch((err) => {
    appendLocalLog('WARN', 'Sidepanel', `[PANEL_HANDOFF_FAILED] The task moved to tab [${payload.tabId}], but the panel could not follow it there (${err.message}). Click the Tarka icon on that tab to see the run.`);
  });
}

function scheduleReconnect() {
  if (portReconnectTimer) return;
  portReconnectAttempts++;
  const delayMs = Math.min(5000, 300 * portReconnectAttempts);
  portReconnectTimer = setTimeout(() => {
    portReconnectTimer = null;
    connectPort();
  }, delayMs);
}


function resyncAgentState() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

  sendBgMessage({ action: 'GET_AGENT_STATE' }, (res) => {
    if (chrome.runtime.lastError) {
      appendLocalLog('WARN', 'Sidepanel', `[RESYNC_FAILED] Background worker did not answer GET_AGENT_STATE (${chrome.runtime.lastError.message}). Will retry.`);
      setConnectionBanner(true);
      scheduleReconnect();
      return;
    }

    portReconnectAttempts = 0;
    setConnectionBanner(false);
    checkWorkerBuild();

    if (res) {
      receiveState(res);
      if (res.logs) {
        rawLogsCache = res.logs;
        renderFilteredLogs();
      }
    }
  });
}


function sendControlMessage(action, done) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

  sendBgMessage({ action }, (res) => {
    if (chrome.runtime.lastError) {
      const msg = chrome.runtime.lastError.message;
      appendLocalLog('ERROR', 'Sidepanel', `[CONTROL_FAILED] ${action} did not reach the background worker (${msg}).`);
      showTaskError(`"${action.replace(/_/g, ' ').toLowerCase()}" did not reach the agent: ${msg}`);
      scheduleReconnect();
      if (done) done(false);
      return;
    }
    if (res && res.success === false) {
      appendLocalLog('ERROR', 'Sidepanel', `[CONTROL_REJECTED] ${action} was rejected: ${res.error || 'no reason given'}`);
      showTaskError(res.error || `${action} was rejected by the agent.`);
      if (done) done(false);
      return;
    }
    appendLocalLog('INFO', 'Sidepanel', `[CONTROL_OK] ${action} acknowledged.`);
    if (done) done(true);
  });
}


let staleWorkerLogged = false;
function checkWorkerBuild() {
  if (!IS_BUILD) return;
  sendBgMessage({ action: 'GET_BUILD' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    const workerBuild = res.success ? res.build : null;
    const stale = workerBuild !== BUILD_STAMP;
    const bar = document.getElementById('updateBanner');
    if (bar) {
      bar.hidden = !stale;
      bar.dataset.workerBuild = stale ? 'stale' : 'same';
    }
    const reload = document.getElementById('btnReloadExtension');
    if (reload) reload.onclick = () => chrome.runtime.reload();
    if (stale && !staleWorkerLogged) {
      staleWorkerLogged = true;
      appendLocalLog('WARN', 'Sidepanel', `[STALE_WORKER] The panel is build ${BUILD_STAMP}, the background worker is ${workerBuild ? `build ${workerBuild}` : 'an older build'}. Reload Tarka to run the new version.`);
    }
  });
}

function setConnectionBanner(isDisconnected) {
  const pill = document.getElementById('statusPill');
  const textEl = document.getElementById('statusText');
  if (!pill) return;
  pill.classList.toggle('reconnecting', isDisconnected);
  if (isDisconnected && textEl) textEl.textContent = 'Reconnecting…';
}


function appendLocalLog(level, module, message) {
  if (currentSettings.developerMode !== true) return;
  try {
    addLogEntry({
      id: `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString(),
      level,
      kind: 'system',
      module,
      message,
      data: null
    });
  } catch (_) {  }
  console.warn(`[${module}]`, message);
}


function reportClientError(source, err) {
  const message = (err && err.message) || String(err);
  appendLocalLog('ERROR', 'Sidepanel', `[${source}] ${message}`);
  try {
    sendBgMessage({
      action: 'CLIENT_ERROR',
      payload: { source, message, stack: (err && err.stack) || null }
    }, () => { void chrome.runtime.lastError; });
  } catch (_) {
    // Extension context invalidated - the local log above is the only record, by design.
  }
}

window.addEventListener('error', (event) => reportClientError('window.onerror', event.error || event.message));
window.addEventListener('unhandledrejection', (event) => reportClientError('unhandledrejection', event.reason));

function initEventListeners() {
  document.getElementById('btnDeveloperMode')?.addEventListener('click', async () => {
    const enabled = !currentSettings.developerMode;
    currentSettings = await Storage.saveSettings({ developerMode: enabled });
    setDeveloperModeUI(enabled);
  });

  document.getElementById('btnThemeToggle').addEventListener('click', async () => {
    const current = currentSettings.theme || 'system';
    const next = THEME_MODES[(THEME_MODES.indexOf(current) + 1) % THEME_MODES.length];
    currentSettings.theme = next;
    applyTheme(next);
    await Storage.saveSettings({ theme: next });
  });

  const historyToggle = document.getElementById('btnToggleHistory');
  const historyDrawer = document.getElementById('historyDrawer');
  const historyClose = document.getElementById('btnCloseHistory');

  if (historyToggle && historyDrawer) {
    historyToggle.addEventListener('click', async () => {
      const willOpen = historyDrawer.style.display === 'none';
      historyDrawer.style.display = willOpen ? 'flex' : 'none';
      historyToggle.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) await loadSessionHistory();
    });
  }

  if (historyClose && historyDrawer) {
    historyClose.addEventListener('click', () => {
      historyDrawer.style.display = 'none';
      if (historyToggle) historyToggle.setAttribute('aria-expanded', 'false');
    });
  }

  document.getElementById('btnStartTask').addEventListener('click', startTask);
  document.getElementById('taskInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      startTask();
    }
  });

  document.getElementById('btnPause').addEventListener('click', () => {
    const btn = document.getElementById('btnPause');
    const isPaused = btn.textContent.trim().includes('Resume');
    sendControlMessage(isPaused ? 'RESUME_TASK' : 'PAUSE_TASK');
  });

  document.getElementById('btnStop').addEventListener('click', () => {
    sendControlMessage('STOP_TASK');
  });


  const btnToggleKey = document.getElementById('btnToggleKey');
  if (btnToggleKey) {
    btnToggleKey.addEventListener('click', () => {
      const input = document.getElementById('apiKeyInput');
      if (input) {
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btnToggleKey.title = isPassword ? 'Hide API Key' : 'Show API Key';
      }
    });
  }


  const approvalBtn = document.getElementById('btnApprovalMode');
  const approvalMenu = document.getElementById('approvalMenu');
  const effortBtn = document.getElementById('btnEffort');
  const effortMenu = document.getElementById('effortMenu');
  const modelBtn = document.getElementById('composerModel');
  const modelMenu = document.getElementById('modelMenu');
  const contextBtn = document.getElementById('btnContext');
  const contextMenu = document.getElementById('contextMenu');

  const setMenuOpen = (menu, btn, open) => {
    if (!menu || !btn) return;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  const closeComposerMenus = () => {
    setMenuOpen(approvalMenu, approvalBtn, false);
    setMenuOpen(effortMenu, effortBtn, false);
    setMenuOpen(modelMenu, modelBtn, false);
    setMenuOpen(contextMenu, contextBtn, false);
  };


  if (contextBtn && contextMenu) {
    contextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = contextMenu.hidden;
      closeComposerMenus();
      setMenuOpen(contextMenu, contextBtn, willOpen);
      if (willOpen) renderContextMeter();
    });
    contextMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target && e.target.closest ? e.target.closest('[data-ctx]') : null;
      if (!target || target.disabled) return;
      const what = target.getAttribute('data-ctx');
      if (what === 'compact') {
        compactChatFromPanel();


        closeComposerMenus();
      } else if (what === 'settings') {
        closeComposerMenus();
        const nav = document.querySelector ? document.querySelector('.nav-btn[data-tab="settings"]') : null;
        if (nav) nav.click();
        const field = document.getElementById('contextWindowInput');
        if (field) setTimeout(() => field.focus(), 50);
      }
    });
  }

  if (approvalBtn && approvalMenu) {
    approvalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = approvalMenu.hidden;
      closeComposerMenus();
      setMenuOpen(approvalMenu, approvalBtn, willOpen);
    });
    approvalMenu.querySelectorAll('.menu-item').forEach((item) => {
      item.addEventListener('click', async () => {
        applyApprovalMode(item.getAttribute('data-approval') || 'auto');
        closeComposerMenus();
        await Storage.saveSettings({ autoApprove: approvalMode === 'auto' });
      });
    });
  }

  if (effortBtn && effortMenu) {
    effortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = effortMenu.hidden;
      closeComposerMenus();
      setMenuOpen(effortMenu, effortBtn, willOpen);
    });
    effortMenu.querySelectorAll('.menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        setEffort(item.getAttribute('data-effort') || 'auto');
        closeComposerMenus();
      });
    });
  }


  if (modelBtn && modelMenu) {
    const modelSearch = document.getElementById('modelMenuSearch');
    const modelCustom = document.getElementById('modelMenuCustom');
    const listEl = document.getElementById('modelMenuList');


    const modelsForMenu = () => {
      const provider = document.getElementById('providerSelect')?.value || currentSettings.provider;
      const list = allFetchedModels.slice();
      const saved = currentSettings.providerConfigs?.[provider]?.model || currentSettings.model || '';
      for (const id of [saved, selectedModel]) {
        if (id && id !== CUSTOM_MODEL_OPTION && !list.includes(id)) list.unshift(id);
      }
      return list;
    };

    const renderComposerModels = (list) => {
      if (!listEl) return;
      const provider = document.getElementById('providerSelect')?.value || currentSettings.provider;
      const active = selectedModel || currentSettings.providerConfigs?.[provider]?.model || currentSettings.model || '';
      if (!list || list.length === 0) {
        listEl.innerHTML = '<div class="menu-empty">No models found for this provider.</div>';
        return;
      }
      listEl.innerHTML = list.map((name) => {
        const checked = name === active;
        return `<button type="button" class="menu-item" role="menuitemradio" aria-checked="${checked}" data-model="${escapeHtml(name)}"><span class="menu-label">${escapeHtml(name)}</span><span class="menu-check" aria-hidden="true">${checked ? MENU_CHECK : ''}</span></button>`;
      }).join('');
      listEl.querySelectorAll('.menu-item').forEach((item) => {
        item.addEventListener('click', async () => {
          updateSelectedModel(item.getAttribute('data-model'));
          closeComposerMenus();
          await autoSaveCurrentForm();
        });
      });
    };

    const applyCustomModel = async () => {
      const value = (modelCustom?.value || '').trim();
      if (!value) return;
      setCustomModelFieldOpen(false);
      updateSelectedModel(value);
      closeComposerMenus();
      if (modelCustom) modelCustom.value = '';
      await autoSaveCurrentForm();
    };

    modelBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const willOpen = modelMenu.hidden;
      closeComposerMenus();
      if (!willOpen) return;
      setMenuOpen(modelMenu, modelBtn, true);
      if (modelSearch) modelSearch.value = '';


      if (allFetchedModelsProvider !== (document.getElementById('providerSelect')?.value || currentSettings.provider)) {
        if (listEl) listEl.innerHTML = '<div class="menu-empty">Loading models...</div>';
        await fetchDynamicModels(false);
        if (!modelMenu.hidden) renderComposerModels(modelsForMenu());
      } else {
        renderComposerModels(modelsForMenu());
      }
    });

    if (modelSearch) {
      modelSearch.addEventListener('click', (e) => e.stopPropagation());
      modelSearch.addEventListener('input', () => {
        const query = modelSearch.value.toLowerCase().trim();
        const source = modelsForMenu();
        renderComposerModels(query ? source.filter((m) => m.toLowerCase().includes(query)) : source);
      });
    }

    if (modelCustom) {
      modelCustom.addEventListener('click', (e) => e.stopPropagation());
      modelCustom.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.stopPropagation();
          applyCustomModel();
        }
      });
    }
    document.getElementById('modelMenuCustomApply')?.addEventListener('click', applyCustomModel);
  }

  document.addEventListener('click', closeComposerMenus);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeComposerMenus();
  });


  const newChatBtn = document.getElementById('btnNewChat');
  if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
      sendBgMessage({ action: 'CLEAR_HISTORY' }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : res.error;
          appendLocalLog('ERROR', 'Sidepanel', `[NEW_CHAT_FAILED] ${errMsg}`);
          showTaskError(errMsg || 'Could not start a new chat.');
          return;
        }
        currentSessionId = null;


        resetChatView();
        const input = document.getElementById('taskInput');
        if (input) {
          input.value = '';
          input.focus();
        }
        const timeline = document.getElementById('timeline');
        if (timeline) renderEmptyState(timeline);
      });
    });
  }


  const modelCustomInput = document.getElementById('modelCustomInput');
  if (modelCustomInput) {
    let modelCustomDebounce = null;
    const commitNow = () => {
      if (modelCustomDebounce) clearTimeout(modelCustomDebounce);
      modelCustomDebounce = null;
      return commitTypedModel();
    };
    modelCustomInput.addEventListener('input', () => {
      if (modelCustomDebounce) clearTimeout(modelCustomDebounce);
      modelCustomDebounce = setTimeout(commitNow, 400);
    });
    modelCustomInput.addEventListener('change', commitNow);
    modelCustomInput.addEventListener('blur', commitNow);
  }


  const contextWindowInput = document.getElementById('contextWindowInput');
  if (contextWindowInput) {
    contextWindowInput.addEventListener('change', () => { saveContextWindowField(); });
    contextWindowInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveContextWindowField();
      }
    });
  }


  ['maxStepsInput', 'delayInput', 'ollamaNumPredictInput', 'llmTimeoutInput', 'effortDefaultSelect', 'effortAdaptiveSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', autoSaveCurrentForm);
    }
  });

  ['researchEnabledSelect', 'researchBackendSelect', 'searxngUrlInput'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => { syncResearchFields(); autoSaveCurrentForm(); });
    if (id === 'searxngUrlInput') el.addEventListener('input', syncResearchFields);
  });

  const effortDefaultSelect = document.getElementById('effortDefaultSelect');
  if (effortDefaultSelect) {
    effortDefaultSelect.addEventListener('change', () => setEffort(effortDefaultSelect.value || 'medium'));
  }

  document.querySelectorAll('.log-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.log-filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentActiveLogFilter = chip.getAttribute('data-filter');
      renderFilteredLogs();
    });
  });

  document.getElementById('btnDownloadLogs').addEventListener('click', () => {
    const text = rawLogsCache.map(log => `[${log.timestamp}] [${log.level}] [${log.module}] ${log.message}${log.data ? `\nPayload: ${log.data}` : ''}`).join('\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tarka-logs-${new Date().toISOString().slice(0,10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btnCopyLogs').addEventListener('click', () => {

    const entries = rawLogsCache.map(log => {
      const time = log.timestamp || '';
      const level = log.level || 'INFO';
      const mod = log.module || 'System';
      const msg = log.message || '';
      const payload = log.data ? `\n  ${String(log.data)}` : '';
      return `[${time}] [${level}] [${mod}] ${msg}${payload}`;
    }).join('\n');
    navigator.clipboard.writeText(entries).then(() => {
      const copyBtn = document.getElementById('btnCopyLogs');
      copyBtn.innerHTML = `${ICONS.check} Copied`;
      setTimeout(() => copyBtn.innerHTML = `${ICONS.copy} Copy`, 2000);
    });
  });

  document.getElementById('btnClearLogs').addEventListener('click', () => {
    rawLogsCache = [];
    document.getElementById('logOutput').textContent = '// Logs cleared.';
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove(['agent_logs_history'], () => {
        if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError;
      });
    }


    sendControlMessage('CLEAR_LOGS', (ok) => {
      if (!ok) {
        appendLocalLog('WARN', 'Sidepanel', '[CLEAR_LOGS_INCOMPLETE] The background worker did not confirm the clear - it may still hold these logs in memory and rewrite them on its next log event.');
      }
    });
  });

  document.getElementById('btnFetchModels').addEventListener('click', () => {
    fetchDynamicModels(true);
  });


  let apiKeyInputDebounce = null;
  let isPastingKey = false;
  const onApiKeyInput = () => {
    if (isPastingKey) return;
    if (apiKeyInputDebounce) clearTimeout(apiKeyInputDebounce);
    apiKeyInputDebounce = setTimeout(async () => {
      await autoSaveCurrentForm();
      const key = document.getElementById('apiKeyInput').value.trim();
      if (key.length >= 8) {
        fetchDynamicModels(true);
      }
    }, 400);
  };

  const onApiKeyChange = async () => {
    if (apiKeyInputDebounce) clearTimeout(apiKeyInputDebounce);
    await autoSaveCurrentForm();
    const key = document.getElementById('apiKeyInput').value.trim();
    if (key.length >= 8) {
      fetchDynamicModels(true);
    }
  };

  const onApiKeyBlur = () => {
    if (apiKeyInputDebounce) clearTimeout(apiKeyInputDebounce);
    autoSaveCurrentForm();
  };

  document.getElementById('apiKeyInput').addEventListener('input', onApiKeyInput);
  document.getElementById('apiKeyInput').addEventListener('change', onApiKeyChange);
  document.getElementById('apiKeyInput').addEventListener('blur', onApiKeyBlur);

  let baseUrlDebounce = null;
  const debouncedAutoSaveBaseUrl = () => {
    if (baseUrlDebounce) clearTimeout(baseUrlDebounce);
    baseUrlDebounce = setTimeout(() => {
      autoSaveCurrentForm();
    }, 400);
  };
  const immediateAutoSaveBaseUrl = () => {
    if (baseUrlDebounce) clearTimeout(baseUrlDebounce);
    autoSaveCurrentForm();
  };
  document.getElementById('baseUrlInput').addEventListener('input', debouncedAutoSaveBaseUrl);
  document.getElementById('baseUrlInput').addEventListener('change', immediateAutoSaveBaseUrl);
  document.getElementById('baseUrlInput').addEventListener('blur', immediateAutoSaveBaseUrl);
  document.getElementById('llmTimeoutInput')?.addEventListener('change', autoSaveCurrentForm);
  document.getElementById('llmTimeoutInput')?.addEventListener('blur', autoSaveCurrentForm);
  document.getElementById('apiKeyInput').addEventListener('paste', () => {
    isPastingKey = true;
    if (apiKeyInputDebounce) clearTimeout(apiKeyInputDebounce);
    apiKeyInputDebounce = setTimeout(async () => {
      isPastingKey = false;
      await autoSaveCurrentForm();
      const key = document.getElementById('apiKeyInput').value.trim();
      if (key.length >= 8) {
        fetchDynamicModels(true);
      }
    }, 200);
  });


  document.getElementById('providerSelect').addEventListener('change', async () => {
    const provider = document.getElementById('providerSelect').value;
    if (provider === CUSTOM_TRIGGER_VALUE) {

      document.getElementById('providerSelect').value = currentSettings.provider || 'openrouter';
      if (customProviderDialog) customProviderDialog.open('add');
      return;
    }
    await applyProviderSelection(provider);
  });

  document.getElementById('btnEditCustomProvider')?.addEventListener('click', () => {
    if (customProviderDialog && isCustomProviderId(currentSettings.provider, currentSettings)) {
      customProviderDialog.open('edit', currentSettings.provider);
    }
  });

  document.getElementById('btnDeleteCustomProvider')?.addEventListener('click', async () => {
    const id = currentSettings.provider;
    if (!isCustomProviderId(id, currentSettings)) return;
    const descriptor = currentSettings.customProviders[id];
    const sessions = await Storage.getSessions();
    const usedBy = sessions.filter((s) => s && s.provider === id).length;
    const suffix = usedBy > 0 ? ` ${usedBy} saved session(s) used it; their history stays.` : '';
    if (!window.confirm(`Delete ${descriptor.displayName || id}? Its key and model list are removed.${suffix}`)) return;
    const settingsAfter = await Storage.deleteCustomProvider(id);
    if (settingsAfter) currentSettings = settingsAfter;
    await loadSettings();


    await fetchDynamicModels(false);
    const fellBack = currentSettings.provider !== id && descriptor.id === id;
    const healedName = providerMeta(currentSettings.provider, currentSettings).displayName;
    showToast(`Provider ${descriptor.displayName || id} deleted.${fellBack ? ` The panel fell back to ${healedName}.` : ''}`);
  });

  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    await autoSaveCurrentForm();
    showToast(`Settings saved! Provider [${currentSettings.provider}] configured.`);
  });

  document.querySelectorAll('.sample-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      document.getElementById('taskInput').value = prompt;
      startTask();
    });
  });
}


async function applyProviderSelection(provider) {
  const activeIsCustom = isCustomProviderId(provider, currentSettings);
  const providerConfigs = currentSettings.providerConfigs || DEFAULT_PROVIDER_CONFIGS;
  const savedCfg = activeIsCustom ? (providerConfigs[provider] || {}) : (providerConfigs[provider] || DEFAULT_PROVIDER_CONFIGS[provider] || {});

  const ollamaGroup = document.getElementById('ollamaNumPredictGroup');
  if (ollamaGroup) {
    ollamaGroup.style.display = provider === 'ollama' ? 'flex' : 'none';
  }


  buildProviderOptions(document.getElementById('providerSelect'), currentSettings.customProviders);
  document.getElementById('providerSelect').value = provider;
  syncCustomProviderActions(provider);

  const baseUrlToSet = savedCfg.baseUrl || (activeIsCustom ? '' : (DEFAULT_PROVIDER_CONFIGS[provider] ? DEFAULT_PROVIDER_CONFIGS[provider].baseUrl : ''));
  document.getElementById('baseUrlInput').placeholder = activeIsCustom
    ? (savedCfg.baseUrl || '')
    : (DEFAULT_PROVIDER_CONFIGS[provider]?.baseUrl || 'https://openrouter.ai/api/v1');
  document.getElementById('baseUrlInput').value = baseUrlToSet;
  document.getElementById('apiKeyInput').value = savedCfg.apiKey || '';

  const modelToSet = savedCfg.model || (activeIsCustom ? '' : (DEFAULT_PROVIDER_CONFIGS[provider] ? DEFAULT_PROVIDER_CONFIGS[provider].model : currentSettings.model));
  setCustomModelFieldOpen(false);
  updateSelectedModel(modelToSet);

  const timeoutToSet = timeoutShownFor({ ...currentSettings, providerConfigs }, provider);
  document.getElementById('llmTimeoutInput').value = timeoutToSet;


  currentSettings.provider = provider;
  currentSettings.baseUrl = baseUrlToSet;
  currentSettings.apiKey = savedCfg.apiKey || '';
  currentSettings.model = modelToSet;


  if (provider !== 'nvidia' && providerOwnTimeoutOf({ ...currentSettings, providerConfigs }, provider) === 0) {
    currentSettings.llmTimeoutMs = timeoutToSet;
  }

  await autoSaveCurrentForm();

  const shouldRefresh = provider === 'ollama' || provider === 'nvidia' || activeIsCustom || (savedCfg.apiKey && savedCfg.apiKey.length > 5);
  await fetchDynamicModels(shouldRefresh);
}

async function startTask() {
  const btn = document.getElementById('btnStartTask');
  const prompt = document.getElementById('taskInput').value.trim();
  if (!prompt) return;


  const activeProviderId = currentSettings.provider || 'openrouter';
  const activeMeta = providerMeta(activeProviderId, currentSettings);
  if (activeMeta.isCustom && !(currentSettings.providerConfigs?.[activeProviderId]?.model || currentSettings.model)) {
    showToast(`Pick a model for ${activeMeta.displayName} in Settings first: a custom endpoint has no default to fall back on.`);
    return;
  }


  if (isSubmittingTask) return;
  isSubmittingTask = true;
  if (btn) btn.disabled = true;

  try {
    await startTaskInner(prompt);
  } finally {
    isSubmittingTask = false;


    if (btn && !isTaskActive) btn.disabled = false;
  }
}


function currentRunModel() {
  const provider = currentSettings.provider || 'openrouter';
  return {
    provider,
    model: currentSettings.providerConfigs?.[provider]?.model || currentSettings.model || ''
  };
}

async function startTaskInner(prompt) {

  await autoSaveCurrentForm();

  clearTaskError();
  runModelSnapshot = currentRunModel();

  setFollowTimeline(true);

  appendLocalLog('INFO', 'Sidepanel', `[TASK_SUBMIT] Sending task to background worker: "${prompt}"`);

  sendBgMessage({ action: 'START_TASK', payload: { prompt, effort: currentEffort, autoApprove: approvalMode !== 'manual' } }, (res) => {


    if (chrome.runtime.lastError) {
      const msg = chrome.runtime.lastError.message;
      appendLocalLog('ERROR', 'Sidepanel', `[TASK_SUBMIT_FAILED] Background worker did not accept the task (${msg}). Reconnecting and retrying is usually enough.`);
      showTaskError(`Could not reach the background worker: ${msg}`);
      scheduleReconnect();
      return;
    }

    if (res && res.success) {
      document.getElementById('taskInput').value = '';
      const emptyState = document.getElementById('emptyState');
      if (emptyState) emptyState.style.display = 'none';
      document.getElementById('controlBar').style.display = 'flex';
      appendLocalLog('INFO', 'Sidepanel', `[TASK_ACCEPTED] Running against tab [${res.tabId}] \u2014 ${res.tabUrl || 'unknown URL'}`);
    } else {
      const msg = (res && res.error) || 'The background worker returned no response.';
      appendLocalLog('ERROR', 'Sidepanel', `[TASK_SUBMIT_FAILED] ${msg}`);
      showTaskError(msg);
    }
  });
}


function showTaskError(message) {
  taskError = String(message || '');
  if (lastState) {
    renderTimelineFromState(lastState);
    return;
  }
  const timeline = document.getElementById('timeline');
  if (!timeline) return;
  timeline.insertAdjacentHTML('beforeend', taskErrorCardHtml(taskError));
  timeline.scrollTop = timeline.scrollHeight;
}


function clearTaskError() {
  if (!taskError) return;
  taskError = null;
  if (lastState) renderTimelineFromState(lastState);
}

async function loadSessionHistory() {
  const sessions = await Storage.getSessions();
  const historyBtn = document.getElementById('btnToggleHistory');


  if (historyBtn) {
    historyBtn.title = `Recent tasks (${sessions.length})`;
    historyBtn.setAttribute('aria-label', `Recent tasks (${sessions.length})`);
  }

  const listContainer = document.getElementById('historySessionsList');
  if (!listContainer) return;

  if (sessions.length === 0) {
    listContainer.innerHTML = `<div class="subtext-hint" style="padding: 10px; text-align: center;">No saved sessions yet.</div>`;
    return;
  }

  listContainer.innerHTML = sessions.map(session => {
    const isSelected = session.id === currentSessionId;
    return `
      <div class="history-session-item ${isSelected ? 'active' : ''}" data-id="${escapeHtml(session.id)}" tabindex="0" role="button">
        <div class="history-item-info">
          <span class="history-item-title">${escapeHtml(session.task || 'Untitled Session')}</span>
          <span class="history-item-meta">${escapeHtml(session.timestamp || '')} • ${escapeHtml(session.model || '')}</span>
        </div>
        <button class="btn-delete-session" data-delete-id="${escapeHtml(session.id)}">${ICONS.trash}</button>
      </div>
    `;
  }).join('');

  listContainer.querySelectorAll('.history-session-item').forEach(item => {
    const open = (e) => {
      if (e.target.closest('.btn-delete-session')) return;
      loadSelectedSession(item.getAttribute('data-id'));
    };
    item.addEventListener('click', open);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
    });
  });

  listContainer.querySelectorAll('.btn-delete-session').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const deleteId = btn.getAttribute('data-delete-id');
      await Storage.deleteSession(deleteId);
      await loadSessionHistory();
    });
  });
}


function receiveState(state) {
  if (!state) return;
  renderState(state);
}


function resetChatView() {
  lastRenderedStateVersion = -1;
  turnExpandOverride.clear();
  expandedRows.clear();
  seenFinishKey = null;


  openCompactSummaries.clear();
  openAuditDetails.clear();
  closedAuditDetails.clear();
  shownFiles.clear();
  unfoldedCode.clear();
  taskError = null;
  setFollowTimeline(true);
}


async function loadSelectedSession(sessionId) {
  const drawer = document.getElementById('historyDrawer');
  if (drawer) drawer.style.display = 'none';
  const toggle = document.getElementById('btnToggleHistory');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');

  const previous = currentSessionId;
  resetChatView();
  const res = await new Promise((resolve) => {
    sendBgMessage({ action: 'LOAD_CHAT', payload: { sessionId } }, (answer) => {
      resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : (answer || { success: false, error: 'The background worker gave no answer.' }));
    });
  });
  if (!res.success) {
    currentSessionId = previous;
    appendLocalLog('WARN', 'Sidepanel', `[LOAD_CHAT_REFUSED] ${res.error}`);
    showToast(res.error || 'The chat could not be opened.', 'error');
    return res;
  }
  currentSessionId = sessionId;
  await loadSessionHistory();
  return res;
}

function renderEmptyState() {
  const timeline = document.getElementById('timeline');
  lastTimelineHtml = '';
  showJumpToLatest(false);
  if (timeline) {
    timeline.innerHTML = `
      <div class="empty-state" id="emptyState">
        <div class="empty-glyph" aria-hidden="true">
          ${BRAND_MARK}
        </div>
        <h3>What would you like to automate?</h3>
        <p>Enter a task below. Tarka will read the page, index elements, and execute browser actions step-by-step.</p>
        <div class="sample-prompts">
          <span class="sample-chip" data-prompt="Search Google for open-source AI browser frameworks">${ICONS.search} Search Google for AI agents</span>
          <span class="sample-chip" data-prompt="Find top trending repositories on GitHub for python">${ICONS.star} Top Python GitHub repos</span>
          <span class="sample-chip" data-prompt="Summarize the main articles on news.ycombinator.com">${ICONS.doc} Summarize Hacker News</span>
        </div>
      </div>
    `;
    document.querySelectorAll('.sample-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const prompt = chip.getAttribute('data-prompt');
        document.getElementById('taskInput').value = prompt;
        startTask();
      });
    });
  }
}


function renderState(state) {
  if (!state) return;

  if (typeof state.stateVersion === 'number') {
    if (state.bootId && state.bootId !== lastBootId) {
      if (lastBootId !== null) {
        appendLocalLog('WARN', 'Sidepanel', '[WORKER_RESTARTED] The background worker was restarted by Chrome. Re-syncing the panel to the new instance.');
      }
      lastBootId = state.bootId;
      lastRenderedStateVersion = -1;
    }
    if (state.stateVersion <= lastRenderedStateVersion) return;
    lastRenderedStateVersion = state.stateVersion;
  }


  if (typeof state.chatId === 'string' && state.chatId) currentSessionId = state.chatId;
  lastState = state;

  const { status, stepCount, history, planSteps, currentPhase, pendingApproval, pendingConfirm } = state;
  const isDisconnected = backgroundPort === null;

  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');
  const controlBar = document.getElementById('controlBar');
  const btnPause = document.getElementById('btnPause');
  const processingBanner = document.getElementById('processingBanner');
  const processingPhaseText = document.getElementById('processingPhaseText');
  const progressBarFill = document.getElementById('progressBarFill');
  const taskInput = document.getElementById('taskInput');
  const btnStartTask = document.getElementById('btnStartTask');

  if (statusPill && statusText) {
    statusPill.className = `status-indicator ${status}${isDisconnected ? ' reconnecting' : ''}`;
    statusText.textContent = isDisconnected
      ? 'Reconnecting…'
      : status.charAt(0).toUpperCase() + status.slice(1);
  }

  if (status === 'running' || status === 'paused') {
    if (processingBanner) {
      processingBanner.style.display = 'flex';
      processingBanner.classList.toggle('paused', status === 'paused');
    }

    if (processingPhaseText) processingPhaseText.textContent = pendingApproval
      ? 'Waiting for your approval'
      : (pauseReasonText(state) || currentPhase || `Processing step ${stepCount}...`);


    const maxSteps = currentSettings.maxSteps || DEFAULT_SETTINGS.maxSteps;
    const currentSteps = stepCount || 1;
    const pct = Math.min(100, Math.round((currentSteps / Math.max(1, maxSteps)) * 100));
    if (progressBarFill) {
      progressBarFill.style.width = `${pct}%`;


      if (progressBarFill.parentElement) progressBarFill.parentElement.style.display = pendingApproval ? 'none' : '';
    }

    isTaskActive = true;


    if (controlBar) controlBar.style.display = pendingApproval ? 'none' : 'flex';
    if (taskInput) taskInput.disabled = true;
    if (btnStartTask) btnStartTask.disabled = true;
    const approvalBtn = document.getElementById('btnApprovalMode');
    const effortBtn = document.getElementById('btnEffort');
    const modelBtn = document.getElementById('composerModel');
    if (approvalBtn) approvalBtn.disabled = true;
    if (effortBtn) effortBtn.disabled = true;
    if (modelBtn) modelBtn.disabled = true;
    if (!runModelSnapshot) runModelSnapshot = currentRunModel();

    if (btnPause) {


      btnPause.style.display = pendingApproval ? 'none' : '';
      if (status === 'paused') {
        btnPause.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume`;
      } else {
        btnPause.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause`;
      }
    }
  } else {
    isTaskActive = false;
    if (processingBanner) processingBanner.style.display = 'none';
    if (controlBar) controlBar.style.display = 'none';
    if (taskInput) taskInput.disabled = false;
    if (btnStartTask) btnStartTask.disabled = false;
    const approvalBtn = document.getElementById('btnApprovalMode');
    const effortBtn = document.getElementById('btnEffort');
    const modelBtn = document.getElementById('composerModel');
    if (approvalBtn) approvalBtn.disabled = false;
    if (effortBtn) effortBtn.disabled = false;
    if (modelBtn) modelBtn.disabled = false;
    runModelSnapshot = null;
  }


  const newChatBtn = document.getElementById('btnNewChat');
  if (newChatBtn) {
    newChatBtn.disabled = isTaskActive;
    newChatBtn.title = isTaskActive ? 'Stop the task before starting a new chat' : 'New chat';
  }


  lastContextState = state.context || null;
  lastContextBusy = status === 'running' || status === 'paused';
  renderContextMeter();


  if (effortRunWasActive && status !== 'running' && status !== 'paused') refreshEffortSupport();
  effortRunWasActive = status === 'running' || status === 'paused';
  const processingEffortBadge = document.getElementById('processingEffortBadge');
  if (processingEffortBadge) {
    if (status === 'running' || status === 'paused') {


      const activeEffort = state.effort?.level || (currentEffort !== 'auto' ? currentEffort : null);
      if (activeEffort && activeEffort !== 'auto' && effortSupport.levels.length > 1 && !pendingApproval) {
        processingEffortBadge.textContent = `${EFFORT_LABEL[normalizeEffort(activeEffort)] || activeEffort}`;
        processingEffortBadge.title = 'How hard the model thinks before each step';
        processingEffortBadge.style.display = 'inline-block';
      } else {
        processingEffortBadge.style.display = 'none';
      }
    } else {
      processingEffortBadge.style.display = 'none';
    }
  }


  const processingModelChip = document.getElementById('processingModelChip');
  if (processingModelChip) {
    if (status === 'running' || status === 'paused') {
      const run = runModelSnapshot || currentRunModel();
      const runProvider = providerMeta(run.provider, currentSettings);
      const runModel = run.model;
      if (runProvider.exists && runModel && !pendingApproval) {
        processingModelChip.textContent = `${runProvider.displayName} · ${runModel}`;


        processingModelChip.title = `${runProvider.displayName} · ${runModel}`;
        processingModelChip.style.display = 'inline-block';
      } else {
        processingModelChip.style.display = 'none';
      }
    } else {
      processingModelChip.style.display = 'none';
    }
  }

  renderTimelineFromState(state);
}


function renderTimelineFromState(state) {
  const { status, currentPhase, history, pendingApproval, pendingConfirm, planSteps } = state;
  const timeline = document.getElementById('timeline');
  if (!timeline) return;
  if ((!history || history.length === 0) && !pendingApproval && !pendingConfirm && !taskError) {
    renderEmptyState();
    return;
  }

  const finishArrived = noteFinishCard(status, history);
  let html = renderTurns(history, status, currentPhase, pendingApproval, pendingConfirm, planSteps);
  if (taskError) html += taskErrorCardHtml(taskError);
  const changed = html !== lastTimelineHtml;
  lastTimelineHtml = html;
  timeline.innerHTML = html;
  attachShotSlots();


  if (followTimeline) {
    if (scrollTimelineToLatest(timeline, finishArrived) === 'card-top') setFollowTimeline(false);
  } else if (changed) {
    showJumpToLatest(true);
  }
}


function taskErrorCardHtml(message) {
  return `<div class="result-badge error" style="margin-top: 8px; padding: 10px 12px; border-radius: 8px; font-size: 12px; line-height: 1.5; align-items: flex-start;">${ICONS.warning}<span><strong>Task error:</strong><br>${escapeHtml(message)}</span></div>`;
}


function isFollowingTimeline() {
  return followTimeline;
}


function setFollowTimeline(on) {
  followTimeline = !!on;
  if (followTimeline) showJumpToLatest(false);
}


function showJumpToLatest(show) {
  const btn = document.getElementById('btnJumpLatest');
  if (btn) btn.hidden = !show;
}


function timelineGap(timeline) {
  return (Number(timeline.scrollHeight) || 0) - (Number(timeline.scrollTop) || 0) - (Number(timeline.clientHeight) || 0);
}


function keepTimelineAtBottom() {
  const timeline = document.getElementById('timeline');
  if (timeline && followTimeline) timeline.scrollTop = timeline.scrollHeight;
}


function initTimelineFollow(timeline) {
  const markReader = () => { readerScrollAt = Date.now(); };
  timeline.addEventListener('wheel', (e) => { if ((e.deltaY || 0) < 0) markReader(); }, { passive: true });
  timeline.addEventListener('touchmove', markReader, { passive: true });
  timeline.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'PageUp', 'Home'].includes(e.key) || (e.key === ' ' && e.shiftKey)) markReader();
  });

  timeline.addEventListener('pointerdown', (e) => {
    if (typeof e.offsetX === 'number' && e.offsetX >= timeline.clientWidth) readerOnScrollbar = true;
  });
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pointerup', () => { readerOnScrollbar = false; });
  }
  timeline.addEventListener('scroll', () => {
    if (timelineGap(timeline) <= FOLLOW_SLACK_PX) {
      setFollowTimeline(true);
      return;
    }
    if (readerOnScrollbar || Date.now() - readerScrollAt < READER_SCROLL_MS) setFollowTimeline(false);
  }, { passive: true });
  const jump = document.getElementById('btnJumpLatest');
  if (jump) {
    jump.addEventListener('click', () => {
      setFollowTimeline(true);
      timeline.scrollTop = timeline.scrollHeight;
    });
  }
}


function attachShotSlots() {
  const slots = document.querySelectorAll('#timeline .act-shot-slot, #timeline .act-head-thumb');
  for (const slot of slots) {
    const thumb = slot.classList.contains('act-head-thumb');
    const imageId = slot.getAttribute(thumb ? 'data-thumb' : 'data-shot') || '';
    if (!imageId) continue;
    const cached = shotCache.get(imageId);
    if (cached) {
      if (thumb) attachShotThumb(slot, cached.thumb);
      else attachShotPicture(slot, cached.img, cached.dataUrl);
      continue;
    }
    if (shotGone.has(imageId)) {
      markShotGone(slot, imageId);
      continue;
    }
    void loadShotPicture(imageId);
  }
}


function markShotGone(slot, imageId) {
  if (slot.classList.contains('act-head-thumb')) {
    slot.remove();
    return;
  }
  const why = shotGone.has(`${imageId}#undecodable`) ? 'Picture could not be shown' : 'Picture no longer kept';
  slot.innerHTML = `<span class="act-shot-gone">${why}</span>`;
}


function attachShotPicture(slot, img, dataUrl) {
  const width = Number(slot.getAttribute('data-w')) || img.naturalWidth || 4;
  const height = Number(slot.getAttribute('data-h')) || img.naturalHeight || 3;


  if (width > 0 && height > 0) slot.style.aspectRatio = `${width} / ${height}`;
  slot.innerHTML = '';
  img.width = width;
  img.height = height;
  img.alt = 'The page as the agent saw it';
  img.className = 'act-shot-img';
  img.setAttribute('data-src', dataUrl);
  slot.appendChild(img);
  keepTimelineAtBottom();
}


function attachShotThumb(slot, thumb) {
  slot.innerHTML = '';
  thumb.alt = '';
  thumb.className = 'act-head-thumb-img';
  slot.appendChild(thumb);
}


function loadShotPicture(imageId, timeoutMs = 3000) {
  if (shotLoading.has(imageId)) return;
  shotLoading.add(imageId);
  const dataUrlFor = (data, mediaType) => (String(data).startsWith('data:')
    ? String(data)
    : `data:${mediaType || 'image/jpeg'};base64,${data}`);


  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    shotLoading.delete(imageId);
  };
  const attach = () => {


    attachShotSlots();
  };


  const applyAnswer = (answer) => {
    if (answer && answer.success && answer.data) {
      const dataUrl = dataUrlFor(answer.data, answer.mediaType);
      const img = new Image();
      img.src = dataUrl;
      img.decode().then(() => {

        shotCache.set(imageId, { dataUrl, img, thumb: img.cloneNode() });
        release();
        attach();
      }, () => {


        shotGone.add(imageId);
        shotGone.add(`${imageId}#undecodable`);
        release();
        attach();
      });
      return;
    }
    shotGone.add(imageId);
    release();
    attach();
  };

  try {
    sendBgMessage({ action: 'GET_SCREENSHOT', payload: { imageId } }, (resp) => {
      if (chrome.runtime.lastError || !resp) {


        release();
        return;
      }
      release();

      applyAnswer(resp);
    });
  } catch (_) {
    release();
    return;
  }
  setTimeout(() => {


    release();
  }, timeoutMs);
}


const FINISH_LANDING_MARGIN = 8;

function finishLandingTop({ cardTop, viewHeight, scrollHeight, margin = FINISH_LANDING_MARGIN }) {
  const bottom = Math.max(0, scrollHeight - viewHeight);
  const cardStart = Math.max(0, cardTop - margin);
  return cardStart >= bottom ? scrollHeight : cardStart;
}


let seenFinishKey = null;


function finishCardKey(history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && (list[i].type === 'finish' || list[i].type === 'partial_result')) {
      return `${currentSessionId}|${i}|${String(list[i].answer == null ? '' : list[i].answer).length}`;
    }
  }
  return null;
}


function noteFinishCard(status, history) {
  if (status === 'running' || status === 'paused') return false;
  const key = finishCardKey(history);
  if (key === null || key === seenFinishKey) return false;
  seenFinishKey = key;
  return true;
}


function scrollTimelineToLatest(timeline, finishArrived) {
  const lastTurn = timeline.lastElementChild;
  const card = finishArrived && lastTurn && lastTurn.querySelector ? lastTurn.querySelector('.finish-card') : null;
  if (!card) {
    timeline.scrollTop = timeline.scrollHeight;
    return 'bottom';
  }
  const cardTop = card.getBoundingClientRect().top - timeline.getBoundingClientRect().top + timeline.scrollTop;
  const landing = finishLandingTop({ cardTop, viewHeight: timeline.clientHeight, scrollHeight: timeline.scrollHeight });
  timeline.scrollTop = landing;
  return landing >= timeline.scrollHeight ? 'bottom' : 'card-top';
}


function buildTurns(history) {
  const turns = [];
  let cur = null;
  (history || []).forEach((item, idx) => {
    if (item.type === 'chat_compacted') {


      turns.push({
        compacted: true,
        idx,
        summary: String(item.summary || ''),
        summarizedTurns: Number(item.summarizedTurns) || 0,
        auto: !!item.auto,
        timestamp: item.timestamp || null
      });
      cur = null;
      return;
    }
    if (item.type === 'user_goal') {
      cur = {
        turn: item.turn || turns.filter((t) => !t.compacted).length + 1,
        goal: item.prompt,
        entries: [],
        answer: null,
        audit: null,
        failed: false,
        timestamp: item.timestamp || null,
        isNewRun: !!item.isNewRun
      };
      turns.push(cur);
      return;
    }
    if (!cur) {
      cur = { turn: turns.filter((t) => !t.compacted).length + 1, goal: null, entries: [], answer: null, audit: null, failed: false, timestamp: null, isNewRun: false };
      turns.push(cur);
    }
    if (item.type === 'agent_response' && item.action) {
      cur.entries.push({ kind: 'action', idx, action: item.action, thought: item.thought || '', outcome: null });
    } else if (item.type === 'execution_result') {

      for (let i = cur.entries.length - 1; i >= 0; i--) {
        if (cur.entries[i].kind === 'action' && !cur.entries[i].outcome) {
          cur.entries[i].outcome = item;
          break;
        }
      }
      if (item.success === false) {
        cur.failed = true;
        cur.failedSteps = (cur.failedSteps || 0) + 1;
      }
    } else if (item.type === 'error') {
      cur.entries.push({ kind: 'fault', idx, content: item.content });
      cur.failed = true;
    } else if (item.type === 'user_answer') {
      cur.entries.push({ kind: 'answer', idx, content: item.content });
    } else if (item.type === 'confirm_review') {


      cur.entries.push({
        kind: 'confirm',
        idx,
        actionSummary: String(item.actionSummary || ''),
        decision: item.decision === 'denied' ? 'denied' : 'approved',
        remembered: !!item.remembered
      });
    } else if (item.type === 'finish') {
      cur.answer = item.answer;
      cur.answerUnconfirmed = !!item.unconfirmed;


      cur.outcome = Object.prototype.hasOwnProperty.call(OUTCOME_CARD, item.outcome) ? item.outcome : null;

      cur.evidence = item.evidence || '';


      cur.audit = item.audit || null;
      cur.table = item.table || null;
      cur.runStats = item.runStats || null;

      cur.files = Array.isArray(item.files) ? item.files.filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string') : null;
    } else if (item.type === 'partial_result') {


      cur.answer = item.answer;
      cur.partial = true;
      cur.partialReason = typeof item.reason === 'string' ? item.reason : '';
      cur.audit = item.audit || null;
      cur.table = item.table || null;
      cur.runStats = item.runStats || null;
    }
  });
  return turns;
}


function firstSentence(text) {
  const t = String(text == null ? '' : text).trim();
  const line = t.split('\n')[0] || '';
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(line);
  const sentence = (m ? m[0] : line).replace(/[:\s]+$/, '').trim();
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}


function describeAction(action, outcome) {
  const label = (outcome && outcome.label) || '';
  const quote = (t) => `<em>${escapeHtml(String(t).length > 44 ? String(t).slice(0, 43) + '…' : String(t))}</em>`;
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return u; } };

  switch (action.action) {
    case 'navigate':      return { icon: ICONS.globe, text: `Opened ${quote(host(action.url || ''))}` };
    case 'read_page': {
      const part = Number.isInteger(action.part) && action.part > 1 ? ` (part ${escapeHtml(String(action.part))})` : '';
      return { icon: ICONS.eye, text: action.element_id !== undefined && action.element_id !== null ? `Read the text of ${label ? quote(label) : `element ${escapeHtml(String(action.element_id))}`}${part}` : `Read page text${part}` };
    }

    case 'read_page_text':return { icon: ICONS.eye, text: 'Read page text' };
    case 'click':         return {
      icon: ICONS.pointer,


      text: label
        ? `Clicked ${quote(label)}`
        : (action.x !== undefined && action.x !== null
          ? `Clicked at (${escapeHtml(String(action.x))}, ${escapeHtml(String(action.y))}) in the picture`
          : `Clicked element ${escapeHtml(String(action.element_id))}`)
    };
    case 'take_screenshot': return { icon: ICONS.camera, text: 'Looked at the page' };
    case 'type':          return { icon: ICONS.keyboard, text: `${action.mode === 'append' ? 'Appended' : 'Typed'} ${quote(action.text || '')}${label ? ` into ${quote(label)}` : ''}` };
    case 'scroll': {

      const measured = /^(Scrolled .+? (?:down|up) \d+px|Did not move: [^.]*)/.exec(String((outcome && outcome.message) || ''));
      return { icon: ICONS.scrollIco, text: measured ? escapeHtml(measured[1]) : `Scrolled ${escapeHtml(action.direction || 'down')}` };
    }
    case 'go_back':       return { icon: ICONS.back, text: 'Went back' };
    case 'go_forward':    return { icon: ICONS.back, text: 'Went forward' };
    case 'get_page_elements': return { icon: ICONS.pointer, text: 'Listed the clickable elements' };
    case 'find_elements': return { icon: ICONS.search, text: `Searched elements for ${quote(action.query || '')}` };

    case 'web_search':    return { icon: ICONS.search, text: `Searched the web: ${quote(action.query || '')}` };
    case 'fetch_url': {
      const file = (() => { try { return decodeURIComponent(new URL(action.url).pathname.split('/').filter(Boolean).pop() || ''); } catch (_) { return ''; } })();
      const name = label || file || host(action.url || '');
      const part = Number.isInteger(action.part) && action.part > 1 ? ` (part ${escapeHtml(String(action.part))})` : '';
      return { icon: ICONS.doc, text: `Read ${quote(name)} (${escapeHtml(host(action.url || ''))})${part}` };
    }
    case 'ask_user':      return { icon: ICONS.ask, text: `Asked ${quote(action.question || 'a question')}` };
    case 'press_key': {
      const names = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
      const mods = Array.isArray(action.modifiers) ? action.modifiers.map((m) => names[m] || String(m)) : [];
      const key = action.key === 'select_all' ? 'Select all' : String(action.key || 'a key');
      return { icon: ICONS.keyboard, text: `Pressed ${quote([...mods, key].join('+'))}` };
    }
    case 'wait':          return { icon: ICONS.clock, text: `Waited ${escapeHtml(String(action.amount || 1))}s` };
    case 'save_data': {

      const saved = /^Saved \d+ new records? \(\d+ in total\)/.exec(String((outcome && outcome.message) || ''));
      const n = Number(action.count) || 0;
      return { icon: ICONS.doc, text: saved ? escapeHtml(saved[0]) : `Saved ${n} record${n === 1 ? '' : 's'}` };
    }
    case 'finish':

      return outcome && outcome.finishRefused
        ? { icon: ICONS.warning, text: 'Finish not accepted', detail: firstSentence(outcome.error) }
        : { icon: ICONS.complete, text: 'Gave the final answer' };
    case 'record_finding': {

      if (action.field) {
        const value = action.value == null ? '' : (typeof action.value === 'string' ? action.value : JSON.stringify(action.value));
        return { icon: ICONS.doc, text: value ? `Saved ${quote(action.field)}: ${quote(value)}` : `Saved ${quote(action.field)}` };
      }
      const fields = action.values && typeof action.values === 'object' ? Object.keys(action.values) : [];
      return { icon: ICONS.doc, text: fields.length ? `Saved ${fields.map(quote).join(', ')}` : 'Saved a finding' };
    }
    default:              return { icon: ICONS.dot, text: escapeHtml(action.action || 'Acted') };
  }
}


function isTurnExpanded(turn, isLive, incomplete) {
  if (turnExpandOverride.has(turn.turn)) return turnExpandOverride.get(turn.turn);

  return isLive || incomplete || !!turn.partial;
}


const PLAN_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'];
const AUDIT_VERDICTS = ['verified', 'partial', 'unverified'];
const NOTE_SEVERITY_RANK = { lie: 0, gap: 1, soft: 2 };

const NOTE_SEVERITY_LABEL = { lie: 'Problem', gap: 'Gap', soft: 'Note' };

const AUDIT_SUBTITLE = {
  unverified: 'Some parts of this answer could not be checked against the pages Tarka read.',
  partial: 'Not every source was checked.'
};
const UNCONFIRMED_NOTICE = 'The model replied in plain text instead of finishing the task.';

const SUBTITLE_SOURCES = 3;


function partialSubtitle(notOpened) {
  if (!notOpened.length) return AUDIT_SUBTITLE.partial;
  const names = notOpened.slice(0, SUBTITLE_SOURCES).map(escapeHtml).join(', ');
  const more = notOpened.length - SUBTITLE_SOURCES;
  return `Not every source was checked: ${names}${more > 0 ? ` and ${more} more` : ''}.`;
}

function hostOfUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}


function normalizeAudit(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list = (v) => (Array.isArray(v) ? v : []);

  const seenPages = new Set();
  const opened = [];
  list(raw.opened).forEach((p) => {
    if (!p || typeof p !== 'object') return;
    const url = typeof p.url === 'string' ? p.url : '';
    const host = (typeof p.host === 'string' && p.host) || hostOfUrl(url);
    const key = url || host;
    if (!key || seenPages.has(key)) return;
    seenPages.add(key);
    opened.push({ host, url });
  });

  const notOpened = [...new Set(list(raw.notOpened).filter((h) => typeof h === 'string' && h).map(String))];

  const notes = list(raw.notes)
    .filter((n) => n && typeof n === 'object' && n.text != null && String(n.text) !== '')
    .map((n, i) => ({
      code: typeof n.code === 'string' ? n.code : '',
      severity: Object.prototype.hasOwnProperty.call(NOTE_SEVERITY_RANK, n.severity) ? n.severity : 'soft',
      text: String(n.text),
      order: i
    }))
    .sort((a, b) => NOTE_SEVERITY_RANK[a.severity] - NOTE_SEVERITY_RANK[b.severity] || a.order - b.order)
    .map(({ code, severity, text }) => ({ code, severity, text }));

  const sendBacks = Number.isFinite(raw.sendBacks) ? Math.max(0, Math.floor(raw.sendBacks)) : 0;

  return {
    verdict: AUDIT_VERDICTS.includes(raw.verdict) ? raw.verdict : 'unverified',
    opened,
    notOpened,
    notes,
    sendBacks
  };
}


function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

function renderAuditPage(page) {
  const host = page.host ? `<span class="audit-host">${escapeHtml(page.host)}</span>` : '';
  let url = '';
  if (page.url) {
    url = isHttpUrl(page.url)
      ? `<a class="audit-url" href="${escapeHtml(page.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(page.url)}</a>`
      : `<span class="audit-url">${escapeHtml(page.url)}</span>`;
  }
  return `<li class="audit-page">${host}${url}</li>`;
}

function renderAuditNotes(notes) {
  return `<ul class="audit-notes">${notes.map((n) =>
    `<li class="audit-note" data-code="${escapeHtml(n.code)}"><span class="audit-dot ${n.severity}" role="img" aria-label="${NOTE_SEVERITY_LABEL[n.severity]}"></span><span>${escapeHtml(n.text)}</span></li>`
  ).join('')}</ul>`;
}


function renderAuditDetails(audit, turnNo, mode) {
  const attention = mode === 'attention';
  const pageCount = audit.opened.length;
  const summaryText = attention
    ? 'What could not be verified'
    : `Checked against ${pageCount} page${pageCount === 1 ? '' : 's'}`;

  const sections = [];
  const label = (text) => `<div class="audit-label">${text}</div>`;
  if (!attention && pageCount) {
    sections.push(`<div>${label('Pages read')}<ul class="audit-pages">${audit.opened.map(renderAuditPage).join('')}</ul></div>`);
  }
  if (audit.notes.length) {
    sections.push(`<div>${attention ? '' : label('Notes')}${renderAuditNotes(audit.notes)}</div>`);
  }
  if (attention) {
    if (audit.notOpened.length) {
      sections.push(`<div>${label('Not opened')}<div class="audit-plain">${audit.notOpened.map(escapeHtml).join(', ')}</div></div>`);
    }
    sections.push(`<div>${label('Pages read')}${pageCount
      ? `<ul class="audit-pages">${audit.opened.map(renderAuditPage).join('')}</ul>`
      : '<div class="audit-plain">No pages were read.</div>'}</div>`);
  }
  if (audit.sendBacks > 0) {
    sections.push(`<div class="audit-meta">Sent back to the model ${audit.sendBacks} time${audit.sendBacks === 1 ? '' : 's'} before the final answer.</div>`);
  }

  const cls = `audit ${attention ? 'attention' : 'verified'}`;
  if (!sections.length) {

    return attention ? '' : `<div class="${cls}"><div class="audit-line">${summaryText}</div></div>`;
  }
  const key = escapeHtml(String(turnNo));

  const byDefault = attention && audit.verdict === 'unverified' && !closedAuditDetails.has(String(turnNo));
  const isOpen = openAuditDetails.has(String(turnNo)) || byDefault;
  return `<details class="${cls}" data-audit-key="${key}"${isOpen ? ' open' : ''}><summary class="audit-summary"><span class="audit-chev">${ICONS.chevron}</span><span>${summaryText}</span></summary><div class="audit-body">${sections.join('')}</div></details>`;
}


const OUTCOME_CARD = {
  done: { title: 'Done', cls: '', icon: 'complete' },
  partial: { title: 'Partly done', cls: 'partial', icon: 'warning' },
  blocked: { title: 'Could not finish', cls: 'blocked', icon: 'warning' }
};

function failedStepsNote(count) {
  const n = Number(count) || 0;
  return n > 0 ? `${n} step${n === 1 ? '' : 's'} failed along the way.` : '';
}


const shownFiles = new Map();

function fileSize(chars) {
  const bytes = new Blob([chars]).size;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function renderFileChips(turn) {
  const files = Array.isArray(turn.files) ? turn.files : [];
  if (!files.length) return '';
  const chips = files.map((f, i) => {
    const key = `${turn.turn}:${i}`;
    shownFiles.set(key, f);
    return `<button type="button" class="file-chip" data-file="${escapeHtml(key)}" title="Preview ${escapeHtml(f.name)}" aria-haspopup="dialog">${ICONS.doc}<span class="file-name">${escapeHtml(f.name)}</span><span class="file-size">${escapeHtml(fileSize(f.content))}</span></button>`;
  }).join('');
  return `<div class="finish-files">${chips}</div>`;
}


function downloadShownFile(key) {
  const file = shownFiles.get(key);
  if (!file) {
    showToast('This file is no longer kept.');
    return;
  }
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mime || 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}


function toggleCodeFold(button) {
  const box = button.closest('.code-box');
  if (!box) return;
  const key = box.getAttribute('data-code-key');
  const folded = box.classList.toggle('folded');
  if (folded) unfoldedCode.delete(key);
  else unfoldedCode.add(key);
  button.setAttribute('aria-expanded', folded ? 'false' : 'true');
  button.textContent = folded ? `Show all ${button.getAttribute('data-lines')} lines` : 'Show less';
}


function previewText(file) {
  const content = String(file.content == null ? '' : file.content);
  if (/\.json$/i.test(file.name || '')) {
    try {
      return { text: JSON.stringify(JSON.parse(content), null, 2), lang: 'json' };
    } catch {  }
  }
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name || '') || [])[1] || '';
  return { text: content, lang: ext.toLowerCase() === 'json' ? 'json' : '' };
}


let filePreviewDialog = null;

function filePreview() {
  if (filePreviewDialog) return filePreviewDialog;
  const dialog = document.createElement('dialog');
  dialog.className = 'file-preview';
  dialog.setAttribute('aria-labelledby', 'filePreviewName');
  dialog.innerHTML = `<div class="file-preview-head">${ICONS.doc}<div class="file-preview-title"><span class="file-name" id="filePreviewName"></span><span class="file-size"></span></div><button type="button" class="file-preview-btn file-copy">Copy</button><button type="button" class="file-preview-btn file-download">Download</button><button type="button" class="file-preview-btn file-close" aria-label="Close preview">${ICONS.cross}</button></div><div class="file-preview-body"></div>`;
  dialog.addEventListener('click', (e) => {
    const key = dialog.getAttribute('data-file');
    if (e.target === dialog || e.target.closest('.file-close')) {
      dialog.close();
      return;
    }
    const copy = e.target.closest('.file-copy');
    if (copy) {
      const file = shownFiles.get(key);
      copyText(file ? String(file.content) : '').then((ok) => flashCopied(copy, ok && !!file));
      return;
    }
    if (e.target.closest('.file-download')) downloadShownFile(key);
  });
  dialog.addEventListener('close', () => {

    const key = dialog.getAttribute('data-file');
    const chip = key ? document.querySelector(`.file-chip[data-file="${CSS.escape(key)}"]`) : null;
    if (chip) chip.focus();
  });
  document.body.appendChild(dialog);
  filePreviewDialog = dialog;
  return dialog;
}

function openFilePreview(key) {
  const file = shownFiles.get(key);
  if (!file) {
    showToast('This file is no longer kept.');
    return;
  }
  const dialog = filePreview();
  const { text, lang } = previewText(file);
  dialog.setAttribute('data-file', key);
  dialog.querySelector('.file-name').textContent = file.name;
  dialog.querySelector('.file-size').textContent = fileSize(file.content);
  dialog.querySelector('.file-preview-body').innerHTML = renderCodeBox(text, lang, { head: false, fold: false });
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('.file-close').focus();
}

function renderFinishCard(turn) {
  if (turn.partial) return renderPartialCard(turn);
  const audit = normalizeAudit(turn.audit);
  const unconfirmed = !!turn.answerUnconfirmed;


  const raw = audit ? withoutEngineNotes(turn.answer) : turn.answer;


  const extracted = extractReadableAnswer(raw);
  const shown = extracted.text;


  const isFailedAnswer = /^MOCK-FAIL:/i.test(String(shown || ''));


  const hadFailedStep = !!turn.failed;
  const body = `<div class="finish-body">${formatMarkdownText(shown)}</div>${renderFileChips(turn)}`;


  const evidenceText = extracted.evidence || turn.evidence || '';
  const evidenceHtml = evidenceText
    ? `<details class="audit verified answer-evidence"><summary class="audit-summary"><span class="audit-chev">${ICONS.chevron}</span><span>Evidence</span></summary><div class="audit-body"><div class="audit-plain">${escapeHtml(evidenceText)}</div></div></details>`
    : '';

  const tableHtml = renderFinishTable(turn.table);
  const statsHtml = renderRunStats(turn.runStats);

  if (!audit && turn.outcome && !isFailedAnswer) {
    const card = OUTCOME_CARD[turn.outcome];
    const note = failedStepsNote(turn.failedSteps);
    const classes = ['finish-card', card.cls, note ? 'has-sub' : ''].filter(Boolean).join(' ');
    const subHtml = note ? `<div class="finish-subs"><div class="finish-sub">${escapeHtml(note)}</div></div>` : '';
    return `<div class="${classes}"><div class="finish-title">${ICONS[card.icon]} ${card.title}</div>${subHtml}${body}${evidenceHtml}${tableHtml}${statsHtml}</div>`;
  }

  if (!audit) {
    if (isFailedAnswer || hadFailedStep) {
      return `<div class="finish-card failed"><div class="finish-title">${ICONS.warning} Failed</div>${body}${evidenceHtml}${tableHtml}${statsHtml}</div>`;
    }
    return unconfirmed
      ? `<div class="finish-card unconfirmed"><div class="finish-title">${ICONS.warning} Unconfirmed answer</div>${body}${evidenceHtml}${tableHtml}${statsHtml}</div>`
      : `<div class="finish-card"><div class="finish-title">${ICONS.complete} Done</div>${body}${evidenceHtml}${tableHtml}${statsHtml}</div>`;
  }

  let title;
  let icon;
  const classes = ['finish-card'];
  const subs = [];
  if (audit.verdict === 'unverified') {
    title = 'Unverified answer'; icon = ICONS.warning;
    classes.push('unverified');
    subs.push(AUDIT_SUBTITLE.unverified);
  } else if (audit.verdict === 'partial') {
    title = 'Partial answer'; icon = ICONS.warning;
    classes.push('partial');
    subs.push(partialSubtitle(audit.notOpened));
  } else if (hadFailedStep) {


    title = 'Failed'; icon = ICONS.warning;
    classes.push('failed');
  } else if (unconfirmed) {
    title = 'Unconfirmed answer'; icon = ICONS.warning;
  } else {
    title = 'Done'; icon = ICONS.complete;
  }
  if (unconfirmed) {
    classes.push('unconfirmed');
    subs.push(UNCONFIRMED_NOTICE);
  }
  if (subs.length) classes.push('has-sub');

  const subHtml = subs.length
    ? `<div class="finish-subs">${subs.map((s) => `<div class="finish-sub">${s}</div>`).join('')}</div>`
    : '';
  const attention = audit.verdict !== 'verified';
  const details = renderAuditDetails(audit, turn.turn, attention ? 'attention' : 'verified');


  return `<div class="${classes.join(' ')}"><div class="finish-title">${icon} ${title}</div>${subHtml}${attention ? details : ''}${body}${evidenceHtml}${tableHtml}${statsHtml}${attention ? '' : details}</div>`;
}


function renderFinishTable(table) {
  const columns = table && Array.isArray(table.columns) ? table.columns : null;
  const rows = table && Array.isArray(table.rows) ? table.rows : null;
  if (!columns || columns.length === 0 || !rows || rows.length === 0) return '';
  const head = `<thead><tr>${columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${rows.map((row) => {
    const cells = Array.isArray(row) ? row : [];

    return `<tr>${columns.map((_, i) => `<td>${escapeHtml(cells[i] == null ? '' : String(cells[i]))}</td>`).join('')}</tr>`;
  }).join('')}</tbody>`;
  return `<div class="md-table-wrap" role="region" aria-label="Table" tabindex="0"><table class="md-table">${head}${body}</table></div>`;
}


function renderRunStats(stats) {
  if (!stats || typeof stats !== 'object') return '';
  const calls = Number(stats.modelCalls) || 0;
  const steps = Number(stats.stepsUsed) || 0;
  const tokensIn = Number(stats.tokensIn) || 0;
  const tokensOut = Number(stats.tokensOut) || 0;
  if (!calls && !steps && !tokensIn && !tokensOut) return '';
  const parts = [
    `${calls} model call${calls === 1 ? '' : 's'}`,
    `${steps} step${steps === 1 ? '' : 's'}`
  ];
  if (tokensIn) parts.push(`${formatTokens(tokensIn)} tokens in`);
  if (tokensOut) parts.push(`${formatTokens(tokensOut)} tokens out`);
  return `<div class="finish-stats">${escapeHtml(parts.join(' · '))}</div>`;
}


const PARTIAL_TITLE = {
  stopped: 'Stopped by you',
  max_steps: 'Stopped at the step limit',
  interrupted: 'Interrupted',
  closed: 'Interrupted'
};

const RESUMABLE_REASONS = ['stopped', 'interrupted', 'closed'];

const RESUME_PROMPT = 'Resume the unfinished task.';
const PARTIAL_SUBTITLE = {
  stopped: 'The run was stopped before it finished.',
  max_steps: 'The run used all its steps before it finished.',
  partial: 'A site could not be read, so not every source was checked.',
  stopped_early: 'The run stopped before every planned site was checked.',
  model_unusable: 'The model replies could not be used, so the run stopped early.',
  interrupted: 'Chrome restarted the background worker, so the run could not go on.',
  closed: 'The run was cut off when the browser or panel closed.'
};
const PARTIAL_SUBTITLE_FALLBACK = 'The run ended before it finished.';

const PARTIAL_REASON_MAX = 200;

function splitPartialReason(answer) {
  const text = String(answer == null ? '' : answer).trim();
  const at = text.indexOf('\n\n');
  const first = (at >= 0 ? text.slice(0, at) : text).trim();
  const looksLikeReason = first && !first.includes('\n') && !first.startsWith('|') && first.length <= PARTIAL_REASON_MAX;
  return looksLikeReason
    ? { reason: first, rest: at >= 0 ? text.slice(at + 2).trim() : '' }
    : { reason: '', rest: text };
}

function renderPartialCard(turn) {
  const audit = normalizeAudit(turn.audit);
  const reasonCode = turn.partialReason || '';
  const title = PARTIAL_TITLE[reasonCode] || 'Not finished';
  const { reason, rest } = splitPartialReason(turn.answer);
  const subtitle = reason ? escapeHtml(reason) : (PARTIAL_SUBTITLE[reasonCode] || PARTIAL_SUBTITLE_FALLBACK);
  const shown = audit ? withoutEngineNotes(rest) : rest;
  const body = shown ? `<div class="finish-body">${formatMarkdownText(shown)}</div>` : '';

  const tableHtml = renderFinishTable(turn.table);
  const statsHtml = renderRunStats(turn.runStats);


  const classes = ['finish-card', 'partial', 'has-sub'];
  if (audit && audit.verdict === 'unverified') classes.push('unverified');
  const details = audit ? renderAuditDetails(audit, turn.turn, audit.verdict === 'verified' ? 'verified' : 'attention') : '';

  const resume = turn.resumable && RESUMABLE_REASONS.includes(reasonCode)
    ? `<div class="finish-actions"><button type="button" class="btn btn-secondary btn-xs finish-resume" data-resume="1">Resume</button></div>`
    : '';
  return `<div class="${classes.join(' ')}"><div class="finish-title">${ICONS.warning} ${title}</div><div class="finish-subs"><div class="finish-sub">${subtitle}</div></div>${details}${body}${tableHtml}${statsHtml}${resume}</div>`;
}


const ENGINE_BANNERS = [
  'WARNING - UNVERIFIED ANSWER: parts of this answer are not backed by any page Tarka read. See the notes at the end.',
  'PARTIAL ANSWER: not every source was checked. See the notes at the end.'
];
const ENGINE_SECTION = '\n\n---\nVerification notes (written by Tarka, not by the model)';

function withoutEngineNotes(answer) {
  let text = String(answer == null ? '' : answer);
  const at = text.indexOf(ENGINE_SECTION);
  if (at >= 0) text = text.slice(0, at);
  const lead = text.replace(/^\s+/, '');
  const banner = ENGINE_BANNERS.find((b) => lead.startsWith(b));
  return banner ? lead.slice(banner.length).replace(/^\s+/, '') : text;
}


function pauseReasonText(state) {
  if (!state || state.status !== 'paused') return '';
  if (state.pendingApproval || state.pendingConfirm) return '';
  return state.pauseReason === 'user'
    ? 'Paused by you. Press Resume to continue.'
    : 'Paused. Press Resume to continue.';
}


function planCounts(planSteps) {
  const steps = Array.isArray(planSteps) ? planSteps : [];
  return {
    done: steps.filter((s) => s && s.status === 'completed').length,
    skipped: steps.filter((s) => s && s.status === 'skipped').length,
    total: steps.length
  };
}


function renderPlanRows(planSteps) {
  return `<div class="act-plan">${(planSteps || []).map((st) => {
    const status = PLAN_STATUSES.includes(st.status) ? st.status : 'pending';
    if (status === 'skipped') {
      return `<div class="act-plan-row skipped"><span>${ICONS.skip}</span><span>${escapeHtml(st.text)}<span class="plan-skip-note"> - not checked</span></span></div>`;
    }
    const ic = status === 'completed' ? ICONS.check : status === 'in_progress' ? ICONS.dot : ICONS.circle;
    return `<div class="act-plan-row ${status}"><span>${ic}</span><span>${escapeHtml(st.text)}</span></div>`;
  }).join('')}</div>`;
}


function renderPlanApprovalCard(pendingApproval) {
  const steps = Array.isArray(pendingApproval?.plan) ? pendingApproval.plan : [];
  if (steps.length === 0) return '';
  return `<div class="plan-approval-card">
    <div class="plan-approval-head">
      <span class="plan-approval-icon">${ICONS.layers}</span>
      <div class="plan-approval-copy">
        <div class="plan-approval-title">Here is my plan</div>
        <div class="plan-approval-lead">Approve it and Tarka will start working.</div>
      </div>
    </div>
    <ol class="plan-approval-steps">${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    <div class="plan-approval-actions">
      <button type="button" class="btn btn-secondary btn-xs" data-plan-decision="reject">Cancel</button>
      <button type="button" class="btn btn-primary btn-xs" data-plan-decision="approve">Approve plan</button>
    </div>
  </div>`;
}


function renderCompactedItem(item) {
  const key = String(item.idx);
  const n = item.summarizedTurns;
  const label = `Summary of ${n} earlier turn${n === 1 ? '' : 's'}`;
  return `<div class="chat-compacted" data-compacted="${escapeHtml(key)}">
      <div class="compact-divider"><span class="compact-tag">${item.auto ? 'Chat compacted automatically' : 'Chat compacted'}</span>${item.timestamp ? `<span class="compact-time">${escapeHtml(item.timestamp)}</span>` : ''}</div>
      <details class="compact-summary" data-compact-key="${escapeHtml(key)}"${openCompactSummaries.has(key) ? ' open' : ''}>
        <summary><span class="compact-chev">${ICONS.chevron}</span>${escapeHtml(label)}</summary>
        <div class="compact-text">${escapeHtml(item.summary)}</div>
      </details>
    </div>`;
}

function renderTurns(history, status, currentPhase, pendingApproval = null, pendingConfirm = null, planSteps = null) {
  const items = buildTurns(history);


  const turns = items.filter((t) => !t.compacted);
  const busy = status === 'running' || status === 'paused';
  const isErrorEnded = status === 'error' || status === 'stopped';


  const progressPlan = pendingApproval ? null : planSteps;

  if (turns.length === 0 && (pendingApproval || pendingConfirm)) {
    const held = { turn: 1, goal: null, entries: [], answer: null, audit: null, failed: false, timestamp: null, isNewRun: false };
    turns.push(held);
    items.push(held);
  }


  if (isErrorEnded && turns.length > 0) {
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn.answer && !lastTurn.partial) {
      const fault = lastTurn.entries.filter((e) => e.kind === 'fault').pop();
      if (status === 'stopped' && !fault) {
        lastTurn.answer = PARTIAL_SUBTITLE.stopped;
        lastTurn.partial = true;
        lastTurn.partialReason = 'stopped';
      } else {
        lastTurn.answer = fault
          ? `The run ended with an error: ${fault.content}.`
          : 'The run ended with an error.';
        lastTurn.failed = true;
      }
    }
  }

  const finalTurn = turns[turns.length - 1] || null;
  return items.map((turn) => {
    if (turn.compacted) return renderCompactedItem(turn);
    const isLast = turn === finalTurn;
    const isLive = busy && isLast;
    const count = turn.entries.filter(e => e.kind === 'action').length;

    const incomplete = !isLive && !turn.answer && turn.entries.length > 0;
    const open = isTurnExpanded(turn, isLive, incomplete);


    const captured = lastShotOf(turn);
    const capturedGone = !!(captured && shotGone.has(captured.imageId));
    const capturedSection = !!(captured && !isLive);


    let headline;
    if (isLive) {

      const { done, total } = planCounts(progressPlan);
      headline = total
        ? `Working · step ${Math.min(done + 1, total)} of ${total} · ${count} action${count === 1 ? '' : 's'}`
        : `Working · ${count} action${count === 1 ? '' : 's'}`;
    } else {
      headline = `${count} action${count === 1 ? '' : 's'}${incomplete ? ' · did not finish' : ''}`;
    }

    const rows = turn.entries.map((e) => {
      if (e.kind === 'fault') {
        return `<div class="act-row fault"><span class="act-ico">${ICONS.warning}</span><span class="act-text">${escapeHtml(e.content)}</span></div>`;
      }
      if (e.kind === 'answer') {
        return `<div class="act-row answer"><span class="act-ico">${ICONS.keyboard}</span><span class="act-text">You answered: <em>${escapeHtml(e.content)}</em></span></div>`;
      }
      if (e.kind === 'confirm') {


        const allowed = e.decision === 'approved';
        const mark = e.remembered ? '<span class="act-detail">remembered for this task</span>' : '';
        return `<div class="act-row confirm"><span class="act-ico">${ICONS.shield}</span><span class="act-text">${allowed ? 'You allowed' : 'You denied'}: ${escapeHtml(e.actionSummary)}${mark}</span></div>`;
      }
      const d = describeAction(e.action, e.outcome);
      const key = `${turn.turn}:${e.idx}`;
      const shown = expandedRows.has(key);
      const refused = !!(e.outcome && e.outcome.finishRefused);

      const bad = !!(e.outcome && e.outcome.success === false) && !refused;

      const pending = isLive && !e.outcome && !(e.action.action === 'finish' && turn.answer);
      const why = e.thought
        ? `<div class="act-why" ${shown ? '' : 'hidden'}>${escapeHtml(e.thought)}</div>`
        : '';
      const state = bad ? `<span class="act-state bad">${ICONS.cross}</span>`
                  : pending ? '<span class="act-state live"></span>'
                  : '';
      const detail = d.detail ? `<span class="act-detail">${escapeHtml(d.detail)}</span>` : '';


      const shot = e.outcome && e.outcome.imageId && !(capturedSection && e.outcome.imageId === captured.imageId)
        ? shotSlotHtml(e.outcome.imageId, e.outcome.imageWidth, e.outcome.imageHeight)
        : '';
      return `<div class="act-item">
          <div class="act-row${bad ? ' bad' : ''}${refused ? ' refused' : ''}${e.thought ? ' has-why' : ''}" data-row="${key}" ${e.thought ? 'role="button" tabindex="0"' : ''}>
            <span class="act-ico">${d.icon}</span>
            <span class="act-text">${d.text}${detail}</span>
            ${state}
          </div>${why}${shot}
        </div>`;
    }).join('');


    const showPlan = Array.isArray(progressPlan) && progressPlan.length > 0
      && (isLive || (isLast && planCounts(progressPlan).skipped > 0));
    const planDetail = showPlan ? renderPlanRows(progressPlan) : '';

    const phase = (isLive && currentPhase)
      ? `<div class="act-phase">${escapeHtml(currentPhase)}</div>`
      : '';

    const confirmPrompt = (isLive && status === 'paused' && pendingConfirm)
      ? renderActionConfirmationCard(pendingConfirm)
      : '';


    const planPrompt = (isLive && pendingApproval)
      ? renderPlanApprovalCard(pendingApproval)
      : '';

    const sessionDivider = (turn.turn > 1 || turn.isNewRun)
      ? `<div class="session-divider">
          <span class="session-tag">⚡ Run #${turn.turn}</span>
          ${turn.timestamp ? `<span class="session-time">${escapeHtml(turn.timestamp)}</span>` : ''}
        </div>`
      : '';

    return `<div class="turn">
      ${sessionDivider}
      ${turn.goal ? `<div class="user-goal-card"><span class="goal-label">Goal</span>${escapeHtml(turn.goal)}</div>` : ''}
      ${planPrompt}
      ${confirmPrompt ? confirmPrompt : ''}
      ${count || turn.entries.length || planDetail ? `<div class="act-group${open ? ' open' : ''}">
        <button class="act-head" data-turn="${turn.turn}" aria-expanded="${open}"${captured && !capturedGone ? ` aria-label="${escapeHtml(`${headline}, with a captured page`)}"` : ''}>
          <span class="act-chev">${ICONS.chevron}</span>
          <span class="act-head-text">${headline}</span>
          ${captured && !capturedGone ? `<span class="act-head-thumb" data-thumb="${escapeHtml(String(captured.imageId))}" aria-hidden="true"></span>` : ''}
        </button>
        <div class="act-body" ${open ? '' : 'hidden'}>${capturedSection ? capturedSectionHtml(captured, capturedGone) : ''}${planDetail}${rows}${phase}</div>
      </div>` : ''}
      ${turn.answer ? renderFinishCard(Object.assign(turn, { resumable: isLast && !busy }), null) : ''}
    </div>`;
  }).join('');
}


function lastShotOf(turn) {
  for (let i = turn.entries.length - 1; i >= 0; i--) {
    const o = turn.entries[i].outcome;
    if (o && o.imageId) return { imageId: String(o.imageId), width: Number(o.imageWidth) || 0, height: Number(o.imageHeight) || 0 };
  }
  return null;
}


function shotSlotHtml(imageId, width, height, extraClass = '') {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const ratio = w > 0 && h > 0 ? ` style="aspect-ratio: ${w} / ${h}"` : '';
  return `<div class="act-shot-slot${extraClass ? ` ${extraClass}` : ''}" data-shot="${escapeHtml(String(imageId))}" data-w="${escapeHtml(String(w))}" data-h="${escapeHtml(String(h))}"${ratio}></div>`;
}


function capturedSectionHtml(captured, gone) {
  const picture = gone
    ? '<span class="act-shot-gone">Picture no longer kept</span>'
    : shotSlotHtml(captured.imageId, captured.width, captured.height, 'act-captured-slot');
  return `<div class="act-captured"><div class="act-captured-label">Captured page</div>${picture}</div>`;
}


function initTimelineInteraction() {
  const timeline = document.getElementById('timeline');
  if (!timeline) return;
  initTimelineFollow(timeline);


  const keepIfLast = (el) => {
    const turnEl = el.closest('.turn');
    if (turnEl && turnEl === timeline.lastElementChild) keepTimelineAtBottom();
  };

  const toggle = (target) => {
    const head = target.closest('.act-head');
    if (head) {
      const turn = Number(head.getAttribute('data-turn'));
      const group = head.parentElement;
      const nowOpen = !group.classList.contains('open');
      turnExpandOverride.set(turn, nowOpen);
      group.classList.toggle('open', nowOpen);
      head.setAttribute('aria-expanded', String(nowOpen));
      const body = group.querySelector('.act-body');
      if (body) body.hidden = !nowOpen;
      if (nowOpen) keepIfLast(head);
      return true;
    }
    const row = target.closest('.act-row.has-why');
    if (row) {
      const key = row.getAttribute('data-row');
      const why = row.parentElement.querySelector('.act-why');
      if (!why) return true;
      const show = why.hidden;
      why.hidden = !show;
      if (show) expandedRows.add(key); else expandedRows.delete(key);
      if (show) keepIfLast(row);
      return true;
    }
    return false;
  };


  timeline.addEventListener('click', (e) => {

    const resumeBtn = e.target.closest('[data-resume]');
    if (resumeBtn) {
      const input = document.getElementById('taskInput');
      if (input) input.value = RESUME_PROMPT;
      startTask();
      return;
    }


    const planBtn = e.target.closest('[data-plan-decision]');
    if (planBtn) {
      const decision = planBtn.getAttribute('data-plan-decision');
      const card = planBtn.closest('.plan-approval-card');
      if (card) card.querySelectorAll('[data-plan-decision]').forEach((b) => { b.disabled = true; });
      sendBgMessage({ action: 'APPROVE_PLAN', payload: { decision } }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          if (card) card.querySelectorAll('[data-plan-decision]').forEach((b) => { b.disabled = false; });
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error);
          showTaskError(errMsg || 'Failed to send the plan decision.');
        }
      });
      return;
    }


    const allowBtn = e.target.closest('.btn-confirm-allow');
    if (allowBtn) {
      allowBtn.disabled = true;
      const card = allowBtn.closest('.action-confirmation-card');
      const rememberChk = card ? card.querySelector('#chkRememberSite') : null;
      const remember = rememberChk && rememberChk.checked ? 'site' : undefined;
      sendBgMessage({ action: 'CONFIRM_ACTION', payload: { decision: 'approve', remember } }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          allowBtn.disabled = false;
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error);
          showTaskError(errMsg || 'Failed to confirm action.');
        }
      });
      return;
    }

    const denyBtn = e.target.closest('.btn-confirm-deny');
    if (denyBtn) {
      denyBtn.disabled = true;
      sendBgMessage({ action: 'CONFIRM_ACTION', payload: { decision: 'reject' } }, (res) => {
        if (chrome.runtime.lastError || (res && res.success === false)) {
          denyBtn.disabled = false;
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : (res && res.error);
          showTaskError(errMsg || 'Failed to reject action.');
        }
      });
      return;
    }

    const fileChip = e.target.closest('.file-chip');
    if (fileChip) {
      openFilePreview(fileChip.getAttribute('data-file'));
      return;
    }

    const codeCopy = e.target.closest('.code-copy');
    if (codeCopy) {
      const code = codeCopy.closest('.code-box')?.querySelector('code');
      copyText(code ? code.textContent : '').then((ok) => flashCopied(codeCopy, ok));
      return;
    }

    const codeFold = e.target.closest('.code-fold');
    if (codeFold) {
      toggleCodeFold(codeFold);
      return;
    }

    toggle(e.target);
  });


  timeline.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d && d.matches && d.matches('details.compact-summary')) {
      const key = d.getAttribute('data-compact-key');
      if (d.open) openCompactSummaries.add(key);
      else openCompactSummaries.delete(key);
      return;
    }
    if (!d || !d.matches || !d.matches('details.audit')) return;
    const key = d.getAttribute('data-audit-key');
    if (d.open) {
      openAuditDetails.add(key);
      closedAuditDetails.delete(key);
    } else {
      openAuditDetails.delete(key);
      closedAuditDetails.add(key);
    }
  }, true);
  timeline.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (toggle(e.target)) e.preventDefault();
    }
  });
}


function logsAtBottom(logOutput) {
  return logOutput.scrollHeight - logOutput.scrollTop - logOutput.clientHeight < 40;
}

const LOGS_WAITING_HTML = '<div class="subtext-hint log-empty">Nothing logged yet. Start a task and every model call and step appears here.</div>';


function renderFilteredLogs() {
  const logOutput = document.getElementById('logOutput');
  if (!logOutput) return;
  const stick = logsAtBottom(logOutput);
  const filtered = (rawLogsCache || []).filter((log) => logMatchesFilter(log, currentActiveLogFilter));
  if (filtered.length === 0) {
    logOutput.innerHTML = rawLogsCache && rawLogsCache.length
      ? '<div class="subtext-hint log-empty">No entries for this filter yet.</div>'
      : LOGS_WAITING_HTML;
    return;
  }
  logOutput.innerHTML = filtered.map((log) => logEntryHtml(log, { state: logTreeState })).join('');
  if (stick) logOutput.scrollTop = logOutput.scrollHeight;
}


function addLogEntry(entry) {
  if (currentSettings.developerMode !== true) return;
  if (!entry) return;
  rawLogsCache.push(entry);
  if (rawLogsCache.length > MAX_PANEL_LOGS) rawLogsCache.shift();
  const logOutput = document.getElementById('logOutput');
  if (!logOutput || !logMatchesFilter(entry, currentActiveLogFilter)) return;
  const stick = logsAtBottom(logOutput);
  if (!logOutput.querySelector('.log-entry')) logOutput.innerHTML = '';
  logOutput.insertAdjacentHTML('beforeend', logEntryHtml(entry, { state: logTreeState }));
  while (logOutput.children.length > MAX_PANEL_LOGS) logOutput.firstElementChild.remove();
  if (stick) logOutput.scrollTop = logOutput.scrollHeight;
}


function initLogInteractions() {
  const logOutput = document.getElementById('logOutput');
  if (!logOutput) return;
  logOutput.addEventListener('click', (event) => {
    const toggle = event.target.closest('.jt-toggle');
    if (toggle) {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      const children = toggle.nextElementSibling;
      if (children) children.hidden = !open;
      const entryId = toggle.closest('.jt')?.getAttribute('data-entry') || '';
      logTreeState.set(treeStateKey(entryId, toggle.getAttribute('data-path') || ''), open);
      return;
    }
    const more = event.target.closest('.jt-more');
    if (more) {
      const open = more.getAttribute('aria-expanded') !== 'true';
      more.setAttribute('aria-expanded', String(open));
      const full = more.previousElementSibling;
      const shortText = full?.previousElementSibling;
      if (full) full.hidden = !open;
      if (shortText) shortText.hidden = open;
      more.textContent = open ? 'show less' : (more.getAttribute('data-label') || 'show all');
      return;
    }
    const copy = event.target.closest('.log-copy');
    if (copy) {
      const log = rawLogsCache.find((entry) => String(entry.id) === copy.getAttribute('data-id'));
      const details = log ? parseLogData(log.data) : null;
      if (details === null) return;
      navigator.clipboard.writeText(typeof details === 'string' ? details : JSON.stringify(details, null, 2)).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy JSON'; }, 1500);
      }).catch(() => {});
    }
  });
}


function formatMarkdownText(text) {
  if (!text) return '';
  const source = String(text);
  const blocks = parseMarkdownBlocks(source);
  return blocks ? renderMarkdownBlocks(blocks) : legacyMarkdown(source);
}


function hasMarkdownBlocks(text) {
  return !!text && parseMarkdownBlocks(String(text)) !== null;
}


function hasMarkdownTable(text) {
  const blocks = text ? parseMarkdownBlocks(String(text)) : null;
  return !!blocks && blocks.some((block) => block.type === 'table');
}


const INLINE_CODE = /(?<!`)`([^`\n]+)`(?!`)/g;

const markdownBold = (escaped) => escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');


function withCodeSpans(escaped, rest) {
  let out = '';
  let at = 0;
  for (const match of escaped.matchAll(INLINE_CODE)) {
    out += rest(escaped.slice(at, match.index)) + `<code class="md-code">${match[1]}</code>`;
    at = match.index + match[0].length;
  }
  return out + rest(escaped.slice(at));
}


function markdownInline(text) {
  return withCodeSpans(escapeHtml(text), markdownBold);
}

function legacyMarkdown(text) {
  return legacyBullets(markdownInline(text));
}

const WHITESPACE_RUN = /\s*/y;
const isLineTerminator = (code) => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;


function legacyBullets(str) {
  const n = str.length;
  let out = '';
  let copied = 0;
  let at = 0;
  while (at <= n) {
    WHITESPACE_RUN.lastIndex = at;
    WHITESPACE_RUN.test(str);
    const afterRun = WHITESPACE_RUN.lastIndex;
    const mark = str.charCodeAt(afterRun);
    let scanFrom = afterRun;
    if (mark === 45 || mark === 42) {
      WHITESPACE_RUN.lastIndex = afterRun + 1;
      WHITESPACE_RUN.test(str);
      const textStart = WHITESPACE_RUN.lastIndex;
      if (textStart > afterRun + 1) {
        let end = textStart;
        while (end < n && !isLineTerminator(str.charCodeAt(end))) end++;
        out += str.slice(copied, at) + '• ' + str.slice(textStart, end);
        copied = end;
        scanFrom = end;
      }
    }

    let next = scanFrom;
    while (next < n && !isLineTerminator(str.charCodeAt(next))) next++;
    if (next >= n) break;
    at = next + 1;
  }
  return out + str.slice(copied);
}


const MARKDOWN_MAX_COLUMNS = 40;


const MARKDOWN_SHORT_CELL = 16;
const MARKDOWN_MAX_LIST_DEPTH = 3;
const isSpaceCode = (code) => code === 32 || code === 9;


function matchHeading(line) {
  let at = 0;
  while (at < 3 && line.charCodeAt(at) === 32) at++;
  let level = 0;
  while (level < 7 && line.charCodeAt(at + level) === 35) level++;
  if (level < 1 || level > 6 || !isSpaceCode(line.charCodeAt(at + level))) return null;
  let title = line.slice(at + level).trim();

  let end = title.length;
  while (end > 0 && title.charCodeAt(end - 1) === 35) end--;
  if (end < title.length && (end === 0 || isSpaceCode(title.charCodeAt(end - 1)))) title = title.slice(0, end).trim();
  return title ? { level, text: title } : null;
}


function matchListItem(line) {
  let at = 0;
  let indent = 0;
  for (; at < line.length; at++) {
    const code = line.charCodeAt(at);
    if (code === 32) indent++;
    else if (code === 9) indent += 4;
    else break;
  }
  const first = line.charCodeAt(at);
  let marker = '';
  let ordered = false;
  let number = 0;
  let end = at;
  if (first === 45 || first === 42 || first === 8226) {
    marker = '•';
    end = at + 1;
  } else if (first >= 48 && first <= 57) {
    let digits = at;
    while (digits < line.length && digits - at < 9 && line.charCodeAt(digits) >= 48 && line.charCodeAt(digits) <= 57) digits++;
    const close = line.charCodeAt(digits);
    if (close === 46 || close === 41) {
      marker = line.slice(at, digits + 1);
      ordered = true;
      number = Number(line.slice(at, digits));
      end = digits + 1;
    }
  }
  if (!marker || !isSpaceCode(line.charCodeAt(end))) return null;
  const text = line.slice(end).trim();
  if (!text) return null;
  return { depth: Math.min(MARKDOWN_MAX_LIST_DEPTH, Math.floor(indent / 2)), ordered, marker, number, text };
}


function hasUnescapedPipe(line) {
  let from = 0;
  for (;;) {
    const at = line.indexOf('|', from);
    if (at < 0) return false;
    if (at === 0 || line.charCodeAt(at - 1) !== 92) return true;
    from = at + 1;
  }
}


function splitTableRow(line) {
  let row = line.trim();
  if (row.charCodeAt(0) === 124) row = row.slice(1);
  const last = row.length - 1;
  if (last >= 0 && row.charCodeAt(last) === 124 && !(last > 0 && row.charCodeAt(last - 1) === 92)) row = row.slice(0, last);
  const cells = [];
  let parts = [];
  let start = 0;
  let from = 0;
  for (;;) {
    const at = row.indexOf('|', from);
    if (at < 0) {
      parts.push(row.slice(start));
      cells.push(parts.join('').trim());
      return cells;
    }
    if (at > start && row.charCodeAt(at - 1) === 92) {
      parts.push(row.slice(start, at - 1), '|');
    } else {
      parts.push(row.slice(start, at));
      cells.push(parts.join('').trim());
      parts = [];
    }
    start = at + 1;
    from = at + 1;
  }
}

const TABLE_DELIMITER_LINE = /^[ \t|:-]+$/;
const TABLE_DELIMITER_CELL = /^:?-+:?$/;


function matchTable(lines, at) {
  const headerLine = lines[at];
  const delimiterLine = lines[at + 1];
  if (delimiterLine === undefined || !TABLE_DELIMITER_LINE.test(delimiterLine)) return null;
  if (!hasUnescapedPipe(headerLine) || !hasUnescapedPipe(delimiterLine)) return null;
  const head = splitTableRow(headerLine);
  const marks = splitTableRow(delimiterLine);
  if (head.length !== marks.length || head.length > MARKDOWN_MAX_COLUMNS) return null;
  if (!marks.every((mark) => TABLE_DELIMITER_CELL.test(mark))) return null;
  const aligns = marks.map((mark) => {
    const left = mark.charCodeAt(0) === 58;
    const right = mark.charCodeAt(mark.length - 1) === 58;
    return left && right ? 'c' : right ? 'r' : '';
  });

  const columns = head.length;
  const rows = [];
  let next = at + 2;
  for (; next < lines.length; next++) {
    const line = lines[next];
    if (!line.trim() || matchHeading(line) || !hasUnescapedPipe(line)) break;
    if (line.trim().charCodeAt(0) !== 124 && matchListItem(line)) break;
    const cells = splitTableRow(line);
    if (cells.length > columns) cells.splice(columns - 1, cells.length - columns + 1, cells.slice(columns - 1).join(' | '));
    while (cells.length < columns) cells.push('');
    rows.push(cells);
  }
  return { block: { type: 'table', aligns, head, rows }, next };
}


function parseMarkdownBlocks(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = null;
  let list = null;
  let special = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = matchFenceOpen(line);
    if (fence) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !isFenceClose(lines[j], fence); j++) body.push(lines[j]);
      blocks.push({ type: 'code', info: fence.info, text: body.join('\n') });
      paragraph = null;
      list = null;
      special = true;
      i = j;
      continue;
    }
    if (!line.trim()) {
      paragraph = null;
      list = null;
      continue;
    }
    if (!special && hasLink(line)) special = true;
    const heading = matchHeading(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading.level, text: heading.text });
      paragraph = null;
      list = null;
      special = true;
      continue;
    }
    const table = i + 1 < lines.length ? matchTable(lines, i) : null;
    if (table) {
      blocks.push(table.block);
      paragraph = null;
      list = null;
      special = true;
      i = table.next - 1;
      continue;
    }
    const item = matchListItem(line);

    if (item && (!paragraph || !item.ordered || item.number === 1 || list)) {
      if (!list || list.ordered !== item.ordered) {
        list = { type: 'list', ordered: item.ordered, items: [] };
        blocks.push(list);
      }
      list.items.push({ depth: item.depth, marker: item.marker, lines: [item.text] });
      paragraph = null;
      continue;
    }
    if (list) {

      list.items[list.items.length - 1].lines.push(line.trim());
      continue;
    }
    if (!paragraph) {
      paragraph = { type: 'paragraph', lines: [] };
      blocks.push(paragraph);
    }
    paragraph.lines.push(line);
  }
  return special ? blocks : null;
}


function matchFenceOpen(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const info = match[2].trim();
  if (match[1][0] === '`' && info.includes('`')) return null;
  return { char: match[1][0], size: match[1].length, info };
}


function isFenceClose(line, fence) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!match && match[1][0] === fence.char && match[1].length >= fence.size;
}


const URL_CHARS = '[^\\s<>"\'`()]';
const LINK = new RegExp(
  `\\[([^\\]\\n]+)\\]\\((https?:\\/\\/${URL_CHARS}+(?:\\(${URL_CHARS}*\\)${URL_CHARS}*)*)\\)` +
  `|(https?:\\/\\/${URL_CHARS}+(?:\\(${URL_CHARS}*\\)${URL_CHARS}*)*)`,
  'g'
);
const hasLink = (text) => /https?:\/\/[^\s<>"'`]/.test(text);

const URL_TAIL = /[.,;:!?*_~]+$/;

function linkTag(url, label) {
  return `<a class="md-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}


function richInline(text) {
  const raw = String(text);
  const out = [];
  let at = 0;
  const plain = (part) => {
    if (!part) return;
    let from = 0;
    for (const match of part.matchAll(LINK)) {
      out.push(markdownBold(escapeHtml(part.slice(from, match.index))));
      if (match[2]) {
        out.push(linkTag(match[2], markdownBold(escapeHtml(match[1]))));
        from = match.index + match[0].length;
      } else {
        const url = match[3].replace(URL_TAIL, '');
        out.push(url.length > 'https://'.length ? linkTag(url, escapeHtml(url)) : escapeHtml(url));
        from = match.index + url.length;
      }
    }
    out.push(markdownBold(escapeHtml(part.slice(from))));
  };
  for (const match of raw.matchAll(INLINE_CODE)) {
    plain(raw.slice(at, match.index));
    out.push(`<code class="md-code">${escapeHtml(match[1])}</code>`);
    at = match.index + match[0].length;
  }
  plain(raw.slice(at));
  return out.join('');
}

function markdownTableInline(text) {
  return richInline(text);
}


const CODE_FOLD_LINES = 15;

const unfoldedCode = new Set();

const codeCache = new Map();
const CODE_CACHE_MAX = 40;


function textKey(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}-${text.length.toString(36)}`;
}


function isJsonCode(text, lang) {
  if (/^(json|jsonc|json5|geojson)$/i.test(lang)) return true;
  if (lang) return false;
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}


const JSON_TOKEN = /("(?:[^"\\\n]|\\.)*")(\s*:)?|\b(true|false|null)\b|(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;

function highlightJson(text) {
  let out = '';
  let at = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    out += escapeHtml(text.slice(at, match.index));
    if (match[1]) {
      out += `<span class="${match[2] ? 'tok-key' : 'tok-str'}">${escapeHtml(match[1])}</span>${match[2] ? escapeHtml(match[2]) : ''}`;
    } else {
      out += `<span class="${match[3] ? 'tok-lit' : 'tok-num'}">${escapeHtml(match[0])}</span>`;
    }
    at = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(at));
}

function codeHtml(text, lang) {
  if (!isJsonCode(text, lang)) return escapeHtml(text);
  const key = textKey(text);
  let html = codeCache.get(key);
  if (html === undefined) {
    html = highlightJson(text);
    if (codeCache.size >= CODE_CACHE_MAX) codeCache.delete(codeCache.keys().next().value);
    codeCache.set(key, html);
  }
  return html;
}


function renderCodeBox(text, info = '', { head = true, fold = true } = {}) {
  const lang = String(info).split(/\s+/)[0] || '';
  const lines = text ? text.split('\n').length : 0;
  const key = textKey(text);
  const foldable = fold && lines > CODE_FOLD_LINES;
  const folded = foldable && !unfoldedCode.has(key);
  const headHtml = head
    ? `<div class="code-head"><span class="code-lang">${escapeHtml(info)}</span><button type="button" class="code-copy" aria-label="Copy code">Copy</button></div>`
    : '';
  const foldHtml = foldable
    ? `<button type="button" class="code-fold" aria-expanded="${folded ? 'false' : 'true'}" data-lines="${lines}">${folded ? `Show all ${lines} lines` : 'Show less'}</button>`
    : '';
  return `<div class="code-box${folded ? ' folded' : ''}" data-code-key="${key}">${headHtml}<pre class="code-pre" tabindex="0"><code>${codeHtml(text, lang)}</code></pre>${foldHtml}</div>`;
}


async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}


function flashCopied(button, ok, idle = 'Copy') {
  button.textContent = ok ? 'Copied' : 'Copy failed';
  button.classList.toggle('copied', ok);
  clearTimeout(button._copyTimer);
  button._copyTimer = setTimeout(() => {
    button.textContent = idle;
    button.classList.remove('copied');
  }, 1500);
}

function renderMarkdownTable(table) {
  const cell = (tag, text, index) => {
    const classes = [];
    if (table.aligns[index]) classes.push(`md-al-${table.aligns[index]}`);
    if (text && text.length <= MARKDOWN_SHORT_CELL) classes.push('md-nw');
    const attributes = `${classes.length ? ` class="${classes.join(' ')}"` : ''}${tag === 'th' ? ' scope="col"' : ''}`;
    return `<${tag}${attributes}>${markdownTableInline(text)}</${tag}>`;
  };
  const head = `<thead><tr>${table.head.map((text, i) => cell('th', text, i)).join('')}</tr></thead>`;
  const body = table.rows.length
    ? `<tbody>${table.rows.map((row) => `<tr>${row.map((text, i) => cell('td', text, i)).join('')}</tr>`).join('')}</tbody>`
    : '';


  return `<div class="md-table-wrap" role="region" aria-label="Table" tabindex="0"><table class="md-table">${head}${body}</table></div>`;
}

function renderMarkdownBlocks(blocks) {
  const html = blocks.map((block) => {
    if (block.type === 'heading') {
      return `<div class="md-h md-h${block.level}" role="heading" aria-level="${block.level}">${richInline(block.text)}</div>`;
    }
    if (block.type === 'table') return renderMarkdownTable(block);
    if (block.type === 'code') return renderCodeBox(block.text, block.info);
    if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((item) =>
        `<li class="md-li${item.depth ? ` md-d${item.depth}` : ''}"><span class="md-mark" aria-hidden="true">${escapeHtml(item.marker)}</span><span class="md-li-text">${richInline(item.lines.join('\n'))}</span></li>`
      ).join('');
      return `<${tag} class="md-list" role="list">${items}</${tag}>`;
    }
    return `<div class="md-p">${richInline(block.lines.join('\n'))}</div>`;
  }).join('');
  return `<div class="md-doc">${html}</div>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


export {
  buildTurns, renderTurns, renderCompactedItem, renderContextMeter, renderFinishCard, renderAuditDetails, renderPlanRows, normalizeAudit,
  planCounts, pauseReasonText, escapeHtml, initTimelineInteraction, openAuditDetails, closedAuditDetails, openCompactSummaries, describeAction, firstSentence, withoutEngineNotes,
  partialSubtitle, renderState, receiveState, loadSelectedSession, finishLandingTop, finishCardKey, noteFinishCard, scrollTimelineToLatest,
  formatMarkdownText, hasMarkdownBlocks, hasMarkdownTable, legacyBullets, splitTableRow, renderCodeBox, textKey, unfoldedCode, shownFiles,
  attachShotSlots, attachShotPicture, shotCache, shotGone, loadShotPicture, lastShotOf, capturedSectionHtml, RESUME_PROMPT,
  setFollowTimeline, isFollowingTimeline, showTaskError, resetChatView, startTaskInner,
  loadSettings, autoSaveCurrentForm, openComboboxMenu, closeComboboxMenu, updateSelectedModel,
  pickComboboxModel, initEventListeners, initCombobox
};
