import { useState } from "react"
import { useListProjects, useCreateProject, getListProjectsQueryKey } from "@workspace/api-client-react"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { formatRupiah, formatPercent, formatDate } from "@/lib/utils"
import { Link } from "wouter"
import { Plus, Search, Building2, TrendingUp, AlertCircle } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"

export default function Projects() {
  const [search, setSearch] = useState("")
  const { data: projects, isLoading } = useListProjects({ search: search || undefined })
  const queryClient = useQueryClient()
  const createProject = useCreateProject()
  
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [newProject, setNewProject] = useState({ code: "", name: "", owner: "", contractValue: "", endDate: "" })

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    createProject.mutate({
      data: {
        code: newProject.code,
        name: newProject.name,
        owner: newProject.owner,
        contractValue: Number(newProject.contractValue),
        endDate: newProject.endDate
      }
    }, {
      onSuccess: () => {
        setIsDialogOpen(false)
        setNewProject({ code: "", name: "", owner: "", contractValue: "", endDate: "" })
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() })
      }
    })
  }

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">Project Portfolio</h1>
          <p className="text-muted-foreground">Manage active construction projects and monitor performance.</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Project
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle>Create New Project</DialogTitle>
                <DialogDescription>Add a new project to the ERP portfolio.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="code">Project Code</Label>
                  <Input id="code" required value={newProject.code} onChange={e => setNewProject({...newProject, code: e.target.value})} placeholder="e.g. PRJ-2023-01" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="name">Project Name</Label>
                  <Input id="name" required value={newProject.name} onChange={e => setNewProject({...newProject, name: e.target.value})} placeholder="e.g. Tol Trans Sumatera" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="owner">Client / Owner</Label>
                  <Input id="owner" required value={newProject.owner} onChange={e => setNewProject({...newProject, owner: e.target.value})} placeholder="e.g. PT Hutama Karya" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="value">Contract Value (IDR)</Label>
                  <Input id="value" type="number" required value={newProject.contractValue} onChange={e => setNewProject({...newProject, contractValue: e.target.value})} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="date">End Date</Label>
                  <Input id="date" type="date" required value={newProject.endDate} onChange={e => setNewProject({...newProject, endDate: e.target.value})} />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createProject.isPending}>
                  {createProject.isPending ? "Creating..." : "Save Project"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input 
            type="search" 
            placeholder="Search projects..." 
            className="pl-8" 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Contract Value</TableHead>
              <TableHead className="w-[200px]">Progress</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Health</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">Loading projects...</TableCell>
              </TableRow>
            ) : !projects?.length ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">No projects found.</TableCell>
              </TableRow>
            ) : (
              projects.map((project) => (
                <TableRow key={project.id} className="group">
                  <TableCell>
                    <div className="flex flex-col">
                      <Link href={`/projects/${project.id}`} className="font-semibold text-primary hover:underline">
                        {project.name}
                      </Link>
                      <span className="text-xs text-muted-foreground">{project.code}</span>
                    </div>
                  </TableCell>
                  <TableCell>{project.owner}</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatRupiah(project.contractValue)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-xs">
                        <span>{formatPercent(project.progress)}</span>
                      </div>
                      <Progress value={project.progress} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={project.status === "active" ? "default" : "secondary"}>
                      {project.status.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge 
                      variant={
                        project.health === "healthy" ? "success" : 
                        project.health === "at_risk" ? "warning" : "destructive"
                      }
                      className="gap-1"
                    >
                      {project.health === "healthy" ? <TrendingUp className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                      {project.health.replace("_", " ").toUpperCase()}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
