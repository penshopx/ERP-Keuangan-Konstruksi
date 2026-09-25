import { useMemo, useState, type FormEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListProjectCommitments, useListVendorReceipts, useListVendorInvoices, useListVendorPayments, useListVendorMatchPolicies,
  useCreateVendorInvoice, useDecideVendorInvoice, useRequestVendorPayment, useDecideVendorPayment, useCreateVendorMatchPolicy,
  getListProjectCommitmentsQueryKey, getListVendorReceiptsQueryKey, getListVendorInvoicesQueryKey, getListVendorPaymentsQueryKey, getListVendorMatchPoliciesQueryKey,
} from "@workspace/api-client-react"
import type { VendorInvoice, VendorInvoiceInput, VendorMatchPolicyInput, VendorPayment, VendorDecisionInputAction, VendorPaymentDecisionInputAction } from "@workspace/api-client-react"
import { useAccess, hasPermission } from "@/lib/access"
import { formatRupiah } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, FilePlus2, Landmark, Plus, ShieldCheck, SlidersHorizontal } from "lucide-react"

type InvoiceDraft = {
  commitmentId: string; lineId: string; invoiceNumber: string; kind: "INVOICE" | "CREDIT_NOTE"; originalInvoiceId: string;
  quantity: string; unitPrice: string; tax: string; retention: string; total: string; receiptEventIds: string[]; evidence: string
}
type Action = { type: "invoice"; item: VendorInvoice; action: VendorDecisionInputAction } |
  { type: "payment"; item: VendorPayment; action: VendorPaymentDecisionInputAction } |
  { type: "request"; item: VendorInvoice }

const emptyInvoice: InvoiceDraft = { commitmentId: "", lineId: "", invoiceNumber: "", kind: "INVOICE", originalInvoiceId: "", quantity: "", unitPrice: "", tax: "0", retention: "0", total: "", receiptEventIds: [], evidence: "" }
const labels: Record<string, string> = {
  MATCHED: "Cocok", EXCEPTION: "Perlu pemeriksaan", REVIEWED: "Terverifikasi", REJECTED: "Ditolak",
  CANCELLED: "Dibatalkan", REQUESTED: "Diajukan", APPROVED: "Disetujui", RELEASED: "Dicairkan",
  INVOICE: "Invoice", CREDIT_NOTE: "Nota kredit",
}
const decisionLabels: Record<string, string> = {
  REVIEW: "Verifikasi kecocokan", OVERRIDE: "Setujui pengecualian", REJECT: "Tolak", CANCEL: "Batalkan",
  APPROVE: "Setujui pembayaran", RELEASE: "Cairkan pembayaran",
}
const money = (value: number) => formatRupiah(value)
const date = (value: string) => new Date(value).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })
function apiError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const data = error as { message?: string; error?: string; data?: { error?: string; message?: string } }
    return data.data?.error || data.data?.message || data.error || data.message || "Permintaan gagal. Periksa data dan coba lagi."
  }
  return "Permintaan gagal. Coba lagi."
}
function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return <label className="block space-y-1.5 text-xs font-semibold text-muted-foreground"><span>{title}</span>{children}</label>
}
const inputClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
function Status({ value }: { value: string }) {
  return <Badge variant={value === "EXCEPTION" || value === "REJECTED" ? "destructive" : value === "MATCHED" || value === "REVIEWED" || value === "RELEASED" ? "success" : "secondary"} data-testid={`status-${value.toLowerCase()}`}>{labels[value] ?? value}</Badge>
}

