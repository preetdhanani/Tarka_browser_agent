
import { redactSensitiveData } from '../background/browser/redact.ts';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type LogKind = 'agent' | 'llm' | 'tool' | 'system';

export interface LogEntry {
  id?: string;
  timestamp: string;
  level: LogLevel;
  kind?: LogKind;
  module: string;
  message: string;
  data: string | null;
}

export const MAX_LOG_ENTRIES = 500;

export const MAX_LOG_STRING = 1500;

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

function redactedText(message: unknown): string {
  try {
    return String(redactSensitiveData(String(message ?? '')) as string);
  } catch (_) {
    return String(message ?? '');
  }
}

function redactedData(data: unknown): unknown {
  try {
    return redactSensitiveData(boundedLogData(data) as unknown);
  } catch (_) {
    return data;
  }
}

let logSequence = 0;
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

let resolveLogsRestored!: () => void;
const logsRestored = new Promise<void>((resolve) => { resolveLogsRestored = resolve; });

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && typeof chrome.storage.local.get === 'function') {
  try {
    chrome.storage.local.get<{ agent_logs_history?: LogEntry[] }>(['agent_logs_history'], (res) => {
      if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError;
      if (Array.isArray(res?.agent_logs_history) && res.agent_logs_history.length > 0) {
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
    }
  },

  event(kind: Exclude<LogKind, 'system'>, module: string, message: string, data: unknown = null, level: LogLevel = 'INFO'): void {
    this.addLog(level, module, message, data, { kind });
    const line = redactedText(message);
    if (level === 'ERROR') console.error(`[${module}]`, line);
    else if (level === 'WARN') console.warn(`[${module}]`, line);
    else console.info(`[${module}]`, line);
  },

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

  error(module: string, message: unknown, error: unknown = null): void {
    const err = error as { message?: unknown; stack?: unknown } | null | undefined;
    const errDetails = err?.message || error || '';
    this.addLog('ERROR', module, `${message} ${errDetails}`, err?.stack || null);
    console.error(`[${module}] ${redactedText(message)}`, errDetails ? redactedText(errDetails) : '');
  },

  debugSilent(module: string, message: unknown, data: unknown = null): void {
    this.addLog('DEBUG', module, message, data, { silent: true });
    console.debug(`[${module}]`, redactedText(message), redactedData(data) ?? '');
  },

  warnSilent(module: string, message: unknown, data: unknown = null): void {
    this.addLog('WARN', module, message, data, { silent: true });
    console.warn(`[${module}]`, redactedText(message), redactedData(data) ?? '');
  }
};
