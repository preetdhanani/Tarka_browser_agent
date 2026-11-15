// src/background/browser/contentFiles.ts
// Constant lists of content script files injected into pages.

export const ISOLATED_CONTENT_FILES = [
  'content/domCompressor.js',
  'content/actionExecutor.js',
  'content/content.js',
] as const;

// Isolated-world script injected into EVERY frame: the frame agent reads, masks and scrolls
// one embedded frame for the background (it does nothing in the top frame).
// See src/content/frameAgent.ts.
export const ALL_FRAMES_ISOLATED_FILES = [
  'content/frameAgent.js',
] as const;

// The frame agent: reads, masks and scrolls one embedded frame for the background (it does
// nothing in the top frame). See src/content/frameAgent.ts.
export const FRAME_AGENT_FILE = 'content/frameAgent.js';

// Backwards-compatible alias
export const CONTENT_SCRIPT_FILES = ISOLATED_CONTENT_FILES;
