import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MessageSquare, Smartphone, Send, Instagram, Radio } from "lucide-react";

const TENANT_ID = "default";
const CHANNEL_ICONS: Record<string, React.ElementType> = {
  whatsapp: MessageSquare,
  sms: Send,
  ussd: Radio,
  telegram: Send,
  instagram: Instagram,
  email: MessageSquare,
};
const CHANNEL_COLORS: Record<string, string> = {
  whatsapp: "bg-green-100 text-green-800",
  sms: "bg-blue-100 text-blue-800",
  ussd: "bg-orange-100 text-orange-800",
  telegram: "bg-sky-100 text-sky-800",
  instagram: "bg-pink-100 text-pink-800",
  email: "bg-gray-100 text-gray-800",
};

export default function MultiChannelHub() {
  const [selectedChannel, setSelectedChannel] = useState<string | undefined>(undefined);

  const { data: messages } = trpc.channels.listMessages.useQuery({ tenantId: TENANT_ID, channel: selectedChannel as "whatsapp" | "sms" | "ussd" | "telegram" | "instagram" | "email" | undefined });
  const { data: stats } = trpc.channels.channelStats.useQuery({ tenantId: TENANT_ID });

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Multi-Channel Hub</h1>
          <p className="text-gray-500 text-sm mt-1">WhatsApp · SMS · USSD · Telegram · Instagram — unified inbox</p>
        </div>

        {/* Channel Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {Object.entries(stats.byChannel).map(([channel, count]) => {
              const Icon = CHANNEL_ICONS[channel] ?? MessageSquare;
              return (
                <Card key={channel} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setSelectedChannel(channel === selectedChannel ? undefined : channel)}>
                  <CardContent className="pt-4 text-center">
                    <Icon className="w-6 h-6 mx-auto mb-1 text-gray-600" />
                    <p className="text-xl font-bold">{count as number}</p>
                    <p className="text-xs text-gray-500 capitalize">{channel}</p>
                  </CardContent>
                </Card>
              );
            })}
            <Card>
              <CardContent className="pt-4 text-center">
                <MessageSquare className="w-6 h-6 mx-auto mb-1 text-gray-400" />
                <p className="text-xl font-bold">{stats.total}</p>
                <p className="text-xs text-gray-500">Total</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Filter */}
        <div className="flex items-center gap-3">
          <Select value={selectedChannel ?? "all"} onValueChange={v => setSelectedChannel(v === "all" ? undefined : v)}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All channels" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              <SelectItem value="whatsapp">WhatsApp</SelectItem>
              <SelectItem value="sms">SMS</SelectItem>
              <SelectItem value="ussd">USSD</SelectItem>
              <SelectItem value="telegram">Telegram</SelectItem>
              <SelectItem value="instagram">Instagram</SelectItem>
              <SelectItem value="email">Email</SelectItem>
            </SelectContent>
          </Select>
          {selectedChannel && <Badge className={CHANNEL_COLORS[selectedChannel] ?? "bg-gray-100 text-gray-800"} onClick={() => setSelectedChannel(undefined)}>Clear filter ×</Badge>}
        </div>

        {/* Message List */}
        <div className="space-y-2">
          {(messages ?? []).map((msg) => {
            const Icon = CHANNEL_ICONS[msg.channel] ?? MessageSquare;
            return (
              <Card key={msg.id}>
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-1">
                      <Icon className="w-5 h-5 text-gray-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge className={CHANNEL_COLORS[msg.channel] ?? "bg-gray-100 text-gray-800"}>{msg.channel}</Badge>
                        <span className="text-xs text-gray-400">{msg.fromAddress} → {msg.toAddress}</span>
                        <span className="text-xs text-gray-400 ml-auto">{new Date(msg.createdAt).toLocaleString()}</span>
                      </div>
                      <p className="text-sm text-gray-700 truncate">{msg.body}</p>
                      {msg.nlpResponse && <p className="text-xs text-blue-600 mt-1 truncate">NLP: {msg.nlpResponse}</p>}
                    </div>
                    <Badge className={msg.processed ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}>
                      {msg.processed ? "Processed" : "Pending"}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {(messages ?? []).length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <Smartphone className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No messages yet. Connect a channel to start receiving messages.</p>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
