import type { StorageSessionArea } from './runnerMeta.ts';
import type { HistoryEntry, RunStats, RunStatus } from '../types.ts';
import { Logger } from '../../shared/logger.ts';

export interface RunSnapshot {
  status: RunStatus;
  task: string;
  history: HistoryEntry[];
  planSteps: Array<{ text: string; status: string }>;
  stepCount: number;
  pauseReason: 'user' | null;
  stateVersion: number;
  lastCall?: { promptTokens: number; outputTokens: number; estimated: boolean } | null;
  runStats?: RunStats | null;
  chatId?: string;
  chatTitle?: string;
  runModel?: { provider: string; model: string } | null;
  records?: Array<Record<string, unknown>>;
  pageUrl?: string;
  savedAt: number;
}

// MV3 workers can stop while idle, and storage.session has a shared 10 MB quota across tabs.
export const RUN_SNAPSHOT_MAX_CHARS = 800_000;

export const RUN_SNAPSHOT_DEBOUNCE_MS = 250;

export const INTERRUPTED_TEXT = 'Chrome restarted Tarka\'s background worker, so the run could not go on. The steps so far are kept; start the task again to continue.';

export const CLOSED_TEXT = 'The run was cut off when the browser or panel closed. The steps so far are kept; resume the task to continue.';

export function withRunData(row: HistoryEntry, data: { records?: Array<Record<string, unknown>>; planSteps?: Array<{ text: string; status: string }>; pageUrl?: string; runStats?: RunStats | null }): HistoryEntry {
  if (row.type !== 'finish' && row.type !== 'partial_result') return row;
  const out: any = { ...row };
  if (data.records && data.records.length) out.records = data.records.slice();
  if (data.runStats) out.runStats = { ...data.runStats };
  if (row.type === 'partial_result') {
    if (data.planSteps && data.planSteps.length) out.plan = data.planSteps.map((s) => ({ text: String(s.text), status: String(s.status) }));
    if (data.pageUrl) out.pageUrl = data.pageUrl;
  }
  return out;
}

function lastClosingIndex(history: HistoryEntry[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]?.type;
    if (t === 'finish' || t === 'partial_result') return i;
  }
  return -1;
}

export function runSnapshotKey(threadId: string | number): string {
  return `sf:run:${threadId}`;
}

function slimRow(row: HistoryEntry, keepRecords = false): HistoryEntry {
  const out: any = { ...row };
  delete out.rawResponse;
  if (!keepRecords) delete out.records;
  if (out.table && Array.isArray(out.table.rows) && out.table.rows.length > 50) {
    out.table = { ...out.table, rows: out.table.rows.slice(0, 50) };
  }
  return out;
}

export function fitSnapshot(snapshot: RunSnapshot, maxChars = RUN_SNAPSHOT_MAX_CHARS): RunSnapshot {
  const closing = lastClosingIndex(snapshot.history);
  let history = snapshot.history.map((row, i) => slimRow(row, i === closing));
  let compacted: HistoryEntry | null = null;
  for (let i = history.length - 1; i >= 0 && !compacted; i--) if (history[i].type === 'chat_compacted') compacted = history[i];
  const keepFrom = (at: number) => {
    const rest = history.slice(at);
    return compacted && !rest.includes(compacted) ? [compacted, ...rest] : rest;
  };
  let fitted = { ...snapshot, history };
  while (JSON.stringify(fitted).length > maxChars) {
    const goals = history.map((row, i) => (row.type === 'user_goal' ? i : -1)).filter((i) => i >= 0);
    const secondGoal = goals.length >= 2 ? goals[1] : -1;
    if (secondGoal <= 0) {
      const next = keepFrom(Math.ceil(history.length / 4));
      if (next.length >= history.length) break;
      history = next;
      if (history.length <= 1) break;
    } else {
      history = keepFrom(secondGoal);
    }
    fitted = { ...snapshot, history };
  }
  return fitted;
}

export function restoredRun(snapshot: RunSnapshot): RunSnapshot {
  if (snapshot.status !== 'running' && snapshot.status !== 'paused') return snapshot;
  const finalRow = withRunData({ type: 'partial_result', answer: INTERRUPTED_TEXT, table: null, reason: 'interrupted' },
    { records: snapshot.records, planSteps: snapshot.planSteps, pageUrl: snapshot.pageUrl, runStats: snapshot.runStats });
  return {
    ...snapshot,
    status: 'stopped',
    pauseReason: null,
    history: [...snapshot.history, finalRow],
    records: [],
    stateVersion: snapshot.stateVersion + 1
  };
}

function isEmpty(snapshot: RunSnapshot): boolean {
  return snapshot.history.length === 0 && !snapshot.task && snapshot.status !== 'running' && snapshot.status !== 'paused';
}

export class RunSnapshotStore {
  private key: string;
  private area: StorageSessionArea | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: RunSnapshot | null = null;

  constructor(threadId: string | number, area?: StorageSessionArea) {
    this.key = runSnapshotKey(threadId);
    this.area = area ?? (typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : null);
  }

  save(snapshot: RunSnapshot, now = false): void {
    this.pending = snapshot;
    if (now) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => { void this.flush(); }, RUN_SNAPSHOT_DEBOUNCE_MS);
  }

  discard(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = this.pending;
    this.pending = null;
    if (!snapshot || !this.area) return;
    try {
      if (isEmpty(snapshot)) {
        await this.area.remove(this.key);
        return;
      }
      await this.area.set({ [this.key]: fitSnapshot(snapshot) });
    } catch (err) {
      try {
        await this.area.set({ [this.key]: fitSnapshot(snapshot, RUN_SNAPSHOT_MAX_CHARS / 2) });
      } catch {
        Logger.warn('AgentRunner', `[RUN_SNAPSHOT] Could not keep the run for a worker restart: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async read(): Promise<RunSnapshot | null> {
    if (!this.area) return null;
    try {
      const data = await this.area.get(this.key);
      const raw = data?.[this.key] as Partial<RunSnapshot> | undefined;
      return raw && typeof raw === 'object' && Array.isArray(raw.history) ? raw as RunSnapshot : null;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    if (!this.area) return;
    await this.area.remove(this.key).catch(() => {});
  }
}
