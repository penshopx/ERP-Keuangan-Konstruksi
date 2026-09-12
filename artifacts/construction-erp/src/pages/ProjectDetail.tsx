import { useGetProject, useUpdateProject, getGetProjectQueryKey } from "@workspace/api-client-react"
import { useParams, Link } from "wouter"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { formatRupiah, formatPercent, formatDate } from "@/lib/utils"
import { Building2, Calendar, FileText, ArrowLeft, TrendingUp, AlertTriangle } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export default function ProjectDetail() {
  const { id } = useParams()
  const { data: project, isLoading } = useGetProject(id || "")
  const updateProject = useUpdateProject()
  const queryClient = useQueryClient()

  if (isLoading || !project) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  const handleComplete = () => {
    updateProject.mutate({
      projectId: project.id,
      data: { status: "completed", progress: 100 }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(project.id) })
      }
    })
  }

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <div className="flex items-center gap-4">
        <Link href="/projects" className="flex h-9 w-9 items-center justify-center rounded-md border bg-background hover:bg-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
            <Badge variant={project.status === "active" ? "default" : "secondary"}>
              {project.status.toUpperCase()}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            {project.code} &bull; {project.owner}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" asChild>
            <Link href={`/projects/${project.id}/rab`}>
              <FileText className="mr-2 h-4 w-4" />
              View RAB
            </Link>
          </Button>
          {project.status !== "completed" && (
            <Button onClick={handleComplete} disabled={updateProject.isPending}>
              Mark Completed
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Contract Value</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatRupiah(project.contractValue)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Budget (RAB)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatRupiah(project.budget)}</div>
            <p className="text-xs text-muted-foreground mt-1">Margin: {formatPercent(((project.contractValue - project.budget) / project.contractValue) * 100)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Actual Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatRupiah(project.actualCost)}</div>
            <div className="mt-2">
              <Progress value={project.budgetUtilization * 100} indicatorColor={project.budgetUtilization > 1 ? "bg-destructive" : "bg-primary"} />
              <p className="text-xs text-muted-foreground mt-1 text-right">{formatPercent(project.budgetUtilization * 100)} Used</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold flex items-center gap-2">
              <Calendar className="h-5 w-5 text-muted-foreground" />
              {formatDate(project.endDate)}
            </div>
            <div className="mt-2">
              <Progress value={project.progress} indicatorColor="bg-emerald-500" />
              <p className="text-xs text-muted-foreground mt-1 text-right">{formatPercent(project.progress)} Progress</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Earned Value Management (EVM)</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-8">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-muted-foreground">Schedule Performance Index (SPI)</span>
              <div className="flex items-center gap-3">
                <span className="text-4xl font-bold">{project.spi.toFixed(2)}</span>
                {project.spi >= 1 ? (
                  <Badge variant="success" className="h-6"><TrendingUp className="mr-1 h-3 w-3"/> Ahead</Badge>
                ) : (
                  <Badge variant="warning" className="h-6"><AlertTriangle className="mr-1 h-3 w-3"/> Behind</Badge>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-muted-foreground">Cost Performance Index (CPI)</span>
              <div className="flex items-center gap-3">
                <span className="text-4xl font-bold">{project.cpi.toFixed(2)}</span>
                {project.cpi >= 1 ? (
                  <Badge variant="success" className="h-6"><TrendingUp className="mr-1 h-3 w-3"/> Under Budget</Badge>
                ) : (
                  <Badge variant="destructive" className="h-6"><AlertTriangle className="mr-1 h-3 w-3"/> Over Budget</Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Invoices</CardTitle>
            <Button variant="link" className="h-auto p-0" asChild>
              <Link href={`/invoices?projectId=${project.id}`}>View All</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {project.recentInvoices.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No invoices issued yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {project.recentInvoices.map(inv => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium">{inv.number}</TableCell>
                      <TableCell>{inv.period}</TableCell>
                      <TableCell className="text-right">{formatRupiah(inv.total)}</TableCell>
                      <TableCell>
                        <Badge variant={inv.status === 'paid' ? 'success' : 'outline'}>{inv.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
