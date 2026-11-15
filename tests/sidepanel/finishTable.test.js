/**
 * CONTRACT-TABLE, panel side: the finish tool's `table` is { columns: string[], rows: string[][] },
 * and the panel renders it as a real table with the header row built from `columns`.
 *
 * What these tests hold on to:
 *   1. A finish card renders the table: one <th> per column, one <tr> per row, every cell escaped.
 *   2. The partial card (a run that ended before it finished) renders the table too.
 *   3. The old fallback is gone: table rows are never fed into the provenance findings renderer,
 *      and cards.js no longer ships that renderer at all.
 *   4. A table that is not the agreed shape (or is absent) renders nothing, and never breaks the card.
 *
 * sidepanel.js is a browser module that touches window and document once at load, so a small stub
 * is enough to import it and call the pure string builders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => null };

const { buildTurns, renderFinishCard } = await import('../../sidepanel/sidepanel.js');
const cards = await import('../../sidepanel/cards.js');

const TABLE = {
  columns: ['Site', 'Price', 'Shipping'],
  rows: [
    ['frame.work', '1.599 EUR', 'free'],
    ['notebooks.test', '1.499 EUR', '9,90 EUR']
  ]
};

/** A run whose finish (or partial end) carries the given table. */
function historyWith(table, partial = false) {
  const rows = [
    { type: 'user_goal', turn: 1, prompt: 'Compare the prices', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'read_page_text' }, rawResponse: '{}' },
    { type: 'execution_result', step: 1, success: true, message: 'ok' }
  ];
  rows.push(partial
    ? { type: 'partial_result', answer: 'Two of three sites read.', table, reason: 'stopped_early' }
    : { type: 'finish', answer: 'Here is the comparison.', outcome: 'done', table });
  return rows;
}

function cardOf(table, partial = false) {
  const turns = buildTurns(historyWith(table, partial));
  return renderFinishCard(turns[turns.length - 1]);
}

test('the finish card renders the table as a real table, header from columns', () => {
  const card = cardOf(TABLE);
  assert.match(card, /<div class="md-table-wrap"[^>]*><table class="md-table">/, 'a real table in the scroll wrapper');
  assert.match(card, /<thead><tr><th scope="col">Site<\/th><th scope="col">Price<\/th><th scope="col">Shipping<\/th><\/tr><\/thead>/);
  assert.match(card, /<tbody><tr><td>frame\.work<\/td><td>1\.599 EUR<\/td><td>free<\/td><\/tr><tr><td>notebooks\.test<\/td><td>1\.499 EUR<\/td><td>9,90 EUR<\/td><\/tr><\/tbody>/);
  assert.equal(card.split('<tr>').length - 1, 3, 'one header row and one row per rows entry, nothing else');
});

test('every table cell is escaped, whatever the model put in it', () => {
  const card = cardOf({
    columns: ['Field', '<b>Value</b>'],
    rows: [['<img src=x onerror=alert(1)>', 'a & b']]
  });
  assert.doesNotMatch(card, /<img/);
  assert.doesNotMatch(card, /<b>Value</);
  assert.match(card, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(card, /&lt;b&gt;Value&lt;\/b&gt;/);
  assert.match(card, /a &amp; b/);
});

test('the partial card renders the table too', () => {
  const card = cardOf(TABLE, true);
  assert.match(card, /finish-card partial/);
  assert.match(card, /<th scope="col">Site<\/th>/);
  assert.match(card, /<td>1\.599 EUR<\/td>/);
});

test('the old findings fallback is gone from the markup', () => {
  const card = cardOf(TABLE);
  assert.doesNotMatch(card, /provenance-findings-container|findings-table|btn-copy-findings-table|quality-badge/);
  // A turn whose history row still carries a findings array from an older build renders nothing for it.
  const turns = buildTurns(historyWith(null));
  turns[turns.length - 1].findings = [{ id: 'f1', value: 'stale' }];
  const stale = renderFinishCard(turns[turns.length - 1]);
  assert.doesNotMatch(stale, /provenance|findings/i, 'no findings renderer output for a stale row');
});

test('a table that is not the agreed shape renders nothing, and the card stands', () => {
  for (const bad of [null, undefined, {}, { columns: [], rows: [] }, { columns: ['A'], rows: [] }, { columns: 'A', rows: [['a']] }, 'no table at all']) {
    const card = cardOf(bad);
    assert.doesNotMatch(card, /<table/, JSON.stringify(bad) || String(bad));
    assert.match(card, /finish-card/, 'the card itself still renders');
    assert.match(card, /Here is the comparison\./);
  }
});

test('rows shorter or longer than the header still render, missing cells stay empty', () => {
  const card = cardOf({ columns: ['A', 'B', 'C'], rows: [['one'], ['x', 'y', 'z', 'extra']] });
  assert.match(card, /<tr><td>one<\/td><td><\/td><td><\/td><\/tr>/, 'a short row is padded with empty cells');
  assert.match(card, /<tr><td>x<\/td><td>y<\/td><td>z<\/td><\/tr>/, 'a long row is cut at the column count');
});

test('cards.js no longer ships the provenance findings renderer', () => {
  assert.equal(cards.renderProvenanceFindingsTable, undefined, 'the renderer is deleted, not merely unused');
});
