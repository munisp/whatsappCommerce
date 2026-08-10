/**
 * PoStatusBadge — muted outline badge for purchase-order statuses.
 * Unknown statuses fall back to a neutral chip (forward-compatible).
 */
import { Badge } from "@/components/ui/badge";
import { poStatusMeta } from "@/lib/b2bLogic";

export function PoStatusBadge({ status }: { status: string }) {
  const meta = poStatusMeta(status);
  return (
    <Badge variant="outline" className={`font-normal ${meta.className}`}>
      {meta.label}
    </Badge>
  );
}
