import { useState } from "react"
import { useForm, useFieldArray } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import { useQueryClient } from "@tanstack/react-query"
import { 
  useCreateProjectCommitment, 
  useGetProjectRab,
  getListProjectCommitmentsQueryKey,
  getGetProjectRabQueryKey
} from "@workspace/api-client-react"

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { Plus, Trash2, Loader2 } from "lucide-react"

const commitmentSchema = z.object({
  documentType: z.enum(["PO", "SPK", "SUBKON"]),
  documentNumber: z.string().min(1, "Nomor dokumen wajib diisi"),
  vendorName: z.string().min(1, "Nama vendor wajib diisi"),
  lines: z.array(z.object({
    costCodeId: z.string().min(1, "WBS / Cost Code wajib dipilih"),
    description: z.string().min(1, "Deskripsi wajib diisi"),
    amount: z.coerce.number().min(1, "Nilai harus lebih dari 0"),
    rabItemId: z.string().nullable().optional()
  })).min(1, "Minimal satu item komitmen diperlukan")
})

interface CreateCommitmentSheetProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateCommitmentSheet({ projectId, open, onOpenChange }: CreateCommitmentSheetProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { data: rab } = useGetProjectRab(projectId)
  const createCommitment = useCreateProjectCommitment()

  const form = useForm<z.infer<typeof commitmentSchema>>({
    resolver: zodResolver(commitmentSchema),
    defaultValues: {
      documentType: "PO",
      documentNumber: "",
      vendorName: "",
      lines: [{ costCodeId: "", description: "", amount: 0, rabItemId: null }]
    }
  })

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "lines"
  })

  const onSubmit = (values: z.infer<typeof commitmentSchema>) => {
    if (!rab) return

    createCommitment.mutate({
      projectId,
      data: {
        baselineId: rab.baselineId,
        ...values
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProjectCommitmentsQueryKey(projectId) })
        queryClient.invalidateQueries({ queryKey: getGetProjectRabQueryKey(projectId) })
        toast({ title: "Berhasil", description: "Komitmen berhasil dibuat." })
        onOpenChange(false)
        form.reset()
      },
      onError: (error: any) => {
        toast({ 
          title: "Gagal membuat komitmen", 
          description: error?.message || "Terjadi kesalahan yang tidak terduga.",
          variant: "destructive"
        })
      }
    })
  }

  const rabItems = rab?.items || []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full max-w-2xl overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="mb-6">
          <SheetTitle>Buat Komitmen Baru</SheetTitle>
          <SheetDescription>Catat PO, SPK, atau Kontrak Subkon untuk mengendalikan pengeluaran.</SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="documentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Jenis Dokumen</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-doc-type">
                          <SelectValue placeholder="Pilih jenis dokumen" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="PO">Purchase Order (PO)</SelectItem>
                        <SelectItem value="SPK">SPK</SelectItem>
                        <SelectItem value="SUBKON">Kontrak Subkon</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="documentNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nomor Dokumen</FormLabel>
                    <FormControl>
                      <Input placeholder="Misal: PO-2023-001" {...field} data-testid="input-doc-number" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="vendorName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nama Vendor / Subkon</FormLabel>
                  <FormControl>
                    <Input placeholder="Nama perusahaan..." {...field} data-testid="input-vendor-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <FormLabel className="text-base">Detail Item (Lines)</FormLabel>
                <Button 
                  type="button" 
                  variant="outline" 
                  size="sm" 
                  onClick={() => append({ costCodeId: "", description: "", amount: 0, rabItemId: null })}
                  data-testid="button-add-line"
                >
                  <Plus className="h-4 w-4 mr-2" /> Tambah Item
                </Button>
              </div>

              {fields.map((field, index) => (
                <Card key={field.id} className="relative bg-muted/20">
                  <CardContent className="pt-6">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute top-2 right-2 text-muted-foreground hover:text-destructive"
                      onClick={() => remove(index)}
                      disabled={fields.length === 1}
                      data-testid={`button-remove-line-${index}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    
                    <div className="grid gap-4">
                      <FormField
                        control={form.control}
                        name={`lines.${index}.costCodeId`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Item RAB (WBS)</FormLabel>
                            <Select 
                              onValueChange={(val) => {
                                const selectedItem = rabItems.find(i => i.id === val)
                                field.onChange(selectedItem?.costCodeId ?? "")
                                form.setValue(`lines.${index}.rabItemId`, val)
                              }}
                              value={form.watch(`lines.${index}.rabItemId`) || ""}
                            >
                              <FormControl>
                                <SelectTrigger data-testid={`select-rab-item-${index}`}>
                                  <SelectValue placeholder="Pilih WBS..." />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {rabItems.map(item => (
                                  <SelectItem key={item.id} value={item.id}>
                                    <span className="font-mono text-xs mr-2">{item.code}</span>
                                    {item.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <div className="grid grid-cols-2 gap-4">
                        <FormField
                          control={form.control}
                          name={`lines.${index}.description`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Deskripsi Pekerjaan / Material</FormLabel>
                              <FormControl>
                                <Input placeholder="Detail pesanan..." {...field} data-testid={`input-desc-${index}`} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name={`lines.${index}.amount`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Nilai Komitmen (Rp)</FormLabel>
                              <FormControl>
                                <Input type="number" min="0" {...field} data-testid={`input-amount-${index}`} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <SheetFooter className="pt-6">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Batal</Button>
              <Button type="submit" disabled={createCommitment.isPending} data-testid="button-save-commitment">
                {createCommitment.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Simpan Komitmen
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
