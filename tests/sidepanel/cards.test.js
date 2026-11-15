import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  renderActionConfirmationCard
} from '../../sidepanel/cards.js';
import fs from 'node:fs';

const CSS = fs.readFileSync(new URL('../../sidepanel/sidepanel.css', import.meta.url), 'utf8');

function ruleEnd(selector) {
  const start = CSS.indexOf(`${selector} {`);
  const end = CSS.indexOf('}', CSS.indexOf('{', start));
  return end < 0 ? -1 : end + 1;
}

function confirmationCardStyles() {
  const start = CSS.indexOf('.action-confirmation-card {');
  const end = ruleEnd('.confirm-code-note');
  return start < 0 || end < start ? '' : CSS.slice(start, end);
}

test('cards: escapeHtml escapes dangerous characters', () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml('foo & bar \'baz\''), 'foo &amp; bar &#39;baz&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('cards: renderActionConfirmationCard renders variants and details', () => {
  assert.equal(renderActionConfirmationCard(null), '');

  // A card without a target origin offers no remember checkbox: there is nothing the engine could
  // remember, so the checkbox would do nothing.
  const confirmPurchase = {
    variant: 'purchase',
    actionSummary: 'Click "Place Order"',
    elementLabel: 'Place Order',
    pageUrl: 'https://shop.test/checkout',
    reason: 'Purchase action detected.',
  };

  const htmlPurchase = renderActionConfirmationCard(confirmPurchase);
  assert.ok(htmlPurchase.includes('Purchase / Checkout Action'), 'Should render purchase title');
  assert.ok(htmlPurchase.includes('tag-purchase'), 'Should render purchase tag');
  assert.ok(htmlPurchase.includes('Place Order'), 'Should render element label');
  assert.ok(!htmlPurchase.includes('chkRememberSite'), 'No remember checkbox on a hold without a target origin');
  assert.ok(htmlPurchase.includes('shop.test'), 'Should still show the page host');
  assert.ok(htmlPurchase.includes('btn-confirm-allow'), 'Should render allow button');
  assert.ok(htmlPurchase.includes('btn-confirm-deny'), 'Should render deny button');

  // The engine remembers a card's targetOrigin (CONTRACT-REMEMBER), so every card that carries
  // one offers the checkbox: ticking it skips the later cards for this origin in this run.
  const confirmPurchaseOrigin = {
    variant: 'purchase',
    actionSummary: 'Click "Place Order"',
    elementLabel: 'Place Order',
    pageUrl: 'https://shop.test/checkout',
    targetOrigin: 'https://shop.test',
    reason: 'Purchase action detected.',
  };
  const htmlPurchaseOrigin = renderActionConfirmationCard(confirmPurchaseOrigin);
  assert.ok(htmlPurchaseOrigin.includes('chkRememberSite'), 'A card with a targetOrigin offers the remember checkbox');
  assert.ok(htmlPurchaseOrigin.includes('Remember <strong>shop.test</strong> for this task'), 'The checkbox names the domain that would be remembered');
  assert.ok(!/<input type="checkbox" id="chkRememberSite" checked>/.test(htmlPurchaseOrigin), 'The remember checkbox is not pre-ticked: remembering an origin must be an explicit tick, or one unnoticed approval silences every later card on that origin');

  const confirmNav = {
    variant: 'navigate',
    actionSummary: 'Navigate to external website',
    pageUrl: 'https://external-auth.com/login',
    reason: 'Navigating to domain outside approved list.',
    targetOrigin: 'https://external-auth.com',
  };

  const htmlNav = renderActionConfirmationCard(confirmNav);
  assert.ok(htmlNav.includes('External Site Navigation'), 'Should render navigate title');
  assert.ok(htmlNav.includes('external-auth.com'), 'Should display target domain');
  assert.ok(htmlNav.includes('chkRememberSite'), 'A navigate hold with a targetOrigin keeps the remember checkbox');
});

// safety/confirm-card-blind-approval: the card shows what the user approves.

test('cards: an execute_js card shows the full code, escaped, in a scrollable monospace block under its own title', () => {
  const code = `document.querySelector('form').innerHTML = "<img src=x onerror=alert(1)>"; return '</pre><b>x</b>' && 1 < 2;`;
  const html = renderActionConfirmationCard({
    variant: 'script',
    actionSummary: 'Run JavaScript on this page',
    pageUrl: 'https://shop.test/items',
    reason: 'Executing arbitrary JavaScript code on the page.',
    detail: { verb: 'execute_js', code, codeLength: code.length },
  });
  assert.ok(html.includes('Run script on this page'), 'own title');
  assert.ok(!html.includes('Personal Data Entry'), 'not the form title');
  assert.ok(html.includes('<pre class="confirm-code"><code>'), 'code block');
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  assert.ok(html.includes(escaped), 'the whole code, escaped');
  assert.ok(!html.includes('<img src=x'), 'no raw markup from the code');
  assert.ok(!html.includes('</pre><b>'), 'the code cannot close its block');
  assert.ok(!html.includes('chkRememberSite'), 'no remember checkbox: it would do nothing for a script');
  assert.ok(!html.includes('confirm-code-note'), 'no cut note when the whole code is shown');
});

