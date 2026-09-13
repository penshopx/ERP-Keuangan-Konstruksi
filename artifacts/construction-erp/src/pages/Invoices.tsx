import { useState } from "react"
import { useListInvoices, useCreateInvoice, getListInvoicesQueryKey, useListProjects, useDecideInvoice } from "@workspace/api-client-react"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatRupiah, formatDate } from "@/lib/utils"
import { FilePlus, Search, Receipt } from "lucide-react"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { hasPermission, useAccess } from "@/lib/access"
import { Check, X } from "lucide-react"

export default function Invoices() {
  const [search, setSearch] = useState("")
  const { data: invoices, isLoading } = useListInvoices()
  const { data: projects } = useListProjects()
  
  const queryClient = useQueryClient()
  const createInvoice = useCreateInvoice()
  const decideInvoice = useDecideInvoice()
  const access = useAccess()
  const canCreate = hasPermission(access, "invoices:write")
  const canApprove = hasPermission(access, "invoices:approve")
  
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [newInv, setNewInv] = useState<{
    projectId: string
    period: string
    dpp: string
    retentionPercent: string
    issuedAt: string
    qualification: "KECIL" | "MENENGAH" | "BESAR"
  }>({
    projectId: "",
    period: "",
    dpp: "",
    retentionPercent: "5",
    issuedAt: new Date().toISOString().slice(0, 10),
    qualification: "KECIL",
  })

  const filteredInvoices = invoices?.filter(i => 
    i.number.toLowerCase().includes(search.toLowerCase()) || 
    i.projectName.toLowerCase().includes(search.toLowerCase())
  )

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    createInvoice.mutate({
      data: {
        projectId: newInv.projectId,
        period: newInv.period,
        dpp: Number(newInv.dpp),
        retentionPercent: Number(newInv.retentionPercent),
        issuedAt: newInv.issuedAt,
        integrated: true,
        serviceType: "KONSTRUKSI",
        qualification: newInv.qualification,
        hasSbu: true,
        supplierPkp: true,
        governmentCollector: false,
      }
    }, {
      onSuccess: () => {
        setIsDialogOpen(false)
        setNewInv({ projectId: "", period: "", dpp: "", retentionPercent: "5", issuedAt: new Date().toISOString().slice(0, 10), qualification: "KECIL" })
        queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() })
      }
    })
  }

  const decide = (invoiceId: string, decision: "APPROVE" | "REJECT") => {
    decideInvoice.mutate({ invoiceId, data: { decision } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() }),
    })
  }

  // Calculate live preview
  const dppVal = Number(newInv.dpp) || 0
  const retentionVal = dppVal * (Number(newInv.retentionPercent) / 100)
  const baseDpp = dppVal
  const ppnVal = baseDpp * 0.11
  const pphRates = { KECIL: 0.0175, MENENGAH: 0.0265, BESAR: 0.0265 } as const
  const pphVal = baseDpp * pphRates[newInv.qualification]
  const totalVal = baseDpp + ppnVal - pphVal

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">Billing & Invoices</h1>
          <p className="text-muted-foreground">Manage project termin billings with automatic tax breakdown.</p>
        </div>
        
        {canCreate && <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <FilePlus className="mr-2 h-4 w-4" />
              Create Invoice
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle>Issue New Termin Invoice</DialogTitle>
                <DialogDescription>Tax breakdown (PPN 11%, PPh Final) will be calculated automatically.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-6 py-4 md:grid-cols-2">
                <div className="flex flex-col gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="project">Project</Label>
                    <Select value={newInv.projectId} onValueChange={(v) => setNewInv({...newInv, projectId: v})}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select Project" />
                      </SelectTrigger>
                      <SelectContent>
                        {projects?.filter(p => p.status === 'active').map(p => (
                          <SelectItem key={p.id} value={p.id}>{p.code} - {p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="period">Billing Period (Termin)</Label>
                    <Input id="period" required value={newInv.period} onChange={e => setNewInv({...newInv, period: e.target.value})} placeholder="e.g. Termin 1 - 25%" />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="dpp">Gross Progress Value (IDR)</Label>
                    <Input id="dpp" type="number" required value={newInv.dpp} onChange={e => setNewInv({...newInv, dpp: e.target.value})} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="retention">Retention (%)</Label>
                      <Input id="retention" type="number" step="0.1" required value={newInv.retentionPercent} onChange={e => setNewInv({...newInv, retentionPercent: e.target.value})} />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="issuedAt">Invoice Date</Label>
                      <Input id="issuedAt" type="date" required value={newInv.issuedAt} onChange={e => setNewInv({...newInv, issuedAt: e.target.value})} />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label>Construction Qualification</Label>
                    <Select value={newInv.qualification} onValueChange={(qualification: "KECIL" | "MENENGAH" | "BESAR") => setNewInv({...newInv, qualification})}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="KECIL">Small — SBU verified</SelectItem>
                        <SelectItem value="MENENGAH">Medium — SBU verified</SelectItem>
                        <SelectItem value="BESAR">Large — SBU verified</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                
                {/* Live Preview Panel */}
                <div className="rounded-lg border bg-muted/30 p-4 flex flex-col gap-3">
                  <h4 className="font-semibold flex items-center gap-2 mb-2"><Receipt className="h-4 w-4"/> Invoice Preview</h4>
                  
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Gross Progress (DPP)</span>
                    <span>{formatRupiah(dppVal)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-destructive">
                    <span>Retention ({newInv.retentionPercent || 0}%)</span>
                    <span>- {formatRupiah(retentionVal)}</span>
                  </div>
                  <div className="border-t border-border/50 my-1 pt-2 flex justify-between text-sm font-medium">
                    <span>Tax Base</span>
                    <span>{formatRupiah(baseDpp)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-emerald-500">
                    <span>PPN (11%)</span>
                    <span>+ {formatRupiah(ppnVal)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-destructive">
                    <span>PPh Final ({(pphRates[newInv.qualification] * 100).toFixed(2)}%)</span>
                    <span>- {formatRupiah(pphVal)}</span>
                  </div>
                  <div className="border-t-2 border-border mt-2 pt-3 flex justify-between text-lg font-bold">
                    <span>Total Net Receive</span>
                    <span>{formatRupiah(totalVal)}</span>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createInvoice.isPending || !newInv.projectId}>
                  {createInvoice.isPending ? "Generating..." : "Generate Invoice"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input 
            type="search" 
            placeholder="Search invoice number or project..." 
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
              <TableHead>Invoice No.</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">DPP</TableHead>
              <TableHead className="text-right">Tax (PPN-PPh)</TableHead>
              <TableHead className="text-right">Total Net</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Issued</TableHead>
              {canApprove && <TableHead className="text-right">Approval</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={canApprove ? 9 : 8} className="h-24 text-center">Loading invoices...</TableCell>
              </TableRow>
            ) : !filteredInvoices?.length ? (
              <TableRow>
                <TableCell colSpan={canApprove ? 9 : 8} className="h-24 text-center">No invoices found.</TableCell>
              </TableRow>
            ) : (
              filteredInvoices.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-mono text-sm font-medium">{inv.number}</TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{inv.projectName}</span>
                      <span className="text-xs text-muted-foreground">{inv.projectCode}</span>
                    </div>
                  </TableCell>
                  <TableCell>{inv.period}</TableCell>
                  <TableCell className="text-right font-medium">{formatRupiah(inv.dpp)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-col text-xs">
                      <span className="text-emerald-500">+{formatRupiah(inv.ppn)}</span>
                      <span className="text-destructive">-{formatRupiah(inv.pphFinal)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-bold text-primary">{formatRupiah(inv.total)}</TableCell>
                  <TableCell>
                    <Badge variant={
                      inv.status === "paid" ? "success" : 
                      inv.status === "issued" ? "default" : "secondary"
                    }>
                      {inv.status.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(inv.issuedAt)}</TableCell>
                  {canApprove && <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" disabled={decideInvoice.isPending} onClick={() => decide(inv.id, "REJECT")}><X className="mr-1 h-3.5 w-3.5" />Tolak</Button>
                      <Button size="sm" disabled={decideInvoice.isPending} onClick={() => decide(inv.id, "APPROVE")}><Check className="mr-1 h-3.5 w-3.5" />Setujui</Button>
                    </div>
                  </TableCell>}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
