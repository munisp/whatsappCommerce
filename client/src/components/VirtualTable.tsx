// === W48 perf (PERF-FE-4): shared table row virtualization ===
// Thin wrapper around @tanstack/react-virtual for the shadcn <Table> markup:
// only the visible slice of rows is rendered, with spacer rows preserving
// scroll height. Pages wrap their <Table> in a scrollable div and pass the
// scrollRef from useTableVirtualizer.
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useRef, type ReactNode } from "react";
import { TableBody } from "@/components/ui/table";

export function useTableVirtualizer<T>(rowCount: number, estimateSize = 53) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan: 10,
  });
  return { scrollRef, virtualizer };
}

interface VirtualTableBodyProps<T> {
  rows: readonly T[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  colSpan: number;
  renderRow: (row: T, index: number) => ReactNode;
  /** Rendered (inside a full-width row) when there are no rows. */
  emptyState: ReactNode;
}

export function VirtualTableBody<T>({ rows, virtualizer, colSpan, renderRow, emptyState }: VirtualTableBodyProps<T>) {
  const items = virtualizer.getVirtualItems();
  if (rows.length === 0) {
    return (
      <TableBody>
        <tr>
          <td colSpan={colSpan}>{emptyState}</td>
        </tr>
      </TableBody>
    );
  }
  const topPad = items.length > 0 ? items[0].start : 0;
  const bottomPad = items.length > 0 ? virtualizer.getTotalSize() - items[items.length - 1].end : 0;
  return (
    <TableBody>
      {topPad > 0 && (
        <tr aria-hidden="true">
          <td colSpan={colSpan} style={{ height: topPad, padding: 0, border: 0 }} />
        </tr>
      )}
      {items.map((vi) => renderRow(rows[vi.index] as T, vi.index))}
      {bottomPad > 0 && (
        <tr aria-hidden="true">
          <td colSpan={colSpan} style={{ height: bottomPad, padding: 0, border: 0 }} />
        </tr>
      )}
    </TableBody>
  );
}
