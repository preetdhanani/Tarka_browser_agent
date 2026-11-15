/**
 * Logger utility for Tarka Agentic Browser Extension
 * Outputs formatted console logs and broadcasts debug messages to Sidepanel UI safely.
 * Persists logs to storage to survive background service worker lifecycle restarts.
 */

import { redactSensitiveData } from '../background/browser/redact.ts';

/** DEBUG is plumbing (ports, keepalive, worker boot): kept, but hidden from the default log view. */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * What a log line is about, for the log view's filters:
 *   agent   the run itself: a task started, finished or failed
 *   llm     one call to the model: what was sent, what came back
 *   tool    one step of the agent: the tool, its arguments and its result
 *   system  everything else (the extension's own machinery)
 */
export type LogKind = 'agent' | 'llm' | 'tool' | 'system';

export interface LogEntry {
  /** Stable id of the entry, so a view can keep its expanded state across re-renders. */
  id?: string;
  timestamp: string;
  level: LogLevel;
  kind?: LogKind;
  module: string;
  message: string;
  /** The structured details as JSON text (the log view shows it as a tree), or null. */
  data: string | null;
}

/** Entries kept in memory and in storage. */
export const MAX_LOG_ENTRIES = 500;

/** The longest string a log's details keep; longer ones are cut with a note, so 500 entries stay small. */
export const MAX_LOG_STRING = 1500;

/** The details with every long string cut, so one page text cannot fill the log store. */
export function boundedLogData(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_LOG_STRING ? `${value.slice(0, MAX_LOG_STRING)}… [${value.length - MAX_LOG_STRING} more characters]` : value;
  }
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => boundedLogData(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = boundedLogData(item, depth + 1);
  return out;
}

/**
 * SEC-11: one redaction path for everything a log text goes through - the entry that is kept and
 * broadcast, and the line the same call prints to the console. A secret that reaches a log call
 * is redacted in both places, or in neither.
 */
function redactedText(message: unknown): string {
  try {
    return String(redactSensitiveData(String(message ?? '')) as string);
  } catch (_) {
    return String(message ?? '');
  }
}

/** The details as they are printed and stored: bounded, then redacted. */
function redactedData(data: unknown): unknown {
  try {
    return redactSensitiveData(boundedLogData(data) as unknown);
  } catch (_) {
    return data;
  }
}

let logSequence = 0;
/** A short id, unique per worker lifetime and across restarts (it carries the time). */
function nextLogId(): string {
  logSequence += 1;
  return `${Date.now().toString(36)}-${logSequence.toString(36)}`;
}

export type LogBroadcastCallback = (entry: LogEntry) => void;

const logsHistory: LogEntry[] = [];
let logBroadcastCallback: LogBroadcastCallback | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistLogsToStorage(): void {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local || typeof chrome.storage.local.set !== 'function') return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      chrome.storage.local.set({ agent_logs_history: logsHistory.slice(-MAX_LOG_ENTRIES) }, () => {
        if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError;
      });
    } catch (_) {}
  }, 100);
}

// Auto-restore persisted logs on cold boot.
//
// This is async, and GET_AGENT_STATE used to answer with getLogsHistory() immediately -
// so a sidepanel resync landing before this restore finished got back an empty array, which
// the panel then trusted and used to overwrite whatever it had already shown. logsRestored
// lets any caller that needs the complete history wait for this to finish first, rather than
// racing it.
// Assigned at once: a Promise executor runs synchronously.
let resolveLogsRestored!: () => void;
const logsRestored = new Promise<void>((resolve) => { resolveLogsRestored = resolve; });

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && typeof chrome.storage.local.get === 'function') {
  try {
    chrome.storage.local.get<{ agent_logs_history?: LogEntry[] }>(['agent_logs_history'], (res) => {
      if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError;
      if (Array.isArray(res?.agent_logs_history) && res.agent_logs_history.length > 0) {
        // Entries carry an id now; an older stored entry without one is matched by time and text.
        const keyOf = (e: LogEntry) => e.id || `${e.timestamp}_${e.message}`;
        const existingKeys = new Set(logsHistory.map(keyOf));
        const toAdd: LogEntry[] = res.agent_logs_history.filter((e) => !existingKeys.has(keyOf(e)));
        logsHistory.unshift(...toAdd);
        if (logsHistory.length > MAX_LOG_ENTRIES) logsHistory.splice(0, logsHistory.length - MAX_LOG_ENTRIES);
      }
      resolveLogsRestored();
    });
  } catch (_) {
    resolveLogsRestored();
  }
} else {
  resolveLogsRestored();
}

