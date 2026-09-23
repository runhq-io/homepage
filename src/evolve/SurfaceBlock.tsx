import type { ReactNode } from 'react';

const PENDING = { visibility: 'hidden' } as const;

/**
 * A surface's container. While its variation is pending (≤ SURFACE_WAIT_MS,
 * consented visitors only) it lays out the shipped copy invisibly, so the box
 * already has its size and nothing below it shifts when the arm paints.
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
