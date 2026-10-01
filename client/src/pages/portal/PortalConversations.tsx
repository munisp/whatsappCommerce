import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MessageSquare } from "lucide-react";
import { useTableVirtualizer, VirtualTableBody } from "@/components/VirtualTable";
import { useIsMobile } from "@/hooks/useMobile";

const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-600/20 text-blue-400 border-blue-600/30",
  resolved: "bg-emerald-600/20 text-emerald-400 border-emerald-600/30",
  pending: "bg-yellow-600/20 text-yellow-400 border-yellow-600/30",
  bot_active: "bg-purple-600/20 text-purple-400 border-purple-600/30",
  human_active: "bg-cyan-600/20 text-cyan-400 border-cyan-600/30",
};

export default function PortalConversations() {
  // W48 PERF-FE-13: smaller first page on mobile viewports (payload trim).
  const isMobile = useIsMobile();
  const { data: convs } = trpc.tenantPortal.listMyConversations.useQuery({ limit: isMobile ? 25 : 50 });
  // === W48 perf (PERF-FE-4): virtualized rows ===
  const rows = convs ?? [];
  const { scrollRef, virtualizer } = useTableVirtualizer(rows.length, 61);

  return (
    <TenantPortalLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Conversations</h1>
        <Card className="bg-slate-800 border-slate-700">
          <CardContent className="p-0">
            <div ref={scrollRef} className="max-h-[560px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-800">
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left p-4">ID</th>
                  <th className="text-left p-4">Channel</th>
                  <th className="text-left p-4">Status</th>
                  <th className="text-left p-4">Messages</th>
                  <th className="text-left p-4">AI Handled</th>
                  <th className="text-left p-4">Last Updated</th>
                </tr>
              </thead>
              <VirtualTableBody
                rows={rows}
                virtualizer={virtualizer}
                colSpan={6}
                emptyState={<p className="text-center text-slate-500 py-10">No conversations yet</p>}
                renderRow={(c) => (
                  <tr key={c.id} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="p-4 font-mono text-xs text-slate-300">{c.id.slice(0, 8)}</td>
                    <td className="p-4 text-slate-300 capitalize">{c.channel}</td>
                    <td className="p-4">
                      <Badge className={`text-xs ${STATUS_COLORS[c.status] ?? ""}`}>{c.status}</Badge>
                    </td>
                    <td className="p-4 text-slate-400">{c.messageCount}</td>
                    <td className="p-4">
                      <Badge className={c.aiHandled ? "bg-purple-600/20 text-purple-400 border-purple-600/30" : "bg-slate-600/20 text-slate-400"}>
                        {c.aiHandled ? "AI" : "Human"}
                      </Badge>
                    </td>
                    <td className="p-4 text-slate-400">{new Date(c.updatedAt).toLocaleString()}</td>
                  </tr>
                )}
              />
            </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </TenantPortalLayout>
  );
}
