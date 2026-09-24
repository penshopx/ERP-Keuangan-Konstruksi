import { useEffect, useRef, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { useGetCurrentUser } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/components/theme-provider';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Redirect,
  Router as WouterRouter,
} from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { AccessProvider } from '@/lib/access';
import { Button } from '@/components/ui/button';

import { Shell } from '@/components/layout/Shell';
import Dashboard from '@/pages/Dashboard';
import Projects from '@/pages/Projects';
import ProjectDetail from '@/pages/ProjectDetail';
import ProjectRab from '@/pages/ProjectRab';
import Invoices from '@/pages/Invoices';
import TaxSummary from '@/pages/TaxSummary';
import TaxRules from '@/pages/TaxRules';
import AuditActivity from '@/pages/AuditActivity';
import CopilotUsage from '@/pages/CopilotUsage';
import AccessManagement from '@/pages/AccessManagement';
import PettyCash from '@/pages/PettyCash';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const stripBase = (path: string) => basePath && path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#2563eb", colorForeground: "#0f172a", colorMutedForeground: "#64748b",
    colorDanger: "#dc2626", colorBackground: "#ffffff", colorInput: "#f8fafc",
    colorInputForeground: "#0f172a", colorNeutral: "#cbd5e1",
    fontFamily: "'Plus Jakarta Sans', sans-serif", borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center", cardBox: "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden border shadow-xl",
    card: "!shadow-none !border-0 !bg-transparent", footer: "!shadow-none !border-0 !bg-transparent",
    headerTitle: "text-slate-950", headerSubtitle: "text-slate-600", socialButtonsBlockButtonText: "text-slate-900",
    formFieldLabel: "text-slate-800", footerActionLink: "text-blue-700", footerActionText: "text-slate-600",
    dividerText: "text-slate-500", identityPreviewEditButton: "text-blue-700", formFieldSuccessText: "text-emerald-700",
    alertText: "text-slate-900", logoBox: "h-12", logoImage: "h-10", socialButtonsBlockButton: "border-slate-300",
    formButtonPrimary: "bg-blue-600 hover:bg-blue-700", formFieldInput: "bg-slate-50 text-slate-950 border-slate-300",
    footerAction: "bg-slate-50", dividerLine: "bg-slate-200", alert: "bg-amber-50", otpCodeFieldInput: "border-slate-300",
    formFieldRow: "text-slate-900", main: "text-slate-950",
  },
};

function Portal() {
  const { data: access, isLoading, error } = useGetCurrentUser();
  if (isLoading) return <div className="grid min-h-screen place-items-center">Memuat hak akses...</div>;
  if (error || !access) return <div className="grid min-h-screen place-items-center text-destructive">Hak akses pengguna tidak dapat dimuat.</div>;
  return (
    <AccessProvider value={access}>
    <Shell>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/portal" component={Dashboard} />
          <Route path="/portal/projects" component={Projects} />
          <Route path="/portal/projects/:id" component={ProjectDetail} />
          <Route path="/portal/projects/:id/rab" component={ProjectRab} />
          <Route path="/portal/invoices" component={Invoices} />
          <Route path="/portal/petty-cash" component={PettyCash} />
          <Route path="/portal/tax" component={TaxSummary} />
          <Route path="/portal/tax-rules" component={TaxRules} />
          <Route path="/portal/audit" component={AuditActivity} />
          <Route path="/portal/copilot-usage" component={CopilotUsage} />
          <Route path="/portal/access" component={AccessManagement} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </Shell>
    </AccessProvider>
  );
}

function Home() {
  return (
    <>
      <Show when="signed-in"><Redirect to="/portal" /></Show>
      <Show when="signed-out">
        <main className="grid min-h-screen place-items-center bg-slate-950 px-6 text-white">
          <div className="max-w-2xl text-center">
            <img src={`${basePath}/logo.svg`} className="mx-auto mb-8 h-16" alt="Konstruksi ERP" />
            <h1 className="text-4xl font-bold">Kontrol keuangan proyek sesuai tanggung jawab setiap jabatan.</h1>
            <p className="mt-4 text-lg text-slate-300">Masuk untuk melihat proyek, invoice, pajak, dan approval yang menjadi kewenangan Anda.</p>
            <Button className="mt-8" asChild><a href={`${basePath}/sign-in`}>Masuk ke ERP</a></Button>
          </div>
        </main>
      </Show>
    </>
  );
}

function ProtectedPortal() {
  return <><Show when="signed-in"><Portal /></Show><Show when="signed-out"><Redirect to="/" /></Show></>;
}

function SignInPage() {
  return <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>;
}
function SignUpPage() {
  return <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>;
}

function ClerkCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const id = user?.id ?? null;
    if (previous.current !== undefined && previous.current !== id) client.clear();
    previous.current = id;
  }), [addListener, client]);
  return null;
}

function AuthenticatedRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance}
    signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}
    localization={{ signIn: { start: { title: "Selamat datang kembali", subtitle: "Masuk untuk mengakses Konstruksi ERP" } }, signUp: { start: { title: "Buat akun ERP", subtitle: "Daftarkan akun kerja Anda" } } }}
    routerPush={(to) => setLocation(stripBase(to))} routerReplace={(to) => setLocation(stripBase(to), { replace: true })}>
    <ClerkCacheInvalidator />
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/portal/*?" component={ProtectedPortal} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route component={NotFound} />
    </Switch>
  </ClerkProvider>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <WouterRouter base={basePath}>
            <AuthenticatedRoutes />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