test('cards: code over the cap says how much is not shown', () => {
  const code = 'x'.repeat(2000);
  const html = renderActionConfirmationCard({
    variant: 'script',
    actionSummary: 'Run JavaScript on this page',
    detail: { verb: 'execute_js', code, codeLength: 2600 },
  });
  assert.ok(html.includes('confirm-code-note'), 'a visible note');
  assert.match(html, /first 2000 of 2600 characters/);
});

test('cards: a type card shows the full typed text, the element label, and where a link or form goes', () => {
  const text = 'Max Mustermann, Hauptstrasse 12, 10115 Berlin <b>not bold</b> and a long tail to pass 20 chars';
  const html = renderActionConfirmationCard({
    variant: 'form',
    actionSummary: 'Type into "Address"',
    elementLabel: 'Address',
    pageUrl: 'https://shop.test/account',
    reason: 'Typing personal data into an address input field.',
    detail: { verb: 'type', typedText: text, formActionHost: 'forms.other-site.test' },
  });
  assert.ok(html.includes(text.replace(/</g, '&lt;').replace(/>/g, '&gt;')), 'the full typed text, escaped');
  assert.ok(!html.includes('<b>not bold</b>'), 'typed text is not markup');
  assert.ok(html.includes('Address'), 'element label');
  assert.ok(html.includes('forms.other-site.test'), 'form action host');

  const link = renderActionConfirmationCard({
    variant: 'purchase',
    actionSummary: 'Click "Buy now"',
    elementLabel: 'Buy now',
    pageUrl: 'https://shop.test/items/42',
    detail: { verb: 'click', linkHost: 'pay.other.test' },
  });
  assert.ok(link.includes('pay.other.test'), 'link host');
});

test('cards: a batch card lists its steps, escaped', () => {
  const html = renderActionConfirmationCard({
    variant: 'submit',
    actionSummary: 'Batch (2 steps)',
    detail: { verb: 'browser_batch', steps: ['Type "<i>hi</i>" into "Comment"', 'Click "Post"'] },
  });
  assert.ok(html.includes('Click &quot;Post&quot;'));
  assert.ok(html.includes('&lt;i&gt;hi&lt;/i&gt;'));
  assert.ok(!html.includes('<i>hi</i>'));
});

test('cards: the confirm detail styles use theme tokens only, and long code scrolls inside its box', () => {
  const block = confirmationCardStyles();
  assert.ok(block, 'the confirm detail rules exist');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsl/i.test(block), 'no fixed colour: both themes get every colour');
  for (const variable of [...new Set([...block.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]))].filter((n) => !n.startsWith('--font'))) {
    assert.ok(CSS.split(`${variable}:`).length - 1 >= 3, `${variable} is defined in all three theme blocks`);
  }
  const codeStart = block.indexOf('.confirm-code {');
  const code = block.slice(codeStart, block.indexOf('}', codeStart));
  assert.match(code, /overflow:\s*auto;/);
  assert.match(code, /max-height:/);
  assert.match(code, /white-space:\s*pre;/);
  assert.match(code, /font-family:\s*var\(--font-mono\)/);

  // Every class the new markup uses has a rule.
  const html = [
    renderActionConfirmationCard({ variant: 'script', actionSummary: 's', pageUrl: 'https://a.test/', detail: { verb: 'execute_js', code: 'x', codeLength: 3000 } }),
    renderActionConfirmationCard({ variant: 'form', actionSummary: 's', elementLabel: 'E', detail: { verb: 'type', typedText: 't', linkHost: 'l.test', formActionHost: 'f.test' } }),
    renderActionConfirmationCard({ variant: 'submit', actionSummary: 's', detail: { verb: 'browser_batch', steps: ['a'] } }),
  ].join('');
  const classes = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  for (const name of classes) {
    // Buttons are styled elsewhere; a variant or tag without its own rule keeps the base card and tag look.
    if (/^(btn|btn-[a-z-]+|variant-[a-z]+|tag-[a-z]+)$/.test(name)) continue;
    assert.ok(CSS.includes(`.${name}`), `.${name} has no rule`);
  }
});

test('cards: the confirmation card variants and tag badges use theme tokens, never literal colours', () => {
  const block = confirmationCardStyles();
  assert.ok(block, 'the confirm card family rules exist');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsl/i.test(block), `no fixed colour anywhere in the family: ${block.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsl\([^)]*\)/gi)}`);
  // Every token the family uses is defined in all three theme blocks (light, system dark, forced dark).
  for (const variable of [...new Set([...block.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]))].filter((n) => !n.startsWith('--font'))) {
    assert.ok(CSS.split(`${variable}:`).length - 1 >= 3, `${variable} is defined in all three theme blocks`);
  }
  // The variants the card really renders keep their own edge colours.
  for (const variant of ['purchase', 'navigate', 'script']) {
    assert.match(CSS, new RegExp(`\\.action-confirmation-card\\.variant-${variant}[^{]*\\{[^}]*border-left-color:\\s*var\\(--[a-z-]+\\)`), variant);
  }
});
