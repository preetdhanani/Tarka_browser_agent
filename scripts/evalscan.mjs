#!/usr/bin/env node


import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');


export const ALLOWLIST = [];


const BASE64 = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));


function decodeVlq(segment) {
  const numbers = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.get(char);
    if (digit === undefined) throw new Error(`bad character "${char}" in sourcemap mappings`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      numbers.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return numbers;
}


function decodeMappings(mappings) {
  const lines = [];
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  for (const line of mappings.split(';')) {
    const segments = [];
    let column = 0;
    for (const raw of line ? line.split(',') : []) {
      const n = decodeVlq(raw);
      column += n[0];
      if (n.length < 4) continue;
      source += n[1];
      sourceLine += n[2];
      sourceColumn += n[3];
      segments.push([column, source, sourceLine, sourceColumn]);
    }
    lines.push(segments);
  }
  return lines;
}


const TRAILING_MAP_COMMENT = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=/;


export function loadMap(file, code) {
  const lastLine = code.trimEnd().split('\n').pop() ?? '';
  if (TRAILING_MAP_COMMENT.test(lastLine)) {
    throw new Error(`${displayPath(file)} ends in a sourceMappingURL comment, but the build writes hidden sourcemaps. Read its map from ${displayPath(file)}.map only, so fix the build (sourcemap: 'hidden') instead of following the comment.`);
  }
  const mapPath = `${file}.map`;
  if (!fs.existsSync(mapPath)) return null;
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  if (!map.mappings || !Array.isArray(map.sources)) throw new Error(`${path.relative(ROOT, mapPath)}: not a sourcemap with sources and mappings`);
  const dir = path.dirname(mapPath);
  return {
    lines: decodeMappings(map.mappings),
    sources: map.sources.map((s) => (s === null ? null : path.resolve(dir, map.sourceRoot || '', s))),
    contents: map.sourcesContent || []
  };
}


function originalPosition(map, line, column) {
  let found = null;
  for (const segment of map.lines[line] || []) {
    if (segment[0] <= column) {
      found = segment;
    } else {
      found ??= segment;
      break;
    }
  }
  if (!found || map.sources[found[1]] === null) return null;
  const abs = map.sources[found[1]];
  let text = map.contents[found[1]];
  if (typeof text !== 'string') text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  return { file: displayPath(abs), line: found[2] + 1, column: found[3] + 1, text: text.split('\n')[found[2]] ?? '' };
}

function displayPath(abs) {
  const rel = path.relative(ROOT, abs);
  return (rel.startsWith('..') ? abs : rel).split(path.sep).join('/');
}


const DANGEROUS = new Set(['eval', 'Function']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global', 'top', 'parent', 'frames']);
const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const COMPARISONS = new Set(['instanceof', '===', '!==', '==', '!=']);
const FUNCTION_LIKE = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const MODULE_NAMES = new Set(['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'ExportSpecifier', 'ExportNamespaceSpecifier']);


function* walk(root) {
  const stack = [{ node: root, key: null, up: null }];
  while (stack.length) {
    const item = stack.pop();
    yield item;
    for (const key of Object.keys(item.node)) {
      const value = item.node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') stack.push({ node: child, key, up: item });
      } else if (value && typeof value.type === 'string') {
        stack.push({ node: value, key, up: item });
      }
    }
  }
}


function peel(callee) {
  for (;;) {
    if (callee.type === 'ParenthesizedExpression' || callee.type === 'ChainExpression') callee = callee.expression;
    else if (callee.type === 'SequenceExpression') callee = callee.expressions[callee.expressions.length - 1];
    else return callee;
  }
}


function memberName(member) {
  const { property } = member;
  if (!member.computed && property.type === 'Identifier') return property.name;
  if (member.computed && property.type === 'Literal' && typeof property.value === 'string') return property.value;
  return null;
}


function calleeName(callee) {
  const node = peel(callee);
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return memberName(node);
  return null;
}


function onGlobalObject(member) {
  const object = peel(member.object);
  return object.type === 'ThisExpression' || (object.type === 'Identifier' && GLOBAL_OBJECTS.has(object.name));
}


function isNotAReference({ node, key, up }) {
  const parent = up.node;
  const grand = up.up && up.up.node;
  if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return true;
  if (parent.type === 'Property' && key === 'key' && !parent.computed) return true;
  if (['MethodDefinition', 'PropertyDefinition', 'AccessorProperty'].includes(parent.type) && key === 'key' && !parent.computed) return true;
  if (MODULE_NAMES.has(parent.type)) return true;
  if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type) && key === 'label') return true;
  if (parent.type === 'MetaProperty') return true;

  if (parent.type === 'VariableDeclarator' && key === 'id') return true;
  if ((FUNCTION_LIKE.has(parent.type) || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && (key === 'id' || key === 'params')) return true;
  if (parent.type === 'CatchClause' && key === 'param') return true;
  if (parent.type === 'RestElement' || parent.type === 'ArrayPattern' || parent.type === 'ObjectPattern') return true;
  if (parent.type === 'AssignmentPattern' && key === 'left') return true;
  if (parent.type === 'Property' && key === 'value' && grand && grand.type === 'ObjectPattern') return true;
  return false;
}


function isComparison(up) {
  const parent = up.up.node;
  return (parent.type === 'BinaryExpression' && COMPARISONS.has(parent.operator)) || (parent.type === 'UnaryExpression' && parent.operator === 'typeof');
}


function isSafePrototypeMember(item) {
  const proto = item.up;
  if (proto.node.type !== 'MemberExpression' || item.key !== 'object' || memberName(proto.node) !== 'prototype') return false;
  const outer = proto.up;
  if (outer.node.type === 'MemberExpression' && proto.key === 'object') {
    const name = memberName(outer.node);
    return name !== null && name !== 'constructor';
  }
  return isComparison(proto);
}


export function findHits(program) {
  const hits = [];
  const seen = new Set();


  for (const { node } of walk(program)) {
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const name = calleeName(node.callee);
      if (DANGEROUS.has(name)) {
        seen.add(peel(node.callee));
        hits.push({ kind: name === 'eval' ? 'eval(' : node.type === 'NewExpression' ? 'new Function(' : 'Function(', node });
      } else if (node.type === 'CallExpression' && TIMERS.has(name)) {
        const first = node.arguments[0];
        if (first && ((first.type === 'Literal' && typeof first.value === 'string') || first.type === 'TemplateLiteral')) {
          hits.push({ kind: `${name}(string)`, node });
        }
      }
    }
  }


  for (const item of walk(program)) {
    const { node } = item;
    if (seen.has(node) || !item.up) continue;
    if (node.type === 'Identifier' && DANGEROUS.has(node.name)) {
      if (isNotAReference(item)) continue;
      if (isComparison(item)) continue;
      if (node.name === 'Function' && isSafePrototypeMember(item)) continue;
      hits.push({ kind: `${node.name} (used as a value)`, node });
    } else if (node.type === 'MemberExpression' && DANGEROUS.has(memberName(node)) && onGlobalObject(node)) {
      if (isComparison(item)) continue;
      hits.push({ kind: `${memberName(node)} (used as a value, through a global object)`, node });
    }
  }
  return hits;
}


export function classifyHits(hits, list = ALLOWLIST) {
  const used = new Map(list.map((entry) => [entry, 0]));
  const results = hits.map((hit) => {
    const entry = list.find((e) => e.file === hit.file && e.kind === hit.kind && hit.text.includes(e.snippet) && used.get(e) < e.max) ?? null;
    if (entry) used.set(entry, used.get(entry) + 1);
    return { hit, entry };
  });
  return { results, used };
}

function jsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...jsFiles(full));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(full);
  }
  return files.sort();
}

