
export interface ImageBudget {
  pxPerToken: number;
  maxTargetPx: number;
  maxTargetTokens: number;
}


export const IMAGE_BUDGET: ImageBudget = {
  pxPerToken: 28,
  maxTargetPx: 1568,
  maxTargetTokens: 1568
};

export function tokensPerAxis(px: number, pxPerToken = IMAGE_BUDGET.pxPerToken): number {
  if (!Number.isFinite(px) || px <= 0) return 0;
  if (!Number.isFinite(pxPerToken) || pxPerToken <= 0) return 0;
  return Math.floor((px - 1) / pxPerToken) + 1;
}

export function imageTokens(w: number, h: number, pxPerToken = IMAGE_BUDGET.pxPerToken): number {
  return tokensPerAxis(w, pxPerToken) * tokensPerAxis(h, pxPerToken);
}

export interface ImageSize {
  width: number;
  height: number;
}

function withinBudget(width: number, height: number, budget: ImageBudget): boolean {
  return (
    width <= budget.maxTargetPx &&
    height <= budget.maxTargetPx &&
    imageTokens(width, height, budget.pxPerToken) <= budget.maxTargetTokens
  );
}

function heightAt(width: number, height: number, atWidth: number): number {
  return Math.max(1, Math.round((atWidth * height) / width));
}

function widestFitting(width: number, height: number, budget: ImageBudget): number {
  let lo = 1;
  let hi = Math.min(width, budget.maxTargetPx);
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (withinBudget(mid, heightAt(width, height, mid), budget)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function fitToBudget(deviceWidth: number, deviceHeight: number, budget: ImageBudget = IMAGE_BUDGET): ImageSize {
  const width = Math.floor(Number(deviceWidth));
  const height = Math.floor(Number(deviceHeight));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  if (withinBudget(width, height, budget)) return { width, height };

  const best = widestFitting(width, height, budget);
  if (best <= 0) return { width: 1, height: 1 };

  const cell = Math.max(1, Math.floor(budget.pxPerToken));
  let aligned = best >= cell ? Math.floor(best / cell) * cell : best;
  while (aligned >= 1 && !withinBudget(aligned, heightAt(width, height, aligned), budget)) {
    aligned = aligned >= cell ? aligned - cell : aligned - 1;
  }
  if (aligned < 1) return { width: 1, height: 1 };
  return { width: aligned, height: heightAt(width, height, aligned) };
}

export function scaleForTarget(target: ImageSize, measured: ImageSize): number {
  if (measured.width <= 0 || target.width <= 0) return 1;
  return target.width / measured.width;
}
