import { useState } from "react"
import { Link } from "wouter"
import { askProjectCopilot, type CopilotCitation, type ProjectCopilotResponse } from "@workspace/api-client-react"
import { AlertCircle, BookOpen, Bot, Loader2, LockKeyhole, Send, ShieldCheck } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"

type CopilotError = {
  status?: number
  message?: string
  data?: { error?: string }
}

const sourceNames: Record<string, string> = {
  projects: "Proyek",
  rab_baselines: "RAB",
  invoices: "Invoice",
  tax_rule_versions: "Aturan pajak",
  audit_logs: "Jejak audit",
}

function citationHref(citation: CopilotCitation, projectId: string) {
  if (citation.source === "projects") return `/portal/projects/${citation.id ?? projectId}`
  if (citation.source === "rab_baselines") return `/portal/projects/${projectId}/rab`
  if (citation.source === "invoices") return `/portal/invoices?projectId=${projectId}`
  if (citation.source === "tax_rule_versions") return "/portal/tax-rules"
  if (citation.source === "audit_logs") return "/portal/audit"
  return null
}

function errorPresentation(error: CopilotError) {
  const detail = error.data?.error ?? error.message ?? "Copilot tidak dapat menjawab saat ini."
  if (error.status === 504) return { title: "Waktu tunggu habis", detail: "Analisis melewati batas waktu. Coba pertanyaan yang lebih spesifik." }
  if (error.status === 503) return { title: "Copilot sedang dinonaktifkan", detail }
  if (error.status === 403 || error.status === 404) return { title: "Akses ditolak", detail }
  if (error.status === 400) return { title: "Pertanyaan tidak dapat diproses", detail: "Tanyakan tentang detail proyek, RAB, invoice, pajak, atau jejak audit. Copilot tidak menjalankan perubahan data." }
  return { title: "Copilot gagal menjawab", detail }
}

export function ProjectCopilot({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [prompt, setPrompt] = useState("")
  const [response, setResponse] = useState<ProjectCopilotResponse | null>(null)
  const [error, setError] = useState<CopilotError | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [openCitation, setOpenCitation] = useState<CopilotCitation | null>(null)

  async function submit() {
    const question = prompt.trim()
    if (!question || isLoading) return
    setError(null)
    setResponse(null)
    setIsLoading(true)
    try {
      const nextResponse = await askProjectCopilot({ projectId, prompt: question })
      setResponse(nextResponse)
    } catch (caught) {
      setError(caught as CopilotError)
    } finally {
      setIsLoading(false)
    }
  }

  const displayedError = error ? errorPresentation(error) : null

  return (
    <>
      <Card data-testid="panel-project-copilot">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2"><Bot className="h-5 w-5 text-primary" /> Copilot Proyek</CardTitle>
              <CardDescription className="mt-1">Analisis baca-saja untuk {projectName}.</CardDescription>
            </div>
            <Badge variant="outline" className="gap-1"><LockKeyhole className="h-3 w-3" /> Scope terkunci</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>Tidak dapat mengubah data</AlertTitle>
            <AlertDescription>Copilot hanya membaca detail proyek, RAB, invoice, pajak, dan jejak audit proyek aktif.</AlertDescription>
          </Alert>

          {response && (
            <div className="rounded-lg border bg-muted/30 p-4" data-testid="text-copilot-answer">
              <p className="text-sm leading-6">{response.answer}</p>
              {response.sources.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2" data-testid="list-copilot-citations">
                  {response.sources.map((citation, index) => (
                    <Button
                      key={`${citation.source}-${citation.id ?? index}`}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setOpenCitation(citation)}
                      data-testid={`button-citation-${index}`}
                    >
                      <BookOpen className="mr-1.5 h-3.5 w-3.5" />
                      {sourceNames[citation.source] ?? citation.source} {citation.id ? `#${citation.id.slice(0, 8)}` : ""}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}

          {displayedError && (
            <Alert variant="destructive" data-testid="status-copilot-error">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{displayedError.title}</AlertTitle>
              <AlertDescription>{displayedError.detail}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder="Contoh: Ringkas invoice proyek ini"
              maxLength={1000}
              disabled={isLoading}
              data-testid="input-copilot-question"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">Enter untuk kirim · Shift+Enter untuk baris baru</p>
              <Button type="button" onClick={() => void submit()} disabled={!prompt.trim() || isLoading} data-testid="button-ask-copilot">
                {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                {isLoading ? "Menganalisis..." : "Tanya Copilot"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(openCitation)} onOpenChange={(open) => !open && setOpenCitation(null)}>
        <DialogContent data-testid="dialog-copilot-citation">
          <DialogHeader>
            <DialogTitle>Record sumber</DialogTitle>
            <DialogDescription>Jawaban ini didasarkan pada record berikut.</DialogDescription>
          </DialogHeader>
          {openCitation && (
            <div className="space-y-4">
              <dl className="grid grid-cols-[8rem_1fr] gap-2 rounded-md border p-4 text-sm">
                <dt className="text-muted-foreground">Sumber</dt>
                <dd className="font-medium">{sourceNames[openCitation.source] ?? openCitation.source}</dd>
                <dt className="text-muted-foreground">Record ID</dt>
                <dd className="break-all font-mono text-xs">{openCitation.id ?? "Kumpulan record"}</dd>
              </dl>
              {citationHref(openCitation, projectId) && (
                <Button asChild data-testid="link-open-citation-record">
                  <Link href={citationHref(openCitation, projectId)!}>Buka record</Link>
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}