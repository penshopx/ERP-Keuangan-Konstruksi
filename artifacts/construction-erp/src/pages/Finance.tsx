import { useEffect, useState } from "react";
import { useAccess } from "@/lib/access";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Account = { code: string; name: string; type: string; isCash: boolean };
type Checklist = Record<string, { done: boolean; note: string }>;
type Period = { month: string; status: string; checklist: Checklist; preparedBy: string | null; reopenRequestedBy: string | null; reopenReason: string | null };
type Line = { id: string; entryId: string; accountCode: string; debit: number; credit: number; projectId: string | null; wbs: string | null; costCode: string | null };
type Entry = { id: string; entryDate: string; kind: string; cashFlowCategory: string | null; description: string; sourceType: string | null; sourceId: string | null; lines: Line[] };
type Group = { key: string; amount: number; lines: (Line & { entryId: string; entryDate: string; sourceType: string | null; sourceId: string | null })[] };
type Report = { period: string; basis: string; balanceSheet: { accounts: Group[]; assets: number; liabilitiesEquity: number; unclosedIncome: number };
  profitLoss: { accounts: Group[]; netIncome: number }; cashFlow: Group[]; projectProfitLoss: Group[] };
type Version = { id: string; version: number; issuedAt: string; approvedBy: string; report: Report };
const keys = ["bank", "ap", "ar", "pettyCash", "payroll", "tax", "missingDocuments"];
const labels: Record<string, string> = { bank: "Rekonsiliasi bank", ap: "Utang usaha (AP)", ar: "Piutang usaha (AR)",
  pettyCash: "Kas kecil", payroll: "Payroll", tax: "Pajak", missingDocuments: "Dokumen kurang" };
const money = (value: number) => new Intl.NumberFormat("id-ID").format(value);
const blank = () => ({ accountCode: "", debit: "", credit: "", projectId: "", wbs: "", costCode: "" });

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/finance${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Permintaan gagal");
  return result as T;
}

function ReportGroups({ title, groups }: { title: string; groups: Group[] }) {
  return <section className="space-y-2"><h3 className="font-semibold">{title}</h3>
    {groups.length === 0 && <p className="text-sm text-muted-foreground">Belum ada jurnal.</p>}
    {groups.map((g) => <details key={g.key} className="rounded border p-3">
      <summary className="cursor-pointer flex justify-between gap-3"><span>{g.key}</span><strong>{money(g.amount)}</strong></summary>
      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
        {g.lines.map((l, i) => <p key={`${l.entryId}-${i}`}>{l.entryDate} · {l.entryId} · debit {money(l.debit)} / kredit {money(l.credit)}
          {l.sourceType && <> · {l.sourceType}: {l.sourceId}</>}</p>)}
      </div>
    </details>)}
  </section>;
}

