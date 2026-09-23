import type { ReactNode } from 'react';

const PENDING = { visibility: 'hidden' } as const;

/**
 * A surface's container. While the boot config it decides from is still in
 * flight (≤ SURFACE_WAIT_MS from the page's request; rare, since index.html
 * preloads it) it lays out the shipped copy invisibly, so the box already has
 * a size when the decided copy paints.
 */
export function SurfaceBlock({
  settled,
  className,
  children,
}: {
  settled: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className} style={settled ? undefined : PENDING} aria-busy={settled ? undefined : true}>
      {children}
    </div>
  );
}
