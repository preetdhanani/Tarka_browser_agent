
export const CANCELLED_MESSAGE = 'LLM request cancelled (task stopped or paused).';
export const CANCELLED_BEFORE_DISPATCH_MESSAGE = 'LLM request cancelled before dispatch (task stopped or paused).';

export class ProviderTimeoutError extends Error {
  readonly provider: string;
  readonly timeoutMs: number;

  constructor(provider: string, timeoutMs: number, source?: string) {
    const from = source ? ` (${source})` : '';
    super(`Provider [${provider}] did not respond within ${Math.round(timeoutMs / 1000)}s${from}. The request was abandoned - check that the provider is reachable, or raise llmTimeoutMs in settings.`);
    this.name = 'ProviderTimeoutError';
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

export type UserAbortReason = DOMException & { tarka: 'user'; reason: string };

export function userAbortReason(why: string): UserAbortReason {
  return Object.assign(new DOMException(`The task was ${why}.`, 'AbortError'), { tarka: 'user' as const, reason: why });
}

export function isUserAbort(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  return (signal.reason as { tarka?: unknown } | null | undefined)?.tarka === 'user';
}

function stepAbortError(signal: AbortSignal, beforeDispatch: boolean): Error {
  if (isUserAbort(signal)) return new Error(beforeDispatch ? CANCELLED_BEFORE_DISPATCH_MESSAGE : CANCELLED_MESSAGE);
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

export interface DeadlineOptions {
  provider: string;
  timeoutMs: number;
  signal?: AbortSignal | null;
  source?: string;
}

export async function withDeadline<T>({ provider, timeoutMs, signal, source }: DeadlineOptions, run: (callSignal: AbortSignal) => Promise<T>): Promise<T> {
  const stepSignal = signal ?? undefined;
  if (stepSignal?.aborted) throw stepAbortError(stepSignal, true);

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ProviderTimeoutError(provider, timeoutMs, source)), timeoutMs);
  const callSignal = stepSignal ? AbortSignal.any([stepSignal, deadline.signal]) : deadline.signal;

  const abortError = (): Error | null => {
    if (stepSignal?.aborted) return stepAbortError(stepSignal, false);
    if (deadline.signal.aborted) return deadline.signal.reason as ProviderTimeoutError;
    return null;
  };

  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(callSignal.reason);
    callSignal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([run(callSignal), stopped]);
  } catch (error) {
    throw abortError() ?? error;
  } finally {
    clearTimeout(timer);
    if (onAbort) callSignal.removeEventListener('abort', onAbort);
  }
}
