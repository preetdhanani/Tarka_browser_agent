
export interface StorageSessionArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface RunnerMeta {
  stateVersion: number;
  tarkaGroupIds: [windowId: number, groupId: number][];
  aliases: number[];
  pauseDetach: { tabIds: number[]; at: number } | null;
  lastBeatAt: number;
  evidence?: any;
}

export class SessionRunnerMeta {
  private threadId: string;
  private area: StorageSessionArea;
  private pendingWrite: ReturnType<typeof setTimeout> | null = null;
  private pendingMeta: RunnerMeta | null = null;
  private lastWrittenAt = 0;

  constructor(threadId: string, area?: StorageSessionArea) {
    this.threadId = threadId;
    this.area = area ?? (typeof chrome !== 'undefined' && chrome.storage?.session
      ? chrome.storage.session
      : {
          async get() { return {}; },
          async set() {},
          async remove() {},
        });
  }

  private storageKey(): string {
    return `sf:meta:${this.threadId}`;
  }

  async read(): Promise<RunnerMeta | null> {
    try {
      const data = await this.area.get(this.storageKey());
      const raw = data[this.storageKey()];
      if (raw && typeof raw === 'object') {
        return raw as RunnerMeta;
      }
    } catch {
    }
    return null;
  }

  async writeImmediate(meta: RunnerMeta): Promise<void> {
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = null;
    }
    this.lastWrittenAt = Date.now();
    try {
      await this.area.set({ [this.storageKey()]: meta });
    } catch {
    }
  }

  scheduleWrite(meta: RunnerMeta): void {
    const now = Date.now();
    const elapsed = now - this.lastWrittenAt;
    if (elapsed >= 250) {
      void this.writeImmediate(meta);
      return;
    }

    this.pendingMeta = meta;
    if (!this.pendingWrite) {
      this.pendingWrite = setTimeout(() => {
        this.pendingWrite = null;
        const latest = this.pendingMeta;
        this.pendingMeta = null;
        if (latest) void this.writeImmediate(latest);
      }, 250 - elapsed);
    }
  }

  async clear(): Promise<void> {
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = null;
    }
    this.pendingMeta = null;
    try {
      await this.area.remove(this.storageKey());
    } catch {
    }
  }
}
