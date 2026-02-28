'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { useRouter } from 'next/navigation';

type SortDirection = 'asc' | 'desc';

export type DataTableColumn<T> = {
  /** Stable identifier used for sorting + visibility */
  id: string;
  /** Plain-text label used when rendering collapsed column values in the row-details view */
  label: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;

  /** Enables header click sorting for this column */
  sortable?: boolean;
  /** Custom comparator for sorting (ignores direction; direction applied by table) */
  sortFn?: (a: T, b: T) => number;
  /** Value used by the default comparator when sortable (string/number/date/bool) */
  sortValue?: (row: T) => string | number | boolean | Date | null | undefined;

  align?: 'left' | 'center' | 'right';

  /** CSS breakpoint-based hiding (still sortable, but hidden via CSS). */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';

  /** Approximate width used by auto-hide logic (px). */
  minWidth?: number;
  /** Larger = hide sooner when auto-hiding. Defaults to the column's index. */
  collapsePriority?: number;
  /** Prevent this column from being auto-hidden. */
  disableAutoHide?: boolean;
  /** If true, do not show this column in the row-details view when it is collapsed. */
  hideInRowDetails?: boolean;

  headerClassName?: string;
  cellClassName?: string;
};

export type DataTableProps<T> = {
  data: T[];
  columns: Array<DataTableColumn<T>>;
  getRowId?: (row: T, index: number) => string;

  /** If provided, rows become clickable and will navigate to this href. */
  rowHref?: (row: T) => string;
  /** Alternative row click handler (takes precedence over rowHref). */
  onRowClick?: (row: T) => void;

  defaultSort?: { columnId: string; direction: SortDirection };

  /** Auto-hide columns as width shrinks (ResizeObserver + collapsePriority). */
  autoHideColumns?: boolean;
  minVisibleColumns?: number;
  /** When columns are auto-hidden, allow expanding rows to view hidden columns. */
  enableRowDetails?: boolean;

  emptyState?: React.ReactNode;
  className?: string;
};

function isDate(value: unknown): value is Date {
  return value instanceof Date;
}

function comparePrimitive(a: unknown, b: unknown): number {
  // Null/undefined always sort last.
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  if (isDate(a) && isDate(b)) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);

  return String(a).localeCompare(String(b));
}

function hideBelowToClass(hideBelow: DataTableColumn<any>['hideBelow']): string {
  switch (hideBelow) {
    case 'sm':
      return 'hidden sm:table-cell';
    case 'md':
      return 'hidden md:table-cell';
    case 'lg':
      return 'hidden lg:table-cell';
    case 'xl':
      return 'hidden xl:table-cell';
    default:
      return '';
  }
}

function alignToClass(align: DataTableColumn<any>['align']): string {
  switch (align) {
    case 'center':
      return 'text-center';
    case 'right':
      return 'text-right';
    default:
      return 'text-left';
  }
}

function shouldIgnoreRowClick(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return !!el.closest('a,button,input,select,textarea,[data-row-click="ignore"]');
}

