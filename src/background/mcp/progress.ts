
export const REPEAT_HINT_PREFIX = 'Hint (repeated step):';

export const STALL_AT = 8;

export const STALL_TEXT = `You have taken ${STALL_AT} steps without new data or a finished plan step. Say in reason what you are looking for and whether the tools can show it. Then save what you have with save_data, mark finished plan steps with update_plan, take a different approach, or finish with outcome partial and say what is missing.`;

export const STALL_END_TEXT = `STALLED: ${STALL_AT * 2} steps in a row brought no new data and finished no plan step. Call finish now with what you have (save nothing more), with outcome partial, and say what is missing and why.`;

export const STALL_FALLBACK_TEXT = `The run stopped: it made no progress for ${STALL_AT * 2} steps in a row.`;

export interface StepContext {
  planFirst?: boolean;
  url?: string;
  taskProgress?: boolean;
  neutral?: boolean;
}

export const REFLECTION_TEXT = 'Your last steps changed nothing on the page: say what failed, then choose a different approach (another tool, keyboard, research) or finish with what you know and the exact next steps for the user.';

export const REFLECTION_WINDOW = 6;
export const REFLECTION_THRESHOLD = 4;
export const REPEAT_AT = 2;
export const COORDINATE_GRID = 24;

const READ_TOOLS = new Set(['read_page', 'get_page_elements', 'find', 'take_screenshot', 'web_search', 'fetch_url']);

const NOT_COUNTED = new Set(['update_plan', 'save_data', 'finish']);

const QUIET_OBSERVATION = /(^|\n)Observation: nothing in view changed/;
const DID_NOT_MOVE = /^Did not move:/;
const SAME_NOTE = /^(Same picture as your last screenshot\.|Same text as your last read\.)/m;

function normalizedElementId(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

function normalizedValue(key: string, value: unknown): unknown {
  if ((key === 'x' || key === 'y') && Number.isFinite(Number(value)) && value !== null && value !== '') {
    return Math.round(Number(value) / COORDINATE_GRID);
  }
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v));
  return value;
}

