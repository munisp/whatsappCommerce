import { useRef, useState, type ChangeEvent } from "react";
import { ArrowLeft, ArrowRight, ImagePlus, RefreshCw, Star, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { MAX_PRODUCT_PHOTOS } from "@shared/productOptions";

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const readFile = (file: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });

/** Several photos per product. The first is the cover shown in listings; arrows reorder. */
export function ProductPhotos({ tenantId, value, onChange }: { tenantId: string; value: string[]; onChange: (photos: string[]) => void }) {
  const upload = trpc.product.uploadImage.useMutation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const room = MAX_PRODUCT_PHOTOS - value.length;
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length > room) toast.error(`Up to ${MAX_PRODUCT_PHOTOS} photos per product. Adding the first ${room}.`);
    const accepted = files.slice(0, room).filter((f) => {
      if (!TYPES.includes(f.type)) { toast.error(`${f.name}: use a JPG, PNG or WebP`); return false; }
      if (f.size > 8 * 1024 * 1024) { toast.error(`${f.name} is over 8MB`); return false; }
      return true;
    });
    if (!accepted.length) return;
    setBusy(accepted.length);
    const uploaded: string[] = [];
    for (const file of accepted) {
      try {
        const { url } = await upload.mutateAsync({ tenantId, base64: await readFile(file), mimeType: file.type as "image/jpeg" });
        uploaded.push(url);
      } catch (err) {
        toast.error(`${file.name}: ${err instanceof Error ? err.message : "upload failed"}`);
      }
      setBusy((n) => n - 1);
    }
    if (uploaded.length) onChange([...value, ...uploaded]);
  };
  const move = (i: number, to: number) => { const next = [...value]; const [x] = next.splice(i, 1); next.splice(to, 0, x!); onChange(next); };
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="grid grid-cols-4 gap-2">
          {value.map((url, i) => (
            <li key={url} className="group relative overflow-hidden rounded border border-border bg-muted">
              <img src={url} alt={i === 0 ? "Cover photo" : `Photo ${i + 1}`} className="aspect-square w-full object-cover" />
              {i === 0 && <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-background/90 px-1 text-[10px] font-semibold"><Star className="h-2.5 w-2.5" aria-hidden="true" /> Cover</span>}
              <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => onChange(value.filter((_, n) => n !== i))} className="absolute right-1 top-1 rounded bg-background/90 p-0.5"><X className="h-3 w-3" /></button>
              <div className="absolute inset-x-1 bottom-1 flex justify-between">
                {i > 0 ? <button type="button" aria-label={`Move photo ${i + 1} earlier`} onClick={() => move(i, i - 1)} className="rounded bg-background/90 p-0.5"><ArrowLeft className="h-3 w-3" /></button> : <span />}
                {i < value.length - 1 && <button type="button" aria-label={`Move photo ${i + 1} later`} onClick={() => move(i, i + 1)} className="rounded bg-background/90 p-0.5"><ArrowRight className="h-3 w-3" /></button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {room > 0 && (
        <Button type="button" variant="outline" className="w-full gap-2 border-border bg-transparent" disabled={busy > 0} onClick={() => inputRef.current?.click()}>
          {busy > 0 ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ImagePlus className="h-4 w-4" aria-hidden="true" />}
          {busy > 0 ? `Uploading ${busy}…` : value.length ? "Add more photos" : "Upload photos"}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">Up to {MAX_PRODUCT_PHOTOS} photos. The first is the cover; use the arrows to change it.</p>
      <input ref={inputRef} type="file" multiple accept={TYPES.join(",")} hidden aria-label="Upload product photos" onChange={pick} />
    </div>
  );
}
