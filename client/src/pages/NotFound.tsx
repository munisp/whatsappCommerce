import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Home } from "lucide-react";
import { useLocation } from "wouter";
import { OakMark } from "@/components/OakLogo";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";

export default function NotFound() {
  const [, setLocation] = useLocation();
  // QA-043: a signed-in user who hits a dead link keeps the sidebar (so they can navigate away) instead of being stranded
  // on a bare page. Signed-out visitors, and shared public links, still get the standalone 404.
  const { user } = useAuth();

  const handleGoHome = () => {
    setLocation("/");
  };

  const page = (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <Card className="w-full max-w-lg mx-4 border-border bg-card">
        <CardContent className="pt-8 pb-8 text-center">
          <div className="flex justify-center mb-6">
            <OakMark className="h-16 w-16" />
          </div>

          <h1 className="oak-display text-5xl text-[var(--oak-forest)] mb-2">404</h1>

          <h2 className="oak-display text-2xl text-foreground mb-4">
            Page Not Found
          </h2>

          <p className="text-muted-foreground mb-8 leading-relaxed">
            Sorry, the page you are looking for doesn't exist.
            <br />
            It may have been moved or deleted.
          </p>

          <div
            id="not-found-button-group"
            className="flex flex-col sm:flex-row gap-3 justify-center"
          >
            <Button
              onClick={handleGoHome}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg transition-all duration-200 shadow-md hover:shadow-md"
            >
              <Home className="w-4 h-4 mr-2" />
              Go Home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );

  return user ? <DashboardLayout>{page}</DashboardLayout> : page;
}