export function stepKey(tool: string, args: Record<string, any> | null | undefined): string {
  const source = args && typeof args === 'object' ? args : {};
  const parts: string[] = [];
  for (const key of Object.keys(source).sort()) {
    if (key === 'reason') continue;
    if (key === 'element_id') {
      const id = normalizedElementId(source[key]);
      if (id !== undefined) parts.push(`element_id=${id}`);
      continue;
    }
    const value = normalizedValue(key, source[key]);
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${JSON.stringify(value)}`);
  }
  return `${tool}(${parts.join(',')})`;
}

type Verdict = 'progress' | 'none' | 'pending';

export function actionChangedNothing(tool: string, result: string): boolean {
  const text = String(result || '');
  if ((tool === 'scroll' || tool === 'go_back' || tool === 'go_forward') && DID_NOT_MOVE.test(text)) return true;
  return QUIET_OBSERVATION.test(text);
}

export function repeatHint(tool: string, times: number): string {
  const head = `${REPEAT_HINT_PREFIX} you ran this same ${tool} ${times} times and it changed nothing.`;
  switch (tool) {
    case 'click':
      return `${head} Do not click it again. If it is a code editor or text area: click inside it once, then press_key select_all, then type without element_id. Otherwise check the target with find or read_page, or use the keyboard (press_key).`;
    case 'scroll':
      return `${head} The page or panel did not move. Pass the element_id of the panel you want to move, or its x and y from a screenshot, or click inside the panel and press_key PageDown.`;
    case 'read_page':
    case 'get_page_elements':
    case 'find':
      return `${head} You got the same text again. Read another part with read_page {part}, read one element with element_id, or search the page with find.`;
    case 'web_search':
      return `${head} Search with other words, or read one of the results with fetch_url.`;
    case 'fetch_url':
      return `${head} You got the same text again. Read another part with part, look for lines with query, or fetch another address.`;
    case 'take_screenshot':
      return `${head} The picture did not change. Act on the page or read it instead of taking another screenshot.`;
    case 'type':
      return `${head} Click into the field first and type without element_id, or press_key select_all before you type.`;
    case 'wait':
      return `${head} Waiting did not change the page. Act on it, or finish with what you know.`;
    default:
      return `${head} Do not repeat it: choose another tool or another approach.`;
  }
}

export interface ProgressNote {
  hint: string | null;
  reflect: boolean;
  stall: 0 | 1 | 2;
  noProgressInWindow: number;
  repeats: number;
}

interface StepEntry {
  tool: string;
  key: string;
  result: string;
  verdict: Verdict;
}

export class ProgressTracker {
  private steps: StepEntry[] = [];
  private noProgressByKey = new Map<string, number>();
  private lastReflectionAt = Number.NEGATIVE_INFINITY;
  private sinceProgress = 0;
  private stalls = 0;
  private readPlaces = new Set<string>();

  reset(): void {
    this.steps = [];
    this.noProgressByKey.clear();
    this.lastReflectionAt = Number.NEGATIVE_INFINITY;
    this.sinceProgress = 0;
    this.stalls = 0;
    this.readPlaces.clear();
  }

  get stepsSinceProgress(): number {
    return this.sinceProgress;
  }

  private movedTask(tool: string, args: Record<string, any>, text: string, verdict: Verdict, ctx: StepContext): boolean {
    if (ctx.taskProgress) return true;
    if (NOT_COUNTED.has(tool)) return false;
    if (/^Error:/.test(text) || /^Refused:/.test(text)) return false;
    if (tool === 'navigate' || tool === 'go_back' || tool === 'go_forward') return verdict !== 'none';
    if (!READ_TOOLS.has(tool)) return tool !== 'wait' && verdict === 'progress';
    const place = (key: string) => {
      if (this.readPlaces.has(key)) return false;
      this.readPlaces.add(key);
      return true;
    };
    if (tool === 'read_page' && normalizedElementId(args.element_id) === undefined) {
      return place(`page ${ctx.url || ''} part ${Number(args.part) || 1}`);
    }
    if (tool === 'web_search') return place(`search ${normalizedValue('query', args.query)}`);
    if (tool === 'fetch_url') return place(`fetch ${String(args.url || '')} part ${Number(args.part) || 1} ${normalizedValue('query', args.query) || ''}`);
    return false;
  }

  private stallOf(tool: string, args: Record<string, any>, text: string, verdict: Verdict, ctx: StepContext): 0 | 1 | 2 {
    if (ctx.neutral) return 0;
    if (this.movedTask(tool, args, text, verdict, ctx)) {
      this.sinceProgress = 0;
      this.stalls = 0;
      return 0;
    }
    this.sinceProgress += 1;
    if (this.sinceProgress < STALL_AT) return 0;
    this.sinceProgress = 0;
    this.stalls += 1;
    return this.stalls >= 2 ? 2 : 1;
  }

  get count(): number {
    return this.steps.length;
  }

  record(tool: string, args: Record<string, any> | null | undefined, result: string, ctx: StepContext = {}): ProgressNote {
    const nothing: ProgressNote = { hint: null, reflect: false, stall: 0, noProgressInWindow: this.noProgressInWindow(), repeats: 0 };
    if (ctx.planFirst) return nothing;
    if (NOT_COUNTED.has(tool)) {
      if (tool === 'finish') return nothing;
      return { ...nothing, stall: this.stallOf(tool, args || {}, String(result || ''), 'none', ctx) };
    }
    const key = stepKey(tool, args);
    const text = String(result || '');
    const verdict = this.verdictOf(tool, key, text);
    const stall = this.stallOf(tool, args || {}, text, verdict, ctx);

    const previous = this.steps[this.steps.length - 1];
    if (previous && previous.verdict === 'pending') {
      const unchangedRead = READ_TOOLS.has(tool) && verdict === 'none';
      previous.verdict = unchangedRead ? 'none' : 'progress';
      if (unchangedRead) this.bump(previous.key);
    }

    this.steps.push({ tool, key, result: text, verdict });
    let repeats = 0;
    if (verdict === 'none') repeats = this.bump(key);

    const inWindow = this.noProgressInWindow();
    const byIdentity = READ_TOOLS.has(tool) || /^Error:/.test(text);
    const times = byIdentity ? repeats + 1 : repeats;
    const hint = verdict === 'none' && times >= REPEAT_AT ? repeatHint(tool, times) : null;
    const reflect = inWindow >= REFLECTION_THRESHOLD && this.steps.length - this.lastReflectionAt >= REFLECTION_WINDOW;
    if (reflect) this.lastReflectionAt = this.steps.length;
    return { hint, reflect, stall, noProgressInWindow: inWindow, repeats };
  }

  private bump(key: string): number {
    const n = (this.noProgressByKey.get(key) || 0) + 1;
    this.noProgressByKey.set(key, n);
    return n;
  }

  private noProgressInWindow(): number {
    return this.steps.slice(-REFLECTION_WINDOW).filter((s) => s.verdict === 'none').length;
  }

  private verdictOf(tool: string, key: string, text: string): Verdict {
    if (tool === 'wait') return 'pending';
    if (READ_TOOLS.has(tool)) {
      if (SAME_NOTE.test(text)) return 'none';
      const earlier = [...this.steps].reverse().find((s) => s.key === key);
      return earlier && earlier.result === text ? 'none' : 'progress';
    }
    if (actionChangedNothing(tool, text)) return 'none';
    if (/^Error:/.test(text)) {
      const earlier = [...this.steps].reverse().find((s) => s.key === key);
      if (earlier && earlier.result === text) return 'none';
    }
    return 'progress';
  }
}
