

import { formatTokens } from '../src/shared/tokens.ts';


export const WINDOW_SOURCE_TEXT = {
  user: 'set by you',
  provider: 'from the provider',
  estimate: 'estimate',
  default: 'default'
};


export const CHAIN_NOTE = 'Earlier answers of this chat are sent with each new request.';


export const WARN_AT = 70;
export const HIGH_AT = 90;


const RING_R = 6;
const RING_LENGTH = 2 * Math.PI * RING_R;


export function percentOf(used, window) {
  const u = Number(used) || 0;
  const w = Number(window) || 0;
  if (u <= 0 || w <= 0) return 0;
  return Math.min(100, (u / w) * 100);
}


export function percentText(pct) {
  if (!(pct > 0)) return '0%';
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}


export function levelOf(pct) {
  if (pct >= HIGH_AT) return 'high';
  if (pct >= WARN_AT) return 'warn';
  return 'ok';
}


export function meterView(context, { busy = false, model = '', pending = false } = {}) {
  const c = context || {};
  const windowTokens = Number(c.window) > 0 ? Number(c.window) : 262144;
  const used = Math.max(0, Number(c.used) || 0);
  const pct = percentOf(used, windowTokens);
  const level = levelOf(pct);
  const windowText = formatTokens(windowTokens);
  const sourceText = WINDOW_SOURCE_TEXT[c.windowSource] || WINDOW_SOURCE_TEXT.default;
  const compacting = !!c.compacting || pending;
  const hasEarlierTurn = !!c.hasEarlierTurn;
  let compactOff = '';
  if (compacting) compactOff = 'The chat is being compacted.';
  else if (busy) compactOff = 'Stop the task before you compact the chat.';
  else if (!hasEarlierTurn) compactOff = 'There is no earlier turn to compact.';
  return {
    pct,
    pctText: percentText(pct),
    level,
    used,
    usedText: formatTokens(used),
    windowText,
    sourceText,
    model: String(model || ''),
    estimated: !!c.estimated && used > 0,
    summarizedTurns: Number(c.summarizedTurns) || 0,
    compacting,
    canCompact: !compactOff,
    compactTitle: compactOff || 'Summarize this chat, so later requests start from the summary',
    label: `Context: ${percentText(pct)} of ${windowText} used`
  };
}


export function ringSvg(view) {
  const filled = view.pct > 0 ? Math.max(view.pct, 4) : 0;
  const arc = (RING_LENGTH * filled) / 100;
  return `<svg class="ctx-ring ctx-${view.level}" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">`
    + `<circle class="ctx-ring-track" cx="8" cy="8" r="${RING_R}" fill="none" stroke-width="2.25"/>`
    + `<circle class="ctx-ring-arc" cx="8" cy="8" r="${RING_R}" fill="none" stroke-width="2.25" stroke-linecap="round"`
    + ` stroke-dasharray="${arc.toFixed(2)} ${RING_LENGTH.toFixed(2)}" transform="rotate(-90 8 8)"${filled ? '' : ' hidden'}/>`
    + '</svg>';
}


function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}


export function contextCardHtml(view) {
  const width = view.pct > 0 ? Math.max(view.pct, 1.5) : 0;
  const summarized = view.summarizedTurns > 0
    ? ` ${view.summarizedTurns} earlier turn${view.summarizedTurns === 1 ? ' is' : 's are'} sent as a summary.`
    : '';
  return `<div class="ctx-head">
      <span class="ctx-title">Context${view.model ? ` · <span class="ctx-model">${esc(view.model)}</span>` : ''}</span>
      <span class="ctx-window">${esc(view.windowText)}, ${esc(view.sourceText)}</span>
    </div>
    <div class="ctx-usage">
      <div class="ctx-usage-row">
        <span class="ctx-usage-label">This chat</span>
        <span class="ctx-usage-value">${esc(view.usedText)} of ${esc(view.windowText)} · ${esc(view.pctText)}</span>
      </div>
      <div class="ctx-bar" role="progressbar" aria-label="Context used by this chat" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(view.pct)}">
        <span class="ctx-bar-fill ctx-${view.level}" style="width:${width.toFixed(1)}%"></span>
      </div>
      ${view.estimated ? '<div class="ctx-estimated">Estimated</div>' : ''}
    </div>
    <p class="ctx-note">${esc(CHAIN_NOTE)}${esc(summarized)}</p>
    <div class="ctx-actions">
      <button type="button" class="ctx-compact" data-ctx="compact"${view.canCompact ? '' : ' disabled'} title="${esc(view.compactTitle)}">${view.compacting ? 'Compacting…' : 'Compact chat'}</button>
      <button type="button" class="ctx-link" data-ctx="settings">Set the window in Settings</button>
    </div>`;
}


export function contextWindowHint(window, provider) {
  const now = window && Number(window.tokens) > 0
    ? `Now ${formatTokens(window.tokens)} (${WINDOW_SOURCE_TEXT[window.source] || WINDOW_SOURCE_TEXT.default}). `
    : '';
  const fallback = provider === 'ollama'
    ? 'Empty uses what Ollama reports for the model. For Ollama this number is also num_ctx, the window Ollama is started with.'
    : "Empty uses the provider's number, else 256K.";
  return `${now}Takes 200000, 200K or 1M. ${fallback}`;
}
