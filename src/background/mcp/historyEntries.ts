
import type { EndReason, HistoryEntry } from '../types.ts';

export interface ToolCallInput {
  name: string;
  args: Record<string, any>;
}

export function mapToolToAction(name: string, args: Record<string, any> | null): Record<string, unknown> | null {
  const a = args || {};
  switch (name) {
    case 'read_page':
      return {
        action: 'read_page',
        ...(Number.isInteger(a.part) && a.part > 1 ? { part: a.part } : {}),
        ...(a.element_id !== undefined && a.element_id !== null ? { element_id: a.element_id } : {})
      };
    case 'get_page_elements':
      return { action: 'get_page_elements' };
    case 'find':
      return { action: 'find_elements', query: a.query };
    case 'click':
      return a.x !== undefined && a.y !== undefined
        ? { action: 'click', x: a.x, y: a.y }
        : { action: 'click', element_id: a.element_id };
    case 'take_screenshot':
      return { action: 'take_screenshot' };
    case 'type':
      return a.element_id !== undefined && a.element_id !== null
        ? { action: 'type', element_id: a.element_id, text: a.text, ...(a.mode === 'append' ? { mode: 'append' } : {}) }
        : { action: 'type', text: a.text, ...(a.mode === 'append' ? { mode: 'append' } : {}) };
    case 'press_key':
      return Array.isArray(a.modifiers) && a.modifiers.length
        ? { action: 'press_key', key: a.key, modifiers: a.modifiers }
        : { action: 'press_key', key: a.key };
    case 'scroll':
      return a.element_id !== undefined && a.element_id !== null
        ? { action: 'scroll', direction: a.direction, element_id: a.element_id }
        : a.x !== undefined && a.y !== undefined
          ? { action: 'scroll', direction: a.direction, x: a.x, y: a.y }
          : { action: 'scroll', direction: a.direction };
    case 'navigate':
      return { action: 'navigate', url: a.url };
    case 'web_search':
      return { action: 'web_search', query: a.query };
    case 'fetch_url':
      return {
        action: 'fetch_url',
        url: a.url,
        ...(Number.isInteger(a.part) && a.part > 1 ? { part: a.part } : {}),
        ...(typeof a.query === 'string' && a.query.trim() ? { query: a.query } : {})
      };
    case 'wait':
      return { action: 'wait', amount: a.amount };
    case 'go_back':
      return { action: 'go_back' };
    case 'go_forward':
      return { action: 'go_forward' };
    case 'update_plan':
      return null;
    case 'save_data':
      return { action: 'save_data', count: Array.isArray(a.records) ? a.records.length : 0 };
    case 'finish':
      return { action: 'finish' };
    default:
      return { action: name };
  }
}

const RESULT_SUMMARY_MAX = 200;

export function summarizeToolResult(text: string): string {
  const t = String(text || '');
  return t.length <= RESULT_SUMMARY_MAX ? t : `${t.slice(0, RESULT_SUMMARY_MAX - 1)}…`;
}

export function userGoalEntry(turn: number, prompt: string): HistoryEntry {
  return { type: 'user_goal', turn, prompt, timestamp: new Date().toLocaleTimeString(), isNewRun: true };
}

export function agentResponseEntry(
  step: number,
  thought: string,
  action: Record<string, unknown> | null,
  rawResponse: string
): HistoryEntry {
  return { type: 'agent_response', step, thought, action, rawResponse };
}

export function executionResultEntry(step: number, success: boolean, message: string, table?: any, label?: string): HistoryEntry {
  const entry: any = success
    ? { type: 'execution_result', step, success: true, message }
    : { type: 'execution_result', step, success: false, error: message };
  if (table) entry.table = table;
  if (label) entry.label = label;
  return entry;
}

export function elementRowLabel(line: string): string {
  const text = String(line || '');
  const labelled = /\blabel="([^"]+)"/.exec(text)?.[1];
  if (labelled) return labelled.trim();
  return (/"([^"]+)"/.exec(text.replace(/^\s*\[\d+\]\s*/, ''))?.[1] || '').trim();
}

export function screenshotResultEntry(
  step: number,
  success: boolean,
  message: string,
  image?: { imageId: string; imageWidth: number; imageHeight: number }
): HistoryEntry {
  const base = executionResultEntry(step, success, message);
  if (!image) return base;
  return { ...base, imageId: image.imageId, imageWidth: image.imageWidth, imageHeight: image.imageHeight } as HistoryEntry;
}

export function errorEntry(content: string): HistoryEntry {
  return { type: 'error', content };
}

export const STOPPED_TEXT = 'The run was stopped before it finished.';

export function partialResultEntry(answer: string, reason: EndReason): HistoryEntry {
  return { type: 'partial_result', answer, table: null, reason };
}

export type FinishOutcome = 'done' | 'partial' | 'blocked';
export const FINISH_OUTCOMES: readonly FinishOutcome[] = ['done', 'partial', 'blocked'];

export function finishOutcomeOf(value: unknown): FinishOutcome | undefined {
  return (FINISH_OUTCOMES as readonly unknown[]).includes(value) ? (value as FinishOutcome) : undefined;
}

export interface FinishFile {
  name: string;
  mime: string;
  content: string;
}

export function finishEntry(answer: string, evidence = '', table?: any, outcome?: FinishOutcome, files?: FinishFile[]): HistoryEntry {
  const entry: any = evidence ? { type: 'finish', answer, evidence } : { type: 'finish', answer };
  if (table) entry.table = table;
  if (outcome) entry.outcome = outcome;
  if (files && files.length) entry.files = files.map((f) => ({ name: f.name, mime: f.mime, content: f.content }));
  return entry;
}
