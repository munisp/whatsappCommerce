import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Rocket } from "lucide-react";
import { useLocation } from "wouter";

/**
 * QA-043: shown, inside the normal shell, to a signed-in user who has not created a business yet — i.e. anyone who has just
 * registered. Every tenant-scoped page would answer such a user with a 403 ("You can only access your own tenant's data"),
 * so instead of a page full of red errors they get the one thing they can usefully do.
 */
export function NoBusinessYet({ name }: { name: string }) {
  const [, navigate] = useLocation();
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6" data-testid="no-business-yet">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <Rocket className="h-5 w-5 text-primary" />
          </div>
          <CardTitle>Welcome, {name}</CardTitle>
          <CardDescription>
            You're signed in, and your account is ready. To start selling on WhatsApp, set up your business first — it takes a few minutes
            and unlocks your catalogue, orders, conversations and payments.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" size="lg" onClick={() => navigate("/onboarding-wizard")} data-testid="no-business-yet-cta">
            Set up your business
          </Button>
          <p className="mt-3 text-center text-xs text-muted-foreground">
            Joining an existing business instead? Ask its owner to send you an invitation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
