import { useState } from "react"
import {
  useListProjectCommitments,
  getListProjectCommitmentsQueryKey,
} from "@workspace/api-client-react"
import type { Commitment, CommitmentTransitionInputAction } from "@workspace/api-client-react"
import { formatRupiah } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertTriangle, Plus, FileText, Check, X, RefreshCw, Send, Trash2, ArrowRight } from "lucide-react"
import { CreateCommitmentSheet } from "./CreateCommitmentSheet"
import { TransitionCommitmentDialog } from "./TransitionCommitmentDialog"
import { VendorMatching } from "./VendorMatching"

interface ProjectCommitmentsProps {
  projectId: string
  rabVersion: number | null
  highlightedCommitmentId?: string | null
}

export function ProjectCommitments({ projectId, rabVersion, highlightedCommitmentId }: ProjectCommitmentsProps) {
  const { data: commitments, isLoading, isError } = useListProjectCommitments(projectId, {
    query: {
      enabled: Boolean(projectId),
      queryKey: getListProjectCommitmentsQueryKey(projectId)
    }
  })

  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [transitioningCommitment, setTransitioningCommitment] = useState<{
    commitment: Commitment
    action: "SUBMIT" | "APPROVE" | "REJECT" | "RECEIVE" | "INVOICE" | "CANCEL" | "AMEND"
  } | null>(null)

  const isHistorical = rabVersion !== null

  if (isLoading) {
    return <div className="py-12 text-center text-muted-foreground animate-pulse">Memuat data komitmen...</div>
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Gagal memuat</AlertTitle>
        <AlertDescription>Daftar komitmen proyek tidak dapat dimuat.</AlertDescription>
      </Alert>
    )
  }

  const activeCommitments = commitments ?? []

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg font-bold">Komitmen Biaya (PO/SPK/Subkon)</h3>
          <p className="text-sm text-muted-foreground">Kelola kontrak vendor, Purchase Order, dan SPK.</p>
        </div>
        {!isHistorical && (
          <Button onClick={() => setIsCreateOpen(true)} data-testid="button-create-commitment">
            <Plus className="mr-2 h-4 w-4" /> Buat Komitmen
          </Button>
        )}
      </div>

      {activeCommitments.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16 px-4 bg-muted/30 border-dashed">
          <FileText className="h-10 w-10 text-muted-foreground mb-4 opacity-50" />
          <h4 className="text-lg font-semibold mb-2">Belum ada komitmen</h4>
          <p className="text-sm text-muted-foreground text-center max-w-md">
            Belum ada Purchase Order atau Kontrak yang dibuat untuk proyek ini.
            Komitmen biaya diperlukan untuk mencatat dan mengendalikan kas keluar.
          </p>
          {!isHistorical && (
            <Button variant="outline" className="mt-6" onClick={() => setIsCreateOpen(true)}>
              Buat Komitmen Pertama
            </Button>
          )}
        </Card>
      ) : (
        <div className="grid gap-4">
          {activeCommitments.map(commitment => (
            <CommitmentCard 
              key={commitment.id} 
              commitment={commitment} 
              isHistorical={isHistorical}
               highlighted={highlightedCommitmentId === commitment.id}
              onTransition={(action) => setTransitioningCommitment({ commitment, action })}
            />
          ))}
        </div>
      )}

      {!isHistorical && <VendorMatching projectId={projectId} />}

      {isCreateOpen && (
        <CreateCommitmentSheet 
          projectId={projectId} 
          open={isCreateOpen} 
          onOpenChange={setIsCreateOpen} 
        />
      )}

      {transitioningCommitment && (
        <TransitionCommitmentDialog
          projectId={projectId}
          commitment={transitioningCommitment.commitment}
          action={transitioningCommitment.action}
          open={!!transitioningCommitment}
          onOpenChange={(open) => !open && setTransitioningCommitment(null)}
        />
      )}
    </div>
  )
}

