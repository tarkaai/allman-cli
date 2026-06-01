/**
 * Random sleep between page requests.
 *
 * Mirrors the pacing pattern in `monorepo/apps/connection-populate` — used to
 * avoid tripping LinkedIn's burst-detection when paginating large lists.
 *
 * Defaults to 2000–8000ms. The randomness matters more than the absolute
 * floor; uniformly fixed delays are themselves a detection signal.
 */

export interface RandomDelayConfig {
  minMs: number;
  maxMs: number;
}

export const DEFAULT_PAGE_DELAY: RandomDelayConfig = { minMs: 2000, maxMs: 8000 };

export function pickDelayMs(config: RandomDelayConfig = DEFAULT_PAGE_DELAY): number {
  const span = Math.max(0, config.maxMs - config.minMs);
  return config.minMs + Math.floor(Math.random() * (span + 1));
}

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random sleep using `pickDelayMs`. */
export async function randomPageSleep(config?: RandomDelayConfig): Promise<void> {
  await sleep(pickDelayMs(config));
}
