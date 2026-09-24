import { useMemo, useState } from "react";
import {
  getListPettyCashRequestsQueryKey,
  getListPettyCashFundsQueryKey,
  getListPettyCashPoliciesQueryKey,
  getListAccessUsersQueryKey,
  getGetProjectRabQueryKey,
  useCreatePettyCashRequest,
  useDecidePettyCashRequest,
  useDisbursePettyCashRequest,
  useListPettyCashRequests,
  useListPettyCashFunds,
  useListPettyCashPolicies,
  useCreatePettyCashFund,
  useReplenishPettyCashFund,
  useCreatePettyCashPolicy,
  useResolvePettyCashEvidence,
  useVerifyPettyCashRequest,
  useEvaluatePettyCashRequest,
  useListProjects,
  useGetProjectRab,
  useListAccessUsers,
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

const badgeVariant = (status: string) => ["DIREKONSILIASI", "DIEVALUASI"].includes(status) ? "success" : status === "DITOLAK" ? "destructive" : status === "DIAJUKAN" ? "warning" : "secondary";

export default function PettyCash() {
  const search = useSearch();
  const projectFilter = new URLSearchParams(search).get("projectId") || undefined;
  const { data: requests = [], isLoading, isError: requestsError } = useListPettyCashRequests(projectFilter ? { projectId: projectFilter } : undefined);
  const { data: projects = [] } = useListProjects();
  const access = useAccess();
  const { data: accessUsers = [] } = useListAccessUsers({ query: { queryKey: getListAccessUsersQueryKey(), enabled: access?.role === "DIRECTOR" } });
  const { data: funds = [], isError: fundsError } = useListPettyCashFunds(projectFilter ? { projectId: projectFilter } : undefined);
  const { data: policies = [] } = useListPettyCashPolicies();
  const queryClient = useQueryClient();
  const create = useCreatePettyCashRequest();
  const decide = useDecidePettyCashRequest();
  const disburse = useDisbursePettyCashRequest();
  const settle = useSettlePettyCashRequest();
  const reconcile = useReconcilePettyCashRequest();
  const createFund = useCreatePettyCashFund();
  const replenish = useReplenishPettyCashFund();
  const createPolicy = useCreatePettyCashPolicy();
  const resolveEvidence = useResolvePettyCashEvidence();
  const verify = useVerifyPettyCashRequest();
  const evaluate = useEvaluatePettyCashRequest();
  const [open, setOpen] = useState(false);
  const [managementProjectId, setManagementProjectId] = useState(projectFilter || "");
  const [form, setForm] = useState({ projectId: projectFilter || "", fundId: "", purpose: "", costCode: "", requestedAmount: "", requestedAt: getJakartaCalendarDate() });
  const { data: rab } = useGetProjectRab(form.projectId, { query: { queryKey: getGetProjectRabQueryKey(form.projectId), enabled: !!form.projectId } });
  const costCodes = [...new Set(rab?.status === "DISETUJUI" ? rab.items.filter(item => item.costCodeId && item.budget > 0).map(item => item.code) : [])];
  const [error, setError] = useState("");
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : "Tindakan gagal. Silakan coba lagi.");
  const done = () => { setError(""); refresh(); queryClient.invalidateQueries({ queryKey: getListPettyCashFundsQueryKey() }); };

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
        setForm({ projectId: projectFilter || "", fundId: "", purpose: "", costCode: "", requestedAmount: "", requestedAt: getJakartaCalendarDate() });
        done();
      },
      onError: fail,
    });
  };

  const approve = (id: string, amount: number) => {
    const note = window.prompt("Catatan persetujuan:");
    if (!note) return;
    const approvedAmount = Number(window.prompt("Jumlah disetujui (Rp):", String(amount)));
    if (!Number.isSafeInteger(approvedAmount) || approvedAmount <= 0) return;
    decide.mutate({ requestId: id, data: { decision: "APPROVE", approvedAmount, note } }, { onSuccess: done, onError: fail });
  };
  const reject = (id: string) => {
    const note = window.prompt("Alasan penolakan:");
    if (!note) return;
    decide.mutate({ requestId: id, data: { decision: "REJECT", note } }, { onSuccess: done, onError: fail });
  };
  const recordDisbursement = (id: string, amount: number) => {
    const reference = window.prompt("Referensi pencairan/bukti serah terima:");
    if (!reference) return;
    disburse.mutate({ requestId: id, data: { amount, reference } }, { onSuccess: done, onError: fail });
  };
  const submitSettlement = (id: string, disbursedAmount: number) => {
    const expenses: { expenseDate: string; description: string; amount: number; receiptReference?: string }[] = [];
    let remaining = disbursedAmount;
    while (remaining > 0) {
      const description = window.prompt(`Deskripsi penggunaan berikutnya (sisa Rp${remaining.toLocaleString("id-ID")}; kosongkan untuk mengembalikan sisanya):`);
      if (description === null) return;
      if (!description.trim()) break;
      const amount = Number(window.prompt("Jumlah penggunaan (Rp):", String(remaining)));
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) { setError("Jumlah penggunaan tidak valid"); return; }
      const receiptReference = window.prompt("Nomor/tautan bukti (kosongkan jika belum tersedia):");
      if (receiptReference === null) return;
      expenses.push({ expenseDate: getJakartaCalendarDate(), description, amount, ...(receiptReference.trim() ? { receiptReference: receiptReference.trim() } : {}) });
      remaining -= amount;
    }
    if (!window.confirm(`Kembalikan sisa Rp${remaining.toLocaleString("id-ID")} dan kirim ${expenses.length} pengeluaran?`)) return;
    const returnReference = remaining > 0 ? window.prompt("Referensi bukti pengembalian sisa:") : undefined;
    if (remaining > 0 && !returnReference?.trim()) return;
    settle.mutate({
      requestId: id,
      data: {
        returnedAmount: remaining,
        ...(returnReference ? { returnReference } : {}),
        expenses,
      },
    }, { onSuccess: done, onError: fail });
  };
  const performReconciliation = (id: string, balance: number) => {
    const physicalCashAmount = Number(window.prompt("Hitung kas fisik (Rp); untuk dana lama gunakan sisa transaksi:", String(balance)));
    if (!Number.isSafeInteger(physicalCashAmount) || physicalCashAmount < 0) return;
    const note = window.prompt("Catatan verifikasi rekonsiliasi:");
    if (!note) return;
    reconcile.mutate({ requestId: id, data: { physicalCashAmount, note } }, { onSuccess: done, onError: fail });
  };
  const setupFund = () => {
    const projectId = projectFilter || managementProjectId;
    if (!projectId) return;
    const location = window.prompt("Nama lokasi:");
    const custodian = access?.role === "DIRECTOR"
      ? accessUsers.find(user => user.userId === window.prompt(`ID custodian (pilih dari: ${accessUsers.filter(user => user.role === "FINANCE").map(user => `${user.displayName}: ${user.userId}`).join(", ")}):`))
      : access;
    const custodianUserId = custodian?.userId;
    const custodianName = custodian?.displayName;
    if (!location || !custodianUserId || !custodianName) return;
    createFund.mutate({ data: { projectId, location, custodianUserId, custodianName } }, { onSuccess: done, onError: fail });
  };
  const setupPolicy = () => {
    const version = window.prompt("Versi kebijakan baru:");
    const effectiveFrom = window.prompt("Berlaku mulai (YYYY-MM-DD):");
    const maxRequestAmount = Number(window.prompt("Batas per permintaan (Rp):"));
    const directorApprovalAbove = Number(window.prompt("Di atas jumlah berapa perlu persetujuan direktur (Rp):"));
    const standardApproverRole = window.prompt("Peran penyetuju sampai ambang batas (PROJECT_MANAGER, FINANCE, DIRECTOR):", "PROJECT_MANAGER");
    const highApproverRole = window.prompt("Peran penyetuju di atas ambang batas (PROJECT_MANAGER, FINANCE, DIRECTOR):", "DIRECTOR");
    const evidenceDueDays = Number(window.prompt("SLA bukti (hari):"));
    const sourceNote = window.prompt("Dasar/rujukan kebijakan:");
    if (!version || !effectiveFrom || !sourceNote || !Number.isSafeInteger(maxRequestAmount) || !Number.isSafeInteger(directorApprovalAbove) || !Number.isSafeInteger(evidenceDueDays)
      || !["PROJECT_MANAGER", "FINANCE", "DIRECTOR"].includes(standardApproverRole || "")
      || !["PROJECT_MANAGER", "FINANCE", "DIRECTOR"].includes(highApproverRole || "")) return;
    createPolicy.mutate({ data: { version, effectiveFrom, maxRequestAmount, directorApprovalAbove, evidenceDueDays, sourceNote,
      standardApproverRole: standardApproverRole as "PROJECT_MANAGER" | "FINANCE" | "DIRECTOR",
      highApproverRole: highApproverRole as "PROJECT_MANAGER" | "FINANCE" | "DIRECTOR" } }, {
      onSuccess: () => { done(); queryClient.invalidateQueries({ queryKey: getListPettyCashPoliciesQueryKey() }); }, onError: fail,
    });
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
                <div className="grid gap-2"><Label>Proyek</Label><Select required value={form.projectId} onValueChange={(projectId) => setForm({ ...form, projectId, fundId: "", costCode: "" })}><SelectTrigger><SelectValue placeholder="Pilih proyek" /></SelectTrigger><SelectContent>{projects.filter((project) => project.status === "BERJALAN").map((project) => <SelectItem key={project.id} value={project.id}>{project.code} — {project.name}</SelectItem>)}</SelectContent></Select></div>
                <div className="grid gap-2"><Label>Dana lokasi</Label><Select value={form.fundId} onValueChange={(fundId) => setForm({ ...form, fundId })}><SelectTrigger><SelectValue placeholder="Pilih dana lokasi" /></SelectTrigger><SelectContent>{funds.filter(fund => fund.projectId === form.projectId).map(fund => <SelectItem key={fund.id} value={fund.id}>{fund.location} · {fund.custodianName} · {formatRupiah(fund.bookBalance)}</SelectItem>)}</SelectContent></Select></div>
                <div className="grid gap-2"><Label htmlFor="purpose">Tujuan</Label><Textarea id="purpose" required value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} /></div>
                <div className="grid gap-2 sm:grid-cols-2"><div className="grid gap-2"><Label>Cost code RAB disetujui</Label><Select value={form.costCode} onValueChange={(costCode) => setForm({ ...form, costCode })}><SelectTrigger><SelectValue placeholder="Pilih cost code" /></SelectTrigger><SelectContent>{costCodes.map(code => <SelectItem key={code} value={code}>{code}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-2"><Label htmlFor="amount">Jumlah (Rp)</Label><Input id="amount" type="number" min="1" required value={form.requestedAmount} onChange={(event) => setForm({ ...form, requestedAmount: event.target.value })} /></div></div>
                <div className="grid gap-2"><Label htmlFor="requestedAt">Tanggal kebutuhan</Label><Input id="requestedAt" type="date" required value={form.requestedAt} onChange={(event) => setForm({ ...form, requestedAt: event.target.value })} /></div>
              </div>
              <DialogFooter><Button type="submit" disabled={create.isPending || !form.projectId || !form.fundId || !form.costCode}>Kirim permintaan</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>}
      </div>
      {error && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</p>}
      {(requestsError || fundsError) && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">Data kas kecil tidak dapat dimuat. Muat ulang halaman untuk mencoba lagi.</p>}
      {hasPermission(access, "petty-cash:manage") && <div className="flex flex-wrap gap-2">
        {!projectFilter && <Select value={managementProjectId} onValueChange={setManagementProjectId}><SelectTrigger className="w-56"><SelectValue placeholder="Proyek dana baru" /></SelectTrigger><SelectContent>{projects.map(project => <SelectItem key={project.id} value={project.id}>{project.code} · {project.name}</SelectItem>)}</SelectContent></Select>}
        <Button variant="outline" disabled={!projectFilter && !managementProjectId} onClick={setupFund}>Buat dana lokasi</Button>
        <Button variant="outline" onClick={setupPolicy}>Atur kebijakan baru</Button>
        {funds.map(fund => <Button key={fund.id} variant="outline" onClick={() => {
          const amount = Number(window.prompt(`Isi ulang ${fund.location} (Rp):`));
          const reference = window.prompt("Referensi transfer/serah terima:");
          if (Number.isSafeInteger(amount) && amount > 0 && reference) replenish.mutate({ fundId: fund.id, data: { amount, reference } }, { onSuccess: done, onError: fail });
        }}>Isi ulang {fund.location} ({formatRupiah(fund.bookBalance)})</Button>)}
      </div>}
      {policies[0] && <p className="text-sm text-muted-foreground">Kebijakan terbaru: {policies[0].version} · batas {formatRupiah(policies[0].maxRequestAmount)} · {policies[0].standardApproverRole} hingga {formatRupiah(policies[0].directorApprovalAbove)}, selebihnya {policies[0].highApproverRole} · bukti {policies[0].evidenceDueDays} hari.</p>}
      <div className="grid gap-3 md:grid-cols-3">
        {funds.map(fund => <Card key={fund.id}><CardHeader className="pb-2"><CardTitle className="text-sm">{projects.find(project => project.id === fund.projectId)?.code || fund.projectId} · {fund.location}</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{formatRupiah(fund.bookBalance)}</p><p className="text-xs text-muted-foreground">Saldo buku · custodian {fund.custodianName}</p></CardContent></Card>)}
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
                <TableCell><div className="font-medium">{request.projectCode} · {funds.find(fund => fund.id === request.fundId)?.location || "Lokasi lama"}</div><div className="text-xs text-muted-foreground">{request.requesterName}</div></TableCell>
                <TableCell><div>{request.purpose}</div><div className="text-xs text-muted-foreground">{request.costCode} · {request.policyVersion}</div>{request.expenses.map(expense => <div key={expense.id} className="text-xs">{formatRupiah(expense.amount)} · {expense.receiptReference || "Bukti belum ada"}</div>)}{request.exceptions?.filter(exception => exception.status === "OPEN").map(exception => <div key={exception.id} className="text-xs text-destructive">Bukti tertunda · pemilik {exception.ownerUserId} · batas {exception.dueAt}</div>)}</TableCell>
                <TableCell className="text-right font-medium">{formatRupiah(request.requestedAmount)}</TableCell>
                <TableCell><Badge variant={badgeVariant(request.status)}>{request.status.replaceAll("_", " ")}</Badge></TableCell>
                <TableCell>{formatDate(request.evidenceDueAt)}</TableCell>
                <TableCell><div className="flex flex-wrap justify-end gap-2">
                  {request.status === "DIAJUKAN" && hasPermission(access, "petty-cash:approve") && request.requesterUserId !== access.userId && <><Button size="sm" variant="outline" onClick={() => reject(request.id)}>Tolak</Button><Button size="sm" onClick={() => approve(request.id, request.requestedAmount)}>Setujui</Button></>}
                  {request.status === "DISETUJUI" && hasPermission(access, "petty-cash:disburse") && request.requesterUserId !== access.userId && request.approverUserId !== access.userId && (!request.fundId || funds.some(fund => fund.id === request.fundId && fund.custodianUserId === access.userId)) && <Button size="sm" onClick={() => recordDisbursement(request.id, request.approvedAmount || 0)}>{request.fundId ? "Cairkan" : "Cairkan transaksi lama"}</Button>}
                  {request.status === "DICAIRKAN" && hasPermission(access, "petty-cash:settle") && (request.requesterUserId === access.userId || access.role === "DIRECTOR") && <Button size="sm" onClick={() => submitSettlement(request.id, request.disbursedAmount || 0)}>Kirim bukti</Button>}
                  {request.status === "DIPERTANGGUNGJAWABKAN" && request.requesterUserId === access.userId && request.exceptions?.filter(exception => exception.status === "OPEN").map(exception => <Button key={exception.id} size="sm" variant="outline" onClick={() => {
                    const receiptReference = window.prompt("Nomor/tautan bukti:");
                    if (receiptReference?.trim()) resolveEvidence.mutate({ requestId: request.id, data: { expenseId: exception.expenseId, receiptReference } }, { onSuccess: done, onError: fail });
                  }}>Lengkapi bukti</Button>)}
                  {request.status === "DIPERTANGGUNGJAWABKAN" && !!request.fundId && hasPermission(access, "petty-cash:verify") && ![request.requesterUserId, request.approverUserId, request.disburserUserId].includes(access.userId) && <Button size="sm" onClick={() => verify.mutate({ requestId: request.id }, { onSuccess: done, onError: fail })}>Verifikasi</Button>}
                  {(request.status === "DIVERIFIKASI" || (!request.fundId && request.status === "DIPERTANGGUNGJAWABKAN")) && hasPermission(access, "petty-cash:reconcile") && ![request.requesterUserId, request.disburserUserId, request.verifierUserId].includes(access.userId) && <Button size="sm" onClick={() => performReconciliation(request.id, request.fundId ? funds.find(fund => fund.id === request.fundId)?.bookBalance || 0 : request.returnedAmount || 0)}>Rekonsiliasi</Button>}
                  {request.status === "DIREKONSILIASI" && hasPermission(access, "petty-cash:evaluate") && ![request.requesterUserId, request.approverUserId, request.disburserUserId, request.verifierUserId, request.reconcilerUserId].includes(access.userId) && <Button size="sm" onClick={() => {
                    const note = window.prompt("Catatan evaluasi:");
                    if (note?.trim()) evaluate.mutate({ requestId: request.id, data: { note } }, { onSuccess: done, onError: fail });
                  }}>Evaluasi</Button>}
                </div></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}