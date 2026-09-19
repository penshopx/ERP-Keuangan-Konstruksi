import { useMemo, useState } from "react";
import {
  getListPettyCashRequestsQueryKey,
  useCreatePettyCashRequest,
  useDecidePettyCashRequest,
  useDisbursePettyCashRequest,
  useListPettyCashRequests,
  useListProjects,
  useReconcilePettyCashRequest,
  useSettlePettyCashRequest,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { WalletCards } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate, formatRupiah } from "@/lib/utils";
import { getJakartaCalendarDate } from "@/lib/indonesia-date";
import { hasPermission, useAccess } from "@/lib/access";

const badgeVariant = (status: string) => status === "DIREKONSILIASI" ? "success" : status === "DITOLAK" ? "destructive" : status === "DIAJUKAN" ? "warning" : "secondary";

export default function PettyCash() {
  const search = useSearch();
  const projectFilter = new URLSearchParams(search).get("projectId") || undefined;
  const { data: requests = [], isLoading } = useListPettyCashRequests(projectFilter ? { projectId: projectFilter } : undefined);
  const { data: projects = [] } = useListProjects();
  const queryClient = useQueryClient();
  const access = useAccess();
  const create = useCreatePettyCashRequest();
  const decide = useDecidePettyCashRequest();
  const disburse = useDisbursePettyCashRequest();
  const settle = useSettlePettyCashRequest();
  const reconcile = useReconcilePettyCashRequest();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ projectId: projectFilter || "", purpose: "", costCode: "", requestedAmount: "", requestedAt: getJakartaCalendarDate() });

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListPettyCashRequestsQueryKey() });
  const totals = useMemo(() => requests.reduce((value, request) => ({
    requested: value.requested + request.requestedAmount,
    spent: value.spent + (request.spentAmount || 0),
    outstanding: value.outstanding + (request.status === "DICAIRKAN" ? request.disbursedAmount || 0 : 0),
  }), { requested: 0, spent: 0, outstanding: 0 }), [requests]);

  const createRequest = (event: React.FormEvent) => {
    event.preventDefault();
    create.mutate({ data: { ...form, requestedAmount: Number(form.requestedAmount) } }, {
      onSuccess: () => {
        setOpen(false);
        setForm({ projectId: projectFilter || "", purpose: "", costCode: "", requestedAmount: "", requestedAt: getJakartaCalendarDate() });
        refresh();
      },
    });
  };

  const approve = (id: string, amount: number) => {
    const note = window.prompt("Catatan persetujuan:");
    if (!note) return;
    decide.mutate({ requestId: id, data: { decision: "APPROVE", approvedAmount: amount, note } }, { onSuccess: refresh });
  };
  const reject = (id: string) => {
    const note = window.prompt("Alasan penolakan:");
    if (!note) return;
    decide.mutate({ requestId: id, data: { decision: "REJECT", note } }, { onSuccess: refresh });
  };
  const recordDisbursement = (id: string, amount: number) => {
    const reference = window.prompt("Referensi pencairan/bukti serah terima:");
    if (!reference) return;
    disburse.mutate({ requestId: id, data: { amount, reference } }, { onSuccess: refresh });
  };
  const submitSettlement = (id: string, disbursedAmount: number) => {
    const description = window.prompt("Deskripsi penggunaan:");
    if (!description) return;
    const amount = Number(window.prompt("Jumlah penggunaan (Rp):", String(disbursedAmount)));
    const receiptReference = window.prompt("Nomor/tautan bukti pengeluaran:");
    if (!receiptReference || !Number.isSafeInteger(amount) || amount <= 0 || amount > disbursedAmount) return;
    settle.mutate({
      requestId: id,
      data: {
        returnedAmount: disbursedAmount - amount,
        expenses: [{ expenseDate: getJakartaCalendarDate(), description, amount, receiptReference }],
      },
    }, { onSuccess: refresh });
  };
  const performReconciliation = (id: string, returnedAmount: number) => {
    const note = window.prompt("Catatan verifikasi rekonsiliasi:");
    if (!note) return;
    reconcile.mutate({ requestId: id, data: { physicalCashAmount: returnedAmount, note } }, { onSuccess: refresh });
  };

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight"><WalletCards className="h-7 w-7" />Kas Kecil Proyek</h1>
          <p className="mt-1 text-muted-foreground">Request, approval, pencairan, bukti, pengembalian, dan rekonsiliasi dalam satu audit trail.</p>
        </div>
        {hasPermission(access, "petty-cash:request") && <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button>Ajukan Kas Kecil</Button></DialogTrigger>
          <DialogContent>
            <form onSubmit={createRequest}>
              <DialogHeader><DialogTitle>Permintaan kas kecil</DialogTitle><DialogDescription>Permintaan akan memakai versi kebijakan yang berlaku pada tanggal pengajuan.</DialogDescription></DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2"><Label>Proyek</Label><Select required value={form.projectId} onValueChange={(projectId) => setForm({ ...form, projectId })}><SelectTrigger><SelectValue placeholder="Pilih proyek" /></SelectTrigger><SelectContent>{projects.filter((project) => project.status === "BERJALAN").map((project) => <SelectItem key={project.id} value={project.id}>{project.code} — {project.name}</SelectItem>)}</SelectContent></Select></div>
                <div className="grid gap-2"><Label htmlFor="purpose">Tujuan</Label><Textarea id="purpose" required value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} /></div>
                <div className="grid gap-2 sm:grid-cols-2"><div className="grid gap-2"><Label htmlFor="costCode">Cost code</Label><Input id="costCode" required value={form.costCode} onChange={(event) => setForm({ ...form, costCode: event.target.value })} /></div><div className="grid gap-2"><Label htmlFor="amount">Jumlah (Rp)</Label><Input id="amount" type="number" min="1" required value={form.requestedAmount} onChange={(event) => setForm({ ...form, requestedAmount: event.target.value })} /></div></div>
                <div className="grid gap-2"><Label htmlFor="requestedAt">Tanggal kebutuhan</Label><Input id="requestedAt" type="date" required value={form.requestedAt} onChange={(event) => setForm({ ...form, requestedAt: event.target.value })} /></div>
              </div>
              <DialogFooter><Button type="submit" disabled={create.isPending || !form.projectId}>Kirim permintaan</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total diminta</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{formatRupiah(totals.requested)}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Pengeluaran berbukti</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{formatRupiah(totals.spent)}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Belum dipertanggungjawabkan</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{formatRupiah(totals.outstanding)}</CardContent></Card>
      </div>

      <Card>
        <Table>
          <TableHeader><TableRow><TableHead>Proyek / Pemohon</TableHead><TableHead>Tujuan</TableHead><TableHead className="text-right">Jumlah</TableHead><TableHead>Status</TableHead><TableHead>Jatuh tempo bukti</TableHead><TableHead className="text-right">Tindakan</TableHead></TableRow></TableHeader>
          <TableBody>
            {isLoading ? <TableRow><TableCell colSpan={6} className="h-24 text-center">Memuat kas kecil...</TableCell></TableRow> : requests.length === 0 ? <TableRow><TableCell colSpan={6} className="h-24 text-center">Belum ada permintaan kas kecil.</TableCell></TableRow> : requests.map((request) => (
              <TableRow key={request.id}>
                <TableCell><div className="font-medium">{request.projectCode}</div><div className="text-xs text-muted-foreground">{request.requesterName}</div></TableCell>
                <TableCell><div>{request.purpose}</div><div className="text-xs text-muted-foreground">{request.costCode} · {request.policyVersion}</div></TableCell>
                <TableCell className="text-right font-medium">{formatRupiah(request.requestedAmount)}</TableCell>
                <TableCell><Badge variant={badgeVariant(request.status)}>{request.status.replaceAll("_", " ")}</Badge></TableCell>
                <TableCell>{formatDate(request.evidenceDueAt)}</TableCell>
                <TableCell><div className="flex flex-wrap justify-end gap-2">
                  {request.status === "DIAJUKAN" && hasPermission(access, "petty-cash:approve") && request.requesterUserId !== access.userId && <><Button size="sm" variant="outline" onClick={() => reject(request.id)}>Tolak</Button><Button size="sm" onClick={() => approve(request.id, request.requestedAmount)}>Setujui</Button></>}
                  {request.status === "DISETUJUI" && hasPermission(access, "petty-cash:disburse") && request.approverName !== access.displayName && <Button size="sm" onClick={() => recordDisbursement(request.id, request.approvedAmount || 0)}>Cairkan</Button>}
                  {request.status === "DICAIRKAN" && hasPermission(access, "petty-cash:settle") && (request.requesterUserId === access.userId || access.role === "DIRECTOR") && <Button size="sm" onClick={() => submitSettlement(request.id, request.disbursedAmount || 0)}>Kirim bukti</Button>}
                  {request.status === "DIPERTANGGUNGJAWABKAN" && hasPermission(access, "petty-cash:reconcile") && <Button size="sm" onClick={() => performReconciliation(request.id, request.returnedAmount || 0)}>Rekonsiliasi</Button>}
                </div></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}