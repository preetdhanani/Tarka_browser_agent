/**
 * src/shared/textPaging.ts: the text helpers the content script and fetch_url share.
 *
 * Pinned here: the table cells of a page's text survive normalization in their columns. innerText
 * separates cells with a tab, and an empty cell is a real cell - dropping it shifts every column
 * after it, and the model reads a row's values under the wrong headers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePageText } from '../../src/shared/textPaging.ts';

test('normalizePageText keeps an empty table cell as an empty slot, so the columns stay aligned', () => {
  assert.equal(normalizePageText('a\t\tb'), 'a |  | b', 'a\\t\\tb is three cells: a, empty, b');
  assert.equal(normalizePageText('name\t\tempty\tvalue'), 'name |  | empty | value');
  assert.equal(normalizePageText('a\t\tb\t\tc'), 'a |  | b |  | c');
});

test('normalizePageText absorbs the research reader\'s row-start mark, and keeps a real empty first cell', () => {
  // htmlText.ts marks where a cell starts, so its row text begins with one tab that separates
  // nothing; a further leading tab is an empty first cell and stays.
  assert.equal(normalizePageText('\ta\t\tb'), 'a |  | b');
  assert.equal(normalizePageText('\t\tb'), ' | b');
  assert.equal(normalizePageText('\t\t\tb'), ' |  | b');
});

test('normalizePageText still trims each cell and drops a line that has no content at all', () => {
  assert.equal(normalizePageText('  a \t b  '), 'a | b', 'cells are trimmed');
  assert.equal(normalizePageText('\t\t'), '', 'a line of empty cells only is no content');
  assert.equal(normalizePageText(''), '');
  assert.equal(normalizePageText('one\ntwo'), 'one\ntwo', 'plain lines are untouched');
});
