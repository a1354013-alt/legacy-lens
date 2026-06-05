import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { t } from "./locales";

const Home = lazy(() => import("./pages/Home"));
const ImportProject = lazy(() => import("./pages/ImportProject"));
const AnalysisResult = lazy(() => import("./pages/AnalysisResult"));
const NotFound = lazy(() => import("./pages/NotFound"));

function Router() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-slate-50">{t("common.loading")}...</div>}>
      <Switch>
        <Route path={"/"} component={Home} />
        <Route path={"/import"} component={ImportProject} />
        <Route path={"/projects/:id/analysis"} component={AnalysisResult} />
        <Route path={"/404"} component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
