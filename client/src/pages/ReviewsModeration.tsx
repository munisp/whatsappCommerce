/**
 * W27: Reviews moderation — verified-purchase reviews with merchant
 * responses and flag/remove/restore moderation.
 */
import { useState } from "react";
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Star } from "lucide-react";

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`h-4 w-4 ${i <= n ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`} />
      ))}
    </span>
  );
}

export default function ReviewsModeration() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();
  const { data: summary } = trpc.reviews.summary.useQuery({ tenantId });
  const { data: reviewList, isLoading } = trpc.reviews.list.useQuery({ tenantId, limit: 100 });

  const invalidate = () => {
    utils.reviews.list.invalidate();
    utils.reviews.summary.invalidate();
  };
  const onError = (e: any) => toast.error(e?.message ?? "Action failed");
  const respondMut = trpc.reviews.respond.useMutation({
    onSuccess: () => { invalidate(); toast.success("Response posted"); setResponses({}); }, onError,
  });
  const moderateMut = trpc.reviews.moderate.useMutation({ onSuccess: invalidate, onError });

  const [responses, setResponses] = useState<Record<string, string>>({});

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Star className="h-6 w-6" /> Reviews</h1>

        <Card>
          <CardContent className="pt-6 flex items-center gap-6">
            <div className="text-3xl font-bold">{summary ? summary.avg.toFixed(1) : "—"}</div>
            <div>
              <Stars n={Math.round(summary?.avg ?? 0)} />
              <p className="text-sm text-muted-foreground">{summary?.count ?? 0} verified reviews</p>
            </div>
            <p className="text-xs text-muted-foreground max-w-md">
              Only buyers with a delivered order can review — every review here is purchase-verified.
              Reviews feed your discovery trust score.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Moderation queue</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead><TableHead>Rating</TableHead><TableHead>Review</TableHead>
                  <TableHead>Status</TableHead><TableHead>Respond / Moderate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(reviewList ?? []).map((r: any) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs whitespace-nowrap">{new Date(r.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell><Stars n={r.rating} /></TableCell>
                    <TableCell className="max-w-md">
                      <p className="text-sm">{r.text ?? <i className="text-muted-foreground">(no text)</i>}</p>
                      {r.merchantResponse && (
                        <p className="text-xs mt-1 border-l-2 pl-2 text-muted-foreground">You: {r.merchantResponse}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.status === "published" ? "default" : r.status === "flagged" ? "outline" : "destructive"}>
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="space-y-2 min-w-[220px]">
                      <Textarea
                        rows={2}
                        placeholder="Write a response…"
                        value={responses[r.id] ?? ""}
                        onChange={(e) => setResponses({ ...responses, [r.id]: e.target.value })}
                      />
                      <div className="flex gap-1 flex-wrap">
                        <Button size="sm" variant="secondary" disabled={!(responses[r.id] ?? "").trim()}
                          onClick={() => respondMut.mutate({ tenantId, reviewId: r.id, response: responses[r.id]! })}>
                          Respond
                        </Button>
                        {r.status !== "flagged" && (
                          <Button size="sm" variant="outline" onClick={() => moderateMut.mutate({ tenantId, reviewId: r.id, status: "flagged" })}>Flag</Button>
                        )}
                        {r.status !== "removed" && (
                          <Button size="sm" variant="destructive" onClick={() => moderateMut.mutate({ tenantId, reviewId: r.id, status: "removed" })}>Remove</Button>
                        )}
                        {r.status !== "published" && (
                          <Button size="sm" variant="outline" onClick={() => moderateMut.mutate({ tenantId, reviewId: r.id, status: "published" })}>Restore</Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!isLoading && (reviewList ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-muted-foreground">
                    No reviews yet — buyers are prompted on WhatsApp after delivery.
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
