import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { getCopilotUsage, updateCopilotLimit, useListProjects } from "@workspace/api-client-react"
import { useAccess } from "@/lib/access"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const roles = ["DIRECTOR", "PROJECT_MANAGER", "SITE_MANAGER", "FINANCE", "TAX_STAFF", "PROCUREMENT", "JURU_HITUNG", "ESTIMATOR", "QUANTITY_SURVEYOR"]

export default function CopilotUsage() {
  const access = useAccess()
  const client = useQueryClient()
  const [scope, setScope] = useState<"role" | "project">("role")
  const [scopeId, setScopeId] = useState("DIRECTOR")
  const [limit, setLimit] = useState("100")
  const [message, setMessage] = useState("")
  const [saving, setSaving] = useState(false)
  const { data, isLoading, error } = useQuery({
    queryKey: ["copilot-usage"],
    queryFn: () => getCopilotUsage(),
    enabled: access.role === "DIRECTOR",
  })
  const { data: projects } = useListProjects()
  useEffect(() => {
    if (!data) return
    setLimit(String(data.limits.find((row) => row.scope === scope && row.scopeId === scopeId)?.dailyLimit
      ?? (scope === "role" ? data.defaultRoleDailyLimit : 100)))
  }, [data, scope, scopeId])
  if (access.role !== "DIRECTOR") return <p role="alert">Hanya Director dapat melihat penggunaan copilot.</p>

  async function save() {
    const count = Number(limit)
    if (!scopeId || !Number.isInteger(count) || count < 0 || count > 100000) {
      setMessage("Isi batas harian dengan bilangan bulat antara 0 dan 100000.")
      return
    }
    setSaving(true)
    setMessage("")
    try {
      await updateCopilotLimit({ scope, scopeId, dailyLimit: count })
      await client.invalidateQueries({ queryKey: ["copilot-usage"] })
      setMessage("Batas harian tersimpan.")
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Batas gagal disimpan.")
    } finally {
      setSaving(false)
    }
  }

  const current = data?.limits.find((row) => row.scope === scope && row.scopeId === scopeId)
  const used = data?.todayUsage.reduce((sum, row) =>
    sum + (scope === "role" ? (row.role === scopeId ? row.count : 0) : (row.projectId === scopeId ? row.count : 0)), 0) ?? 0

  return <div className="mx-auto max-w-5xl space-y-6">
    <div><h1 className="text-3xl font-bold">Penggunaan Copilot</h1>
      <p className="text-muted-foreground">Eksekusi dan durasi selama tujuh hari terakhir. Kuota dihitung per hari UTC, termasuk percobaan yang gagal.</p></div>
    {isLoading && <p>Memuat penggunaan…</p>}
    {error && <p role="alert" className="text-destructive">Penggunaan tidak dapat dimuat. Coba muat ulang halaman.</p>}
    {data && <>
      <Card><CardHeader><CardTitle>Per tool · {data.since} – {data.today}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead><tr className="border-b"><th className="p-2">Tool</th><th className="p-2">Eksekusi</th><th className="p-2">Gagal</th><th className="p-2">Timeout</th><th className="p-2">Durasi total</th></tr></thead>
          <tbody>{data.tools.map((row) => <tr key={row.tool} className="border-b">
            <td className="p-2">{row.tool === "planning" ? "Perencanaan" : row.tool}</td><td className="p-2">{row.executions}</td><td className="p-2">{row.failures}</td><td className="p-2">{row.timeouts}</td><td className="p-2">{(row.durationMs / 1000).toFixed(2)} detik</td>
          </tr>)}</tbody>
        </table>{!data.tools.length && <p className="py-4 text-muted-foreground">Belum ada penggunaan.</p>}</CardContent>
      </Card>
      <Card><CardHeader><CardTitle>Batas harian</CardTitle></CardHeader><CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">Default setiap peran: {data.defaultRoleDailyLimit} eksekusi/hari. Batas proyek berlaku bersama batas peran. Nilai 0 menghentikan penggunaan pada cakupan tersebut.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <div><Label>Jenis batas</Label><Select value={scope} onValueChange={(value) => { setScope(value as "role" | "project"); setScopeId(value === "role" ? "DIRECTOR" : projects?.[0]?.id ?? "") }}>
            <SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="role">Peran</SelectItem><SelectItem value="project">Proyek</SelectItem></SelectContent></Select></div>
          <div><Label>Peran / proyek</Label><Select value={scopeId} onValueChange={setScopeId}>
            <SelectTrigger><SelectValue placeholder="Pilih proyek" /></SelectTrigger><SelectContent>
              {scope === "role" ? roles.map((role) => <SelectItem key={role} value={role}>{role}</SelectItem>)
                : projects?.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
            </SelectContent></Select></div>
          <div><Label htmlFor="daily-limit">Maksimum per hari</Label><Input id="daily-limit" type="number" min={0} max={100000} step={1} value={limit} onChange={(event) => setLimit(event.target.value)} /></div>
        </div>
        <p className="text-sm">Terpakai hari ini: {used} / {current?.dailyLimit ?? (scope === "role" ? data.defaultRoleDailyLimit : "tanpa batas proyek")}</p>
        <Button onClick={() => void save()} disabled={saving || !scopeId}>{saving ? "Menyimpan…" : "Simpan batas"}</Button>
        {message && <p role="status" className="text-sm">{message}</p>}
        {!!data.limits.length && <div className="text-sm"><h3 className="font-semibold">Batas aktif</h3>
          {data.limits.map((row) => <p key={`${row.scope}-${row.scopeId}`}>{row.scope === "role" ? "Peran" : "Proyek"} {row.scope === "project" ? projects?.find((p) => p.id === row.scopeId)?.name ?? row.scopeId : row.scopeId}: {row.dailyLimit}/hari</p>)}
        </div>}
      </CardContent></Card>
    </>}
  </div>
}