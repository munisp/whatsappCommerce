/**
 * CreditAgingTable — aging-bucket summary cards matching the backend's
 * bucketForDraw buckets (current / 1–30d / 31–60d / 61–90d / >90d) for
 * supplier-side credit accounts. Purely presentational.
 */
import { Card, CardContent } from "@/components/ui/card";
import { AGING_BUCKET_LABELS, formatNaira, type AgingBucketKey, type AgingBuckets } from "@/lib/b2bLogic";

const BUCKET_ORDER: AgingBucketKey[] = ["current", "days1to30", "days31to60", "days61to90", "days90plus"];
const BUCKET_TONE: Record<AgingBucketKey, string> = {
  current: "text-foreground",
  days1to30: "text-amber-400",
  days31to60: "text-orange-400",
  days61to90: "text-orange-400",
  days90plus: "text-red-400",
};

export function CreditAgingCards({ buckets }: { buckets: AgingBuckets }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {BUCKET_ORDER.map((key) => (
        <Card key={key}>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">{AGING_BUCKET_LABELS[key]}</p>
            <p className={`text-lg font-bold mt-1 ${BUCKET_TONE[key]}`}>{formatNaira(buckets[key])}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
