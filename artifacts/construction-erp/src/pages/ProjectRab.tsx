import { useGetProjectRab } from "@workspace/api-client-react"
import { useParams, Link } from "wouter"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ArrowLeft, AlertTriangle } from "lucide-react"
import { formatRupiah, formatPercent } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"

import { ImportTemplateSheet } from "@/components/rab/ImportTemplateSheet"

export default function ProjectRab() {
  const { id } = useParams()
  const { data: rab, isLoading, isError } = useGetProjectRab(id || "")

  if (isLoading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }
  if (isError || !rab) {
    return <div className="flex h-[50vh] items-center justify-center text-destructive">RAB proyek tidak dapat dimuat.</div>
  }

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <div className="flex items-center gap-4">
        <Link href={`/portal/projects/${id}`} className="flex h-9 w-9 items-center justify-center rounded-md border bg-background hover:bg-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">Rencana Anggaran Biaya (RAB)</h1>
            <Badge variant="outline">v{rab.version}.0</Badge>
            <Badge variant={rab.status.includes("DISETUJUI") ? "success" : "secondary"}>
              {rab.status.toUpperCase()}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">Baseline pengendalian biaya dan struktur WBS proyek.</p>
        </div>
        <div className="ml-auto">
          <ImportTemplateSheet projectId={id || ""} currentTotal={rab.totalBudget} />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card className="bg-muted/30">
          <CardContent className="p-6">
            <div className="text-sm font-medium text-muted-foreground mb-2">Total Budget</div>
            <div className="text-2xl font-bold">{formatRupiah(rab.totalBudget)}</div>
          </CardContent>
        </Card>
        <Card className="bg-muted/30">
          <CardContent className="p-6">
            <div className="text-sm font-medium text-muted-foreground mb-2">Committed Cost (PO)</div>
            <div className="text-2xl font-bold text-amber-500">{formatRupiah(rab.committed)}</div>
          </CardContent>
        </Card>
        <Card className="bg-muted/30">
          <CardContent className="p-6">
            <div className="text-sm font-medium text-muted-foreground mb-2">Actual Cost (Paid)</div>
            <div className="text-2xl font-bold text-emerald-500 dark:text-emerald-400">{formatRupiah(rab.actual)}</div>
          </CardContent>
        </Card>
        <Card className="bg-muted/30">
          <CardContent className="p-6">
            <div className="text-sm font-medium text-muted-foreground mb-2">Remaining Budget</div>
            <div className="text-2xl font-bold">{formatRupiah(rab.remaining)}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">WBS Code</TableHead>
              <TableHead>Work Item</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Budget</TableHead>
              <TableHead className="text-right">Actual + Committed</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead className="w-[150px]">Utilization</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rab.items.map((item) => {
              const isOverbudget = item.variance < 0
              return (
                <TableRow key={item.id} className={item.level === 0 ? "bg-muted/10" : ""}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{item.code}</TableCell>
                  <TableCell>
                    <div className="font-medium" style={{ paddingLeft: `${item.level * 1.5}rem` }}>
                      {item.name}
                    </div>
                    {item.quantity > 0 && (
                      <div className="text-xs text-muted-foreground mt-1" style={{ paddingLeft: `${item.level * 1.5}rem` }}>
                        {item.quantity.toLocaleString("id-ID")} {item.unit} @ {formatRupiah(item.unitPrice)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-normal text-xs">{item.category}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{formatRupiah(item.budget)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(item.actual + item.committed)}</TableCell>
                  <TableCell className={`text-right font-medium ${isOverbudget ? 'text-destructive' : 'text-emerald-500 dark:text-emerald-400'}`}>
                    {isOverbudget && "-"} {formatRupiah(Math.abs(item.variance))}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 mt-1">
                      <Progress 
                        value={Math.min(item.utilization, 100)}
                        indicatorColor={isOverbudget ? "bg-destructive" : "bg-primary"} 
                      />
                      <div className="flex justify-between items-center text-[10px] text-muted-foreground">
                        <span>{formatPercent(item.utilization)}</span>
                        {isOverbudget && <AlertTriangle className="h-3 w-3 text-destructive" />}
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3} className="text-right font-bold">Total</TableCell>
              <TableCell className="text-right font-bold">{formatRupiah(rab.totalBudget)}</TableCell>
              <TableCell className="text-right font-bold">{formatRupiah(rab.actual + rab.committed)}</TableCell>
              <TableCell className="text-right font-bold">{formatRupiah(rab.remaining)}</TableCell>
              <TableCell></TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </Card>
    </div>
  )
}