export function DataTable<T extends Record<string, any>>({
  data,
  columns,
  getRowId,
  rowHref,
  onRowClick,
  defaultSort,
  autoHideColumns = true,
  minVisibleColumns = 2,
  enableRowDetails = true,
  emptyState,
  className,
}: DataTableProps<T>) {
  const router = useRouter();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection } | null>(
    defaultSort ?? null
  );

  const [expandedRowIds, setExpandedRowIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSort(defaultSort ?? null);
  }, [defaultSort?.columnId, defaultSort?.direction]);

  useEffect(() => {
    if (!autoHideColumns) return;
    const el = scrollContainerRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerWidth(entry.contentRect.width);
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [autoHideColumns]);

  const visibleColumnIds = useMemo(() => {
    const allIds = new Set(columns.map((c) => c.id));
    if (!autoHideColumns) return allIds;
    if (!containerWidth) return allIds;

    const widths = columns.map((c) => c.minWidth ?? 160);
    // Fudge factor for padding / borders / scrollbars.
    let required = widths.reduce((sum, w) => sum + w, 0) + 32;

    // By default: keep the first column visible; hide from the right-most side.
    const candidates = columns
      .map((c, index) => ({
        c,
        index,
        width: widths[index],
        priority: c.collapsePriority ?? index,
      }))
      .filter(({ c, index }) => index !== 0 && !c.disableAutoHide);

    const visible = new Set(columns.map((c) => c.id));
    const minVisible = Math.max(1, minVisibleColumns);

    candidates
      .sort((a, b) => b.priority - a.priority)
      .forEach(({ c, width }) => {
        if (required <= containerWidth) return;
        if (visible.size <= minVisible) return;
        visible.delete(c.id);
        required -= width;
      });

    return visible;
  }, [columns, autoHideColumns, containerWidth, minVisibleColumns]);

  const visibleColumns = useMemo(
    () => columns.filter((c) => visibleColumnIds.has(c.id)),
    [columns, visibleColumnIds]
  );
  const collapsedColumns = useMemo(
    () => columns.filter((c) => !visibleColumnIds.has(c.id) && !c.hideInRowDetails),
    [columns, visibleColumnIds]
  );

  const showRowDetailsToggle = enableRowDetails && autoHideColumns && collapsedColumns.length > 0;

  const sortedRows = useMemo(() => {
    if (!sort) return data;
    const col = columns.find((c) => c.id === sort.columnId);
    if (!col) return data;
    const sortable = col.sortable ?? Boolean(col.sortFn || col.sortValue);
    if (!sortable) return data;

    const direction = sort.direction === 'asc' ? 1 : -1;
    const baseCompare =
      col.sortFn ??
      ((a: T, b: T) => comparePrimitive(col.sortValue?.(a), col.sortValue?.(b)));

    // Stable sort.
    return data
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const res = direction * baseCompare(a.row, b.row);
        if (res !== 0) return res;
        return a.index - b.index;
      })
      .map((x) => x.row);
  }, [data, sort, columns]);

  const handleHeaderClick = (column: DataTableColumn<T>) => {
    const sortable = column.sortable ?? Boolean(column.sortFn || column.sortValue);
    if (!sortable) return;

    setExpandedRowIds(new Set());
    setSort((prev) => {
      if (!prev || prev.columnId !== column.id) return { columnId: column.id, direction: 'asc' };
      return { columnId: column.id, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
    });
  };

  const getId = (row: T, index: number) => {
    if (getRowId) return getRowId(row, index);
    const id = (row as any).id;
    return typeof id === 'string' ? id : String(index);
  };

  const handleRowActivate = (row: T) => {
    if (onRowClick) return onRowClick(row);
    if (rowHref) return router.push(rowHref(row));
  };

  const renderSortIcon = (columnId: string) => {
    if (!sort || sort.columnId !== columnId) {
      return <ChevronsUpDown className="h-4 w-4 text-slate-500" aria-hidden="true" />;
    }
    if (sort.direction === 'asc') {
      return <ChevronUp className="h-4 w-4 text-slate-300" aria-hidden="true" />;
    }
    return <ChevronDown className="h-4 w-4 text-slate-300" aria-hidden="true" />;
  };

  const hasRowClick = Boolean(onRowClick || rowHref);

  return (
    <div className={className ?? ''}>
      <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
        <div ref={scrollContainerRef} className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-slate-700">
              <tr>
                {visibleColumns.map((col) => {
                  const sortable = col.sortable ?? Boolean(col.sortFn || col.sortValue);
                  const ariaSort =
                    sort?.columnId === col.id
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none';

                  return (
                    <th
                      key={col.id}
                      scope="col"
                      aria-sort={ariaSort as any}
                      className={[
                        'px-4 py-3 text-xs font-medium text-slate-300 uppercase tracking-wider select-none',
                        alignToClass(col.align),
                        hideBelowToClass(col.hideBelow),
                        col.headerClassName ?? '',
                      ].join(' ')}
                    >
                      <button
                        type="button"
                        onClick={() => handleHeaderClick(col)}
                        className={[
                          'w-full flex items-center gap-1',
                          col.align === 'right'
                            ? 'justify-end'
                            : col.align === 'center'
                              ? 'justify-center'
                              : 'justify-start',
                          sortable ? 'cursor-pointer hover:text-white' : 'cursor-default',
                        ].join(' ')}
                        disabled={!sortable}
                      >
                        <span className="truncate">{col.header}</span>
                        {sortable && renderSortIcon(col.id)}
                      </button>
                    </th>
                  );
                })}

                {showRowDetailsToggle && (
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-xs font-medium text-slate-300 uppercase tracking-wider"
                  >
                    <span className="sr-only">Details</span>
                  </th>
                )}
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-700">
              {sortedRows.map((row, index) => {
                const rowId = getId(row, index);
                const isExpanded = expandedRowIds.has(rowId);

                return (
                  <React.Fragment key={rowId}>
                    <tr
                      className={[
                        'transition-colors',
                        hasRowClick ? 'cursor-pointer hover:bg-slate-700/40' : 'hover:bg-slate-700/20',
                      ].join(' ')}
                      tabIndex={hasRowClick ? 0 : -1}
                      onClick={(e) => {
                        if (!hasRowClick) return;
                        if (shouldIgnoreRowClick(e.target)) return;
                        handleRowActivate(row);
                      }}
                      onKeyDown={(e) => {
                        if (!hasRowClick) return;
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        if (shouldIgnoreRowClick(e.target)) return;
                        e.preventDefault();
                        handleRowActivate(row);
                      }}
                    >
                      {visibleColumns.map((col) => (
                        <td
                          key={col.id}
                          className={[
                            'px-4 py-3 text-sm',
                            alignToClass(col.align),
                            hideBelowToClass(col.hideBelow),
                            col.cellClassName ?? '',
                          ].join(' ')}
                        >
                          {col.cell(row)}
                        </td>
                      ))}

                      {showRowDetailsToggle && (
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            data-row-click="ignore"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setExpandedRowIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(rowId)) next.delete(rowId);
                                else next.add(rowId);
                                return next;
                              });
                            }}
                            className="inline-flex items-center justify-center h-8 w-8 rounded hover:bg-slate-600/50 text-slate-300"
                            aria-expanded={isExpanded}
                            aria-label={isExpanded ? 'Hide details' : 'Show details'}
                          >
                            <ChevronDown
                              className={[
                                'h-4 w-4 transition-transform',
                                isExpanded ? 'rotate-180' : 'rotate-0',
                              ].join(' ')}
                              aria-hidden="true"
                            />
                          </button>
                        </td>
                      )}
                    </tr>

                    {showRowDetailsToggle && isExpanded && (
                      <tr className="bg-slate-900/30">
                        <td
                          colSpan={visibleColumns.length + 1}
                          className="px-4 py-4"
                          data-row-click="ignore"
                        >
                          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
                            {collapsedColumns.map((col) => (
                              <div key={col.id} className="min-w-0">
                                <dt className="text-[10px] text-slate-500 uppercase tracking-wider">
                                  {col.label}
                                </dt>
                                <dd className="text-sm text-slate-200 mt-1 break-words">
                                  {col.cell(row)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {data.length === 0 && (
          <div className="px-6 py-10 text-center text-slate-400">
            {emptyState ?? <p>No results</p>}
          </div>
        )}
      </div>
    </div>
  );
}
