import { DOMCompressor } from './domCompressor.ts';

declare global {
  interface Window {
    DOMCompressor: typeof DOMCompressor;
    domCompressorInstance: DOMCompressor;
    domCompressor: DOMCompressor;
  }
}

if (typeof window !== 'undefined') {
  window.DOMCompressor = window.DOMCompressor || DOMCompressor;
  window.domCompressorInstance = window.domCompressorInstance || new DOMCompressor();
  window.domCompressor = window.domCompressor || window.domCompressorInstance;
}
