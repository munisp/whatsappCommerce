/**
 * PoBuilderDrawer — right-side sheet for building a purchase order against a
 * supplier: pick lines from their catalog, MOQ validation, terms + payment
 * mode ("Pay on credit (net N)" disabled-with-reason without an active credit
 * account vs "Pay now"), then submit. Pay-now POs that come back with a
 * paymentUrl offer an immediate checkout.
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useB2bUtils, useCreatePo, useWholesaleCatalog } from "@/lib/b2b";
import {
  formatNaira, poPaymentModes, poSubtotal, suspensionBlockReason, validateMoq, validatePoLines,
  type PoLine, type PoPaymentMode, type SupplierSummary,
} from "@/lib/b2bLogic";
import { AlertTriangle, Loader2, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { toast } from "sonner";

export function PoBuilderDrawer({
  tenantId,
  supplier,
  open,
  onOpenChange,
}: {
  tenantId: string;
  supplier: SupplierSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = useB2bUtils();
  const supplierTenantId = supplier?.supplierTenantId ?? null;
  const { data: catalogData, isLoading: profileLoading } = useWholesaleCatalog(tenantId, supplierTenantId, { enabled: open });

  const [lines, setLines] = useState<PoLine[]>([]);
  const [termsDays, setTermsDays] = useState<number | null>(null);
  const [paymentMode, setPaymentMode] = useState<PoPaymentMode>("paynow");
  const [notes, setNotes] = useState("");

  // Reset the draft whenever a different supplier is opened.
  useEffect(() => {
    if (open) {
      setLines([]);
      setTermsDays(supplier?.defaultTermsDays ?? supplier?.termsDays[0] ?? null);
      setPaymentMode(supplier?.myAccount?.status === "active" ? "credit" : "paynow");
      setNotes("");
    }
  }, [open, supplier?.supplierTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const createPo = useCreatePo({
    onSuccess: ({ po, autoApproved }) => {
      toast.success(
        autoApproved
          ? `PO ${po.poNumber} auto-approved by ${supplier?.businessName ?? "supplier"}`
          : `PO ${po.poNumber} submitted to ${supplier?.businessName ?? "supplier"} for approval`,
      );
      utils.procurement.listPos.invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const catalog = catalogData?.catalog ?? [];
  // Supplier MOQ from the live catalog when available, else the directory entry.
  const effectiveMoq = catalogData?.moq ?? supplier?.moq ?? 0;
  const subtotal = useMemo(() => poSubtotal(lines), [lines]);
  const moq = useMemo(() => validateMoq(subtotal, effectiveMoq), [subtotal, effectiveMoq]);
  const lineError = useMemo(() => validatePoLines(lines), [lines]);
  const modes = useMemo(
    () => poPaymentModes(supplier?.myAccount, termsDays ?? supplier?.defaultTermsDays ?? supplier?.termsDays[0]),
    [supplier, termsDays],
  );
  const creditMode = modes.find((m) => m.mode === "credit");

  const addLine = (catalogItemId: string) => {
    const item = catalog.find((c) => c.id === catalogItemId);
    if (!item) return;
    setLines((prev) => {
      const existing = prev.find((l) => l.catalogItemId === item.id);
      if (existing) {
        return prev.map((l) => (l.catalogItemId === item.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...prev, { catalogItemId: item.id, name: item.name, quantity: item.minQty ?? 1, unitPrice: item.unitPrice }];
    });
  };

  const minQtyFor = (catalogItemId: string | null | undefined) =>
    catalog.find((c) => c.id === catalogItemId)?.minQty ?? 1;

  const setQty = (catalogItemId: string | null | undefined, quantity: number) => {
    setLines((prev) => prev.map((l) => (l.catalogItemId === catalogItemId ? { ...l, quantity } : l)));
  };

  const removeLine = (catalogItemId: string | null | undefined) => {
    setLines((prev) => prev.filter((l) => l.catalogItemId !== catalogItemId));
  };

  const belowMinQty = lines.some((l) => l.quantity < minQtyFor(l.catalogItemId));
  // Enforcement gate (mirrors server): a suspended buyer may compose the
  // draft but cannot submit — the button is disabled with the reason shown.
  const submitBlock = suspensionBlockReason(supplier?.myAccount);
  const canSubmit = !submitBlock && !lineError && !belowMinQty && moq.ok && !createPo.isPending && (paymentMode === "paynow" || creditMode?.enabled === true);

  const submit = () => {
    if (!supplier) return;
    createPo.mutate({
      tenantId,
      supplierTenantId: supplier.supplierTenantId,
      lines,
      paymentMode,
      termsDays: paymentMode === "credit" ? (termsDays ?? undefined) : undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-primary" /> New purchase order
          </SheetTitle>
          <SheetDescription>
            {supplier ? `Buying from ${supplier.businessName} · min order ${formatNaira(effectiveMoq)}` : "Select a supplier first"}
          </SheetDescription>
        </SheetHeader>

        {!supplier ? null : profileLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading catalog…
          </div>
        ) : (
          <div className="space-y-6 py-4">
            {/* ── Catalog picker ─────────────────────────────────────────── */}
            <div className="space-y-2">
              <Label>Add items from catalog</Label>
              {catalog.length === 0 ? (
                <p className="text-sm text-muted-foreground rounded-lg border border-dashed border-border p-4 text-center">
                  This supplier has not published a catalog yet.
                </p>
              ) : (
                <div className="rounded-lg border border-border divide-y divide-border max-h-56 overflow-y-auto">
                  {catalog.map((item) => (
                    <div key={item.id} className="flex items-center gap-3 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">{item.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatNaira(item.unitPrice)}{item.unit ? ` / ${item.unit}` : ""}
                          {item.sku ? ` · ${item.sku}` : ""}
                        </p>
                      </div>
                      <Button variant="outline" size="sm" className="gap-1" onClick={() => addLine(item.id)}>
                        <Plus className="w-3.5 h-3.5" /> Add
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Lines ──────────────────────────────────────────────────── */}
            <div className="space-y-2">
              <Label>Order lines</Label>
              {lines.length === 0 ? (
                <p className="text-sm text-muted-foreground rounded-lg border border-dashed border-border p-4 text-center">
                  No items yet — add products from the catalog above.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="w-24">Qty</TableHead>
                      <TableHead className="text-right">Unit ₦</TableHead>
                      <TableHead className="text-right">Line ₦</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((l) => (
                      <TableRow key={l.catalogItemId ?? l.name}>
                        <TableCell className="font-medium">{l.name}</TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={minQtyFor(l.catalogItemId)}
                            className="h-8 w-20"
                            value={l.quantity}
                            onChange={(e) => setQty(l.catalogItemId, Number(e.target.value))}
                          />
                        </TableCell>
                        <TableCell className="text-right">{formatNaira(l.unitPrice)}</TableCell>
                        <TableCell className="text-right">{formatNaira(l.quantity * l.unitPrice)}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                            onClick={() => removeLine(l.catalogItemId)}
                            aria-label={`Remove ${l.name}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <div className="flex items-center justify-between text-sm pt-1">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="font-semibold">{formatNaira(subtotal)}</span>
              </div>
              {!moq.ok && (
                <Alert variant="destructive" className="py-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{moq.reason}</AlertDescription>
                </Alert>
              )}
            </div>

            <Separator />

            {/* ── Terms + payment mode ───────────────────────────────────── */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Payment terms</Label>
                <Select
                  value={termsDays != null ? String(termsDays) : ""}
                  onValueChange={(v) => setTermsDays(Number(v))}
                  disabled={paymentMode !== "credit"}
                >
                  <SelectTrigger className="w-full max-w-xs">
                    <SelectValue placeholder="Select terms" />
                  </SelectTrigger>
                  <SelectContent>
                    {(supplier.termsDays.length > 0 ? supplier.termsDays : [0]).map((d) => (
                      <SelectItem key={d} value={String(d)}>{d === 0 ? "Due on receipt" : `Net ${d} days`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <RadioGroup value={paymentMode} onValueChange={(v) => setPaymentMode(v as PoPaymentMode)} className="space-y-2">
                {modes.map((m) => (
                  <div key={m.mode} className="flex items-start gap-2">
                    <RadioGroupItem value={m.mode} id={`pm-${m.mode}`} disabled={!m.enabled} className="mt-0.5" />
                    <div className="space-y-0.5">
                      <Label htmlFor={`pm-${m.mode}`} className={m.enabled ? "" : "text-muted-foreground"}>
                        {m.label}
                      </Label>
                      {!m.enabled && m.disabledReason && (
                        <p className="text-xs text-muted-foreground">{m.disabledReason}</p>
                      )}
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="po-notes">Notes (optional)</Label>
              <Textarea
                id="po-notes"
                rows={2}
                maxLength={500}
                placeholder="Delivery instructions, reference…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {submitBlock && (
              <Alert variant="destructive">
                <AlertDescription>{submitBlock}</AlertDescription>
              </Alert>
            )}
            {lineError && lines.length > 0 && (
              <p className="text-xs text-destructive">{lineError}</p>
            )}
            {belowMinQty && !lineError && (
              <p className="text-xs text-destructive">One or more lines are below the supplier's minimum line quantity.</p>
            )}

            <div className="flex items-center justify-between gap-3 pt-2">
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {paymentMode === "credit" ? `On credit · net ${termsDays ?? 0}d` : "Pay now"}
              </Badge>
              <Button className="gap-1.5" disabled={!canSubmit} onClick={submit}>
                {createPo.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShoppingCart className="w-4 h-4" />}
                Submit PO · {formatNaira(subtotal)}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
