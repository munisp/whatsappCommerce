import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import MerchantWallet from "./MerchantWallet";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function PortalWallet() {
  // Retrieve the tenant ID from the portal session via getMyTenant
  const { data: tenant, isLoading } = trpc.tenantPortal.getMyTenant.useQuery();

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      </div>
    );
  }

  if (!tenant?.id) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground py-12">
            Please log in to your merchant portal to view your wallet.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6">
      <MerchantWallet tenantId={tenant.id} />
    </div>
  );
}