function CommitmentCard({ 
  commitment, 
  isHistorical,
  highlighted,
  onTransition
}: { 
  commitment: Commitment
  isHistorical: boolean
  highlighted?: boolean
  onTransition: (action: CommitmentTransitionInputAction) => void
}) {
  const isDraft = commitment.status === "DRAFT"
  const isPending = commitment.status === "PENDING_APPROVAL"
  const isApproved = commitment.status === "APPROVED"
  const isClosed = commitment.status === "CLOSED" || commitment.status === "CANCELLED" || commitment.status === "REJECTED"

  const totalReceived = commitment.lines.reduce((sum, line) => sum + line.receivedAmount, 0)
  const totalInvoiced = commitment.lines.reduce((sum, line) => sum + line.invoicedAmount, 0)
  
  const statusColor = {
    DRAFT: "secondary",
    PENDING_APPROVAL: "default", // primary
    APPROVED: "success",
    REJECTED: "destructive",
    CANCELLED: "destructive",
    CLOSED: "secondary"
  }[commitment.status] as any

  return (
    <Card className={highlighted ? "ring-2 ring-amber-500 bg-amber-500/10" : undefined}>
      <div className="p-5 flex flex-col md:flex-row gap-4 justify-between items-start md:items-center border-b bg-muted/20">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="outline">{commitment.documentType}</Badge>
            <h4 className="font-bold text-lg">{commitment.documentNumber}</h4>
            <Badge variant={statusColor}>{commitment.status}</Badge>
            {commitment.version > 1 && (
              <Badge variant="outline" className="text-xs">v{commitment.version}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground font-medium">Vendor: {commitment.vendorName}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground mb-1">Total Nilai</p>
          <p className="font-bold text-xl">{formatRupiah(commitment.totalAmount)}</p>
        </div>
      </div>
      
      <div className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10 hover:bg-muted/10">
              <TableHead>Cost Code</TableHead>
              <TableHead>Deskripsi</TableHead>
              <TableHead className="text-right">Total Nilai</TableHead>
              <TableHead className="text-right">Diterima</TableHead>
              <TableHead className="text-right">Ditagihkan</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {commitment.lines.map(line => (
              <TableRow key={line.id}>
                <TableCell className="font-mono text-xs">{line.costCodeId}</TableCell>
                <TableCell>{line.description}</TableCell>
                <TableCell className="text-right font-medium">{formatRupiah(line.amount)}</TableCell>
                <TableCell className="text-right text-muted-foreground">{formatRupiah(line.receivedAmount)}</TableCell>
                <TableCell className="text-right text-muted-foreground">{formatRupiah(line.invoicedAmount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {!isHistorical && !isClosed && (
        <div className="p-4 border-t bg-muted/10 flex flex-wrap gap-2 justify-end">
          {isDraft && (
            <Button size="sm" onClick={() => onTransition("SUBMIT")} data-testid={`button-submit-${commitment.id}`}>
              <Send className="w-4 h-4 mr-2" /> Ajukan Approval
            </Button>
          )}
          {isPending && (
            <>
              <Button size="sm" variant="destructive" onClick={() => onTransition("REJECT")} data-testid={`button-reject-${commitment.id}`}>
                <X className="w-4 h-4 mr-2" /> Tolak
              </Button>
              <Button size="sm" variant="default" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => onTransition("APPROVE")} data-testid={`button-approve-${commitment.id}`}>
                <Check className="w-4 h-4 mr-2" /> Setujui
              </Button>
            </>
          )}
          {isApproved && (
            <>
              <Button size="sm" variant="outline" onClick={() => onTransition("AMEND")} data-testid={`button-amend-${commitment.id}`}>
                <RefreshCw className="w-4 h-4 mr-2" /> Amendemen
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onTransition("RECEIVE")} data-testid={`button-receive-${commitment.id}`}>
                <ArrowRight className="w-4 h-4 mr-2" /> Progress / Terima
              </Button>
            </>
          )}
          {(isDraft || isPending || isApproved) && (
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => onTransition("CANCEL")} data-testid={`button-cancel-${commitment.id}`}>
              <Trash2 className="w-4 h-4 mr-2" /> Batalkan
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}
