import { useState } from "react"
import {
  getGetProjectRabVersionQueryKey,
  getListProjectRabVersionsQueryKey,
  useGetProjectRab,
  useGetProjectRabVersion,
  useListProjectRabVersions,
} from "@workspace/api-client-react"
import { useParams, Link } from "wouter"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ArrowLeft, AlertTriangle, GitCompareArrows, History } from "lucide-react"
import { formatRupiah, formatPercent } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import { ImportTemplateSheet } from "@/components/rab/ImportTemplateSheet"

export default function ProjectRab() {
  const { id } = useParams()
  const projectId = id || ""
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [comparisonVersions, setComparisonVersions] = useState<{ from: number; to: number } | null>(null)
  const latestQuery = useGetProjectRab(projectId)
  const versionsQuery = useListProjectRabVersions(projectId, {
    query: {
      enabled: Boolean(projectId),
      queryKey: getListProjectRabVersionsQueryKey(projectId),
    },
  })
  const historicalQuery = useGetProjectRabVersion(projectId, selectedVersion ?? 1, {
    query: {
      enabled: Boolean(projectId) && selectedVersion !== null,
      queryKey: getGetProjectRabVersionQueryKey(projectId, selectedVersion ?? 1),
    },
  })
  const comparisonFromQuery = useGetProjectRabVersion(projectId, comparisonVersions?.from ?? 1, {
    query: {
      enabled: Boolean(projectId) && comparisonVersions !== null,
      queryKey: getGetProjectRabVersionQueryKey(projectId, comparisonVersions?.from ?? 1),
    },
  })
  const comparisonToQuery = useGetProjectRabVersion(projectId, comparisonVersions?.to ?? 1, {
    query: {
      enabled: Boolean(projectId) && comparisonVersions !== null,
      queryKey: getGetProjectRabVersionQueryKey(projectId, comparisonVersions?.to ?? 1),
    },
  })
  const isHistorical = selectedVersion !== null
  const rab = isHistorical ? historicalQuery.data : latestQuery.data
  const isLoading = isHistorical ? historicalQuery.isLoading : latestQuery.isLoading
  const isError = isHistorical ? historicalQuery.isError : latestQuery.isError

  if (isLoading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }
  if (isError || !rab) {
    return <div className="flex h-[50vh] items-center justify-center text-destructive">RAB proyek tidak dapat dimuat.</div>
  }

  const versions = versionsQuery.data ?? []
  const canCompare = versions.length >= 2
  const comparisonFrom = comparisonFromQuery.data
  const comparisonTo = comparisonToQuery.data
  const comparisonItems = comparisonFrom && comparisonTo
    ? (() => {
        const fromByCode = new Map(comparisonFrom.items.map((item) => [item.code, item]))
        const toByCode = new Map(comparisonTo.items.map((item) => [item.code, item]))
        return Array.from(new Set([...fromByCode.keys(), ...toByCode.keys()])).sort().map((code) => {
        const from = fromByCode.get(code)
        const to = toByCode.get(code)
        const status = !from ? "ADDED" : !to ? "REMOVED" : (
          from.quantity !== to.quantity ||
          from.unitPrice !== to.unitPrice ||
          from.budget !== to.budget ||
          from.name !== to.name
        ) ? "CHANGED" : "UNCHANGED"
        return { code, from, to, status }
      }).filter((item) => item.status !== "UNCHANGED")
      })()
    : []

  if (comparisonVersions) {
    const comparisonLoading = comparisonFromQuery.isLoading || comparisonToQuery.isLoading
    const comparisonError = comparisonFromQuery.isError || comparisonToQuery.isError
    return (
      <div className="flex flex-col gap-6 animate-in fade-in duration-500">
        <div className="flex flex-wrap items-center gap-4">
          <Button type="button" variant="outline" size="icon" onClick={() => setComparisonVersions(null)} data-testid="button-close-rab-comparison">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight">Perbandingan Versi RAB</h1>
              <Badge variant="outline">v{comparisonVersions.from}.0 → v{comparisonVersions.to}.0</Badge>
            </div>
            <p className="text-sm text-muted-foreground">Perubahan biaya dan item antar-baseline proyek.</p>
          </div>
          <div className="ml-auto flex flex-wrap items-end gap-3">
            <VersionSelect
              label="Versi awal"
              value={comparisonVersions.from}
              versions={versions}
              testId="select-rab-comparison-from"
              onChange={(from) => setComparisonVersions((current) => current ? { ...current, from } : null)}
            />
            <VersionSelect
              label="Versi pembanding"
              value={comparisonVersions.to}
              versions={versions}
              testId="select-rab-comparison-to"
              onChange={(to) => setComparisonVersions((current) => current ? { ...current, to } : null)}
            />
          </div>
        </div>

        {comparisonVersions.from === comparisonVersions.to && (
          <Alert><AlertTriangle className="h-4 w-4" /><AlertTitle>Pilih dua versi berbeda</AlertTitle></Alert>
        )}
        {comparisonLoading && <div className="py-16 text-center text-muted-foreground">Memuat perbandingan RAB…</div>}
        {comparisonError && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Perbandingan RAB tidak dapat dimuat</AlertTitle></Alert>}
        {!comparisonLoading && !comparisonError && comparisonFrom && comparisonTo && (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <ComparisonTotal label={`Total v${comparisonFrom.version}.0`} value={comparisonFrom.totalBudget} />
              <ComparisonTotal label={`Total v${comparisonTo.version}.0`} value={comparisonTo.totalBudget} />
              <ComparisonTotal label="Perubahan total" value={comparisonTo.totalBudget - comparisonFrom.totalBudget} signed />
            </div>
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Item RAB</TableHead>
                    <TableHead className="text-right">Kuantitas</TableHead>
                    <TableHead className="text-right">Harga satuan</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparisonItems.map(({ code, from, to, status }) => (
                    <TableRow key={code} data-testid={`row-rab-comparison-${code}`}>
                      <TableCell><Badge variant={status === "ADDED" ? "success" : status === "REMOVED" ? "destructive" : "secondary"}>
                        {status === "ADDED" ? "BARU" : status === "REMOVED" ? "DIHAPUS" : "BERUBAH"}
                      </Badge></TableCell>
                      <TableCell>
                        <div className="font-mono text-xs text-muted-foreground">{code}</div>
                        <div className="font-medium">{to?.name ?? from?.name}</div>
                      </TableCell>
                      <ComparisonValue from={from?.quantity} to={to?.quantity} suffix={` ${to?.unit ?? from?.unit ?? ""}`} />
                      <ComparisonValue from={from?.unitPrice} to={to?.unitPrice} currency />
                      <ComparisonValue from={from?.budget} to={to?.budget} currency />
                    </TableRow>
                  ))}
                  {comparisonItems.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">Tidak ada perubahan item pada dua versi ini.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-500">
      <div className="flex items-center gap-4">
        <Link href={`/portal/projects/${id}`} className="flex h-9 w-9 items-center justify-center rounded-md border bg-background hover:bg-muted">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">Rencana Anggaran Biaya (RAB)</h1>
            <Badge variant="outline">v{rab.version}.0</Badge>
            <Badge variant={rab.status.includes("DISETUJUI") ? "success" : "secondary"}>
              {rab.status.toUpperCase()}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">Baseline pengendalian biaya dan struktur WBS proyek.</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={!canCompare}
            onClick={() => setComparisonVersions({ from: versions[1].version, to: versions[0].version })}
            data-testid="button-compare-rab-versions"
          >
            <GitCompareArrows className="mr-2 h-4 w-4" />
            Bandingkan versi
          </Button>
          <Select
            value={selectedVersion === null ? "latest" : String(selectedVersion)}
            onValueChange={(value) => setSelectedVersion(value === "latest" ? null : Number(value))}
          >
            <SelectTrigger className="w-[220px]" data-testid="select-rab-version">
              <History className="mr-2 h-4 w-4" />
              <SelectValue placeholder="Pilih versi RAB" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest" data-testid="option-rab-version-latest">
                Versi terbaru{latestQuery.data ? ` · v${latestQuery.data.version}.0` : ""}
              </SelectItem>
              {versionsQuery.data
                ?.filter((version) => version.version !== latestQuery.data?.version)
                .map((version) => (
                  <SelectItem
                    key={version.version}
                    value={String(version.version)}
                    data-testid={`option-rab-version-${version.version}`}
                  >
                    v{version.version}.0 · {version.status}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {!isHistorical && <ImportTemplateSheet projectId={projectId} currentTotal={rab.totalBudget} />}
        </div>
      </div>

      {isHistorical && (
        <Alert className="border-amber-500/40 bg-amber-500/5" data-testid="alert-rab-historical">
          <History className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <AlertTitle>Versi historis hanya-baca</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>Anda sedang melihat RAB v{rab.version}.0. Versi aktif proyek tidak berubah.</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelectedVersion(null)}
              data-testid="button-rab-return-latest"
            >
              Kembali ke versi terbaru
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card className="bg-muted/30">
          <CardContent className="p-6">
            <div className="text-sm font-medium text-muted-foreground mb-2">Total Budget</div>
            <div className="text-2xl font-bold" data-testid="text-rab-total-budget">{formatRupiah(rab.totalBudget)}</div>
          </CardContent>
        </Card>
        <Card className="bg-muted/30">
          <CardContent className="p-6">
            <div className="text-sm font-medium text-muted-foreground mb-2">Committed Cost (PO)</div>
            <div className="text-2xl font-bold text-amber-500">{formatRupiah(rab.committed)}</div>
          </CardContent>
        </Card>
        <Card className="bg-muted/30">
          <CardContent className="p-6">
            <div className="text-sm font-medium text-muted-foreground mb-2">Actual Cost (Paid)</div>
            <div className="text-2xl font-bold text-emerald-500 dark:text-emerald-400">{formatRupiah(rab.actual)}</div>
          </CardContent>
        </Card>
        <Card className="bg-muted/30">
          <CardContent className="p-6">
            <div className="text-sm font-medium text-muted-foreground mb-2">Remaining Budget</div>
            <div className="text-2xl font-bold">{formatRupiah(rab.remaining)}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">WBS Code</TableHead>
              <TableHead>Work Item</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Budget</TableHead>
              <TableHead className="text-right">Actual + Committed</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead className="w-[150px]">Utilization</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rab.items.map((item) => {
              const isOverbudget = item.variance < 0
              return (
                <TableRow key={item.id} className={item.level === 0 ? "bg-muted/10" : ""}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{item.code}</TableCell>
                  <TableCell>
                    <div className="font-medium" style={{ paddingLeft: `${item.level * 1.5}rem` }}>
                      {item.name}
                    </div>
                    {item.quantity > 0 && (
                      <div className="text-xs text-muted-foreground mt-1" style={{ paddingLeft: `${item.level * 1.5}rem` }}>
                        {item.quantity.toLocaleString("id-ID")} {item.unit} @ {formatRupiah(item.unitPrice)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-normal text-xs">{item.category}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{formatRupiah(item.budget)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(item.actual + item.committed)}</TableCell>
                  <TableCell className={`text-right font-medium ${isOverbudget ? 'text-destructive' : 'text-emerald-500 dark:text-emerald-400'}`}>
                    {isOverbudget && "-"} {formatRupiah(Math.abs(item.variance))}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 mt-1">
                      <Progress 
                        value={Math.min(item.utilization, 100)}
                        indicatorColor={isOverbudget ? "bg-destructive" : "bg-primary"} 
                      />
                      <div className="flex justify-between items-center text-[10px] text-muted-foreground">
                        <span>{formatPercent(item.utilization)}</span>
                        {isOverbudget && <AlertTriangle className="h-3 w-3 text-destructive" />}
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3} className="text-right font-bold">Total</TableCell>
              <TableCell className="text-right font-bold">{formatRupiah(rab.totalBudget)}</TableCell>
              <TableCell className="text-right font-bold">{formatRupiah(rab.actual + rab.committed)}</TableCell>
              <TableCell className="text-right font-bold">{formatRupiah(rab.remaining)}</TableCell>
              <TableCell></TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </Card>
    </div>
  )
}

function VersionSelect({ label, value, versions, testId, onChange }: {
  label: string
  value: number
  versions: Array<{ version: number; status: string }>
  testId: string
  onChange: (version: number) => void
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
        <SelectTrigger className="w-[180px]" data-testid={testId}><SelectValue /></SelectTrigger>
        <SelectContent>
          {versions.map((version) => <SelectItem key={version.version} value={String(version.version)}>v{version.version}.0 · {version.status}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

function ComparisonTotal({ label, value, signed = false }: { label: string; value: number; signed?: boolean }) {
  const tone = signed ? value > 0 ? "text-amber-600 dark:text-amber-400" : value < 0 ? "text-emerald-600 dark:text-emerald-400" : "" : ""
  return (
    <Card className="bg-muted/30"><CardContent className="p-6">
      <div className="mb-2 text-sm font-medium text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold ${tone}`} data-testid={signed ? "text-rab-comparison-total-delta" : undefined}>
        {signed && value > 0 ? "+" : ""}{formatRupiah(value)}
      </div>
    </CardContent></Card>
  )
}

function ComparisonValue({ from, to, currency = false, suffix = "" }: {
  from?: number
  to?: number
  currency?: boolean
  suffix?: string
}) {
  const format = (value: number) => currency ? formatRupiah(value) : `${value.toLocaleString("id-ID")}${suffix}`
  const delta = (to ?? 0) - (from ?? 0)
  return (
    <TableCell className="text-right">
      <div>{from === undefined ? "—" : format(from)} → {to === undefined ? "—" : format(to)}</div>
      <div className={`text-xs font-medium ${delta > 0 ? "text-amber-600 dark:text-amber-400" : delta < 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
        {delta > 0 ? "+" : ""}{format(delta)}
      </div>
    </TableCell>
  )
}
