import { Storage, type SavedSession } from '../../shared/storage.ts';
import { Logger } from '../../shared/logger.ts';

export const CHAT_SAVE_THROTTLE_MS = 3000;

export const CHAT_MAX_CHARS = 300_000;

export class ChatSaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: (() => SavedSession | null) | null = null;
  private write: (chat: SavedSession) => Promise<void>;

  constructor(write?: (chat: SavedSession) => Promise<void>) {
    this.write = write ?? ((chat) => Storage.saveChat(chat));
  }

  save(build: () => SavedSession | null, now = false): void {
    this.pending = build;
    if (now) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => { void this.flush(); }, CHAT_SAVE_THROTTLE_MS);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const build = this.pending;
    this.pending = null;
    if (!build) return;
    const chat = build();
    if (!chat) return;
    try {
      await this.write(chat);
    } catch (err) {
      Logger.warn('AgentRunner', `[CHAT_SAVE] Could not save the chat to Recent tasks: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