export function VendorMatching({ projectId }: { projectId: string }) {
  const access = useAccess()
  const client = useQueryClient()
  const commitmentsQuery = useListProjectCommitments(projectId, { query: { enabled: !!projectId, queryKey: getListProjectCommitmentsQueryKey(projectId) } })
  const receiptsQuery = useListVendorReceipts(projectId, { query: { enabled: !!projectId, queryKey: getListVendorReceiptsQueryKey(projectId) } })
  const invoicesQuery = useListVendorInvoices(projectId, { query: { enabled: !!projectId, queryKey: getListVendorInvoicesQueryKey(projectId) } })
  const paymentsQuery = useListVendorPayments(projectId, { query: { enabled: !!projectId, queryKey: getListVendorPaymentsQueryKey(projectId) } })
  const policiesQuery = useListVendorMatchPolicies()
  const createInvoice = useCreateVendorInvoice()
  const decideInvoice = useDecideVendorInvoice()
  const requestPayment = useRequestVendorPayment()
  const decidePayment = useDecideVendorPayment()
  const createPolicy = useCreateVendorMatchPolicy()
  const [tab, setTab] = useState<"invoices" | "policy">("invoices")
  const [invoiceOpen, setInvoiceOpen] = useState(false)
  const [draft, setDraft] = useState<InvoiceDraft>(emptyInvoice)
  const [action, setAction] = useState<Action | null>(null)
  const [actionEvidence, setActionEvidence] = useState("")
  const [actionAmount, setActionAmount] = useState("")
  const [policyOpen, setPolicyOpen] = useState(false)
  const [policyDraft, setPolicyDraft] = useState({ effectiveFrom: "", quantityToleranceBasisPoints: "0", priceToleranceBasisPoints: "0", taxTolerance: "0", retentionTolerance: "0", totalTolerance: "0" })
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const commitments = commitmentsQuery.data ?? []
  const receipts = receiptsQuery.data ?? []
  const invoices = invoicesQuery.data ?? []
  const payments = paymentsQuery.data ?? []
  const policies = policiesQuery.data ?? []
  const selectedCommitment = commitments.find(c => c.id === draft.commitmentId)
  const selectedLine = selectedCommitment?.lines.find(l => l.id === draft.lineId)
  const lineReceipts = receipts.filter(r => r.commitmentId === draft.commitmentId && r.lineId === draft.lineId)
  const originals = invoices.filter(i => i.kind === "INVOICE" && i.status === "REVIEWED" && i.commitmentId === draft.commitmentId && i.lineId === draft.lineId)
  const canWrite = hasPermission(access, "commitments:write")
  const canApprove = hasPermission(access, "commitments:approve")
  const canManagePolicy = access.role === "DIRECTOR" && hasPermission(access, "tax-rules:manage")
  const canView = hasPermission(access, "commitments:view")
  const pending = createInvoice.isPending || decideInvoice.isPending || requestPayment.isPending || decidePayment.isPending || createPolicy.isPending
  const summary = useMemo(() => ({
    exceptions: invoices.filter(i => i.status === "EXCEPTION").length,
    reviewed: invoices.filter(i => i.status === "REVIEWED" && i.kind === "INVOICE").length,
    awaiting: payments.filter(p => p.status === "REQUESTED" || p.status === "APPROVED").length,
  }), [invoices, payments])

  function refresh() {
    void Promise.all([
      client.invalidateQueries({ queryKey: getListProjectCommitmentsQueryKey(projectId) }),
      client.invalidateQueries({ queryKey: getListVendorReceiptsQueryKey(projectId) }),
      client.invalidateQueries({ queryKey: getListVendorInvoicesQueryKey(projectId) }),
      client.invalidateQueries({ queryKey: getListVendorPaymentsQueryKey(projectId) }),
      client.invalidateQueries({ queryKey: getListVendorMatchPoliciesQueryKey() }),
    ])
  }
  function startAction(next: Action) { setError(""); setActionEvidence(""); setActionAmount(next.type === "request" ? String(Math.max(0, remaining(next.item))) : ""); setAction(next) }
  function remaining(invoice: VendorInvoice) {
    return Math.max(0, invoice.eligibleAmount -
      invoices.filter(i => i.kind === "CREDIT_NOTE" && i.originalInvoiceId === invoice.id && i.status === "REVIEWED").reduce((n, i) => n + i.total, 0) -
      payments.filter(p => p.invoiceId === invoice.id && ["REQUESTED", "APPROVED", "RELEASED"].includes(p.status)).reduce((n, p) => n + p.amount, 0))
  }
  function numbersValid(...values: number[]) { return values.every(n => Number.isSafeInteger(n) && n >= 0) }

  async function submitInvoice(event: FormEvent) {
    event.preventDefault(); setError("")
    const quantity = Number(draft.quantity), unitPrice = Number(draft.unitPrice), tax = Number(draft.tax), retention = Number(draft.retention), total = Number(draft.total)
    if (!selectedCommitment || !selectedLine || !draft.invoiceNumber.trim() || !draft.evidence.trim() || !draft.receiptEventIds.length ||
      (draft.kind === "CREDIT_NOTE" && !draft.originalInvoiceId) || !numbersValid(quantity, unitPrice, tax, retention, total) ||
      quantity < 1 || draft.quantity === "" || draft.unitPrice === "" || draft.total === "" || total !== quantity * unitPrice + tax - retention) {
      setError("Lengkapi baris, nomor, bukti penerimaan, dan referensi. Pastikan semua nilai rupiah bilangan bulat serta total = kuantitas × harga + pajak − retensi."); return
    }
    const data: VendorInvoiceInput = { commitmentId: draft.commitmentId, lineId: draft.lineId, invoiceNumber: draft.invoiceNumber.trim(), kind: draft.kind,
      ...(draft.kind === "CREDIT_NOTE" ? { originalInvoiceId: draft.originalInvoiceId } : {}), quantity, unitPrice, tax, retention, total,
      receiptEventIds: draft.receiptEventIds, evidence: draft.evidence.trim() }
    try {
      await createInvoice.mutateAsync({ projectId, data })
      setInvoiceOpen(false); setDraft(emptyInvoice); setSuccess("Dokumen dicatat. Periksa hasil kecocokan sebelum pembayaran."); refresh()
    } catch (e) { setError(apiError(e)) }
  }
  async function submitAction(event: FormEvent) {
    event.preventDefault(); setError("")
    if (!action || !actionEvidence.trim()) { setError("Alasan atau referensi bukti wajib diisi untuk jejak audit."); return }
    try {
      if (action.type === "invoice") await decideInvoice.mutateAsync({ invoiceId: action.item.id, data: { action: action.action, evidence: actionEvidence.trim() } })
      if (action.type === "payment") await decidePayment.mutateAsync({ paymentId: action.item.id, data: { action: action.action, evidence: actionEvidence.trim() } })
      if (action.type === "request") {
        const amount = Number(actionAmount)
        if (!numbersValid(amount) || amount < 1 || amount > remaining(action.item) || actionAmount === "") {
          setError(`Jumlah harus bilangan bulat lebih dari nol dan tidak melebihi sisa ${money(remaining(action.item))}.`); return
        }
        await requestPayment.mutateAsync({ invoiceId: action.item.id, data: { amount, evidence: actionEvidence.trim() } })
      }
      setAction(null); setSuccess("Keputusan tersimpan bersama bukti audit."); refresh()
    } catch (e) { setError(apiError(e)) }
  }
  async function submitPolicy(event: FormEvent) {
    event.preventDefault(); setError("")
    const effectiveFrom = new Date(policyDraft.effectiveFrom)
    const fields = ["quantityToleranceBasisPoints", "priceToleranceBasisPoints", "taxTolerance", "retentionTolerance", "totalTolerance"] as const
    const values = fields.map(key => Number(policyDraft[key]))
    if (!policyDraft.effectiveFrom || Number.isNaN(effectiveFrom.getTime()) || fields.some(key => policyDraft[key] === "") ||
      !numbersValid(...values) || values[0] > 10000 || values[1] > 10000 || (policies[0] && effectiveFrom <= new Date(policies[0].effectiveFrom))) {
      setError("Tanggal berlaku harus setelah versi terakhir. Toleransi harus bilangan bulat tidak negatif; basis poin maksimal 10.000."); return
    }
    const data: VendorMatchPolicyInput = { effectiveFrom: effectiveFrom.toISOString(), quantityToleranceBasisPoints: values[0], priceToleranceBasisPoints: values[1],
      taxTolerance: values[2], retentionTolerance: values[3], totalTolerance: values[4] }
    try {
      await createPolicy.mutateAsync({ data }); setPolicyOpen(false); setSuccess("Versi aturan baru berhasil dibuat."); refresh()
    } catch (e) { setError(apiError(e)) }
  }

  if (!canView) return null
  const loading = commitmentsQuery.isLoading || receiptsQuery.isLoading || invoicesQuery.isLoading || paymentsQuery.isLoading || policiesQuery.isLoading
  const failed = commitmentsQuery.isError || receiptsQuery.isError || invoicesQuery.isError || paymentsQuery.isError || policiesQuery.isError
  return <section className="space-y-5 border-t pt-8" aria-labelledby="vendor-matching-heading">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div><div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-primary"><ShieldCheck className="h-4 w-4" /> Kontrol pembayaran vendor</div>
        <h3 id="vendor-matching-heading" className="text-xl font-bold tracking-tight">Kecocokan tiga dokumen</h3>
        <p className="mt-1 text-sm text-muted-foreground">PO / SPK, bukti penerimaan, dan invoice diverifikasi sebelum dana dicairkan.</p>
      </div>
      {canWrite && <Button onClick={() => { setError(""); setDraft(emptyInvoice); setInvoiceOpen(true) }} data-testid="button-create-vendor-invoice"><FilePlus2 className="mr-2 h-4 w-4" /> Catat invoice / nota kredit</Button>}
    </div>
    {success && <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30"><CheckCircle2 className="h-4 w-4" /><AlertDescription>{success}</AlertDescription></Alert>}
    {loading ? <div className="grid gap-3" aria-label="Memuat pencocokan vendor">{[1, 2, 3].map(n => <div key={n} className="h-24 animate-pulse rounded-lg bg-muted" />)}</div> :
      failed ? <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>Data pencocokan belum dapat dimuat. <Button size="sm" variant="outline" onClick={refresh} data-testid="button-retry-vendor-matching">Coba lagi</Button></AlertDescription></Alert> :
      <>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border bg-card p-4"><span className="text-xs text-muted-foreground">Perlu pemeriksaan</span><p className="mt-1 text-2xl font-bold tabular-nums" data-testid="text-vendor-exceptions">{summary.exceptions}</p></div>
          <div className="rounded-lg border bg-card p-4"><span className="text-xs text-muted-foreground">Invoice terverifikasi</span><p className="mt-1 text-2xl font-bold tabular-nums" data-testid="text-vendor-reviewed">{summary.reviewed}</p></div>
          <div className="rounded-lg border bg-card p-4"><span className="text-xs text-muted-foreground">Pembayaran dalam proses</span><p className="mt-1 text-2xl font-bold tabular-nums" data-testid="text-vendor-awaiting">{summary.awaiting}</p></div>
        </div>
        <div className="flex gap-1 border-b">
          <button type="button" onClick={() => setTab("invoices")} className={`px-4 py-3 text-sm font-semibold ${tab === "invoices" ? "border-b-2 border-primary text-primary" : "text-muted-foreground"}`} data-testid="tab-vendor-invoices">Dokumen & pembayaran</button>
          <button type="button" onClick={() => setTab("policy")} className={`px-4 py-3 text-sm font-semibold ${tab === "policy" ? "border-b-2 border-primary text-primary" : "text-muted-foreground"}`} data-testid="tab-vendor-policies">Aturan kecocokan</button>
        </div>
        {tab === "policy" ? <div className="space-y-3">
          <div className="flex items-center justify-between"><p className="text-sm text-muted-foreground">Setiap invoice menyimpan versi aturan saat dicatat.</p>{canManagePolicy && <Button size="sm" variant="outline" onClick={() => { setError(""); setPolicyOpen(true) }} data-testid="button-new-vendor-policy"><Plus className="mr-2 h-4 w-4" /> Versi baru</Button>}</div>
          {policies.length === 0 ? <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Belum ada aturan kecocokan. Director perlu membuat aturan sebelum invoice dapat dicatat.</div> :
            policies.map(p => <Card key={p.id} data-testid={`card-vendor-policy-${p.id}`}><CardContent className="p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-primary" /><strong>Versi {p.version}</strong>{p.id === policies[0].id && <Badge variant="outline">Terbaru</Badge>}</div><span className="text-xs text-muted-foreground">Berlaku {date(p.effectiveFrom)}</span></div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">{[
                ["Kuantitas", `${p.quantityToleranceBasisPoints} bp`], ["Harga", `${p.priceToleranceBasisPoints} bp`], ["Pajak", money(p.taxTolerance)], ["Retensi", money(p.retentionTolerance)], ["Total", money(p.totalTolerance)]
              ].map(([title, value]) => <div key={title}><div className="text-xs text-muted-foreground">{title}</div><div className="mt-1 font-semibold tabular-nums">{value}</div></div>)}</div>
            </CardContent></Card>)}
        </div> : invoices.length === 0 ? <div className="rounded-lg border border-dashed bg-muted/20 px-6 py-12 text-center"><ClipboardCheck className="mx-auto mb-3 h-9 w-9 text-muted-foreground" /><h4 className="font-semibold">Belum ada invoice vendor</h4><p className="mt-1 text-sm text-muted-foreground">Catat invoice dengan bukti penerimaan untuk memulai pemeriksaan.</p></div> :
          <div className="space-y-4">{invoices.map(invoice => {
            const commitment = commitments.find(c => c.id === invoice.commitmentId)
            const line = commitment?.lines.find(l => l.id === invoice.lineId)
            const invoicePayments = payments.filter(p => p.invoiceId === invoice.id)
            const available = remaining(invoice)
            const canReview = canApprove && invoice.makerId !== access.userId
            return <Card key={invoice.id} className="overflow-hidden" data-testid={`card-vendor-invoice-${invoice.id}`}>
              <div className="flex flex-col gap-3 border-b bg-muted/20 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
                <div><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{labels[invoice.kind] ?? invoice.kind}</Badge><strong className="text-base">{invoice.invoiceNumber}</strong><Status value={invoice.status} /></div>
                  <p className="mt-2 text-sm">{commitment?.vendorName ?? "Vendor"} <span className="text-muted-foreground">· {commitment?.documentNumber ?? invoice.commitmentId} / {line?.description ?? invoice.lineId}</span></p>
                  <p className="mt-1 text-xs text-muted-foreground">{date(invoice.createdAt)} · Aturan v{invoice.policyVersion} · {invoice.quantity} × {money(invoice.unitPrice)}</p></div>
                <div className="sm:text-right"><div className="text-xs text-muted-foreground">Nilai dokumen</div><div className="text-lg font-bold tabular-nums">{money(invoice.total)}</div></div>
              </div>
              <CardContent className="space-y-4 p-4 sm:p-5">
                <div className="grid gap-3 text-xs sm:grid-cols-3">
                  <div className="rounded-md bg-muted/50 p-3"><span className="text-muted-foreground">Bukti penerimaan</span><div className="mt-1 font-semibold">{invoice.receiptEventIds.length} bukti terpilih</div><div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{invoice.receiptEventIds.join(", ")}</div></div>
                  <div className="rounded-md bg-muted/50 p-3"><span className="text-muted-foreground">Referensi invoice</span><div className="mt-1 break-words font-medium">{invoice.evidence}</div>{invoice.originalInvoiceId && <div className="mt-1 text-muted-foreground">Asal: {invoices.find(i => i.id === invoice.originalInvoiceId)?.invoiceNumber ?? invoice.originalInvoiceId}</div>}</div>
                  <div className="rounded-md bg-muted/50 p-3"><span className="text-muted-foreground">Rincian / aturan v{invoice.policyVersion}</span><div className="mt-1">Pajak {money(invoice.tax)} · Retensi {money(invoice.retention)}</div><div className="mt-1 text-muted-foreground">Snapshot: {Object.entries(invoice.policySnapshot).map(([key, value]) => `${({quantityToleranceBasisPoints:"Qty",priceToleranceBasisPoints:"Harga",taxTolerance:"Pajak",retentionTolerance:"Retensi",totalTolerance:"Total"} as Record<string,string>)[key] ?? key} ${value}`).join(" · ")}</div></div>
                </div>
                {invoice.exceptions.length > 0 && <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-200"><strong>Selisih ditemukan</strong><ul className="mt-1 list-inside list-disc">{invoice.exceptions.map((issue, idx) => <li key={idx}>{issue}</li>)}</ul></div>}
                {invoice.reviewEvidence && <p className="text-xs text-muted-foreground">Keputusan: {invoice.reviewEvidence} {invoice.reviewedAt && `· ${date(invoice.reviewedAt)}`}</p>}
                {invoice.kind === "INVOICE" && invoice.status === "REVIEWED" && <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/20 bg-primary/5 p-3"><div><div className="text-xs text-muted-foreground">Sisa dapat diminta bayar</div><strong className="tabular-nums">{money(available)}</strong></div>{canWrite && invoice.reviewerId !== access.userId && available > 0 && <Button size="sm" onClick={() => startAction({ type: "request", item: invoice })} data-testid={`button-request-payment-${invoice.id}`}><Landmark className="mr-2 h-4 w-4" /> Ajukan pembayaran</Button>}</div>}
                {canReview && (invoice.status === "MATCHED" || invoice.status === "EXCEPTION") && <div className="flex flex-wrap gap-2">
                  {invoice.status === "MATCHED" && <Button size="sm" onClick={() => startAction({ type: "invoice", item: invoice, action: "REVIEW" })} data-testid={`button-review-invoice-${invoice.id}`}>Verifikasi</Button>}
                  {invoice.status === "EXCEPTION" && access.role === "DIRECTOR" && <Button size="sm" onClick={() => startAction({ type: "invoice", item: invoice, action: "OVERRIDE" })} data-testid={`button-override-invoice-${invoice.id}`}>Setujui pengecualian</Button>}
                  <Button size="sm" variant="outline" onClick={() => startAction({ type: "invoice", item: invoice, action: "REJECT" })} data-testid={`button-reject-invoice-${invoice.id}`}>Tolak</Button>
                  <Button size="sm" variant="ghost" onClick={() => startAction({ type: "invoice", item: invoice, action: "CANCEL" })} data-testid={`button-cancel-invoice-${invoice.id}`}>Batalkan</Button>
                </div>}
                {canReview && invoice.status === "REVIEWED" && invoice.kind === "INVOICE" && invoicePayments.every(p => p.status === "REJECTED") && !invoices.some(i => i.originalInvoiceId === invoice.id && i.status === "REVIEWED") && <Button size="sm" variant="ghost" onClick={() => startAction({ type: "invoice", item: invoice, action: "CANCEL" })} data-testid={`button-cancel-reviewed-invoice-${invoice.id}`}>Batalkan invoice</Button>}
                {invoicePayments.length > 0 && <div className="space-y-2 border-t pt-4"><h5 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Riwayat pembayaran</h5>{invoicePayments.map(payment => <div key={payment.id} className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`row-vendor-payment-${payment.id}`}>
                  <div><div className="flex items-center gap-2"><strong className="text-sm tabular-nums">{money(payment.amount)}</strong><Status value={payment.status} /></div><div className="mt-1 text-xs text-muted-foreground">{date(payment.createdAt)} · {payment.evidence}</div>{payment.approvalEvidence && <div className="text-xs text-muted-foreground">Persetujuan: {payment.approvalEvidence}</div>}{payment.releaseEvidence && <div className="text-xs text-muted-foreground">Pencairan: {payment.releaseEvidence}</div>}</div>
                  {canApprove && invoice.status === "REVIEWED" && <div className="flex flex-wrap gap-2">
                    {payment.status === "REQUESTED" && ![payment.makerId, invoice.makerId, invoice.reviewerId].includes(access.userId) && <><Button size="sm" onClick={() => startAction({ type: "payment", item: payment, action: "APPROVE" })} data-testid={`button-approve-payment-${payment.id}`}>Setujui</Button><Button size="sm" variant="outline" onClick={() => startAction({ type: "payment", item: payment, action: "REJECT" })} data-testid={`button-reject-payment-${payment.id}`}>Tolak</Button></>}
                    {payment.status === "APPROVED" && ["FINANCE", "DIRECTOR"].includes(access.role) && ![payment.makerId, invoice.makerId, invoice.reviewerId, payment.approverId].includes(access.userId) && <Button size="sm" onClick={() => startAction({ type: "payment", item: payment, action: "RELEASE" })} data-testid={`button-release-payment-${payment.id}`}><ArrowRight className="mr-1 h-4 w-4" /> Cairkan</Button>}
                  </div>}
                </div>)}</div>}
              </CardContent>
            </Card>
          })}</div>}
      </>}

    <Dialog open={invoiceOpen} onOpenChange={open => { if (!pending) { setInvoiceOpen(open); setError("") } }}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Catat dokumen vendor</DialogTitle><DialogDescription>Tagihan sebagian dan nota kredit dicatat per baris komitmen. Pilih semua bukti penerimaan terkait.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={submitInvoice}>
          <div className="grid gap-3 sm:grid-cols-2"><Field title="Jenis dokumen"><select className={inputClass} value={draft.kind} onChange={e => setDraft(d => ({ ...d, kind: e.target.value as InvoiceDraft["kind"], originalInvoiceId: "" }))} data-testid="select-vendor-invoice-kind"><option value="INVOICE">Invoice</option><option value="CREDIT_NOTE">Nota kredit</option></select></Field>
            <Field title="Nomor dokumen"><Input value={draft.invoiceNumber} onChange={e => setDraft(d => ({ ...d, invoiceNumber: e.target.value }))} placeholder="Nomor dari vendor" data-testid="input-vendor-invoice-number" /></Field></div>
          <div className="grid gap-3 sm:grid-cols-2"><Field title="PO / SPK"><select className={inputClass} value={draft.commitmentId} onChange={e => setDraft(d => ({ ...d, commitmentId: e.target.value, lineId: "", receiptEventIds: [], originalInvoiceId: "" }))} data-testid="select-vendor-commitment"><option value="">Pilih komitmen</option>{commitments.filter(c => c.status === "APPROVED" || (draft.kind === "CREDIT_NOTE" && c.status === "CLOSED")).map(c => <option key={c.id} value={c.id}>{c.documentNumber} · {c.vendorName}</option>)}</select></Field>
            <Field title="Baris komitmen"><select className={inputClass} value={draft.lineId} onChange={e => setDraft(d => ({ ...d, lineId: e.target.value, receiptEventIds: [], originalInvoiceId: "" }))} data-testid="select-vendor-line"><option value="">Pilih baris</option>{selectedCommitment?.lines.map(l => <option key={l.id} value={l.id}>{l.description} · {money(l.amount)}</option>)}</select></Field></div>
          {selectedLine && <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">Baris PO: {selectedLine.quantity} unit · {money(selectedLine.amount)} · Sudah diterima {money(selectedLine.receivedAmount)} · Sudah ditagih {money(selectedLine.invoicedAmount)}. Isi kuantitas sesuai tagihan sebagian.</div>}
          {draft.kind === "CREDIT_NOTE" && <Field title="Invoice asal"><select className={inputClass} value={draft.originalInvoiceId} onChange={e => setDraft(d => ({ ...d, originalInvoiceId: e.target.value }))} data-testid="select-vendor-original-invoice"><option value="">Pilih invoice terverifikasi</option>{originals.map(i => <option key={i.id} value={i.id}>{i.invoiceNumber} · {money(i.eligibleAmount)} · sisa {money(remaining(i))}</option>)}</select></Field>}
          <fieldset className="rounded-md border p-3"><legend className="px-1 text-xs font-semibold text-muted-foreground">Bukti penerimaan (pilih satu atau lebih)</legend>{!draft.lineId ? <p className="text-xs text-muted-foreground">Pilih baris komitmen terlebih dahulu.</p> : lineReceipts.length === 0 ? <p className="text-xs text-muted-foreground">Belum ada penerimaan pada baris ini. Catat penerimaan di komitmen terlebih dahulu.</p> :
            <div className="max-h-36 space-y-1 overflow-y-auto">{lineReceipts.map(r => <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted"><input type="checkbox" checked={draft.receiptEventIds.includes(r.id)} onChange={e => setDraft(d => ({ ...d, receiptEventIds: e.target.checked ? [...d.receiptEventIds, r.id] : d.receiptEventIds.filter(id => id !== r.id) }))} data-testid={`checkbox-vendor-receipt-${r.id}`} /><span>{date(r.createdAt)} · {money(r.amount)}</span><span className="ml-auto font-mono text-[10px] text-muted-foreground">{r.id.slice(0, 8)}</span></label>)}</div>}</fieldset>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{([["quantity", "Kuantitas"], ["unitPrice", "Harga satuan (Rp)"], ["tax", "Pajak (Rp)"], ["retention", "Retensi (Rp)"], ["total", "Total tagihan (Rp)"]] as const).map(([key, title]) => <Field key={key} title={title}><Input type="number" min={key === "quantity" ? "1" : "0"} step="1" value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} data-testid={`input-vendor-${key}`} /></Field>)}</div>
          <p className="text-xs text-muted-foreground">Total = kuantitas × harga satuan + pajak − retensi.</p>
          <Field title="Referensi bukti / dokumen"><Input value={draft.evidence} onChange={e => setDraft(d => ({ ...d, evidence: e.target.value }))} placeholder="Nomor berkas, berita acara, atau tautan bukti" data-testid="input-vendor-invoice-evidence" /></Field>
          {error && <p role="alert" className="text-sm text-destructive" data-testid="error-vendor-invoice">{error}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={pending} onClick={() => setInvoiceOpen(false)}>Batal</Button><Button type="submit" disabled={pending} data-testid="button-save-vendor-invoice">{pending ? "Menyimpan..." : "Catat & periksa"}</Button></div>
        </form></DialogContent>
    </Dialog>
    <Dialog open={!!action} onOpenChange={open => { if (!open && !pending) { setAction(null); setError("") } }}>
      <DialogContent><DialogHeader><DialogTitle>{action?.type === "request" ? "Ajukan pembayaran" : action ? decisionLabels[action.action] : ""}</DialogTitle><DialogDescription>Keputusan dan bukti akan dicatat dalam jejak audit. Periksa kembali sebelum melanjutkan.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={submitAction}>
          {action?.type === "request" && <><p className="text-sm">Sisa tersedia: <strong>{money(remaining(action.item))}</strong></p><Field title="Jumlah pembayaran (Rp)"><Input type="number" min="1" step="1" max={remaining(action.item)} value={actionAmount} onChange={e => setActionAmount(e.target.value)} data-testid="input-vendor-payment-amount" /></Field></>}
          <Field title="Alasan / referensi bukti"><textarea className={`${inputClass} min-h-24 resize-y`} value={actionEvidence} onChange={e => setActionEvidence(e.target.value)} placeholder="Tuliskan referensi dokumen atau alasan keputusan" data-testid="input-vendor-decision-evidence" /></Field>
          {error && <p role="alert" className="text-sm text-destructive" data-testid="error-vendor-decision">{error}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={pending} onClick={() => setAction(null)}>Kembali</Button><Button type="submit" disabled={pending} data-testid="button-confirm-vendor-decision">{pending ? "Memproses..." : "Konfirmasi"}</Button></div>
        </form></DialogContent>
    </Dialog>
    <Dialog open={policyOpen} onOpenChange={open => { if (!pending) { setPolicyOpen(open); setError("") } }}>
      <DialogContent><DialogHeader><DialogTitle>Versi aturan kecocokan baru</DialogTitle><DialogDescription>Aturan lama tidak berubah. Versi ini berlaku bagi dokumen yang dicatat setelah tanggal efektifnya.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={submitPolicy}>
          <Field title="Tanggal & waktu berlaku"><Input type="datetime-local" value={policyDraft.effectiveFrom} onChange={e => setPolicyDraft(d => ({ ...d, effectiveFrom: e.target.value }))} data-testid="input-vendor-policy-effective" /></Field>
          <div className="grid grid-cols-2 gap-3">{([["quantityToleranceBasisPoints", "Toleransi kuantitas (bp)"], ["priceToleranceBasisPoints", "Toleransi harga (bp)"], ["taxTolerance", "Toleransi pajak (Rp)"], ["retentionTolerance", "Toleransi retensi (Rp)"], ["totalTolerance", "Toleransi total (Rp)"]] as const).map(([key, title]) => <Field key={key} title={title}><Input type="number" min="0" max={key.endsWith("BasisPoints") ? "10000" : undefined} step="1" value={policyDraft[key]} onChange={e => setPolicyDraft(d => ({ ...d, [key]: e.target.value }))} data-testid={`input-vendor-policy-${key}`} /></Field>)}</div>
          <p className="text-xs text-muted-foreground">100 basis poin = 1%. Toleransi rupiah menggunakan nilai bulat.</p>
          {error && <p role="alert" className="text-sm text-destructive" data-testid="error-vendor-policy">{error}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={pending} onClick={() => setPolicyOpen(false)}>Batal</Button><Button type="submit" disabled={pending} data-testid="button-save-vendor-policy">{pending ? "Menyimpan..." : "Simpan versi"}</Button></div>
        </form></DialogContent>
    </Dialog>
  </section>
}