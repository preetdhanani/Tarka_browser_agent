

(function init() {
  console.log('[Tarka Agent] Content script active.');


  if (window.__tarka_listener_registered) {
    return;
  }
  window.__tarka_listener_registered = true;


  const reportContentError = (source, err) => {
    try {
      chrome.runtime.sendMessage({
        action: 'CLIENT_ERROR',
        payload: {
          source: `content:${source}`,
          message: (err && err.message) || String(err),
          stack: (err && err.stack) || null
        }
      });
    } catch (_) {
      // Extension context may already be invalidated (e.g. page navigating away) - ignore.
    }
  };


  const OWN_SCRIPT = /chrome-extension:\/\//;
  window.addEventListener('error', (event) => {
    const stack = (event.error && event.error.stack) || '';
    if (!OWN_SCRIPT.test(String(event.filename || '')) && !OWN_SCRIPT.test(stack)) return;
    reportContentError(window.location.href, event.error || event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const stack = (event.reason && event.reason.stack) || '';
    if (!OWN_SCRIPT.test(stack)) return;
    reportContentError(window.location.href, event.reason);
  });


  window.__tarka_mutations = 0;
  window.__tarka_last_mutation = Date.now();
  try {
    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      const observer = new MutationObserver(() => {
        window.__tarka_mutations = (window.__tarka_mutations || 0) + 1;
        window.__tarka_last_mutation = Date.now();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    }
  } catch (_) {}

  function describeElement(el) {
    if (!el || el.nodeType !== 1) return 'unknown';
    let desc = el.tagName.toLowerCase();
    if (el.id) desc += `#${el.id}`;
    else if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) desc += `.${cls}`;
    }


    const text = (typeof el.innerText === 'string' ? el.innerText : (el.textContent || '')).trim().replace(/\s+/g, ' ').slice(0, 30);
    if (text) desc += ` "${text}"`;
    return desc;
  }


  function deepElementFromPoint(x, y) {
    if (typeof document.elementFromPoint !== 'function') return null;
    let hit = document.elementFromPoint(x, y);
    for (let depth = 0; hit && hit.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function' && depth < 32; depth++) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  function isAcceptedHit(target, hit) {
    if (!hit || !target) return false;
    if (hit === target) return true;
    if (typeof target.contains === 'function' && target.contains(hit)) return true;
    if (typeof hit.contains === 'function' && hit.contains(target)) return true;
    if (hit.shadowRoot && typeof hit.shadowRoot.contains === 'function' && hit.shadowRoot.contains(target)) return true;
    if (composedContains(hit, target) || composedContains(target, hit)) return true;
    if (hit.tagName === 'IFRAME') return true;


    const interactiveSel = 'a, button, [role="button"], [role="link"], label, select, input, textarea, summary';
    if (typeof target.closest === 'function' && typeof hit.closest === 'function') {
      const targetParent = target.closest(interactiveSel);
      const hitParent = hit.closest(interactiveSel);
      if (targetParent && hitParent && (targetParent === hitParent || targetParent.contains(hitParent) || hitParent.contains(targetParent))) {
        return true;
      }
    }


    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const style = window.getComputedStyle(hit);
        if (style && style.pointerEvents === 'none') {
          return true;
        }
      } catch (_) {}
    }

    return false;
  }


  function composedContains(outer, inner) {
    for (let node = inner, depth = 0; node && depth < 4096; depth++) {
      if (node === outer) return true;
      const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
      node = node.parentNode || (root && root.host) || null;
    }
    return false;
  }

  function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
    }
    return h.toString(16);
  }


  const LAYOUT_GRID_PX = 4;


  function layoutParts(nodes) {
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const grid = (v) => Math.round(v / LAYOUT_GRID_PX);
    const out = [];
    for (let i = 0; i < nodes.length && out.length < 300; i++) {
      const el = nodes[i];
      if (typeof el.getBoundingClientRect !== 'function') continue;
      let r;
      try { r = el.getBoundingClientRect(); } catch (_) { continue; }
      if (!r || r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
      const tag = String(el.tagName || '').toLowerCase();
      const role = (typeof el.getAttribute === 'function' && el.getAttribute('role')) || tag;
      out.push(`${tag}:${role}:${grid(r.left)},${grid(r.top)},${grid(r.width)},${grid(r.height)}`);
    }
    return out;
  }

  function getLightPageSignature(wordsToLookFor) {
    const pageText = window.domCompressor ? window.domCompressor.extractPageText() : (document.body ? document.body.innerText : '');
    const normText = (pageText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    const textHash = hashString(normText);

    const interactiveSel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';
    const nodes = document.querySelectorAll(interactiveSel);
    const parts = [];
    let count = 0;

    for (let i = 0; i < nodes.length && count < 150; i++) {
      const el = nodes[i];
      if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      count++;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || tag;
      const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || '').slice(0, 40).trim();
      parts.push(`${tag}:${role}:${label}`);
    }

    const interactiveHash = hashString(parts.join(';'));


    const layoutHash = hashString(layoutParts(nodes).join(';'));
    const priceRegex = /[€$£¥₹]\s?\d|\d\s?(?:[€$£¥₹]|EUR\b|USD\b|GBP\b)/gi;
    const priceMatches = (pageText || '').match(priceRegex);
    const priceHits = priceMatches ? priceMatches.length : 0;

    let visibleWords = [];
    if (Array.isArray(wordsToLookFor) && wordsToLookFor.length > 0) {
      const lower = (pageText || '').toLowerCase();
      visibleWords = wordsToLookFor.filter(w => typeof w === 'string' && lower.includes(w.toLowerCase()));
    }

    return {
      url: window.location.href,
      title: document.title,
      elementCount: count,
      interactiveHash,
      textHash,
      layoutHash,
      scrollY: Math.round(window.scrollY || 0),
      priceHits,
      visibleWords
    };
  }


  const DIFF_MAX_CHARS = 400;
  const LINE_MAX_CHARS = 200;
  const MAX_TEXT_NODES = 6000;
  const MAX_LINES = 800;


  function deepActiveElement() {
    let el = document.activeElement;
    for (let depth = 0; el && el.shadowRoot && el.shadowRoot.activeElement && depth < 32; depth++) el = el.shadowRoot.activeElement;
    return el && el !== document.body && el !== document.documentElement ? el : null;
  }

  const NOT_TEXT_INPUTS = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'];


  function computeFieldKindOf(el) {
    if (!el) return undefined;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return undefined;
    const lowerType = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
    const attr = (name) => String((el.getAttribute && el.getAttribute(name)) || '').toLowerCase();
    const combined = `${attr('name')} ${String(el.id || '').toLowerCase()} ${attr('autocomplete')}`;
    if (lowerType === 'password' || combined.includes('password') || combined.includes('passwort')) return 'password';


    if (/(?:e-?mail|mail)[-_ ]?(?:code|otp|token)/i.test(combined)) return 'otp';
    if (lowerType === 'email' || combined.includes('email') || combined.includes('e-mail')) return 'email';
    if (/card|cc-number|cvv|cvc|cardnumber|kreditkarte/i.test(combined) || (lowerType === 'tel' && combined.includes('cc'))) return 'cc';


    if (/(?:postal|zip|post|area|country|currency|sort|qr|bar|promo|coupon|voucher|discount)[-_ ]?code/i.test(combined)) {

    } else if (
      /otp|2fa|mfa/i.test(combined) ||
      /(?:^|[^a-z0-9])tan(?:[^a-z0-9]|$)/i.test(combined) ||
      /one[-_ ]?time|verification|authenticator/i.test(combined) ||
      /(?:verification|verify|confirm(?:ation)?|security|auth|login|signin|sms|mobile|phone|pass)[-_ ]?code/i.test(combined) ||
      /(?:csrf|auth|access|session|bearer|refresh)[-_ ]?tokens?/i.test(combined) ||
      /(?:^|[^a-z0-9])tokens?(?:[^a-z0-9]|$)/i.test(combined) ||
      /(?:^|[^a-z0-9])code(?:[^a-z0-9]|$)/i.test(combined)
    ) return 'otp';
    if (lowerType === 'search' || /search|suche|query/i.test(combined)) return 'search';
    if (/address|street|city|zip|postal|postcode|plz|strasse|(?:^|[^a-z0-9])(?:wohn|geburts|arbeits)?orts?(?:[^a-z0-9]|$)/i.test(combined)) return 'address';
    return 'text';
  }


  const MASKED_FIELD_KINDS = ['password', 'cc', 'otp'];


  function isMaskedField(el) {
    const kind = computeFieldKindOf(el);
    return kind !== undefined && MASKED_FIELD_KINDS.includes(kind);
  }


  const REDACTED_MARKER = '[REDACTED: populated]';


  function isSubmitControlOf(el) {
    if (!el || typeof el.closest !== 'function' || !el.closest('form')) return false;
    const tag = String(el.tagName || '').toLowerCase();
    const type = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
    if (tag === 'button') return type === '' || type === 'submit';
    return tag === 'input' && (type === 'submit' || type === 'image');
  }


  function formTargetOf(el) {
    const form = el && typeof el.closest === 'function' ? el.closest('form') : null;
    if (!form) return {};
    const out = {};
    const attr = (node, name) => String((node && node.getAttribute && node.getAttribute(name)) || '').trim();
    const action = attr(el, 'formaction') || attr(form, 'action');
    if (action) {
      try {
        const base = new URL(window.location.href);
        const url = new URL(action, base);
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.toLowerCase() !== base.hostname.toLowerCase()) {
          out.formActionHost = url.hostname.toLowerCase();
        }
      } catch (_) {

      }
    }
    const method = (attr(el, 'formmethod') || attr(form, 'method')).toLowerCase();
    if (method === 'get') out.formMethod = 'get';
    return out;
  }


  function formHasMaskedFieldOf(el) {
    const form = el && typeof el.closest === 'function' ? el.closest('form') : null;
    if (!form || typeof form.querySelectorAll !== 'function') return false;
    let fields;
    try { fields = form.querySelectorAll('input, textarea'); } catch (_) { return false; }
    for (const field of Array.from(fields || [])) {
      if (isMaskedField(field)) return true;
    }
    return false;
  }


  function submitControlPressable(control) {
    if (control.disabled) return false;
    try {
      if (typeof control.closest === 'function' && control.closest('fieldset[disabled]')) return false;
    } catch (_) {}
    return true;
  }


  function submitControlLabel(control) {
    const tag = String(control.tagName || '').toLowerCase();
    const attr = (name) => String((control.getAttribute && control.getAttribute(name)) || '').trim();
    const text = tag === 'input'
      ? attr('alt') || String(control.value == null ? '' : control.value)
      : String((typeof control.innerText === 'string' ? control.innerText : (control.textContent || '')) || '');
    return (attr('aria-label') || text).replace(/\s+/g, ' ').trim().slice(0, 60);
  }


  function formSubmitLabelOf(el) {
    const form = el && typeof el.closest === 'function' ? el.closest('form') : null;
    if (!form || typeof form.querySelectorAll !== 'function') return '';
    let controls;
    try { controls = form.querySelectorAll('button, input'); } catch (_) { return ''; }
    for (const control of Array.from(controls || [])) {
      if (!isSubmitControlOf(control)) continue;
      return submitControlPressable(control) ? submitControlLabel(control) : '';
    }
    return '';
  }


  function securityFactsOf(el) {
    const tag = el && el.tagName ? String(el.tagName).toLowerCase() : '';
    const type = tag === 'input' ? String((el.getAttribute && el.getAttribute('type')) || el.type || '') : '';
    return {
      tag,
      type,
      fieldKind: computeFieldKindOf(el),
      isSubmitControl: isSubmitControlOf(el),
      formTarget: formTargetOf(el),
      formHasMaskedField: formHasMaskedFieldOf(el),
      formSubmitLabel: formSubmitLabelOf(el),
      label: el ? labelOfElement(el) : '',
      text: el ? String((typeof el.innerText === 'string' ? el.innerText : (el.textContent || '')) || '').trim().replace(/\s+/g, ' ').slice(0, 60) : '',
    };
  }


  function isEditableElement(el) {
    if (!el) return false;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') return null;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (el.tagName === 'INPUT') return !el.disabled && !el.readOnly && !NOT_TEXT_INPUTS.includes(String(el.type || 'text').toLowerCase());
    return !!el.isContentEditable;
  }


  function editingHost(el) {
    let host = el;
    while (host && host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
    return host;
  }


  function fieldTextOf(el) {
    if (!el) return null;
    if (isMaskedField(el)) {
      const filled = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
        ? String(el.value == null ? '' : el.value).length > 0
        : String(typeof el.innerText === 'string' ? el.innerText : (el.textContent || '')).trim().length > 0;
      return filled ? REDACTED_MARKER : null;
    }
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value == null ? '' : el.value);
    const cm = typeof el.closest === 'function' ? el.closest('.cm-content') : null;
    const host = cm || (el.isContentEditable ? editingHost(el) : null);
    if (!host) return null;
    return String(typeof host.innerText === 'string' ? host.innerText : (host.textContent || ''));
  }


  function labelOfElement(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();
    let name = el.getAttribute('aria-label') || '';
    if (!name) {
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      name = ids.map((id) => { const n = document.getElementById(id); return n ? (n.innerText || n.textContent || '') : ''; }).join(' ');
    }
    if (!name && el.labels && el.labels[0]) name = el.labels[0].innerText || el.labels[0].textContent || '';
    if (!name) name = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    name = String(name).replace(/\s+/g, ' ').trim().slice(0, 60);
    const role = el.getAttribute('role')
      || (tag === 'textarea' || (tag === 'input' && isEditableElement(el)) || el.isContentEditable ? 'textbox' : tag === 'a' ? 'link' : tag);
    return name ? `${role} "${name}"` : describeElement(el);
  }


  function caretLineOf(el) {
    if (!el) return null;
    if (isMaskedField(el)) return null;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const value = String(el.value == null ? '' : el.value);
      let pos = value.length;
      try { if (typeof el.selectionStart === 'number') pos = el.selectionStart; } catch (_) {}
      const start = value.lastIndexOf('\n', pos - 1) + 1;
      let end = value.indexOf('\n', pos);
      if (end < 0) end = value.length;
      return value.slice(start, end).slice(0, LINE_MAX_CHARS);
    }
    if (!el.isContentEditable) return null;
    const root = typeof el.getRootNode === 'function' ? el.getRootNode() : document;
    const sel = root && typeof root.getSelection === 'function' ? root.getSelection() : window.getSelection();
    if (!sel || !sel.anchorNode) return null;
    const host = editingHost(el);
    const anchor = sel.anchorNode;
    const anchorEl = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    const line = anchorEl && typeof anchorEl.closest === 'function' ? anchorEl.closest('.cm-line, [data-line], p, li, div, pre') : null;
    if (line && line !== host && host.contains(line)) {
      return String(line.innerText || line.textContent || '').replace(/\n+$/, '').slice(0, LINE_MAX_CHARS);
    }

    if (anchor.nodeType === 3) {
      const value = String(anchor.nodeValue || '');
      const pos = Math.min(sel.anchorOffset || 0, value.length);
      const start = value.lastIndexOf('\n', pos - 1) + 1;
      let end = value.indexOf('\n', pos);
      if (end < 0) end = value.length;
      return value.slice(start, end).slice(0, LINE_MAX_CHARS);
    }
    const all = String(host.innerText || host.textContent || '');
    return all.split('\n')[0].slice(0, LINE_MAX_CHARS);
  }


  function scrollContainerOf(el) {
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 64; depth++) {
      if (node === document.body || node === document.documentElement) return null;
      try {
        const style = window.getComputedStyle(node);
        const scrolls = /(auto|scroll|overlay)/.test(style.overflowY) || /(auto|scroll|overlay)/.test(style.overflowX);
        if (scrolls && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)) return node;
      } catch (_) {}
      const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
      node = node.parentElement || (root && root.host) || null;
    }
    return null;
  }


  function visibleTextLines() {
    const lines = [];
    if (!document.body || typeof document.createTreeWalker !== 'function') return lines;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const shown = new Map();
    const range = typeof document.createRange === 'function' ? document.createRange() : null;
    const walker = document.createTreeWalker(document.body, 4 );
    let count = 0;
    let node;
    while ((node = walker.nextNode()) && count < MAX_TEXT_NODES && lines.length < MAX_LINES) {
      count++;
      const text = node.nodeValue;
      if (!text || !text.trim()) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      let visible = shown.get(parent);
      if (visible === undefined) {
        const tag = parent.tagName;
        visible = tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'NOSCRIPT' && tag !== 'TEMPLATE'
          && !(typeof parent.closest === 'function' && parent.closest('[class*="tarka"], [id^="tarka"]'));
        if (visible) {
          try {
            const style = window.getComputedStyle(parent);
            visible = style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
          } catch (_) {}
        }
        shown.set(parent, visible);
      }
      if (!visible) continue;
      let rect = null;
      try {
        if (range) { range.selectNodeContents(node); rect = range.getBoundingClientRect(); } else rect = parent.getBoundingClientRect();
      } catch (_) { rect = null; }
      if (!rect || rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= vh || rect.left >= vw) continue;
      for (const part of text.split('\n')) {
        const line = part.replace(/\s+/g, ' ').trim();
        if (line) lines.push(line.slice(0, LINE_MAX_CHARS));
      }
    }
    return lines;
  }


  function measurePageState() {
    const focused = deepActiveElement();
    const editable = isEditableElement(focused);
    const centre = deepElementFromPoint(Math.round((window.innerWidth || 0) / 2), Math.round((window.innerHeight || 0) / 2));
    const container = scrollContainerOf(focused || centre);
    const lines = visibleTextLines();
    const fieldText = editable === false ? null : fieldTextOf(focused);
    return {
      url: window.location.href,
      focusEl: focused,
      focus: focused ? {
        label: labelOfElement(focused),
        editable: editable === null ? null : !!editable,
        fieldKind: computeFieldKindOf(focused),
        caretLine: editable ? caretLineOf(focused) : null,
        text: fieldText === null ? null : fieldText.slice(0, 2000)
      } : null,
      scroll: { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) },
      container,
      containerTop: container ? Math.round(container.scrollTop) : 0,
      lines,
      textHash: hashString(lines.join('\n'))
    };
  }


  function lineDiff(before, after) {
    const left = new Map();
    for (const line of before) left.set(line, (left.get(line) || 0) + 1);
    const added = [];
    for (const line of after) {
      const n = left.get(line) || 0;
      if (n > 0) left.set(line, n - 1);
      else added.push(line);
    }
    const removed = [];
    for (const line of before) {
      const n = left.get(line) || 0;
      if (n > 0) { removed.push(line); left.set(line, n - 1); }
    }
    return { added, removed };
  }

  function joinCut(lines, max) {
    if (max <= 0 || !lines.length) return '';
    const text = lines.join(' | ');
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
  }


  function effectDetail(baseState, baseUrl) {
    const now = measurePageState();
    const has = !!baseState;
    const focusChanged = has ? baseState.focusEl !== now.focusEl : null;
    const scrollChanged = has ? (baseState.scroll.x !== now.scroll.x || baseState.scroll.y !== now.scroll.y) : null;
    let container = null;
    if (has && baseState.container && baseState.container.isConnected) {
      const top = Math.round(baseState.container.scrollTop);
      container = { label: labelOfElement(baseState.container), top, moved: top - baseState.containerTop };
    } else if (now.container) {
      container = { label: labelOfElement(now.container), top: now.containerTop, moved: null };
    }
    let added = '';
    let removed = '';
    let changedChars = 0;
    const textChanged = has ? baseState.textHash !== now.textHash : null;
    if (textChanged) {
      const diff = lineDiff(baseState.lines, now.lines);
      changedChars = diff.added.join('').length + diff.removed.join('').length;
      added = joinCut(diff.added, diff.removed.length ? 250 : DIFF_MAX_CHARS);
      removed = joinCut(diff.removed, DIFF_MAX_CHARS - added.length);
    }
    return {
      base: has,
      url: now.url,
      urlChanged: typeof baseUrl === 'string' ? baseUrl !== now.url : null,
      focus: now.focus,
      focusChanged,
      scroll: now.scroll,
      scrollChanged,
      container,
      textHash: now.textHash,
      textChanged,
      added,
      removed,
      changedChars
    };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const { action, payload } = request;

    if (action === 'GET_DOM_SNAPSHOT') {
      try {
        if (!window.domCompressor) {
          return sendResponse({ success: false, error: 'DOMCompressor engine not initialized on page.' });
        }
        if (window.actionExecutor && typeof window.actionExecutor.removeBadges === 'function') {
          window.actionExecutor.removeBadges();
        }
        const effectivePayload = {
          maxElements: (payload && payload.maxElements) ?? request.maxElements,
          showBadges: (payload && payload.showBadges) ?? request.showBadges,
          ...(payload || {})
        };
        const snapshot = window.domCompressor.getSnapshot(effectivePayload);

        if (effectivePayload.showBadges === true && window.actionExecutor) {
          window.actionExecutor.renderBadges(snapshot.elements);
        }
        const elementInfo = window.domCompressor.elementInfo || {};
        sendResponse({ success: true, data: { ...snapshot, elementInfo }, docId: window.domCompressor.docId });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'RESOLVE_ELEMENT_POINT') {
      try {
        if (!window.domCompressor) {
          return sendResponse({ success: false, error: 'DOMCompressor engine not initialized on page.' });
        }
        const resolved = window.domCompressor.resolveElementWithStatus
          ? window.domCompressor.resolveElementWithStatus(payload?.element_id, payload?.docId)
          : { success: !!window.domCompressor.getElement(payload?.element_id), element: window.domCompressor.getElement(payload?.element_id) };

        if (!resolved.success || !resolved.element) {
          return sendResponse({
            success: false,
            stale: resolved.stale || false,
            error: resolved.error || `Element [${payload?.element_id}] not found.`
          });
        }

        const el = resolved.element;
        if (typeof el.scrollIntoView === 'function') {
          try {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          } catch (_) {
            el.scrollIntoView();
          }
        }

        const proceed = () => {
          try {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return sendResponse({ success: false, error: `Element [${payload?.element_id}] has zero size.` });
            }
            const x = Math.round(rect.left + rect.width / 2);
            const y = Math.round(rect.top + rect.height / 2);

            const hit = deepElementFromPoint(x, y);

            if (hit && !isAcceptedHit(el, hit)) {
              const obscuredBy = describeElement(hit);
              return sendResponse({
                success: false,
                obscuredBy,
                error: `Element [${payload?.element_id}] is covered by <${obscuredBy}>.`
              });
            }

            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            const role = typeof el.getAttribute === 'function' ? (el.getAttribute('role') || el.type || undefined) : undefined;
            const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);


            if (window.actionExecutor) {
              if (typeof window.actionExecutor.highlightElement === 'function') {
                window.actionExecutor.highlightElement(el);
              }
              if (typeof window.actionExecutor.animateCursor === 'function') {
                window.actionExecutor.animateCursor(x, y);
              }
            }

            sendResponse({
              success: true,
              point: { x, y },
              tag,
              role,
              text,


              ...securityFactsOf(el)
            });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
        };

        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => requestAnimationFrame(proceed));
        } else {
          setTimeout(proceed, 10);
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'EFFECT_PROBE_BEGIN') {
      let state = null;
      try { state = measurePageState(); } catch (_) { state = null; }
      window.__tarka_probe_baseline = {
        url: window.location.href,
        mutCount: window.__tarka_mutations || 0,
        value: document.activeElement && 'value' in document.activeElement ? String(document.activeElement.value) : '',
        activeTag: document.activeElement && document.activeElement.tagName ? document.activeElement.tagName.toLowerCase() : '',
        activeId: document.activeElement ? (document.activeElement.id || '') : '',
        state
      };


      let focusFacts = null;
      if (state && state.focusEl) {
        try {
          const facts = securityFactsOf(state.focusEl);
          focusFacts = {
            tag: facts.tag,
            inputType: facts.type,
            isSubmitControl: facts.isSubmitControl,
            formHasMaskedField: facts.formHasMaskedField,
            formTarget: facts.formTarget,
            formSubmitLabel: facts.formSubmitLabel
          };
        } catch (_) {
          focusFacts = null;
        }
      }
      sendResponse({
        success: true,
        baseline: {
          url: window.location.href,
          focus: state && state.focus
            ? {
                label: state.focus.label,
                editable: state.focus.editable,
                fieldKind: state.focus.fieldKind,
                ...(focusFacts || {})
              }
            : null
        }
      });
      return true;
    }

    if (action === 'EFFECT_PROBE_END') {
      const base = window.__tarka_probe_baseline;
      let effect = 'none';
      if (!base || window.location.href !== base.url) {
        effect = 'url_changed';
      } else if (document.activeElement && 'value' in document.activeElement && String(document.activeElement.value) !== base.value) {
        effect = 'value_set';
      } else if ((window.__tarka_mutations || 0) > base.mutCount) {
        effect = 'dom_changed';
      } else {
        const curTag = document.activeElement && document.activeElement.tagName ? document.activeElement.tagName.toLowerCase() : '';
        const curId = document.activeElement ? (document.activeElement.id || '') : '';
        if (curTag !== base.activeTag || curId !== base.activeId) {
          effect = 'focus_changed';
        }
      }
      let detail = null;
      try { detail = effectDetail(base && base.state, base && base.url); } catch (_) { detail = null; }
      sendResponse({ success: true, effect, ...(detail ? { detail } : {}) });
      return true;
    }

    if (action === 'WAIT_DOM_QUIET') {
      const quietMs = (payload && payload.quietMs) || request.quietMs || 100;
      const maxWaitMs = (payload && (payload.maxWaitMs || payload.maxMs)) || request.maxWaitMs || request.maxMs || 500;
      const start = Date.now();

      const checkQuiet = () => {
        const now = Date.now();
        const elapsed = now - start;
        const lastMut = window.__tarka_last_mutation || start;
        if (now - lastMut >= quietMs || elapsed >= maxWaitMs) {
          return sendResponse({ success: true, quiet: true, elapsedMs: elapsed });
        }
        setTimeout(checkQuiet, 30);
      };
      setTimeout(checkQuiet, 30);
      return true;
    }

    if (action === 'SHOW_CLICK_ANIMATION') {
      try {
        const x = payload?.x ?? 0;
        const y = payload?.y ?? 0;
        if (window.actionExecutor && typeof window.actionExecutor.showClickEffect === 'function') {
          window.actionExecutor.showClickEffect(x, y);
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'CLEAR_BADGES') {
      try {
        if (window.actionExecutor && typeof window.actionExecutor.removeBadges === 'function') {
          window.actionExecutor.removeBadges();
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'HIDE_AGENT_UI') {


      try {
        if (!window.actionExecutor || typeof window.actionExecutor.hideAgentUi !== 'function') {
          sendResponse({ success: false, error: 'The page executor is not loaded, so the privacy covers could not be put up.' });
          return true;
        }
        window.actionExecutor.hideAgentUi(request.payload && request.payload.shownFramePaths);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'CHECK_AGENT_UI') {


      try {
        const holds = !!(window.actionExecutor && typeof window.actionExecutor.masksHold === 'function' && window.actionExecutor.masksHold());
        sendResponse({ success: holds });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'SHOW_AGENT_UI') {
      try {
        if (window.actionExecutor && typeof window.actionExecutor.showAgentUi === 'function') {
          window.actionExecutor.showAgentUi();
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'DESCRIBE_POINT') {


      try {
        if (!window.actionExecutor || typeof window.actionExecutor.describePoint !== 'function') {
          return sendResponse({ success: false, error: 'ActionExecutor engine not initialized on page.' });
        }
        let x = Number(payload && payload.x);
        let y = Number(payload && payload.y);


        const snap = payload && payload.snap && typeof window.actionExecutor.snapPoint === 'function'
          ? window.actionExecutor.snapPoint(x, y)
          : null;
        if (snap) {
          x = snap.x;
          y = snap.y;
        }
        const point = window.actionExecutor.describePoint(x, y);
        if (point && point.fieldKind) {
          return sendResponse({
            success: false,
            fieldKind: point.fieldKind,
            what: point.what,
            error: window.actionExecutor.maskedFieldRefusal(point.fieldKind)
          });
        }
        sendResponse({
          success: true,
          what: point && point.what,
          interactive: !!(point && point.interactive),
          ...(point && point.isSubmitControl ? { isSubmitControl: true } : {}),
          ...(point && point.formTarget ? { formTarget: point.formTarget } : {}),
          ...(point && point.formHasMaskedField ? { formHasMaskedField: true } : {}),
          ...(snap ? { snapped: snap } : {})
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'ELEMENT_SECURITY') {


      try {
        if (!window.domCompressor) {
          return sendResponse({ success: false, error: 'DOMCompressor engine not initialized on page.' });
        }
        const resolved = window.domCompressor.resolveElementWithStatus
          ? window.domCompressor.resolveElementWithStatus(payload?.element_id, payload?.docId)
          : { success: !!window.domCompressor.getElement(payload?.element_id), element: window.domCompressor.getElement(payload?.element_id) };
        if (!resolved.success || !resolved.element) {
          return sendResponse({
            success: false,
            stale: resolved.stale || false,
            error: resolved.error || `Element [${payload?.element_id}] not found.`
          });
        }
        const facts = securityFactsOf(resolved.element);
        sendResponse({ success: true, ...facts });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'VERIFY_CLICK_POINT') {


      try {
        const x = Number(payload && payload.x);
        const y = Number(payload && payload.y);
        const hit = deepElementFromPoint(x, y);
        const targetId = payload ? payload.element_id : undefined;
        const target = targetId !== undefined && targetId !== null && window.domCompressor && typeof window.domCompressor.getElement === 'function'
          ? window.domCompressor.getElement(targetId)
          : null;
        const facts = securityFactsOf(hit);
        const askedForElement = targetId !== undefined && targetId !== null;
        let withinTarget = true;
        if (askedForElement && !target) {


          withinTarget = false;
        } else if (target) {
          withinTarget = !!hit && (hit === target
            || (typeof target.contains === 'function' && target.contains(hit))
            || composedContains(target, hit)
            || composedContains(hit, target));
        }
        sendResponse({
          success: true,
          what: describeElement(hit),
          hitTag: facts.tag,
          fieldKind: facts.fieldKind,
          isSubmitControl: facts.isSubmitControl,
          formTarget: facts.formTarget,
          formHasMaskedField: facts.formHasMaskedField,
          formSubmitLabel: facts.formSubmitLabel,
          withinTarget,
          ...(askedForElement && !target ? { targetGone: true } : {})
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'GET_PAGE_SIG') {
      try {
        const sig = getLightPageSignature(payload?.words);
        sendResponse({ success: true, data: sig });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'EXECUTE_ACTION') {
      try {
        if (!window.actionExecutor) {
          return sendResponse({ success: false, error: 'ActionExecutor engine not initialized on page.' });
        }

        window.actionExecutor.execute(payload)
          .then((res) => sendResponse(res))
          .catch((err) => sendResponse({ success: false, error: err.message }));
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }
  });
})();
