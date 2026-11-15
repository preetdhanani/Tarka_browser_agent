

export const LOG_KIND_LABELS = { agent: 'Task', tool: 'Step', llm: 'Model', system: 'System' };


export const LOG_FILTERS = {

  all: (log) => log.level !== 'DEBUG' && (kindOf(log) !== 'system' || log.level === 'WARN' || log.level === 'ERROR'),
  agent: (log) => kindOf(log) === 'agent' || kindOf(log) === 'tool',
  llm: (log) => kindOf(log) === 'llm',
  system: (log) => kindOf(log) === 'system'
};


export const JSON_STRING_PREVIEW = 300;


export function kindOf(log) {
  return log && LOG_KIND_LABELS[log.kind] ? log.kind : 'system';
}


export function logMatchesFilter(log, filter) {
  const test = LOG_FILTERS[filter];
  return test ? test(log) : true;
}

export function escapeLogHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


export function parseLogData(data) {
  if (data === null || data === undefined || data === '') return null;
  if (typeof data === 'object') return data;
  try {
    return JSON.parse(String(data));
  } catch {
    return String(data);
  }
}


export function treeStateKey(entryId, path) {
  return `${entryId}|${path}`;
}

function isContainer(value) {
  return value !== null && typeof value === 'object';
}

function sizeLabel(value) {
  return Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`;
}

function leafHtml(value, path) {
  if (value === null) return '<span class="jt-null">null</span>';
  if (typeof value === 'number') return `<span class="jt-num">${escapeLogHtml(value)}</span>`;
  if (typeof value === 'boolean') return `<span class="jt-bool">${value}</span>`;
  const text = String(value);
  if (text.length <= JSON_STRING_PREVIEW) return `<span class="jt-str">"${escapeLogHtml(text)}"</span>`;
  return `<span class="jt-str jt-str-short">"${escapeLogHtml(text.slice(0, JSON_STRING_PREVIEW))}…"</span>`
    + `<span class="jt-str jt-str-full" hidden>"${escapeLogHtml(text)}"</span>`
    + `<button type="button" class="jt-more" data-path="${escapeLogHtml(path)}" data-label="show all ${text.length.toLocaleString('en-US')} characters" aria-expanded="false">show all ${text.length.toLocaleString('en-US')} characters</button>`;
}

function keyHtml(key, inArray) {
  return inArray
    ? `<span class="jt-index">${escapeLogHtml(key)}</span><span class="jt-colon">:</span> `
    : `<span class="jt-key">"${escapeLogHtml(key)}"</span><span class="jt-colon">:</span> `;
}


function nodeHtml(value, { key, inArray, path, depth, entryId, state }) {
  const label = key === undefined ? '' : keyHtml(key, inArray);
  if (!isContainer(value)) return `<div class="jt-leaf">${label}${leafHtml(value, path)}</div>`;
  const entries = Array.isArray(value) ? value.map((item, i) => [String(i), item]) : Object.entries(value);
  if (entries.length === 0) {
    return `<div class="jt-leaf">${label}<span class="jt-brace">${Array.isArray(value) ? '[]' : '{}'}</span></div>`;
  }
  const remembered = state ? state.get(treeStateKey(entryId, path)) : undefined;
  const open = remembered === undefined ? depth === 0 : remembered;
  const children = entries.map(([childKey, child]) => nodeHtml(child, {
    key: childKey,
    inArray: Array.isArray(value),
    path: Array.isArray(value) ? `${path}[${childKey}]` : `${path}.${childKey}`,
    depth: depth + 1,
    entryId,
    state
  })).join('');
  return `<div class="jt-node">`
    + `<button type="button" class="jt-toggle" data-path="${escapeLogHtml(path)}" aria-expanded="${open}">`
    + `<span class="jt-caret" aria-hidden="true"></span>${label}<span class="jt-brace">${sizeLabel(value)}</span></button>`
    + `<div class="jt-children"${open ? '' : ' hidden'}>${children}</div></div>`;
}


export function renderJsonTree(value, { entryId = '', state = null } = {}) {
  return `<div class="jt" data-entry="${escapeLogHtml(entryId)}">${nodeHtml(value, { path: '$', depth: 0, entryId, state })}</div>`;
}


export function logEntryHtml(log, { state = null } = {}) {
  const kind = kindOf(log);
  const level = ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(log.level) ? log.level : 'INFO';
  const id = String(log.id || `${log.timestamp || ''}-${(log.message || '').slice(0, 24)}`);
  const details = parseLogData(log.data);
  let body = '';
  if (details !== null && isContainer(details)) {
    body = renderJsonTree(details, { entryId: id, state });
  } else if (details !== null) {
    body = `<pre class="log-payload">${escapeLogHtml(details)}</pre>`;
  }
  return `<div class="log-entry log-kind-${kind} log-entry-${level}" data-id="${escapeLogHtml(id)}">`
    + `<div class="log-meta">`
    + `<span class="log-time">${escapeLogHtml(log.timestamp || '')}</span>`
    + `<span class="log-kind log-kind-badge-${kind}">${LOG_KIND_LABELS[kind]}</span>`
    + `${level === 'INFO' ? '' : `<span class="log-level-${level}">${level}</span>`}`

    + `${kind === 'system' ? `<span class="log-module">${escapeLogHtml(log.module || 'System')}</span>` : ''}`
    + `${isContainer(details) ? `<button type="button" class="log-copy" data-id="${escapeLogHtml(id)}" title="Copy the details as JSON">Copy JSON</button>` : ''}`
    + `</div>`
    + `<div class="log-msg">${escapeLogHtml(log.message || '')}</div>`
    + body
    + `</div>`;
}
