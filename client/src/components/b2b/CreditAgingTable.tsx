/**
 * CreditAgingTable — aging-bucket summary cards (current / 1–7d / 8–30d / >30d)
 * for supplier-side credit accounts. Bucketing logic lives in b2bLogic
 * (unit-tested); this is the presentational summary.
 */
import { Card, CardContent } from "@/components/ui/card";
import { AGING_BUCKET_LABELS, formatNaira, type AgingBucketKey, type AgingBuckets } from "@/lib/b2bLogic";

const BUCKET_ORDER: AgingBucketKey[] = ["current", "d1_7", "d8_30", "over30"];
const BUCKET_TONE: Record<AgingBucketKey, string> = {
  current: "text-foreground",
  d1_7: "text-amber-400",
  d8_30: "text-orange-400",
  over30: "text-red-400",
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
