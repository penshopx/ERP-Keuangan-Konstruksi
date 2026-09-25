import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import { useQueryClient } from "@tanstack/react-query"
import { 
  useTransitionProjectCommitment,
  getListProjectCommitmentsQueryKey,
  getGetProjectRabQueryKey
} from "@workspace/api-client-react"
import type { Commitment, CommitmentTransitionInputAction } from "@workspace/api-client-react"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { Loader2, AlertCircle } from "lucide-react"
import { formatRupiah } from "@/lib/utils"

const transitionSchema = z.object({
  note: z.string().optional(),
  lineId: z.string().nullable().optional(),
  amount: z.coerce.number().optional(),
  amendedAmount: z.coerce.number().optional(),
})

interface TransitionCommitmentDialogProps {
  projectId: string
  commitment: Commitment
  action: CommitmentTransitionInputAction
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TransitionCommitmentDialog({ projectId, commitment, action, open, onOpenChange }: TransitionCommitmentDialogProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const transitionCommitment = useTransitionProjectCommitment()

  const form = useForm<z.infer<typeof transitionSchema>>({
    resolver: zodResolver(transitionSchema),
    defaultValues: {
      note: "",
      lineId: commitment.lines.length === 1 ? commitment.lines[0].id : null,
      amount: 0,
      amendedAmount: commitment.totalAmount,
    }
  })

  const isFinancialAction = action === "RECEIVE" || action === "INVOICE"
  const isAmendment = action === "AMEND"
  const isDestructiveAction = action === "REJECT" || action === "CANCEL"

  const onSubmit = (values: z.infer<typeof transitionSchema>) => {
    if (action === "RECEIVE" && !values.note?.trim()) {
      toast({ title: "Referensi bukti wajib diisi", description: "Sertakan nomor berita acara atau dokumen penerimaan jasa/barang.", variant: "destructive" })
      return
    }
    if (isFinancialAction && (!values.lineId || !values.amount || values.amount <= 0)) {
      toast({ title: "Validasi Gagal", description: "Pilih item dan masukkan jumlah yang valid.", variant: "destructive" })
      return
    }

    transitionCommitment.mutate({
      projectId,
      commitmentId: commitment.id,
      data: {
        action,
        note: values.note,
        ...(isFinancialAction ? {
          lineId: values.lineId,
          amount: values.amount,
          idempotencyKey: crypto.randomUUID(),
        } : {}),
        ...(isAmendment ? {
          lines: commitment.lines.map((line) => ({
            costCodeId: line.costCodeId,
            description: line.description,
            amount: Math.round((values.amendedAmount ?? commitment.totalAmount) * (line.amount / commitment.totalAmount)),
          })),
        } : {}),
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProjectCommitmentsQueryKey(projectId) })
        queryClient.invalidateQueries({ queryKey: getGetProjectRabQueryKey(projectId) })
        toast({ title: "Berhasil", description: `Aksi ${action} berhasil dilakukan.` })
        onOpenChange(false)
        form.reset()
      },
      onError: (error: any) => {
        toast({ 
          title: "Gagal", 
          description: error?.message || "Terjadi kesalahan yang tidak terduga.",
          variant: "destructive"
        })
      }
    })
  }

  const getActionTitle = () => {
    switch (action) {
      case "SUBMIT": return "Ajukan Approval"
      case "APPROVE": return "Setujui Komitmen"
      case "REJECT": return "Tolak Komitmen"
      case "RECEIVE": return "Penerimaan / Progress"
      case "INVOICE": return "Tagihan (Invoice)"
      case "CANCEL": return "Batalkan Komitmen"
      case "AMEND": return "Amendemen Komitmen"
      default: return action
    }
  }

  const getActionDescription = () => {
    switch (action) {
      case "SUBMIT": return "Ajukan dokumen ini ke manajer proyek untuk disetujui."
      case "APPROVE": return "Menyetujui komitmen ini berarti mengakui pengeluaran proyek."
      case "REJECT": return "Tolak dokumen komitmen ini. Berikan alasan penolakan."
      case "RECEIVE": return "Catat nilai pekerjaan/barang yang sudah diterima (progress fisik)."
      case "INVOICE": return "Catat nilai tagihan yang diterima dari vendor/subkon."
      case "CANCEL": return "Batalkan dokumen ini sepenuhnya. Aksi ini tidak dapat dikembalikan."
      case "AMEND": return "Buat versi baru dari komitmen ini tanpa mengubah histori versi yang sudah disetujui."
      default: return ""
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isDestructiveAction && <AlertCircle className="h-5 w-5 text-destructive" />}
            {getActionTitle()}
          </DialogTitle>
          <DialogDescription>
            {getActionDescription()}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            
            {isFinancialAction && (
              <>
                <FormField
                  control={form.control}
                  name="lineId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Pilih Item / Line</FormLabel>
                      <Select 
                        onValueChange={field.onChange} 
                        value={field.value || ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-transition-line">
                            <SelectValue placeholder="Pilih item..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {commitment.lines.map(line => (
                            <SelectItem key={line.id} value={line.id}>
                              {line.description} ({formatRupiah(line.amount)})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Nilai {action === "RECEIVE" ? "Diterima (Rp)" : "Ditagih (Rp)"}
                      </FormLabel>
                      <FormControl>
                        <Input type="number" min="1" {...field} data-testid="input-transition-amount" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {isAmendment && (
              <FormField
                control={form.control}
                name="amendedAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nilai komitmen versi baru (Rp)</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" {...field} data-testid="input-amended-amount" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{action === "RECEIVE" ? "Referensi berita acara penerimaan (wajib)" : "Catatan (Opsional)"}</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Tambahkan catatan terkait aksi ini..." {...field} data-testid="input-transition-note" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Batal</Button>
              <Button 
                type="submit" 
                variant={isDestructiveAction ? "destructive" : "default"}
                disabled={transitionCommitment.isPending} 
                data-testid="button-confirm-transition"
              >
                {transitionCommitment.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Konfirmasi
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
