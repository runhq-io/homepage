/**
 * When a block is first seen (ruling R127): its exposure counts then, not at
 * mount, so a surface below the fold is measured on the visitors who reached
 * it rather than diluted by everyone who loaded the page.
 *
 * The trigger is the block's TOP EDGE entering the upper 75% of the viewport:
 * `threshold: 0` with the bottom quarter cut off. A threshold on the fraction
 * of the block visible would depend on the block's height — a taller arm would
 * be "seen" later — and make the exposure depend on the arm.
 */
export const FIRST_SIGHT_OPTIONS: IntersectionObserverInit = { threshold: 0, rootMargin: '0px 0px -25% 0px' };

/** The same trigger, read from geometry: the top edge is above 75% of the viewport height and the block is not scrolled past. */
const SEEN_BAND = 0.75;

/** Blocks observed but not yet reported: a synchronous check for each. */
const pending = new Set<(viewport: { innerHeight: number }) => void>();

/**
 * Report, synchronously, every pending block that is in view by the same
 * trigger (R126 × R127). Called when the page is leaving: an observer's
 * callback waits for a rendering step, which a busy main thread delays by
 * seconds, and a visitor who left in that gap had the block in view.
 */
export function checkPendingSightings(viewport: { innerHeight: number } = window): void {
  for (const check of [...pending]) check(viewport);
}

type ObserverCtor = new (
  callback: (entries: Array<{ isIntersecting: boolean }>) => void,
  options: IntersectionObserverInit,
) => { observe(el: Element): void; disconnect(): void };

/**
 * Calls `onSeen` once, the first time `element` is seen; returns a stop. With
 * no IntersectionObserver the block counts as seen at mount (the old rule).
 */
export function observeFirstSight(
  element: Element,
  onSeen: () => void,
  Observer: ObserverCtor | undefined = typeof IntersectionObserver === 'function' ? (IntersectionObserver as unknown as ObserverCtor) : undefined,
): () => void {
  if (!Observer) {
    onSeen();
    return () => {};
  }
  let done = false;
  const report = () => {
    if (done) return;
    done = true;
    pending.delete(check);
    observer.disconnect();
    onSeen();
  };
  const check = (viewport: { innerHeight: number }) => {
    try {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < viewport.innerHeight * SEEN_BAND) report();
    } catch {
      // Not measurable: leave it to the observer.
    }
  };
  const observer = new Observer((entries) => {
    if (entries.some((e) => e.isIntersecting)) report();
  }, FIRST_SIGHT_OPTIONS);
  observer.observe(element);
  pending.add(check);
  return () => {
    done = true;
    pending.delete(check);
    observer.disconnect();
  };
}
