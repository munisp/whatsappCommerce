/**
 * CreditStatusChip — small outline chip summarising how a pending PO fits the
 * buyer's credit account (within-limit / over-limit / no-account / frozen).
 */
import { Badge } from "@/components/ui/badge";
import { creditFitForPo, type CreditAccountRef } from "@/lib/b2bLogic";

export function CreditStatusChip({
  account,
  poSubtotal,
}: {
  account: Pick<CreditAccountRef, "status" | "limit" | "outstanding"> | null | undefined;
  poSubtotal: number;
}) {
  const fit = creditFitForPo(account, poSubtotal);
  return (
    <Badge variant="outline" className={`font-normal ${fit.className}`}>
      {fit.label}
    </Badge>
  );
}
