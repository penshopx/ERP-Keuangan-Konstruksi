import { useState } from "react"
import { useGetTaxSummary } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatRupiah } from "@/lib/utils"
import { Download, FileCheck, CheckCircle2, AlertTriangle, FileText } from "lucide-react"

const PERIODS = ["2024-03", "2024-02", "2024-01", "2023-12", "2023-11", "2023-10"]

export default function TaxSummary() {
  const [period, setPeriod] = useState(PERIODS[0])
  const { data: tax, isLoading } = useGetTaxSummary({ period })

  if (isLoading || !tax) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  const isReconciled = tax.reconciliation === 1

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">Tax & Reconciliation</h1>
          <p className="text-muted-foreground">Monthly SPT PPN and PPh Final reporting console.</p>
        </div>
        <div className="flex items-center gap-4">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Select Period" />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map(p => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline">
            <Download className="mr-2 h-4 w-4" />
            Export SPT
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="bg-primary/5 border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-primary">Total Tax Obligation</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-primary">{formatRupiah(tax.total)}</div>
            <div className="mt-4 flex items-center gap-2 text-sm">
              {isReconciled ? (
                <span className="flex items-center text-emerald-500 font-medium"><CheckCircle2 className="mr-1 h-4 w-4" /> Fully Reconciled</span>
              ) : (
                <span className="flex items-center text-amber-500 font-medium"><AlertTriangle className="mr-1 h-4 w-4" /> Pending Reconciliation</span>
              )}
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">PPh Final (Pasal 4 Ayat 2)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatRupiah(tax.pphFinal)}</div>
            <p className="text-xs text-muted-foreground mt-1">Construction Services Tax</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">PPN (Value Added Tax)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatRupiah(tax.ppn)}</div>
            <p className="text-xs text-muted-foreground mt-1">Collected Output Tax</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileCheck className="h-5 w-5" /> Documents Generated
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  <div className="rounded bg-muted p-2"><FileText className="h-4 w-4" /></div>
                  <div>
                    <p className="font-medium text-sm">Faktur Pajak Keluaran</p>
                    <p className="text-xs text-muted-foreground">{tax.documents} documents linked</p>
                  </div>
                </div>
                <Button variant="outline" size="sm">Download e-Faktur</Button>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  <div className="rounded bg-muted p-2"><FileText className="h-4 w-4" /></div>
                  <div>
                    <p className="font-medium text-sm">Bukti Potong PPh Final</p>
                    <p className="text-xs text-muted-foreground">Collected from clients</p>
                  </div>
                </div>
                <Button variant="outline" size="sm">View Bukti Potong</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Reconciliation Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">General Ledger Balance</span>
                <span className="font-medium">{formatRupiah(tax.total)}</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Tax Sub-ledger Balance</span>
                <span className="font-medium">{formatRupiah(tax.subLedgerTotal)}</span>
              </div>
              <div className="border-t pt-4 mt-2">
                <div className="flex justify-between items-center">
                  <span className="font-medium">Variance</span>
                  <span className={`font-bold ${isReconciled ? 'text-emerald-500' : 'text-destructive'}`}>
                    {formatRupiah(tax.total - tax.subLedgerTotal)}
                  </span>
                </div>
              </div>
              {!isReconciled && (
                <Dialog>
                  <DialogTrigger asChild>
                    <Button className="w-full mt-2" variant="secondary">
                      View {tax.reconciliationDetails.length} Mismatched Invoice{tax.reconciliationDetails.length === 1 ? "" : "s"}
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-4xl">
                    <DialogHeader>
                      <DialogTitle>Reconciliation Differences · {tax.period}</DialogTitle>
                      <DialogDescription>
                        Invoices whose tax value differs between the general ledger and tax snapshot.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="max-h-[60vh] overflow-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Invoice</TableHead>
                            <TableHead>Project</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead className="text-right">General Ledger</TableHead>
                            <TableHead className="text-right">Tax Snapshot</TableHead>
                            <TableHead className="text-right">Variance</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {tax.reconciliationDetails.map(detail => (
                            <TableRow key={detail.invoiceId}>
                              <TableCell className="font-medium">{detail.invoiceNumber}</TableCell>
                              <TableCell>{detail.projectName}</TableCell>
                              <TableCell>{detail.issuedAt}</TableCell>
                              <TableCell className="text-right">{formatRupiah(detail.ledgerTax)}</TableCell>
                              <TableCell className="text-right">{formatRupiah(detail.snapshotTax)}</TableCell>
                              <TableCell className="text-right font-semibold text-destructive">
                                {formatRupiah(detail.variance)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </DialogContent>
                </Dialog>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
