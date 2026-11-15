const GEMINI_STREAM_CUT = /^\[GoogleGenerativeAI Error\]: (?:Error reading from the stream|Request aborted when reading from the stream|Failed to parse stream)$/;

export function isGeminiStreamCut(reason: unknown): boolean {
  return reason instanceof Error && GEMINI_STREAM_CUT.test(reason.message);
}
