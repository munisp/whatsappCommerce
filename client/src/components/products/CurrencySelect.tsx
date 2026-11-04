import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PRODUCT_CURRENCIES } from "@shared/productOptions";

export function CurrencySelect({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const known = PRODUCT_CURRENCIES.some((c) => c.code === value);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full border-border bg-input" aria-label="Currency"><SelectValue /></SelectTrigger>
      <SelectContent>
        {!known && value && <SelectItem value={value}>{value}</SelectItem>}
        {PRODUCT_CURRENCIES.map((c) => <SelectItem key={c.code} value={c.code}>{c.code} · {c.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
