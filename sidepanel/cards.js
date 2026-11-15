/**
 * sidepanel/cards.js
 * Specialized Card Renderers for HITL approval: the action confirmation card
 * (confirm_action). Designed with Studio Mono tokens and clean HTML generation.
 */

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The host name of a URL, or '' when it does not parse. */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

/** One labelled line of the card, or '' when there is no value. */
function confirmRow(label, value) {
  if (!value) return '';
  return `<div class="confirm-row"><span class="confirm-row-label">${escapeHtml(label)}</span><code class="confirm-row-value">${escapeHtml(value)}</code></div>`;
}

/**
 * The action's own data, so the user sees what they approve: the typed text, the code of a script (escaped, monospace,
 * scrolling inside its box) and the steps of a batch. `detail` comes from the risk gate (agent/risk.ts ConfirmDetail).
 */
function renderConfirmDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const parts = [];
  if (typeof detail.typedText === 'string' && detail.typedText) {
    parts.push(`
      <div class="confirm-block">
        <span class="confirm-block-label">Text to type</span>
        <pre class="confirm-code confirm-text">${escapeHtml(detail.typedText)}</pre>
      </div>`);
  }
  if (typeof detail.code === 'string') {
    const total = Number(detail.codeLength) || detail.code.length;
    const cut = total > detail.code.length
      ? `<span class="confirm-code-note">Showing the first ${detail.code.length} of ${total} characters. The rest is not shown but runs too.</span>`
      : '';
    parts.push(`
      <div class="confirm-block">
        <span class="confirm-block-label">JavaScript to run</span>
        <pre class="confirm-code"><code>${escapeHtml(detail.code)}</code></pre>
        ${cut}
      </div>`);
  }
  if (Array.isArray(detail.steps) && detail.steps.length > 0) {
    parts.push(`
      <div class="confirm-block">
        <span class="confirm-block-label">Steps</span>
        <ol class="confirm-steps">${detail.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
      </div>`);
  }
  return parts.join('');
}

/**
 * Render Action Confirmation Card (HITL interrupt: confirm_action)
 */
export function renderActionConfirmationCard(confirm) {
  if (!confirm) return '';

  const variant = confirm.variant || 'form';
  const detail = confirm.detail && typeof confirm.detail === 'object' ? confirm.detail : null;
  const actionSummary = confirm.actionSummary || 'Perform browser action';
  const elementLabel = confirm.elementLabel || (detail && detail.elementLabel) || '';
  const reason = confirm.reason || 'This action modifies external state or navigates away.';
  const pageHost = confirm.pageUrl ? hostOf(confirm.pageUrl) : '';
  // The engine remembers a card's targetOrigin for the rest of the run (CONTRACT-REMEMBER), so
  // every card that carries one offers the checkbox: ticking it skips the later cards for this
  // origin. Without an origin there is nothing to remember, so the checkbox never shows.
  const targetOrigin = confirm.targetOrigin || '';
  const targetDomain = targetOrigin ? hostOf(targetOrigin) : '';

  const variantTitles = {
    purchase: 'Purchase / Checkout Action',
    login: 'Login / Authentication Action',
    submit: 'Form Submission / Deletion',
    form: 'Personal Data Entry',
    navigate: 'External Site Navigation',
    script: 'Run script on this page'
  };

  const title = variantTitles[variant] || 'Confirmation Required';
  const variantClass = String(variant).replace(/[^a-z]/g, '');

  return `
    <div class="approval-card action-confirmation-card variant-${variantClass}">
      <div class="card-header">
        <div class="card-title-group">
          <span class="card-icon">🛡️</span>
          <span class="card-title">${escapeHtml(title)}</span>
        </div>
        <span class="variant-tag tag-${variantClass}">${escapeHtml(variant)}</span>
      </div>

      <div class="card-body">
        <div class="action-summary-box">
          <div class="action-highlight">
            <strong>${escapeHtml(actionSummary)}</strong>
          </div>
          ${confirmRow('Element', elementLabel)}
          ${confirmRow('Link opens', detail && detail.linkHost)}
          ${confirmRow('Form sends to', detail && detail.formActionHost)}
          ${targetDomain ? confirmRow('Target domain', targetDomain) : confirmRow('Page', pageHost)}
        </div>

        ${renderConfirmDetail(detail)}

        <div class="risk-reason-box">
          <span class="reason-label">Risk Policy:</span>
          <span class="reason-text">${escapeHtml(reason)}</span>
        </div>

        ${targetDomain ? `
          <div class="remember-domain-row">
            <label class="checkbox-label" for="chkRememberSite">
              <input type="checkbox" id="chkRememberSite">
              <span>Remember <strong>${escapeHtml(targetDomain)}</strong> for this task</span>
            </label>
          </div>
        ` : ''}
      </div>

      <div class="card-actions">
        <button type="button" class="btn btn-primary btn-sm btn-confirm-allow">
          Allow Action
        </button>
        <button type="button" class="btn btn-danger btn-sm btn-confirm-deny">
          Deny Action
        </button>
      </div>
    </div>
  `;
}

