import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { observeFirstSight } from './firstSight';

const PENDING = { visibility: 'hidden' } as const;

/**
 * A surface's container.
 *
 * While the boot config it decides from is still in flight (≤ SURFACE_WAIT_MS
 * from the page's request; rare, since index.html preloads it) it lays out the
 * shipped copy invisibly, so the box already has a size when the decided copy
 * paints.
 *
 * `onSeen` (the surface's `seen`, from useSurface) is called once, the first
 * time the block is seen (firstSight.ts, R127): that, not the mount, is when
 * its exposure counts.
 */
export function SurfaceBlock({
  settled,
  className,
  onSeen,
  children,
}: {
  settled: boolean;
  className?: string;
  onSeen?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // At commit, not in a passive effect: those ran 1–1.5 s after paint on a
  // busy page, and a block not yet observed cannot be counted.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !onSeen) return;
    return observeFirstSight(element, onSeen);
  }, [onSeen]);
  return (
    <div ref={ref} className={className} style={settled ? undefined : PENDING} aria-busy={settled ? undefined : true}>
      {children}
    </div>
  );
}