export default function Finance() {
  const access = useAccess();
  const canPost = access.permissions.includes("finance:post");
  const canApprove = access.permissions.includes("finance:approve");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [periods, setPeriods] = useState<Period[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [draft, setDraft] = useState<Report | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [checklist, setChecklist] = useState<Checklist>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState({ code: "", name: "", type: "ASSET", isCash: false });
  const [entry, setEntry] = useState({ entryDate: `${month}-01`, kind: "NORMAL", description: "", sourceType: "", sourceId: "", reversesId: "", cashFlowCategory: "" });
  const [lines, setLines] = useState([blank(), blank()]);
  const [reason, setReason] = useState("");
  const period = periods.find((p) => p.month === month);

  async function refresh() {
    const [p, a] = await Promise.all([api<Period[]>("/periods"), api<Account[]>("/accounts")]);
    setPeriods(p); setAccounts(a);
    if (p.some((row) => row.month === month)) {
      const [j, r] = await Promise.all([
        api<Entry[]>(`/journals?period=${month}`),
        api<{ versions: Version[]; draft: Report | null }>(`/periods/${month}/reports`),
      ]);
      setEntries(j); setVersions(r.versions); setDraft(r.draft);
      setChecklist(p.find((row) => row.month === month)?.checklist ?? {});
    } else { setEntries([]); setVersions([]); setDraft(null); setChecklist({}); }
  }
  useEffect(() => {
    setLoading(true); setError("");
    void refresh().catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [month]);

  async function mutate(path: string, body: unknown, clear?: () => void) {
    setBusy(true); setError("");
    try { await api(path, body); await refresh(); clear?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "Gagal menyimpan"); }
    finally { setBusy(false); }
  }
  const displayedVersion = selectedVersion ?? (draft ? null : versions.at(-1)?.version ?? null);
  const report = displayedVersion === null ? draft : versions.find((v) => v.version === displayedVersion)?.report ?? null;

  return <div className="space-y-6">
    <div><h1 className="text-3xl font-bold">Buku besar & tutup periode</h1>
      <p className="text-muted-foreground">Laporan hanya mencakup jurnal yang diposting di sini. Dokumen operasional lama belum otomatis masuk buku besar.</p></div>
    {error && <p role="alert" className="rounded border border-destructive p-3 text-destructive">{error}</p>}
    <div className="flex flex-wrap items-end gap-3">
      <div><Label htmlFor="finance-month">Periode</Label><Input id="finance-month" type="month" value={month}
        onChange={(e) => { setMonth(e.target.value); setSelectedVersion(null); setEntry((v) => ({ ...v, entryDate: `${e.target.value}-01` })); }} /></div>
      {canPost && !period && <Button disabled={busy || loading} onClick={() => void mutate("/periods", { month })}>Buka periode</Button>}
      {period && <span className="rounded bg-muted px-3 py-2 font-medium">{period.status}</span>}
    </div>
    {loading ? <p>Memuat data keuangan...</p> : <>
      {canPost && <Card><CardHeader><CardTitle>Daftar akun</CardTitle></CardHeader><CardContent className="space-y-3">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void mutate("/accounts", {
          ...account,
        }, () => setAccount({ code: "", name: "", type: "ASSET", isCash: false })); }}>
          <div><Label>Kode</Label><Input required value={account.code} onChange={(e) => setAccount({ ...account, code: e.target.value })} /></div>
          <div><Label>Nama akun</Label><Input required value={account.name} onChange={(e) => setAccount({ ...account, name: e.target.value })} /></div>
          <div><Label>Jenis</Label><select className="h-10 rounded border bg-background px-2" value={account.type} onChange={(e) => setAccount({ ...account, type: e.target.value })}>
            {["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"].map((v) => <option key={v}>{v}</option>)}</select></div>
          <label className="flex h-10 items-center gap-2"><input type="checkbox" checked={account.isCash} onChange={(e) => setAccount({ ...account, isCash: e.target.checked })} /> Kas/bank</label>
          <Button disabled={busy}>Tambah akun</Button>
        </form>
        <p className="text-sm text-muted-foreground">Tandai akun kas/bank; kategori arus kas dipilih pada setiap jurnal yang memakai akun tersebut. Akun yang sudah digunakan tidak dapat diganti klasifikasinya.</p>
      </CardContent></Card>}
      <Card><CardHeader><CardTitle>Chart of accounts ({accounts.length})</CardTitle></CardHeader><CardContent>
        {accounts.length === 0 ? <p>Belum ada akun.</p> : <div className="flex flex-wrap gap-2">{accounts.map((a) =>
          <span className="rounded border px-2 py-1 text-sm" key={a.code}>{a.code} · {a.name} ({a.type})</span>)}</div>}
      </CardContent></Card>
      {period && canPost && ["OPEN", "REOPENED"].includes(period.status) && <Card><CardHeader><CardTitle>Posting jurnal</CardTitle></CardHeader><CardContent className="space-y-3">
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          void mutate("/journals", { ...entry, sourceType: entry.sourceType || null, sourceId: entry.sourceId || null,
            reversesId: entry.kind === "REVERSAL" ? entry.reversesId : null, cashFlowCategory: entry.cashFlowCategory || null,
            lines: lines.map((l) => ({ ...l, debit: Number(l.debit || 0), credit: Number(l.credit || 0),
              projectId: l.projectId || null, wbs: l.wbs || null, costCode: l.costCode || null })) },
          () => { setEntry({ entryDate: `${month}-01`, kind: "NORMAL", description: "", sourceType: "", sourceId: "", reversesId: "", cashFlowCategory: "" }); setLines([blank(), blank()]); });
        }}>
          <div className="flex flex-wrap gap-2">
            <div><Label>Tanggal</Label><Input type="date" required value={entry.entryDate} onChange={(e) => setEntry({ ...entry, entryDate: e.target.value })} /></div>
            <div><Label>Jenis</Label><select className="h-10 rounded border bg-background px-2" value={entry.kind} onChange={(e) => setEntry({ ...entry, kind: e.target.value })}>
              {["NORMAL", "ADJUSTMENT", "REVERSAL"].map((v) => <option key={v}>{v}</option>)}</select></div>
            <div><Label>Keterangan</Label><Input required value={entry.description} onChange={(e) => setEntry({ ...entry, description: e.target.value })} /></div>
            <div><Label>Jenis dokumen sumber</Label><Input required={entry.kind !== "REVERSAL"} value={entry.sourceType} onChange={(e) => setEntry({ ...entry, sourceType: e.target.value })} /></div>
            <div><Label>ID dokumen sumber</Label><Input required={entry.kind !== "REVERSAL"} value={entry.sourceId} onChange={(e) => setEntry({ ...entry, sourceId: e.target.value })} /></div>
            <div><Label>Kategori arus kas</Label><select className="h-10 rounded border bg-background px-2" value={entry.cashFlowCategory} onChange={(e) => setEntry({ ...entry, cashFlowCategory: e.target.value })}>
              <option value="">Tidak berlaku</option>{["OPERATING", "INVESTING", "FINANCING"].map((v) => <option key={v}>{v}</option>)}</select></div>
          </div>
          {entry.kind === "REVERSAL" && <div className="flex flex-wrap items-end gap-2">
            <div><Label>ID jurnal asal (termasuk periode lalu)</Label><Input required value={entry.reversesId}
              onChange={(e) => setEntry({ ...entry, reversesId: e.target.value })} /></div>
            <Button type="button" variant="outline" onClick={() => {
              setError("");
              void api<Entry>(`/journals/${encodeURIComponent(entry.reversesId)}`).then((original) => {
                setEntry({ ...entry, cashFlowCategory: original.cashFlowCategory ?? "", description: `Pembalikan: ${original.description}` });
                setLines(original.lines.map((l) => ({ accountCode: l.accountCode, debit: String(l.credit), credit: String(l.debit),
                  projectId: l.projectId ?? "", wbs: l.wbs ?? "", costCode: l.costCode ?? "" })));
              }).catch((e: Error) => setError(e.message));
            }}>Isi baris pembalik</Button></div>}
          {lines.map((l, i) => <div className="grid grid-cols-2 gap-2 md:grid-cols-7" key={i}>
            <div><Label>Akun</Label><select required className="h-10 w-full rounded border bg-background px-2" value={l.accountCode}
              onChange={(e) => setLines(lines.map((row, k) => i === k ? { ...row, accountCode: e.target.value } : row))}>
              <option value="">Pilih</option>{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}</select></div>
            {(["debit", "credit", "projectId", "wbs", "costCode"] as const).map((key) =>
              <div key={key}><Label>{key}</Label><Input type={key === "debit" || key === "credit" ? "number" : "text"} min={key === "debit" || key === "credit" ? 0 : undefined}
                value={l[key]} onChange={(e) => setLines(lines.map((row, k) => i === k ? { ...row, [key]: e.target.value } : row))} /></div>)}
            <Button type="button" variant="outline" disabled={lines.length <= 2} onClick={() => setLines(lines.filter((_, k) => k !== i))}>Hapus</Button>
          </div>)}
          <div className="flex gap-2"><Button type="button" variant="outline" onClick={() => setLines([...lines, blank()])}>Tambah baris</Button>
            <Button disabled={busy}>Posting jurnal</Button></div>
        </form>
      </CardContent></Card>}
      {period && <Card><CardHeader><CardTitle>Jurnal {month}</CardTitle></CardHeader><CardContent className="space-y-2">
        {entries.length === 0 ? <p>Belum ada jurnal.</p> : entries.map((j) => <details key={j.id} className="rounded border p-3">
          <summary className="cursor-pointer">{j.entryDate} · {j.kind} · {j.description} · {j.id}</summary>
          {j.sourceType && <p>Dokumen: {j.sourceType} / {j.sourceId}</p>}
          {j.lines.map((l) => <p className="text-sm" key={l.id}>{l.accountCode} · debit {money(l.debit)} / kredit {money(l.credit)}
            {l.projectId && <> · proyek {l.projectId} / {l.wbs ?? "-"} / {l.costCode ?? "-"}</>}</p>)}
        </details>)}
      </CardContent></Card>}
      {period && <Card><CardHeader><CardTitle>Checklist dan persetujuan</CardTitle></CardHeader><CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">Setiap item harus ditandai selesai sebelum direktur dapat menerbitkan laporan. Catat kendala pada item yang belum selesai.</p>
        {keys.map((key) => <div className="flex flex-wrap items-center gap-2" key={key}>
          <label className="flex w-56 items-center gap-2"><input type="checkbox" disabled={!canPost || !["OPEN", "REOPENED"].includes(period.status)}
            checked={checklist[key]?.done ?? false} onChange={(e) => setChecklist({ ...checklist, [key]: { done: e.target.checked, note: checklist[key]?.note ?? "" } })} />{labels[key]}</label>
          <Input className="max-w-lg" placeholder="Catatan / referensi bukti" disabled={!canPost || !["OPEN", "REOPENED"].includes(period.status)}
            value={checklist[key]?.note ?? ""} onChange={(e) => setChecklist({ ...checklist, [key]: { done: checklist[key]?.done ?? false, note: e.target.value } })} />
        </div>)}
        {canPost && ["OPEN", "REOPENED"].includes(period.status) && <Button disabled={busy} onClick={() => void mutate(`/periods/${month}/transition`, { action: "REVIEW", checklist })}>Ajukan review</Button>}
        {canApprove && period.status === "REVIEW" && <Button disabled={busy || period.preparedBy === access.userId}
          onClick={() => void mutate(`/periods/${month}/transition`, { action: "CLOSE" })}>Setujui close dan terbitkan laporan</Button>}
        {canPost && period.status === "CLOSED" && !period.reopenRequestedBy && <div className="flex gap-2">
          <Input placeholder="Alasan reopen" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button disabled={busy || !reason.trim()} onClick={() => void mutate(`/periods/${month}/transition`, { action: "REQUEST_REOPEN", reason }, () => setReason(""))}>Minta reopen</Button></div>}
        {period.reopenRequestedBy && <p>Permintaan reopen: {period.reopenReason} (pemohon: {period.reopenRequestedBy})</p>}
        {canApprove && period.status === "CLOSED" && period.reopenRequestedBy && <Button disabled={busy || period.reopenRequestedBy === access.userId}
          onClick={() => void mutate(`/periods/${month}/transition`, { action: "APPROVE_REOPEN" })}>Setujui reopen</Button>}
      </CardContent></Card>}
      {period && <Card><CardHeader><CardTitle>Laporan & versi terbit</CardTitle></CardHeader><CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">{draft && <Button variant={displayedVersion === null ? "default" : "outline"} onClick={() => setSelectedVersion(null)}>Draft terkini</Button>}
          {versions.map((v) => <Button key={v.id} variant={displayedVersion === v.version ? "default" : "outline"}
            onClick={() => setSelectedVersion(v.version)}>Terbit v{v.version} · {new Date(v.issuedAt).toLocaleString("id-ID")}</Button>)}</div>
        {report ? <div className="space-y-5">
          <p className="text-sm text-muted-foreground">{displayedVersion === null ? "Draft — berubah bila jurnal baru diposting" : `Versi terbit ${displayedVersion} — snapshot tetap`}</p>
          <ReportGroups title="Neraca" groups={report.balanceSheet.accounts} />
          <p>Aset: {money(report.balanceSheet.assets)} · Liabilitas & ekuitas: {money(report.balanceSheet.liabilitiesEquity)} · Laba belum ditutup: {money(report.balanceSheet.unclosedIncome)}</p>
          <ReportGroups title="Laba rugi" groups={report.profitLoss.accounts} /><p>Laba bersih: {money(report.profitLoss.netIncome)}</p>
          <ReportGroups title="Arus kas (akun kas/bank)" groups={report.cashFlow} />
          <ReportGroups title="Project P&L (proyek / WBS / cost code)" groups={report.projectProfitLoss} />
        </div> : <p>Belum ada laporan untuk periode ini.</p>}
      </CardContent></Card>}
    </>}
  </div>;
}