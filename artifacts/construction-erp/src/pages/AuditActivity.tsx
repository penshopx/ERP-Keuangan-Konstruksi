import { useListActivity } from "@workspace/api-client-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { formatDate } from "@/lib/utils"
import { History, Shield, CheckCircle2, AlertTriangle, Info } from "lucide-react"
import { cn } from "@/lib/utils"

export default function AuditActivity() {
  const { data: activities, isLoading } = useListActivity()

  if (isLoading || !activities) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  const getToneIcon = (tone: string) => {
    switch(tone) {
      case 'positive': return <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      case 'warning': return <AlertTriangle className="h-4 w-4 text-amber-500" />
      case 'critical': return <Shield className="h-4 w-4 text-destructive" />
      default: return <Info className="h-4 w-4 text-primary" />
    }
  }

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500 max-w-4xl mx-auto">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Audit Trail</h1>
        <p className="text-muted-foreground">Immutable timeline of critical financial operations.</p>
      </div>

      <div className="relative border-l border-muted ml-4 md:ml-6 mt-4 pb-8 space-y-8">
        {activities.map((activity, index) => (
          <div key={activity.id} className="relative pl-6 md:pl-8">
            <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-background border shadow-sm">
              {getToneIcon(activity.tone)}
            </span>
            
            <Card className={cn(
              "transition-all hover:shadow-md",
              activity.tone === 'critical' ? 'border-destructive/50 bg-destructive/5' : ''
            )}>
              <CardContent className="p-4 sm:p-5">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="uppercase text-[10px] tracking-wider font-semibold">
                      {activity.action}
                    </Badge>
                    <span className="text-sm font-medium">{activity.entity}</span>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDate(activity.timestamp)} • {new Date(activity.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                
                <p className="text-sm my-2 text-foreground/90">{activity.detail}</p>
                
                <div className="flex items-center gap-2 mt-4 pt-4 border-t text-xs text-muted-foreground">
                  <div className="h-5 w-5 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
                    {activity.user.charAt(0)}
                  </div>
                  <span>Authorized by <span className="font-medium text-foreground">{activity.user}</span></span>
                </div>
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    </div>
  )
}
