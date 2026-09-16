import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListRabTemplates,
  getListRabTemplatesQueryKey,
  useImportProjectRabTemplate,
  getGetProjectRabQueryKey,
  getGetProjectQueryKey,
  getListProjectRabVersionsQueryKey,
} from "@workspace/api-client-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  SheetTrigger
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from "@/components/ui/form"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { formatRupiah } from "@/lib/utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertTriangle, CopyPlus, Info, CheckCircle2 } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"

const importSchema = z.object({
  templateId: z.string().min(1, "Silakan pilih template terlebih dahulu"),
  priceFactor: z.coerce.number().min(0.01, "Faktor harga minimal 0.01").max(100, "Faktor harga maksimal 100")
})

type ImportFormValues = z.infer<typeof importSchema>

export function ImportTemplateSheet({ projectId, currentTotal }: { projectId: string; currentTotal: number }) {
  const [open, setOpen] = useState(false)
  const { data: templates, isLoading: loadingTemplates } = useListRabTemplates({
    query: {
      enabled: open,
      queryKey: getListRabTemplatesQueryKey()
    }
  })
  const importTemplate = useImportProjectRabTemplate()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const form = useForm<ImportFormValues>({
    resolver: zodResolver(importSchema),
    defaultValues: {
      templateId: "",
      priceFactor: 1,
    }
  })

  const selectedTemplateId = form.watch("templateId")
  const priceFactor = form.watch("priceFactor") || 0
  const selectedTemplate = templates?.find(t => t.id === selectedTemplateId)
  const adjustedTotal = selectedTemplate ? selectedTemplate.totalBudget * priceFactor : 0

  const onSubmit = (data: ImportFormValues) => {
    importTemplate.mutate({
      projectId,
      data: {
        templateId: data.templateId,
        priceFactor: data.priceFactor
      }
    }, {
      onSuccess: () => {
        toast({
          title: "Template Berhasil Diimpor",
          description: "RAB draft baru telah dibuat berdasarkan template.",
        })
        queryClient.invalidateQueries({ queryKey: getGetProjectRabQueryKey(projectId) })
        queryClient.invalidateQueries({ queryKey: getListProjectRabVersionsQueryKey(projectId) })
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) })
        setOpen(false)
        form.reset()
      },
      onError: (err: any) => {
        toast({
          title: "Gagal Mengimpor",
          description: err.message || "Terjadi kesalahan saat memproses template.",
          variant: "destructive"
        })
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button>
          <CopyPlus className="mr-2 h-4 w-4" />
          Impor Template RAB
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-xl flex flex-col gap-0 border-l border-border bg-card p-0 h-[100dvh]">
        <div className="px-6 py-6 border-b border-border bg-muted/30">
          <SheetHeader>
            <SheetTitle className="text-xl">Impor Template RAB Baru</SheetTitle>
            <SheetDescription>
              Buat versi RAB baru dari struktur standar template. Baseline sebelumnya tetap tersimpan dan versi baru berstatus DRAF untuk ditinjau.
            </SheetDescription>
          </SheetHeader>
        </div>

        <ScrollArea className="flex-1 px-6 py-6">
          <Form {...form}>
            <form id="import-template-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              
              <FormField
                control={form.control}
                name="templateId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Pilih Template Standar</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} disabled={loadingTemplates}>
                      <FormControl>
                        <SelectTrigger className="bg-background">
                          <SelectValue placeholder="Pilih template dari library..." />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {templates?.map(t => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name} — {t.projectType}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {selectedTemplate && (
                <div className="rounded-lg border border-border bg-background p-5 text-sm flex flex-col gap-3 animate-in fade-in slide-in-from-top-2 shadow-sm">
                  <div className="flex items-start justify-between">
                    <div className="font-bold text-foreground text-base">{selectedTemplate.name}</div>
                    <div className="bg-primary/10 text-primary text-xs font-semibold px-2 py-1 rounded-md">{selectedTemplate.projectType}</div>
                  </div>
                  
                  <div className="text-muted-foreground leading-relaxed">
                    {selectedTemplate.description}
                  </div>
                  
                  <div className="grid grid-cols-2 gap-6 mt-2 pt-4 border-t border-border">
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wider">Item WBS</div>
                      <div className="font-mono text-xl font-semibold">{selectedTemplate.itemCount}</div>
                    </div>
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wider">Base Budget</div>
                      <div className="font-mono text-xl font-semibold">{formatRupiah(selectedTemplate.totalBudget)}</div>
                    </div>
                  </div>
                  
                  <div className="bg-muted/50 p-3 rounded-md text-xs text-muted-foreground flex items-start gap-2 mt-2">
                    <Info className="h-4 w-4 shrink-0 text-primary mt-0.5" />
                    <span>Sumber Harga: {selectedTemplate.sourceNote}</span>
                  </div>
                </div>
              )}

              <FormField
                control={form.control}
                name="priceFactor"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Penyesuaian Harga (Multiplier)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" min="0.01" max="100" {...field} className="font-mono bg-background text-lg py-5" />
                    </FormControl>
                    <FormDescription>
                      Gunakan 1.0 untuk harga base. Gunakan (contoh: 1.15) untuk menyesuaikan margin, inflasi regional, atau kondisi proyek spesifik.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {selectedTemplate && (
                <Alert className={adjustedTotal > currentTotal ? "border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10" : "border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-500/10"}>
                  {adjustedTotal > currentTotal ? (
                    <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-500" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
                  )}
                  <AlertTitle className="text-sm font-semibold ml-1">Proyeksi Anggaran Draft</AlertTitle>
                  <AlertDescription className="text-sm mt-3 ml-1">
                    <div className="flex flex-col gap-2">
                      <div className="flex justify-between items-center py-1">
                        <span className="text-muted-foreground">Baseline Saat Ini</span>
                        <span className="font-mono font-medium">{formatRupiah(currentTotal)}</span>
                      </div>
                      <div className="flex justify-between items-center py-2 border-t border-border/50">
                        <span className="text-muted-foreground font-medium">Estimasi WBS Baru</span>
                        <span className={`font-mono text-lg font-bold ${adjustedTotal > currentTotal ? "text-amber-600 dark:text-amber-500" : "text-emerald-600 dark:text-emerald-500"}`}>
                          {formatRupiah(adjustedTotal)}
                        </span>
                      </div>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
            </form>
          </Form>
        </ScrollArea>

        <div className="p-6 border-t border-border bg-muted/30">
          <SheetFooter className="flex-row justify-end gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={importTemplate.isPending} className="w-full sm:w-auto">
              Batal
            </Button>
            <Button type="submit" form="import-template-form" disabled={importTemplate.isPending || !selectedTemplate} className="w-full sm:w-auto">
              {importTemplate.isPending ? "Memproses..." : "Terapkan Draft WBS"}
            </Button>
          </SheetFooter>
        </div>
      </SheetContent>
    </Sheet>
  )
}
