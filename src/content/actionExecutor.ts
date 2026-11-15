
import { renderBadges, removeBadges, type BadgeElementItem } from './badges.ts';
import {
  ensureCursorOverlay,
  animateCursor,
  showClickEffect,
  highlightElement
} from './cursor.ts';
import { maskSensitiveFields, masksStillHold, removeSensitiveMasks, describePoint, snapPoint, maskedFieldRefusal, type PointDescription, type PointSnap } from './screenshotPrivacy.ts';
import { resolveElement, resolveElementDetailed } from './resolve.ts';
import { framePathKeyOf, shownFrames } from './frameIds.ts';
import {
  describeElement,
  setFieldValue,
  doClick,
  doType,
  execute,
  type ActionExecutionContext
} from './actions.ts';

export class ActionExecutor implements ActionExecutionContext {
  badgeContainer: HTMLElement | null;
  cursorContainer: HTMLElement | null;
  cursorEl: HTMLElement | null;
  cursorFadeTimer: ReturnType<typeof setTimeout> | null;
  hiddenUi = new Map<HTMLElement, string>();
  doc?: Document;
  win?: Window & typeof globalThis;

  constructor(doc?: Document, win?: Window & typeof globalThis) {
    this.badgeContainer = null;
    this.cursorContainer = null;
    this.cursorEl = null;
    this.cursorFadeTimer = null;
    this.doc = doc;
    this.win = win;
  }

  private getDoc(): Document {
    return this.doc || (typeof document !== 'undefined' ? document : (null as unknown as Document));
  }

  private getWin(): (Window & typeof globalThis) | undefined {
    return this.win || (typeof window !== 'undefined' ? window : undefined);
  }

  renderBadges(elements: BadgeElementItem[]): void {
    this.badgeContainer = renderBadges(elements, this.getDoc(), this.getWin());
  }

  removeBadges(): void {
    removeBadges(this.badgeContainer, this.getDoc());
    this.badgeContainer = null;
  }

  ensureCursorOverlay(): void {
    const state = ensureCursorOverlay(this.cursorContainer, this.cursorEl, this.getDoc());
    this.cursorContainer = state.container;
    this.cursorEl = state.pointer;
  }

  animateCursor(x: number, y: number): void {
    this.ensureCursorOverlay();
    animateCursor(
      x,
      y,
      this.cursorEl,
      () => this.cursorFadeTimer,
      (t) => {
        this.cursorFadeTimer = t;
      }
    );
  }

  showClickEffect(x: number, y: number): void {
    this.ensureCursorOverlay();
    this.animateCursor(x, y);
    showClickEffect(x, y, this.cursorContainer, this.cursorEl, this.getDoc());
  }

  highlightElement(el: HTMLElement | null): void {
    highlightElement(el);
  }

  hideAgentUi(shownFramePaths: unknown = []): void {
    const doc = this.getDoc();
    if (!doc || !doc.getElementById) return;
    const containers = ['tarka-badge-container', 'tarka-cursor-container'];
    for (const id of containers) {
      const el = doc.getElementById(id);
      if (!el || !el.style) continue;
      if (!this.hiddenUi.has(el)) this.hiddenUi.set(el, el.style.visibility);
      el.style.visibility = 'hidden';
    }
    maskSensitiveFields(doc, this.getWin(), shownFrames(shownFramePaths));
  }

  masksHold(): boolean {
    return masksStillHold(this.getDoc() as Document);
  }

  framePathOf(frame: HTMLIFrameElement): string | null {
    return framePathKeyOf(frame);
  }

  showAgentUi(): void {
    for (const [el, visibility] of this.hiddenUi) {
      if (el && el.style) el.style.visibility = visibility;
    }
    this.hiddenUi.clear();
    removeSensitiveMasks(this.getDoc());
  }

  describePoint(x: number, y: number): PointDescription {
    return describePoint(this.getDoc(), x, y);
  }

  snapPoint(x: number, y: number): PointSnap | null {
    return snapPoint(this.getDoc(), x, y);
  }

  maskedFieldRefusal(kind: string): string {
    return maskedFieldRefusal(kind);
  }

  resolveElement(elementId: number | string): Element | null {
    return resolveElement(elementId, this.getDoc(), this.getWin());
  }

  resolveElementDetailed(elementId: number | string): { element: Element | null; recoveredBy?: 'stable-id' } {
    return resolveElementDetailed(elementId, this.getDoc(), this.getWin());
  }

  describeElement(el: Element | null): string {
    return describeElement(el);
  }

  setFieldValue(el: Element, text: unknown): { success: boolean; error?: string } {
    return setFieldValue(el, text);
  }

  doClick(elementId: number | string): any {
    return doClick(elementId, this, this.getWin());
  }

  doType(elementId: number | string, text: unknown, submit: unknown = false): any {
    return doType(elementId, text, submit, this);
  }

  execute(actionPayload: any): Promise<any> {
    return execute(actionPayload, this, this.getDoc(), this.getWin());
  }
}
