import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import Tenants from "./pages/Tenants";
import TenantDetail from "./pages/TenantDetail";
import Products from "./pages/Products";
import Conversations from "./pages/Conversations";
import Orders from "./pages/Orders";
import Payments from "./pages/Payments";
import AgentConsole from "./pages/AgentConsole";
import ServiceHealth from "./pages/ServiceHealth";
import TwentyCRM from "./pages/TwentyCRM";
import OdooERP from "./pages/OdooERP";
import MenuBuilder from "./pages/MenuBuilder";
import IntegrationHub from "./pages/IntegrationHub";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/tenants" component={Tenants} />
      <Route path="/tenants/:id" component={TenantDetail} />
      <Route path="/products" component={Products} />
      <Route path="/conversations" component={Conversations} />
      <Route path="/orders" component={Orders} />
      <Route path="/payments" component={Payments} />
      <Route path="/agent" component={AgentConsole} />
      <Route path="/health" component={ServiceHealth} />
      <Route path="/twenty-crm" component={TwentyCRM} />
      <Route path="/odoo-erp" component={OdooERP} />
      <Route path="/menu-builder" component={MenuBuilder} />
      <Route path="/integrations" component={IntegrationHub} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
