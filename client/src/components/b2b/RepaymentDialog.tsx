/**
 * RepaymentDialog — buyer repays (part of) their outstanding credit balance.
 * Requests a payment link via creditRepay.requestRepaymentLink and opens the
 * returned checkout URL in a new tab.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useB2bUtils, useRequestRepaymentLink } from "@/lib/b2b";
import { formatNaira } from "@/lib/b2bLogic";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

export function RepaymentDialog({
  tenantId,
  accountId,
  counterpartyName,
  outstanding,
  poId,
  open,
  onOpenChange,
}: {
  tenantId: string;
  accountId: string;
  counterpartyName: string;
  outstanding: number;
  /** When repaying against a specific credit-invoiced PO. */
  poId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = useB2bUtils();
  const [amount, setAmount] = useState(String(outstanding));

  // Default to the full outstanding balance each time the dialog opens.
  useEffect(() => {
    if (open) setAmount(String(outstanding));
  }, [open, outstanding]);

  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= outstanding;

  const requestLink = useRequestRepaymentLink({
    onSuccess: ({ url }) => {
      toast.success("Repayment link created — opening checkout");
      window.open(url, "_blank", "noopener");
      onOpenChange(false);
      utils?.tradeCredit?.myAccounts?.invalidate();
      utils?.tradeCredit?.myLedger?.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Repay {counterpartyName}</DialogTitle>
          <DialogDescription>
            Outstanding balance: {formatNaira(outstanding)}. You will be redirected to a secure
            checkout to complete the repayment.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="repay-amount">Amount (₦)</Label>
          <Input
            id="repay-amount"
            type="number"
            min={1}
            max={outstanding}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {!valid && amount.trim() !== "" && (
            <p className="text-xs text-destructive">
              Enter an amount between ₦1 and {formatNaira(outstanding)}.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            className="gap-1.5"
            disabled={!valid || requestLink.isPending}
            onClick={() => requestLink.mutate({ tenantId, accountId, amount: parsed })}
          >
            {requestLink.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
            Get payment link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