function lineStarts(code) {
  const starts = [0];
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}


function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}


function main() {
  if (!fs.existsSync(DIST)) {
    console.error('evalscan: dist/ not found. Run `npm run build` first.');
    process.exit(1);
  }
  const files = jsFiles(DIST);
  if (files.length === 0) {
    console.error('evalscan: no .js files in dist/. Run `npm run build` first.');
    process.exit(1);
  }

  const hits = [];
  let mapsUsed = 0;
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const shown = displayPath(file);
    const { program, errors } = parseSync(shown, code, { lang: 'js', sourceType: 'unambiguous' });
    if (errors.length) {

      console.error(`evalscan: cannot parse ${shown}: ${errors[0].message}`);
      process.exit(1);
    }
    let map;
    try {
      map = loadMap(file, code);
    } catch (error) {

      console.error(`evalscan: ${error.message}`);
      process.exit(1);
    }
    if (map) mapsUsed++;
    const starts = lineStarts(code);
    for (const { kind, node } of findHits(program)) {
      const line = lineOf(starts, node.start);
      const column = node.start - starts[line];
      const origin = map && originalPosition(map, line, column);
      hits.push({
        kind,
        dist: `${shown}:${line + 1}:${column + 1}`,

        file: origin ? origin.file : shown,
        line: origin ? origin.line : line + 1,
        column: origin ? origin.column : column + 1,
        text: (origin ? origin.text : code.split('\n')[line]).trim()
      });
    }
  }
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column));

  const { results, used } = classifyHits(hits);
  let allowed = 0;
  let denied = 0;
  for (const { hit, entry } of results) {
    const at = `${hit.file}:${hit.line}:${hit.column}`;
    if (entry) {
      allowed++;
      console.log(`allowed      ${at}  ${hit.kind}  (${entry.why})`);
    } else {
      denied++;
      console.log(`NOT ALLOWED  ${at}  ${hit.kind}  ${hit.text.slice(0, 100)}  [${hit.dist}]`);
    }
  }
  for (const [entry, count] of used) {
    if (count === 0) console.log(`note: allowlist entry for ${entry.file} (${entry.snippet}) matched nothing, remove it if the code is gone`);
  }

  console.log(`evalscan: ${files.length} files scanned (${mapsUsed} sourcemaps used), ${hits.length} hit(s): ${allowed} allowed, ${denied} not allowed`);
  process.exitCode = denied ? 1 : 0;
}


if (fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url))) main();