export const Logger = {
  setBroadcastCallback(cb: LogBroadcastCallback | null): void {
    logBroadcastCallback = cb;
  },

  getLogsHistory(): LogEntry[] {
    return logsHistory;
  },

  /**
   * Resolves once the cold-boot restore above has completed (or immediately, if
   * chrome.storage was unavailable). Callers that need the COMPLETE history - GET_AGENT_STATE
   * chief among them - must await this before reading getLogsHistory(), or they can return an
   * empty array while the restore is still in flight.
   */
  logsRestored(): Promise<void> {
    return logsRestored;
  },

  clearLogs(): void {
    logsHistory.length = 0;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && typeof chrome.storage.local.remove === 'function') {
      chrome.storage.local.remove(['agent_logs_history'], () => {
        if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError;
      });
    }
  },

  addLog(level: LogLevel, module: string, message: unknown, data: unknown = null, options: { silent?: boolean; kind?: LogKind } = {}): void {
    try {
      // ISO, with the date: a persisted entry is read days later, and a time of day alone
      // ("10:00:00") cannot say which day it was. The side panel prints the stamp as it is, and
      // the restore's dedup key (id, else timestamp and text) only needs it to be stable.
      const timestamp = new Date().toISOString();
      let dataStr: string | null = null;
      if (data) {
        if (typeof data === 'object') {
          try {
            dataStr = JSON.stringify(redactedData(data), null, 2);
          } catch (e) {
            dataStr = String(data);
          }
        } else {
          dataStr = String(redactedData(String(data)));
        }
      }

      const entry: LogEntry = {
        id: nextLogId(),
        timestamp,
        level,
        kind: options.kind ?? 'system',
        module,
        // SEC-11: the message line is redacted like the details, so a token or a key-value pair a
        // page or a provider echoed never reaches the memory store or the persisted one.
        message: redactedText(message),
        data: dataStr
      };

      logsHistory.push(entry);
      if (logsHistory.length > MAX_LOG_ENTRIES) logsHistory.shift();

      persistLogsToStorage();

      if (logBroadcastCallback && !options.silent) {
        logBroadcastCallback(entry);
      }
    } catch (e) {
      // Prevent recursion
    }
  },

  /**
   * One entry about the run: a model call, an agent step, or the task itself. `message` is the
   * plain sentence a person reads ("Clicking ..."), `data` the structured details behind it.
   * The console line is redacted like the stored entry (SEC-11).
   */
  event(kind: Exclude<LogKind, 'system'>, module: string, message: string, data: unknown = null, level: LogLevel = 'INFO'): void {
    this.addLog(level, module, message, data, { kind });
    const line = redactedText(message);
    if (level === 'ERROR') console.error(`[${module}]`, line);
    else if (level === 'WARN') console.warn(`[${module}]`, line);
    else console.info(`[${module}]`, line);
  },

  /** Plumbing: kept for diagnosis, hidden from the default log view. */
  debug(module: string, message: unknown, data: unknown = null): void {
    this.addLog('DEBUG', module, message, data);
    console.debug(`[${module}]`, redactedText(message), redactedData(data) ?? '');
  },

  info(module: string, message: unknown, data: unknown = null): void {
    this.addLog('INFO', module, message, data);
    console.info(`[${module}]`, redactedText(message), redactedData(data) ?? '');
  },

  warn(module: string, message: unknown, data: unknown = null): void {
    this.addLog('WARN', module, message, data);
    console.warn(`[${module}]`, redactedText(message), redactedData(data) ?? '');
  },

  /**
   * `error` is whatever a catch clause gave: an Error, a string or anything else. An Error
   * contributes its message and stack, a string only itself. The console line carries the
   * redacted message, not the raw error object (SEC-11); the stack is kept in the entry.
   */
  error(module: string, message: unknown, error: unknown = null): void {
    const err = error as { message?: unknown; stack?: unknown } | null | undefined;
    const errDetails = err?.message || error || '';
    this.addLog('ERROR', module, `${message} ${errDetails}`, err?.stack || null);
    console.error(`[${module}] ${redactedText(message)}`, errDetails ? redactedText(errDetails) : '');
  },

  /** debug() that never invokes the broadcast callback (see warnSilent for why). */
  debugSilent(module: string, message: unknown, data: unknown = null): void {
    this.addLog('DEBUG', module, message, data, { silent: true });
    console.debug(`[${module}]`, redactedText(message), redactedData(data) ?? '');
  },

  /**
   * Identical to warn(), except it never invokes the broadcast callback.
   * Use this for any log call made FROM WITHIN the broadcast callback's own call chain
   * (e.g. background.ts's broadcastToSession() diagnosing that it has zero listeners) -
   * routing that through the normal warn()/addLog() broadcast path calls the same
   * broadcast function again, recursively, since the caller's own de-duplication guard
   * cannot take effect until AFTER this call returns. Still persisted to logsHistory and
   * storage, so it still shows up once the panel reconnects - it just can't be pushed
   * live to a channel that, by definition, has nobody listening on it right now anyway.
   */
  warnSilent(module: string, message: unknown, data: unknown = null): void {
    this.addLog('WARN', module, message, data, { silent: true });
    console.warn(`[${module}]`, redactedText(message), redactedData(data) ?? '');
  }
};
