import { wrapUntrusted } from '../mcp/untrusted.ts';
import { decodeEntities } from './htmlText.ts';
import { checkWebUrl } from './urlPolicy.ts';
import { fetchCapped, FetchFailure, type FetchDeps } from './fetchText.ts';
import type { ResearchSettings } from '../../shared/storage.ts';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
export const SEARCH_DEFAULT_RESULTS = 6;
export const SEARCH_MAX_RESULTS = 8;

export function resultCount(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (raw === undefined || raw === null || !Number.isFinite(n)) return SEARCH_DEFAULT_RESULTS;
  return Math.min(SEARCH_MAX_RESULTS, Math.max(1, n));
}

function inlineText(html: string): string {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function attr(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
}

export function unwrapDuckDuckGoLink(href: string): string {
  let url: URL;
  try {
    url = new URL(href, 'https://duckduckgo.com');
  } catch {
    return '';
  }
  const target = url.searchParams.get('uddg');
  const real = target !== null && /(^|\.)duckduckgo\.com$/i.test(url.hostname) ? target : url.href;
  try {
    const parsed = new URL(real);
    if (!checkWebUrl(parsed.href).ok) return '';
    return /(^|\.)duckduckgo\.com$/i.test(parsed.hostname) ? '' : parsed.href;
  } catch {
    return '';
  }
}

const DDG_CHALLENGE = /anomaly-modal|anomaly\.js|challenge-form|bots use duckduckgo too|please complete the following challenge|select all squares containing/i;

export function parseDuckDuckGoHtml(html: string): { results: SearchResult[]; challenge: boolean; noResults: boolean } {
  const source = String(html || '');
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const anchors = [...source.matchAll(/<a\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
  anchors.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < anchors.length ? anchors[i + 1].index ?? source.length : source.length;
    const block = source.slice(start, end);
    const url = unwrapDuckDuckGoLink(attr(m[1], 'href'));
    if (!url || !checkWebUrl(url).ok || seen.has(url)) return;
    const snippet = /<(a|div|td|span)\b[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i.exec(block)?.[2] ?? '';
    seen.add(url);
    results.push({ title: inlineText(m[2]) || url, url, snippet: inlineText(snippet) });
  });
  return {
    results,
    challenge: results.length === 0 && DDG_CHALLENGE.test(source),
    noResults: results.length === 0 && /class\s*=\s*["'][^"']*\bno-results\b/i.test(source)
  };
}

export function parseSearxngJson(text: string): SearchResult[] {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FetchFailure('the SearXNG server did not answer with JSON. Turn the JSON format on in its settings.yml (search: formats: [html, json]), or check the URL in Settings > Research.');
  }
  const list = Array.isArray(data?.results) ? data.results : [];
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const url = typeof item?.url === 'string' ? item.url : '';
    if (!url || !checkWebUrl(url).ok || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: inlineText(typeof item.title === 'string' ? item.title : '') || url,
      url,
      snippet: inlineText(typeof item.content === 'string' ? item.content : '')
    });
  }
  return results;
}

export function searxngSearchUrl(base: string, query: string): { url: string } | { error: string } {
  const checked = checkWebUrl(base);
  if (!checked.ok) return { error: `the SearXNG URL in Settings > Research is not usable: ${checked.error}` };
  const url = new URL(checked.url.href);
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/search$/, '')}/search`;
  url.search = '';
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  return { url: url.href };
}

export function formatResults(query: string, backendName: string, results: SearchResult[]): string {
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`);
  const head = `Web search (${backendName}) for "${query}": ${results.length} result${results.length === 1 ? '' : 's'}.`;
  return `${head}\n${wrapUntrusted(`web search results (${backendName})`, lines.join('\n'))}\nThese are search snippets, not the pages: read a page with fetch_url {url} before you rely on what it says.`;
}

export interface WebSearchOutcome {
  text: string;
  isError?: boolean;
  results: SearchResult[];
}

const SET_SEARXNG = 'Do not guess results. Tell the user that web search needs a SearXNG URL in Settings > Research, or read the official site directly with fetch_url.';

export async function webSearch(args: { query?: unknown; max_results?: unknown }, research: ResearchSettings, deps: FetchDeps = {}): Promise<WebSearchOutcome> {
  const query = typeof args?.query === 'string' ? args.query.replace(/\s+/g, ' ').trim() : '';
  if (!query) return { text: 'Error: web_search needs a query: the words to search for.', isError: true, results: [] };
  const count = resultCount(args?.max_results);

  if (research.backend === 'searxng') {
    if (!research.searxngUrl) {
      return { text: 'Error: the search backend in Settings > Research is SearXNG, but no SearXNG URL is set, so nothing was searched. Tell the user to set the URL, or use fetch_url on an address you know.', isError: true, results: [] };
    }
    const target = searxngSearchUrl(research.searxngUrl, query);
    if ('error' in target) return { text: `Error: ${target.error}`, isError: true, results: [] };
    try {
      const res = await fetchCapped(target.url, { ...deps, redirects: 'follow' }, 'application/json');
      if (!res.ok) {
        const hint = res.status === 403 || res.status === 429 ? ' Many SearXNG servers refuse the JSON format or limit requests: check the server in Settings > Research.' : '';
        return { text: `Error: the SearXNG server answered HTTP ${res.status}, so there are no results.${hint}`, isError: true, results: [] };
      }
      const results = parseSearxngJson(res.text).slice(0, count);
      if (!results.length) return { text: `Web search (SearXNG) for "${query}": no results. Try other words.`, results };
      return { text: formatResults(query, 'SearXNG', results), results };
    } catch (err: any) {
      return { text: `Error: ${err instanceof FetchFailure ? err.message : String(err?.message || err)}`, isError: true, results: [] };
    }
  }

  const url = `${DDG_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetchCapped(url, { ...deps, redirects: 'follow' }, 'text/html');
    if (!res.ok) {
      return { text: `Error: DuckDuckGo answered HTTP ${res.status} instead of results (it often does this to automated searches), so there are no results. ${SET_SEARXNG}`, isError: true, results: [] };
    }
    const parsed = parseDuckDuckGoHtml(res.text);
    if (parsed.challenge) {
      return { text: `Error: DuckDuckGo answered with its bot check ("anomaly" page) instead of results, so there are no results. ${SET_SEARXNG}`, isError: true, results: [] };
    }
    if (!parsed.results.length) {
      return parsed.noResults
        ? { text: `Web search (DuckDuckGo) for "${query}": no results. Try other words.`, results: [] }
        : { text: `Error: the DuckDuckGo page had no results that could be read (its layout may have changed). ${SET_SEARXNG}`, isError: true, results: [] };
    }
    const results = parsed.results.slice(0, count);
    return { text: formatResults(query, 'DuckDuckGo', results), results };
  } catch (err: any) {
    return { text: `Error: ${err instanceof FetchFailure ? err.message : String(err?.message || err)} ${SET_SEARXNG}`, isError: true, results: [] };
  }
}
