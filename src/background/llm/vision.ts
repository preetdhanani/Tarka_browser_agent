
import { baseUrlOf, providerOf } from './settings.ts';
import { Logger } from '../../shared/logger.ts';
import type { LlmSettings } from './types.ts';

export type VisionSupport = 'yes' | 'no' | 'unknown';

const visionCache = new Map<string, VisionSupport>();

export function visionCacheKey(settings: LlmSettings, model = settings.model || ''): string {
  return `${providerOf(settings)}|${baseUrlOf(settings) || 'default'}|${model}`;
}

export function clearVisionCache(): void {
  visionCache.clear();
}

export async function visionSupport(settings: LlmSettings): Promise<VisionSupport> {
  const provider = providerOf(settings);
  if (provider !== 'ollama') return 'unknown';

  const model = settings.model || '';
  if (!model) return 'unknown';
  const key = visionCacheKey(settings, model);
  const cached = visionCache.get(key);
  if (cached) return cached;

  const support = await probeOllamaVision(settings, model);
  visionCache.set(key, support);
  return support;
}

async function probeOllamaVision(settings: LlmSettings, model: string): Promise<VisionSupport> {
  const baseUrl = (baseUrlOf(settings) || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    if (!res.ok) {
      Logger.warn('ApiClients', `[VISION] Ollama /api/show for ${model} returned HTTP ${res.status}`);
      return 'unknown';
    }
    const data: any = await res.json();
    if (!Array.isArray(data?.capabilities)) {
      return 'unknown';
    }
    const support: VisionSupport = data.capabilities.includes('vision') ? 'yes' : 'no';
    Logger.debug('ApiClients', `[VISION] ${model}: ${support} (capabilities: ${data.capabilities.join(', ')})`);
    return support;
  } catch (err: any) {
    Logger.warn('ApiClients', `[VISION] Could not probe ${model}: ${err?.message || String(err)}`);
    return 'unknown';
  }
}
