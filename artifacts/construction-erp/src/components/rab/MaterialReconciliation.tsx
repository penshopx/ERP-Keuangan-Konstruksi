import { useEffect, useState } from "react"
import {
  useGetProjectMaterialReconciliation,
  getGetProjectMaterialReconciliationQueryKey,
  useUpdateMaterialVarianceException,
  useCreateMaterialRequirement,
  useGetProjectRab,
  getGetProjectRabQueryKey,
  MaterialReconciliationItem
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertCircle, History, CheckCircle2, PackageSearch, Plus } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { format } from "date-fns"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { useToast } from "@/hooks/use-toast"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

function EvidenceSheet({
  open,
  onOpenChange,
  item
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  item: MaterialReconciliationItem | null;
}) {
  if (!item) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-[500px] overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle>Bukti Transaksi Material</SheetTitle>
          <SheetDescription>
            {item.materialCode} - {item.materialName} ({item.workName})
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-muted/30 p-3 rounded-md border">
              <div className="text-muted-foreground text-xs mb-1">Dipesan (PO)</div>
              <div className="font-semibold text-base">{item.procuredQuantity.toLocaleString('id-ID')} {item.unit}</div>
            </div>
            <div className="bg-muted/30 p-3 rounded-md border">
              <div className="text-muted-foreground text-xs mb-1">Diterima</div>
              <div className="font-semibold text-base">{item.receivedQuantity.toLocaleString('id-ID')} {item.unit}</div>
            </div>
            <div className="bg-muted/30 p-3 rounded-md border">
              <div className="text-muted-foreground text-xs mb-1">Dikeluarkan</div>
              <div className="font-semibold text-base">{item.issuedQuantity.toLocaleString('id-ID')} {item.unit}</div>
            </div>
            <div className="bg-muted/30 p-3 rounded-md border">
              <div className="text-muted-foreground text-xs mb-1">Dikembalikan</div>
              <div className="font-semibold text-base">{item.returnedQuantity.toLocaleString('id-ID')} {item.unit}</div>
            </div>
            <div className="bg-muted/30 p-3 rounded-md border">
              <div className="text-muted-foreground text-xs mb-1">Terpasang</div>
              <div className="font-semibold text-base">{item.installedQuantity.toLocaleString('id-ID')} {item.unit}</div>
            </div>
            <div className="bg-muted/30 p-3 rounded-md border">
              <div className="text-muted-foreground text-xs mb-1">Ditagihkan</div>
              <div className="font-semibold text-base">{item.invoicedQuantity.toLocaleString('id-ID')} {item.unit}</div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold mb-3 border-b pb-2">Rincian Pergerakan</h3>
            {item.evidence.length === 0 ? (
              <div className="text-center text-muted-foreground py-8 border rounded-md border-dashed text-sm flex flex-col items-center gap-2">
                <PackageSearch className="h-6 w-6 opacity-20" />
                Tidak ada bukti pergerakan tercatat.
              </div>
            ) : (
              <div className="space-y-3">
                {item.evidence.map((ev) => (
                  <div key={ev.id} className="text-sm border rounded-md p-3 bg-muted/10">
                    <div className="flex justify-between items-start mb-2">
                      <Badge variant="outline" className="text-[10px] uppercase tracking-wider">{ev.movementType}</Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {format(new Date(ev.occurredAt), "dd MMM yyyy")}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="font-medium text-slate-800 dark:text-slate-200">
                        {ev.sourceDocumentType} {ev.sourceDocumentNumber}
                      </span>
                      <span className={`font-mono font-semibold ${ev.quantity > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                        {ev.quantity > 0 ? "+" : ""}{ev.quantity.toLocaleString('id-ID')} {ev.unit}
                      </span>
                    </div>
                    {ev.notes && <div className="text-xs text-muted-foreground mt-2 bg-muted/50 p-2 rounded">{ev.notes}</div>}
                    <div className="text-[10px] text-muted-foreground mt-2 text-right">Oleh: {ev.createdBy}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

const exceptionSchema = z.object({
  status: z.enum(["UNDER_REVIEW", "CLOSED"]),
  classification: z.enum([
    "WASTE", "DESIGN_CHANGE", "REWORK", "MISALLOCATION",
    "RECORDING_DELAY", "IN_TRANSIT", "UNIT_CONVERSION", "DAMAGE", "LOSS"
  ]),
  disposition: z.string().min(5, "Tindakan penyelesaian harus diisi (min. 5 karakter)")
})

function ExceptionDialog({
  projectId,
  open,
  onOpenChange,
  item
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  item: MaterialReconciliationItem | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateException = useUpdateMaterialVarianceException();

  const form = useForm<z.infer<typeof exceptionSchema>>({
    resolver: zodResolver(exceptionSchema),
    defaultValues: {
      status: "UNDER_REVIEW",
      classification: "WASTE",
      disposition: ""
    }
  })

  useEffect(() => {
    if (item?.exception) {
      form.reset({
        status: item.exception.status === "OPEN" ? "UNDER_REVIEW" : item.exception.status as any,
        classification: item.exception.classification ?? "WASTE",
        disposition: item.exception.disposition ?? ""
      })
    }
  }, [item, form])

  if (!item || !item.exception) return null;

  const onSubmit = (values: z.infer<typeof exceptionSchema>) => {
    updateException.mutate({
      projectId,
      exceptionId: item.exception!.id,
      data: values
    }, {
      onSuccess: (updatedException) => {
        queryClient.invalidateQueries({ queryKey: getGetProjectMaterialReconciliationQueryKey(projectId) })
        toast({ title: "Disposition tersimpan", description: updatedException.status === "CLOSED" ? "Exception material telah ditutup." : "Exception material sedang ditinjau." })
        onOpenChange(false);
      },
      onError: (error) => toast({ title: "Disposition gagal disimpan", description: error.message, variant: "destructive" })
    })
  }

  const ex = item.exception;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle>Tindak Lanjut Selisih Material</DialogTitle>
          <DialogDescription>
            Rekonsiliasi <span className="font-mono">{item.materialCode}</span> melebihi toleransi penggunaan pada pekerjaan {item.workName}.
          </DialogDescription>
        </DialogHeader>

        <div className="my-2 bg-muted/40 p-4 rounded-lg border grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">Kebutuhan RAB</div>
            <div className="font-semibold text-lg">{item.theoreticalQuantity.toLocaleString('id-ID')} {item.unit}</div>
          </div>
          <div className="space-y-1">
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">Pemakaian Aktual</div>
            <div className="font-semibold text-lg">{item.consumedQuantity.toLocaleString('id-ID')} {item.unit}</div>
          </div>
          <div className="space-y-1">
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">Batas Toleransi</div>
            <div className="font-medium text-muted-foreground text-sm">{item.allowedQuantity.toLocaleString('id-ID')} {item.unit} (+{item.tolerancePercent}%)</div>
          </div>
          <div className="space-y-1">
            <div className="text-destructive text-[10px] uppercase tracking-wider font-semibold">Selisih Berlebih</div>
            <div className="font-bold text-destructive text-lg">+{item.varianceQuantity.toLocaleString('id-ID')} {item.unit}</div>
          </div>
        </div>

        {ex.status === "CLOSED" ? (
          <div className="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900 rounded-lg p-5 space-y-4 text-sm mt-2">
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-bold text-base border-b border-emerald-100 dark:border-emerald-900/50 pb-3">
              <CheckCircle2 className="h-5 w-5" />
              Pengecualian Ditutup
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Klasifikasi Penyebab</div>
                <div className="font-medium">{ex.classification?.replace("_", " ")}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Diselesaikan Oleh</div>
                <div className="font-medium">{ex.closedBy}</div>
              </div>
              <div className="col-span-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Waktu Selesai</div>
                <div className="font-medium">{ex.closedAt ? format(new Date(ex.closedAt), "dd MMMM yyyy HH:mm") : "-"}</div>
              </div>
            </div>
            <div className="pt-3 border-t border-emerald-100 dark:border-emerald-900/50">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Tindakan Penyelesaian</div>
              <p className="bg-white dark:bg-black/20 p-3 rounded border text-slate-700 dark:text-slate-300 leading-relaxed">{ex.disposition}</p>
            </div>
            <Button type="button" variant="outline" className="w-full mt-2" onClick={() => onOpenChange(false)}>Tutup</Button>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 mt-2">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="classification"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Klasifikasi Penyebab</FormLabel>
                       <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-classification">
                            <SelectValue placeholder="Pilih klasifikasi" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="WASTE">Waste (Pemborosan)</SelectItem>
                          <SelectItem value="DESIGN_CHANGE">Perubahan Desain</SelectItem>
                          <SelectItem value="REWORK">Kerja Ulang (Rework)</SelectItem>
                          <SelectItem value="MISALLOCATION">Salah Alokasi</SelectItem>
                          <SelectItem value="RECORDING_DELAY">Telat Pencatatan</SelectItem>
                          <SelectItem value="IN_TRANSIT">Dalam Perjalanan</SelectItem>
                          <SelectItem value="UNIT_CONVERSION">Beda Satuan</SelectItem>
                          <SelectItem value="DAMAGE">Rusak di Proyek</SelectItem>
                          <SelectItem value="LOSS">Hilang</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Status Penanganan</FormLabel>
                       <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-status">
                            <SelectValue placeholder="Pilih status" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="UNDER_REVIEW">Sedang Ditinjau</SelectItem>
                          <SelectItem value="CLOSED">Selesai (Tutup)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="disposition"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tindakan Penyelesaian</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Jelaskan tindakan yang diambil untuk menyelesaikan masalah ini..."
                        className="resize-none min-h-[100px]"
                        data-testid="textarea-disposition"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter className="pt-2">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Batal</Button>
                <Button type="submit" disabled={updateException.isPending} data-testid="button-submit-exception">
                  {updateException.isPending ? "Menyimpan..." : "Simpan Perubahan"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <History className="h-4 w-4" />
            Jejak audit exception
          </div>
          {ex.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada aktivitas peninjauan.</p>
          ) : (
            <div className="max-h-40 space-y-2 overflow-y-auto pr-1">
              {ex.events.map((event) => (
                <div key={event.id} className="rounded-md border bg-muted/20 p-3 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold">{event.eventType.replaceAll("_", " ")}</span>
                    <span className="text-muted-foreground">{format(new Date(event.createdAt), "dd MMM yyyy HH:mm")}</span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{event.detail}</p>
                  <p className="mt-1 font-medium">Oleh {event.actorName}</p>
                </div>
              ))}
            </div>
          )}
        </div>

      </DialogContent>
    </Dialog>
  )
}

function RequirementDialog({ projectId, baselineId, open, onOpenChange }: {
  projectId: string
  baselineId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const rab = useGetProjectRab(projectId, { query: { enabled: open, queryKey: getGetProjectRabQueryKey(projectId) } })
  const createRequirement = useCreateMaterialRequirement()
  const [values, setValues] = useState({
    rabItemId: "",
    materialCode: "",
    materialName: "",
    unit: "",
    analysisVersion: "1",
    coefficient: "",
    tolerancePercent: "0",
    effectiveFrom: new Date().toISOString().slice(0, 10),
    effectiveTo: "",
    reason: "",
  })
  const eligibleItems = rab.data?.items.filter((item) => item.costCodeId && item.quantity > 0) ?? []
  const update = (field: keyof typeof values, value: string) => setValues((current) => ({ ...current, [field]: value }))

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!values.rabItemId || !values.materialCode.trim() || !values.materialName.trim() || !values.unit.trim() || !values.reason.trim()) {
      toast({ title: "Konfigurasi belum lengkap", description: "Isi item RAB, identitas material, satuan, dan alasan versi.", variant: "destructive" })
      return
    }
    createRequirement.mutate({
      projectId,
      data: {
        baselineId,
        rabItemId: values.rabItemId,
        materialCode: values.materialCode.trim(),
        materialName: values.materialName.trim(),
        unit: values.unit.trim(),
        analysisVersion: Number(values.analysisVersion),
        coefficient: Number(values.coefficient),
        tolerancePercent: Number(values.tolerancePercent),
        effectiveFrom: values.effectiveFrom,
        effectiveTo: values.effectiveTo || null,
        reason: values.reason.trim(),
      },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetProjectMaterialReconciliationQueryKey(projectId) })
        toast({ title: "Kebutuhan material ditambahkan", description: "Koefisien dan toleransi berlaku sesuai periode yang dipilih." })
        onOpenChange(false)
        setValues((current) => ({ ...current, rabItemId: "", materialCode: "", materialName: "", unit: "", coefficient: "", reason: "" }))
      },
      onError: (error) => toast({ title: "Konfigurasi gagal disimpan", description: error.message, variant: "destructive" }),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tambah kebutuhan material</DialogTitle>
          <DialogDescription>Hubungkan material ke item RAB dengan koefisien analisa dan toleransi waste yang memiliki periode berlaku.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>Item RAB / WBS</Label>
            <Select value={values.rabItemId} onValueChange={(value) => update("rabItemId", value)}>
              <SelectTrigger data-testid="select-material-rab-item"><SelectValue placeholder="Pilih item RAB" /></SelectTrigger>
              <SelectContent>
                {eligibleItems.map((item) => <SelectItem key={item.id} value={item.id}>{item.code} · {item.name} ({item.quantity} {item.unit})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2"><Label>Kode material</Label><Input value={values.materialCode} onChange={(event) => update("materialCode", event.target.value)} data-testid="input-material-code" /></div>
            <div className="grid gap-2 sm:col-span-2"><Label>Nama material</Label><Input value={values.materialName} onChange={(event) => update("materialName", event.target.value)} data-testid="input-material-name" /></div>
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="grid gap-2"><Label>Satuan dasar</Label><Input value={values.unit} onChange={(event) => update("unit", event.target.value)} placeholder="kg, m3, zak" /></div>
            <div className="grid gap-2"><Label>Versi analisa</Label><Input type="number" min="1" step="1" value={values.analysisVersion} onChange={(event) => update("analysisVersion", event.target.value)} /></div>
            <div className="grid gap-2"><Label>Koefisien</Label><Input type="number" min="0.000001" step="any" value={values.coefficient} onChange={(event) => update("coefficient", event.target.value)} data-testid="input-material-coefficient" /></div>
            <div className="grid gap-2"><Label>Toleransi waste (%)</Label><Input type="number" min="0" max="100" step="0.01" value={values.tolerancePercent} onChange={(event) => update("tolerancePercent", event.target.value)} /></div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label>Berlaku mulai</Label><Input type="date" value={values.effectiveFrom} onChange={(event) => update("effectiveFrom", event.target.value)} /></div>
            <div className="grid gap-2"><Label>Berlaku sampai (opsional)</Label><Input type="date" value={values.effectiveTo} onChange={(event) => update("effectiveTo", event.target.value)} /></div>
          </div>
          <div className="grid gap-2"><Label>Alasan versi dan toleransi</Label><Textarea value={values.reason} onChange={(event) => update("reason", event.target.value)} placeholder="Contoh: metode kerja pengecoran dan kondisi akses proyek" /></div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Batal</Button>
            <Button type="submit" disabled={createRequirement.isPending} data-testid="button-save-material-requirement">
              {createRequirement.isPending ? "Menyimpan…" : "Simpan kebutuhan"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function MaterialReconciliation({ projectId }: { projectId: string }) {
  const { data, isLoading, isError } = useGetProjectMaterialReconciliation(projectId, {
    query: {
      enabled: Boolean(projectId),
      queryKey: getGetProjectMaterialReconciliationQueryKey(projectId)
    }
  });

  const [evidenceItem, setEvidenceItem] = useState<MaterialReconciliationItem | null>(null);
  const [exceptionItem, setExceptionItem] = useState<MaterialReconciliationItem | null>(null);
  const [requirementOpen, setRequirementOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="h-64 flex flex-col items-center justify-center gap-4 text-muted-foreground">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p>Memuat data rekonsiliasi material...</p>
      </div>
    );
  }
  
  if (isError || !data) {
    return (
      <div className="h-64 flex flex-col items-center justify-center border border-dashed rounded-lg bg-muted/10 text-destructive p-6 text-center">
        <AlertCircle className="h-8 w-8 mb-2 opacity-50" />
        <p className="font-medium">Gagal memuat rekonsiliasi material.</p>
        <p className="text-sm opacity-80 mt-1">Pastikan baseline proyek telah ditetapkan.</p>
      </div>
    );
  }

  const items = data.items || [];
  const safeItemsCount = items.length;
  const safeExceptionsCount = data.openExceptionCount ?? 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Kebutuhan dan pemakaian material</h2>
          <p className="text-sm text-muted-foreground">Perhitungan memakai quantity RAB × koefisien analisa berversi. Selisih menjadi exception, bukan koreksi otomatis.</p>
        </div>
        <Button type="button" onClick={() => setRequirementOpen(true)} data-testid="button-add-material-requirement">
          <Plus className="mr-2 h-4 w-4" />Tambah kebutuhan
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="bg-gradient-to-br from-muted/50 to-muted/20 border-muted-foreground/20 shadow-sm">
          <CardContent className="p-5 flex flex-col justify-center">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Item Terpantau</div>
            <div className="text-3xl font-bold text-foreground">{safeItemsCount} <span className="text-base font-normal text-muted-foreground ml-1">Material</span></div>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-amber-500/10 to-amber-500/5 border-amber-500/20 shadow-sm">
          <CardContent className="p-5 flex flex-col justify-center">
            <div className="text-xs font-semibold uppercase tracking-wider text-amber-700/80 dark:text-amber-500/80 mb-1">Selisih Aktif (Review)</div>
            <div className="text-3xl font-bold text-amber-600 dark:text-amber-500">{safeExceptionsCount} <span className="text-base font-normal opacity-70 ml-1">Item</span></div>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-blue-500/10 to-blue-500/5 border-blue-500/20 shadow-sm">
          <CardContent className="p-5 flex flex-col justify-center">
            <div className="text-xs font-semibold uppercase tracking-wider text-blue-700/80 dark:text-blue-500/80 mb-1">Terakhir Diperbarui</div>
            <div className="text-xl font-bold text-blue-600 dark:text-blue-500 mt-1">
              {data.asOf ? format(new Date(data.asOf), "dd MMM yyyy, HH:mm") : "-"}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[250px]">Material</TableHead>
                <TableHead className="w-[250px]">Pekerjaan (WBS)</TableHead>
                <TableHead className="text-right">Kebutuhan RAB</TableHead>
                <TableHead className="text-right">Pemakaian</TableHead>
                <TableHead className="text-right">Status Toleransi</TableHead>
                <TableHead className="w-[120px] text-center">Tindakan</TableHead>
                <TableHead className="w-[100px] text-right pr-4">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const percentUsed = item.theoreticalQuantity > 0 
                  ? (item.consumedQuantity / item.theoreticalQuantity) * 100 
                  : 0;
                  
                return (
                  <TableRow 
                    key={`${item.rabItemId}-${item.materialId}`} 
                    data-testid={`row-reconciliation-${item.materialCode}`}
                    className={item.exceedsTolerance ? "bg-amber-50/30 dark:bg-amber-950/10" : ""}
                  >
                    <TableCell>
                      <div className="font-semibold text-slate-800 dark:text-slate-200 line-clamp-1" title={item.materialName}>{item.materialName}</div>
                      <div className="text-xs text-muted-foreground font-mono mt-0.5">{item.materialCode}</div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-sm line-clamp-1" title={item.workName}>{item.workName}</div>
                      <div className="text-[10px] text-muted-foreground font-mono mt-0.5 bg-muted inline-block px-1.5 py-0.5 rounded">{item.workCode}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="text-sm font-medium">{item.theoreticalQuantity.toLocaleString('id-ID')} {item.unit}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">Maks: {item.allowedQuantity.toLocaleString('id-ID')} (+{item.tolerancePercent}%)</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="text-sm font-bold">{item.consumedQuantity.toLocaleString('id-ID')} {item.unit}</div>
                      <div className="w-24 ml-auto mt-1.5 flex items-center gap-2">
                        <Progress 
                          value={Math.min(percentUsed, 100)} 
                          className="h-1.5" 
                          indicatorColor={item.exceedsTolerance ? "bg-destructive" : "bg-primary"} 
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {item.exceedsTolerance ? (
                        <div className="flex flex-col items-end">
                          <span className="text-sm font-bold text-destructive flex items-center gap-1">
                            +{item.varianceQuantity.toLocaleString('id-ID')} {item.unit}
                          </span>
                          <span className="text-[10px] text-destructive/80 font-medium">MELEBIHI BATAS</span>
                        </div>
                      ) : (
                        <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 px-2 py-1 rounded-full border border-emerald-200 dark:border-emerald-900/50">
                          Sesuai RAB
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {item.exception ? (
                        <Badge
                          variant={item.exception.status === "CLOSED" ? "success" : item.exception.status === "UNDER_REVIEW" ? "warning" : "destructive"}
                          className="whitespace-nowrap text-[10px] py-0 tracking-wide h-5"
                        >
                          {item.exception.status.replace("_", " ")}
                        </Badge>
                      ) : item.exceedsTolerance ? (
                        <Badge variant="outline" className="text-amber-600 border-amber-600/50 bg-amber-50 dark:bg-amber-950/20 whitespace-nowrap text-[10px] py-0 tracking-wide h-5">MENUNGGU TINDAKAN</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground opacity-50">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right pr-4">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted"
                          title="Lihat Bukti Pergerakan"
                          data-testid={`button-evidence-${item.materialCode}`}
                          onClick={() => setEvidenceItem(item)}
                        >
                          <History className="h-4 w-4" />
                        </Button>
                        {item.exception && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className={`h-8 w-8 ${item.exception.status !== "CLOSED" ? "text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/30" : "text-muted-foreground hover:text-foreground"}`}
                            title="Tindak Lanjut Selisih"
                            data-testid={`button-exception-${item.materialCode}`}
                            onClick={() => setExceptionItem(item)}
                          >
                            <AlertCircle className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground bg-muted/10">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <PackageSearch className="h-8 w-8 opacity-20" />
                      <p>Tidak ada rekonsiliasi material untuk proyek ini.</p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <EvidenceSheet
        open={evidenceItem !== null}
        onOpenChange={(o) => !o && setEvidenceItem(null)}
        item={evidenceItem}
      />

      <ExceptionDialog
        projectId={projectId}
        open={exceptionItem !== null}
        onOpenChange={(o) => !o && setExceptionItem(null)}
        item={exceptionItem}
      />
      <RequirementDialog
        projectId={projectId}
        baselineId={data.baselineId}
        open={requirementOpen}
        onOpenChange={setRequirementOpen}
      />
    </div>
  )
}
