import { Link, useLocation } from "wouter"
import { 
  Building2, 
  LayoutDashboard, 
  ReceiptText, 
  Calculator,
  Scale,
  History,
  Settings,
  Bell
} from "lucide-react"
import { WalletCards } from "lucide-react"
import { cn } from "@/lib/utils"
import { useClerk } from "@clerk/react"
import { hasPermission, useAccess } from "@/lib/access"
import { LogOut } from "lucide-react"

const navigation = [
  { name: "Dashboard", href: "/portal", icon: LayoutDashboard },
  { name: "Projects", href: "/portal/projects", icon: Building2, permission: "projects:view" },
  { name: "Invoices", href: "/portal/invoices", icon: ReceiptText, permission: "invoices:view" },
  { name: "Kas Kecil", href: "/portal/petty-cash", icon: WalletCards, permission: "petty-cash:view" },
  { name: "Tax & Recon", href: "/portal/tax", icon: Calculator, permission: "tax:view", exact: true },
  { name: "Aturan Pajak", href: "/portal/tax-rules", icon: Scale, permission: "tax-rules:manage" },
  { name: "Audit Trail", href: "/portal/audit", icon: History, permission: "audit:view" },
  { name: "Hak Akses", href: "/portal/access", icon: Settings, role: "DIRECTOR" },
  { name: "Penggunaan Copilot", href: "/portal/copilot-usage", icon: History, role: "DIRECTOR" },
]
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "")

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation()
  const access = useAccess()
  const { signOut } = useClerk()

  return (
    <div className="flex min-h-screen w-full flex-col bg-background">
      <aside className="fixed inset-y-0 left-0 z-10 hidden w-64 flex-col border-r bg-card sm:flex">
        <div className="flex h-14 items-center border-b px-4 lg:h-[60px] lg:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Building2 className="h-5 w-5" />
            </div>
            <span className="text-lg tracking-tight">Konstruksi ERP</span>
          </Link>
        </div>
        <div className="flex-1 overflow-auto py-4">
          <nav className="grid items-start px-4 text-sm font-medium gap-1">
            {navigation.filter((item) => (!item.permission || hasPermission(access, item.permission)) && (!item.role || item.role === access.role)).map((item) => {
              const isActive = item.href === "/portal" || item.exact ? location === item.href : location.startsWith(item.href)
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors",
                    isActive 
                      ? "bg-primary text-primary-foreground" 
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.name}
                </Link>
              )
            })}
          </nav>
        </div>
        <div className="border-t p-4">
          <button onClick={() => signOut({ redirectUrl: basePath || "/" })} className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <LogOut className="h-4 w-4" />
            Keluar
          </button>
        </div>
      </aside>
      
      <div className="flex flex-1 flex-col sm:pl-64">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-background/95 px-4 backdrop-blur sm:static sm:h-[60px] sm:bg-transparent sm:px-6">
          <div className="flex flex-1 items-center justify-between sm:justify-end">
            <div className="sm:hidden">
              <span className="font-semibold">Konstruksi ERP</span>
            </div>
            <div className="flex items-center gap-4">
              <button className="relative flex h-8 w-8 items-center justify-center rounded-full border bg-background hover:bg-muted">
                <Bell className="h-4 w-4" />
                <span className="absolute right-1.5 top-1.5 flex h-2 w-2 rounded-full bg-primary" />
              </button>
               <div className="text-right"><div className="text-sm font-semibold">{access.displayName}</div><div className="text-xs text-muted-foreground">{access.role.replaceAll("_", " ")}</div></div>
            </div>
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  )
}
