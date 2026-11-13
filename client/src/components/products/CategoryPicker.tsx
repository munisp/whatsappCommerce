import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PRODUCT_CATEGORIES } from "@shared/productOptions";

const OTHER = "__other__";

/** Searchable categories, with Other for anything not listed. */
export function CategoryPicker({ value, onChange, extra = [] }: { value: string; onChange: (value: string) => void; extra?: string[] }) {
  const options = useMemo(() => Array.from(new Set([...extra.filter(Boolean), ...PRODUCT_CATEGORIES])).sort((a, b) => a.localeCompare(b)), [extra]);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(() => !!value && !options.includes(value));
  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between border-border bg-input font-normal">
            <span className={value || custom ? "" : "text-muted-foreground"}>{custom ? "Other" : value || "Choose a category"}</span>
            <ChevronsUpDown className="h-4 w-4 opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search categories" />
            <CommandList className="max-h-64">
              <CommandEmpty>Not listed. Choose Other to type your own.</CommandEmpty>
              <CommandGroup>
                {options.map((c) => (
                  <CommandItem key={c} value={c} onSelect={() => { onChange(c); setCustom(false); setOpen(false); }}>
                    <Check className={`mr-2 h-4 w-4 ${!custom && value === c ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />{c}
                  </CommandItem>
                ))}
                {/* Always shown, whatever was typed: it's the way out when nothing matches. */}
                <CommandItem forceMount value={`${OTHER} other`} onSelect={() => { setCustom(true); onChange(""); setOpen(false); }}>
                  <Check className={`mr-2 h-4 w-4 ${custom ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />Other…
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {custom && <Input autoFocus value={value} maxLength={100} onChange={(e) => onChange(e.target.value)} placeholder="Type your category" aria-label="Your category" className="border-border bg-input" />}
    </div>
  );
}
