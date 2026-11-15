
import { providerOf } from './settings.ts';
import type { LlmSettings } from './types.ts';

export type CoordinateSpace = 'pixels' | 'per-mille';

export type CoordinateReading = 'pixels' | 'per-mille' | 'fraction';

const PER_MILLE_MODELS: RegExp[] = [
  /nemotron[^/]*(?:-vl|vision)/i,
  /qwen3[-.]?vl/i,
  /gemini/i,
  /glm-4\.\dv/i
];

export function coordinateSpaceOf(settings: Partial<LlmSettings> | null | undefined): CoordinateSpace {
  if (!settings) return 'pixels';
  if (providerOf(settings as LlmSettings) === 'gemini') return 'per-mille';
  const model = String(settings.model || '');
  return PER_MILLE_MODELS.some((re) => re.test(model)) ? 'per-mille' : 'pixels';
}

export function toPicturePixels(
  space: CoordinateSpace,
  x: number,
  y: number,
  image: { width: number; height: number }
): { x: number; y: number; reading: CoordinateReading } {
  const fraction = x >= 0 && x <= 1 && y >= 0 && y <= 1 && (!Number.isInteger(x) || !Number.isInteger(y));
  if (fraction) return { x: x * image.width, y: y * image.height, reading: 'fraction' };
  if (space === 'per-mille') return { x: (x * image.width) / 1000, y: (y * image.height) / 1000, reading: 'per-mille' };
  return { x, y, reading: 'pixels' };
}

export function coordinateWords(space: CoordinateSpace): { x: string; y: string; rule: string; example: string } {
  if (space === 'per-mille') {
    return {
      x: 'Horizontal position on the last take_screenshot picture, 0 (left edge) to 1000 (right edge)',
      y: 'Vertical position on the last take_screenshot picture, 0 (top edge) to 1000 (bottom edge)',
      rule: 'x and y are positions on a 0-1000 scale of the picture: (0, 0) is its top left corner and (1000, 1000) its bottom right corner, whatever its size. Aim at the center of the target',
      example: 'click {x: 590, y: 402}'
    };
  }
  return {
    x: 'The x pixel in the picture from take_screenshot',
    y: 'The y pixel in the picture from take_screenshot',
    rule: 'x and y are pixels in the picture you were given, counted from its top left. Aim at the center of the target',
    example: 'click {x: 812, y: 344}'
  };
}

export function pictureCaption(space: CoordinateSpace, width: number, height: number): string {
  return space === 'per-mille'
    ? `Here is the picture of the page (${width}x${height}). To click on it, give x and y on a 0-1000 scale of the picture.`
    : `Here is the picture of the page (${width}x${height}). Coordinates you read off it are pixels in this picture.`;
}
