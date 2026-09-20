import { useState, useMemo } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useGetCurrentUser,
  useListAhsTemplates,
  usePreviewRabEstimate,
  useCreateRabEstimateBaseline,
  useTransitionRabBaseline,
  getGetProjectRabQueryKey,
  getListAhsTemplatesQueryKey,
  getListProjectRabVersionsQueryKey,
  type EstimatePreview,
} from "@workspace/api-client-react"
import { formatRupiah, formatDate } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { Calculator, AlertTriangle, CheckCircle2, FileText, Activity, ShieldAlert, ArrowRight } from "lucide-react"

export function EstimatorWorkbench({
  projectId,
  baselineId,
  rabVersion,
  rabStatus,
  isHistorical
}: {
  projectId: string
  baselineId: string
  rabVersion: number
  rabStatus: string
  isHistorical: boolean
}) {
  const { data: user } = useGetCurrentUser()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [effectiveDate, setEffectiveDate] = useState(() => {
    const d = new Date()
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split("T")[0]
  })
  const [templateId, setTemplateId] = useState<string>("")
  const [volume, setVolume] = useState<string>("1")
  const [preview, setPreview] = useState<EstimatePreview | null>(null)
  
  const [transitionNote, setTransitionNote] = useState("")

  const { data: templates, isLoading: loadingTemplates, isError: errorTemplates } = useListAhsTemplates(
    { effectiveDate },
    { query: { enabled: !!effectiveDate, queryKey: getListAhsTemplatesQueryKey({ effectiveDate }) } }
  )

  const previewEstimate = usePreviewRabEstimate()
  const createBaseline = useCreateRabEstimateBaseline()
  const transitionRab = useTransitionRabBaseline()

  const selectedTemplate = useMemo(() => templates?.find(t => t.id === templateId), [templates, templateId])

  const permissions = user?.permissions || []
  const canEstimate = permissions.includes("rab:estimate")
  const canApprove = permissions.includes("rab:approve")
  const canReview = permissions.includes("rab:review")

  const handlePreview = () => {
    const volumeDec = parseFloat(volume)
    if (isNaN(volumeDec) || volumeDec <= 0) {
      toast({ title: "Volume tidak valid", description: "Masukkan angka positif yang valid.", variant: "destructive" })
      return
    }
    
    previewEstimate.mutate(
      {
        projectId,
        data: {
          templateId,
          effectiveDate,
          volumeBasisPoints: Math.round(volumeDec * 100)
        }
      },
      {
        onSuccess: (data) => {
          setPreview(data)
        },
        onError: (error: any) => {
          toast({
            title: "Gagal memuat pratinjau",
            description: error?.message || "Terjadi kesalahan saat mengkalkulasi estimasi dari backend.",
            variant: "destructive"
          })
        }
      }
    )
  }

  const handleApplyToDraft = () => {
    if (!preview) return
    createBaseline.mutate(
      {
        projectId,
        data: {
          previewId: preview.id,
          expectedLatestVersion: rabVersion
        }
      },
      {
        onSuccess: () => {
          toast({ title: "Berhasil", description: "Estimasi berhasil ditambahkan ke Draf RAB." })
          setPreview(null)
          queryClient.invalidateQueries({ queryKey: getGetProjectRabQueryKey(projectId) })
          queryClient.invalidateQueries({ queryKey: getListProjectRabVersionsQueryKey(projectId) })
        },
        onError: (error: any) => {
          toast({
            title: "Gagal menyimpan estimasi",
            description: error?.message || "Terjadi konflik versi atau masalah di backend.",
            variant: "destructive"
          })
        }
      }
    )
  }

  const handleTransition = (decision: "SUBMIT" | "APPROVE" | "REJECT") => {
    transitionRab.mutate(
      {
        projectId,
        data: {
          baselineId,
          decision,
          note: transitionNote
        }
      },
      {
        onSuccess: () => {
          toast({ title: "Status Berhasil Diperbarui", description: `RAB telah di-${decision.toLowerCase()}.` })
          setTransitionNote("")
          queryClient.invalidateQueries({ queryKey: getGetProjectRabQueryKey(projectId) })
          queryClient.invalidateQueries({ queryKey: getListProjectRabVersionsQueryKey(projectId) })
        },
        onError: (error: any) => {
          toast({
            title: "Gagal memperbarui status",
            description: error?.message || "Terdapat konflik pada proses peralihan status RAB.",
            variant: "destructive"
          })
        }
      }
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert className="bg-primary/5 text-primary border-primary/20">
        <Activity className="h-4 w-4" />
        <AlertTitle>Workflow Estimator AHS</AlertTitle>
        <AlertDescription className="text-muted-foreground mt-1">
          <p className="mb-2">Alur kerja estimasi: <strong>Pilih AHS & tanggal harga → masukkan volume → review rincian formula (backend authoritative) → buat draft RAB → submit/review status.</strong></p>
          <p className="text-xs border-t border-primary/10 pt-2">
            <em>Catatan Sistem:</em> Profil kompetensi (seperti SKKNI Estimator) terpisah dari otorisasi sistem. Sertifikasi Anda memvalidasi kemampuan profesi, namun tindakan di bawah ini bergantung pada izin operasional (RBAC) pada proyek ini (mis. <code className="text-xs bg-muted px-1 rounded">rab:estimate</code>).
          </p>
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Kalkulasi Estimasi Baru</CardTitle>
              <CardDescription>Pilih Analisa Harga Satuan (AHS) master untuk menghitung estimasi biaya berdasarkan harga sumber daya pada tanggal efektif.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Tanggal Harga Efektif</Label>
                  <Input 
                    type="date" 
                    value={effectiveDate} 
                    onChange={e => setEffectiveDate(e.target.value)} 
                    disabled={isHistorical}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Volume Pekerjaan</Label>
                  <Input 
                    type="number" 
                    min="0.01"
                    step="0.01"
                    value={volume} 
                    onChange={e => setVolume(e.target.value)} 
                    disabled={isHistorical}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>Template AHS Master</Label>
                  {loadingTemplates ? (
                    <div className="text-sm text-muted-foreground animate-pulse">Memuat template AHS...</div>
                  ) : errorTemplates ? (
                    <div className="text-sm text-destructive">Gagal memuat template AHS.</div>
                  ) : !templates || templates.length === 0 ? (
                    <Alert className="border-amber-500/30 bg-amber-500/5">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      <AlertTitle className="text-sm">Master AHS Kosong</AlertTitle>
                      <AlertDescription className="text-xs text-muted-foreground mt-1">
                        Konfigurasi master AHS dan harga sumber daya (material/upah/alat) pada tanggal efektif ini belum tersedia. Sistem tidak mengizinkan penggunaan harga palsu atau dummy. Hubungi admin Cost Control.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Select value={templateId} onValueChange={setTemplateId} disabled={isHistorical}>
                      <SelectTrigger>
                        <SelectValue placeholder="Pilih Template AHS..." />
                      </SelectTrigger>
                      <SelectContent>
                        {templates.map(t => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.code} - {t.name} (v{t.version}) · Berlaku mulai {formatDate(t.effectiveFrom)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>

              {selectedTemplate && (
                <div className="mt-6 border rounded-lg overflow-hidden">
                  <div className="bg-muted px-4 py-3 flex justify-between items-center border-b">
                    <div>
                      <div className="font-semibold">{selectedTemplate.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Versi {selectedTemplate.version} · Berlaku: {formatDate(selectedTemplate.effectiveFrom)} {selectedTemplate.effectiveTo ? `- ${formatDate(selectedTemplate.effectiveTo)}` : ''} · {selectedTemplate.sourceNote}
                      </div>
                    </div>
                    <Badge variant="outline">{selectedTemplate.unit}</Badge>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Kategori</TableHead>
                        <TableHead>Sumber Daya</TableHead>
                        <TableHead>Koefisien</TableHead>
                        <TableHead>Waste</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedTemplate.components.map(comp => (
                        <TableRow key={comp.id}>
                          <TableCell><Badge variant="secondary" className="text-[10px]">{comp.resourceKind}</Badge></TableCell>
                          <TableCell>
                            <div className="text-sm font-medium">{comp.resourceName}</div>
                            <div className="text-xs text-muted-foreground font-mono">{comp.resourceCode}</div>
                          </TableCell>
                          <TableCell className="text-sm font-mono">{(comp.coefficientMicros / 1000000).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 4 })} {comp.unit}</TableCell>
                          <TableCell className="text-sm font-mono">{(comp.wasteBasisPoints / 100).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%</TableCell>
                        </TableRow>
                      ))}
                      {selectedTemplate.components.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground py-6 text-sm">Tidak ada komponen pada AHS ini.</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
            <CardFooter className="bg-muted/30 border-t flex justify-end">
              <Button 
                onClick={handlePreview} 
                disabled={!templateId || isHistorical || previewEstimate.isPending}
              >
                <Calculator className="mr-2 h-4 w-4" />
                {previewEstimate.isPending ? "Mengkalkulasi..." : "Pratinjau Estimasi (Backend)"}
              </Button>
            </CardFooter>
          </Card>

          {preview && (
            <Card className="border-primary/20 shadow-md animate-in fade-in slide-in-from-bottom-4">
              <CardHeader className="bg-primary/5 pb-4 border-b border-primary/10">
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg text-primary">
                      <CheckCircle2 className="h-5 w-5" /> Hasil Kalkulasi Pratinjau
                    </CardTitle>
                    <CardDescription className="mt-1.5">
                      Dihitung secara authoritative oleh server. Volume: <strong className="text-foreground">{(preview.volumeBasisPoints / 100).toLocaleString('id-ID')}</strong> · Tanggal: <strong className="text-foreground">{formatDate(preview.effectiveDate)}</strong>
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="bg-background text-xs font-mono flex items-center gap-1 border-primary/20 text-primary">
                    <ShieldAlert className="h-3 w-3" /> Snapshot Formula Terkunci
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-6">
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <div className="text-sm font-medium text-muted-foreground mb-1">Harga Satuan</div>
                    <div className="text-2xl font-mono font-semibold">{formatRupiah(preview.unitPriceRupiah)}</div>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-muted-foreground mb-1">Total Biaya (Budget)</div>
                    <div className="text-2xl font-mono font-bold text-primary">{formatRupiah(preview.totalBudgetRupiah)}</div>
                  </div>
                </div>
                
                <div className="mt-6 p-4 bg-muted/40 rounded-lg border border-border/50 text-xs">
                  <div className="font-semibold flex items-center gap-2 mb-2 text-muted-foreground">
                    <FileText className="h-3.5 w-3.5" /> Jejak Audit Rincian (Formula Snapshot)
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground overflow-auto max-h-32 whitespace-pre-wrap">
                    {JSON.stringify(preview.formulaSnapshot, null, 2)}
                  </div>
                </div>
              </CardContent>
              <CardFooter className="bg-muted/10 border-t flex justify-end py-4">
                {rabStatus === "DRAF" ? (
                  canEstimate ? (
                    <Button 
                      onClick={handleApplyToDraft} 
                      disabled={createBaseline.isPending}
                    >
                      <ArrowRight className="mr-2 h-4 w-4" />
                      {createBaseline.isPending ? "Menyimpan..." : "Terapkan ke Draf RAB"}
                    </Button>
                  ) : (
                    <span className="text-sm text-muted-foreground">Tidak memiliki izin operasi (rab:estimate)</span>
                  )
                ) : (
                  <span className="text-sm text-muted-foreground">Hanya dapat diterapkan pada RAB status DRAF</span>
                )}
              </CardFooter>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Alur Kerja RAB</CardTitle>
              <CardDescription>Peralihan status persetujuan baseline RAB.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-muted/50 p-4 rounded-lg flex flex-col items-center justify-center border text-center">
                <span className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">Status Saat Ini</span>
                 <Badge variant={rabStatus === 'DISETUJUI' ? 'success' : rabStatus === 'DITOLAK' ? 'destructive' : 'default'} className="text-sm py-1 px-3">
                  {rabStatus}
                </Badge>
                {isHistorical && (
                  <span className="text-xs text-destructive mt-2 font-medium">Hanya-baca (Versi Historis)</span>
                )}
              </div>

              {!isHistorical && (
                <div className="space-y-3 pt-4 border-t">
                  <Label>Catatan Transisi (Opsional)</Label>
                  <Textarea 
                    placeholder="Masukkan justifikasi atau catatan..." 
                    value={transitionNote} 
                    onChange={e => setTransitionNote(e.target.value)}
                    className="text-sm min-h-[80px]"
                  />
                  
                  <div className="flex flex-col gap-2 mt-4">
                    {rabStatus === "DRAF" && (
                      canEstimate ? (
                        <Button 
                          className="w-full" 
                          onClick={() => handleTransition("SUBMIT")}
                          disabled={transitionRab.isPending}
                        >
                          Ajukan Persetujuan (SUBMIT)
                        </Button>
                      ) : (
                        <Alert className="py-2 px-3"><AlertDescription className="text-xs">Izin <code className="bg-muted px-1">rab:estimate</code> diperlukan untuk submit.</AlertDescription></Alert>
                      )
                    )}

                    {rabStatus === "DIAJUKAN" && (
                      <>
                        {canApprove ? (
                          <Button 
                            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white" 
                            onClick={() => handleTransition("APPROVE")}
                            disabled={transitionRab.isPending}
                          >
                            Setujui Baseline (APPROVE)
                          </Button>
                        ) : (
                          <Alert className="py-2 px-3"><AlertDescription className="text-xs">Izin <code className="bg-muted px-1">rab:approve</code> diperlukan untuk menyetujui.</AlertDescription></Alert>
                        )}
                        
                        {canReview ? (
                          <Button 
                            variant="destructive"
                            className="w-full" 
                            onClick={() => handleTransition("REJECT")}
                            disabled={transitionRab.isPending}
                          >
                            Tolak (REJECT)
                          </Button>
                        ) : (
                          !canApprove && <Alert className="py-2 px-3"><AlertDescription className="text-xs">Izin <code className="bg-muted px-1">rab:review</code> diperlukan untuk menolak.</AlertDescription></Alert>
                        )}
                      </>
                    )}

                    {rabStatus !== "DRAF" && rabStatus !== "DIAJUKAN" && (
                      <div className="text-center text-sm text-muted-foreground italic py-2">
                        Tidak ada tindakan lanjutan untuk status ini.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
