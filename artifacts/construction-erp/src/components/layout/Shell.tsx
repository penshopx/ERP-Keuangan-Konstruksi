import { Link, useLocation } from "wouter"
import { 
  Building2, 
  LayoutDashboard, 
  ReceiptText, 
  Calculator,
  History,
  Settings,
  Bell
} from "lucide-react"
import { cn } from "@/lib/utils"

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Projects", href: "/projects", icon: Building2 },
  { name: "Invoices", href: "/invoices", icon: ReceiptText },
  { name: "Tax & Recon", href: "/tax", icon: Calculator },
  { name: "Audit Trail", href: "/audit", icon: History },
]

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation()

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
            {navigation.map((item) => {
              const isActive = item.href === "/" ? location === "/" : location.startsWith(item.href)
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
          <button className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <Settings className="h-4 w-4" />
            Settings
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
              <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-blue-500 to-emerald-500 border-2 border-background" />
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
