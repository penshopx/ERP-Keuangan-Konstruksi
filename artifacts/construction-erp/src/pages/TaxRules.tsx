import { useState } from "react";
import {
  getListTaxRulesQueryKey,
  useCreateTaxRule,
  useListTaxRules,
  type TaxRuleInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Calculator, LockKeyhole, Plus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { calculateTaxSimulation } from "@/lib/tax-simulation";

type ServiceType = TaxRuleInput["serviceType"];
type Qualification = Exclude<TaxRuleInput["qualification"], null | undefined>;

const initialForm: TaxRuleInput = {
  version: "",
  effectiveFrom: "",
  effectiveTo: null,
  regulatorySource: "",
  serviceType: "KONSTRUKSI",
  qualification: "KECIL",
  requiresSbu: true,
  supplierPkp: true,
  governmentCollector: false,
  integrated: false,
  dppRateBasisPoints: 10000,
  ppnRateBasisPoints: 1100,
  pphFinalRateBasisPoints: 175,
  pph23RateBasisPoints: 0,
};

const percent = (basisPoints: number) => `${(basisPoints / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;
const date = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
const rupiah = (value: number) => new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
}).format(value);

export default function TaxRules() {
  const { data: rules, isLoading, error } = useListTaxRules();
  const [open, setOpen] = useState(false);

  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Aturan Pajak</h1>
        <p className="mt-1 text-muted-foreground">Kelola versi regulasi yang dipakai otomatis saat invoice dibuat.</p>
      </div>
      <CreateTaxRuleDialog open={open} onOpenChange={setOpen} />
    </div>

    <Alert>
      <LockKeyhole className="h-4 w-4" />
      <AlertTitle>Riwayat aturan dilindungi</AlertTitle>
      <AlertDescription>Versi yang sudah dibuat tidak dapat diubah atau dihapus. Tambahkan versi baru untuk perubahan regulasi berikutnya.</AlertDescription>
    </Alert>

    <Card>
      <CardHeader><CardTitle className="text-base">Daftar versi</CardTitle></CardHeader>
      <CardContent className="p-0">
        {isLoading && <p className="p-6 text-sm text-muted-foreground">Memuat aturan pajak...</p>}
        {error && <p className="p-6 text-sm text-destructive">Aturan pajak tidak dapat dimuat.</p>}
        {!isLoading && !error && rules?.length === 0 && <p className="p-6 text-sm text-muted-foreground">Belum ada aturan pajak.</p>}
        {rules && rules.length > 0 && <div className="overflow-x-auto"><Table>
          <TableHeader><TableRow>
            <TableHead>Versi & sumber</TableHead><TableHead>Kriteria</TableHead><TableHead>Periode berlaku</TableHead><TableHead>Tarif</TableHead><TableHead className="text-right">Pemakaian</TableHead>
          </TableRow></TableHeader>
          <TableBody>{rules.map((rule) => <TableRow key={rule.id}>
            <TableCell className="min-w-64 align-top"><p className="font-semibold">{rule.version}</p><p className="mt-1 max-w-sm whitespace-normal text-xs text-muted-foreground">{rule.regulatorySource}</p></TableCell>
            <TableCell className="min-w-52 align-top"><p>{rule.serviceType === "KONSTRUKSI" ? "Jasa konstruksi" : "Jasa lain"}</p><p className="text-xs text-muted-foreground">{rule.qualification?.replaceAll("_", " ") ?? "Tanpa kualifikasi"} · {rule.supplierPkp ? "PKP" : "Non-PKP"}</p></TableCell>
            <TableCell className="whitespace-nowrap align-top">{date(rule.effectiveFrom)}<span className="block text-xs text-muted-foreground">s.d. {rule.effectiveTo ? date(rule.effectiveTo) : "seterusnya"}</span></TableCell>
            <TableCell className="whitespace-nowrap align-top text-sm">DPP {percent(rule.dppRateBasisPoints)} · PPN {percent(rule.ppnRateBasisPoints)}<span className="block text-xs text-muted-foreground">PPh Final {percent(rule.pphFinalRateBasisPoints)} · PPh 23 {percent(rule.pph23RateBasisPoints)}</span></TableCell>
            <TableCell className="text-right align-top"><Badge variant={rule.invoiceUsageCount > 0 ? "default" : "secondary"}>{rule.invoiceUsageCount} invoice</Badge></TableCell>
          </TableRow>)}</TableBody>
        </Table></div>}
      </CardContent>
    </Card>
  </div>;
}

function CreateTaxRuleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
  const [form, setForm] = useState<TaxRuleInput>(initialForm);
  const [sampleInvoiceValue, setSampleInvoiceValue] = useState(100_000_000);
  const [message, setMessage] = useState("");
  const create = useCreateTaxRule();
  const client = useQueryClient();
  const set = <K extends keyof TaxRuleInput>(key: K, value: TaxRuleInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  const setRate = (key: "dppRateBasisPoints" | "ppnRateBasisPoints" | "pphFinalRateBasisPoints" | "pph23RateBasisPoints", value: string) => {
    set(key, Math.round((Number(value) || 0) * 100));
  };
  const changeService = (serviceType: ServiceType) => setForm((current) => serviceType === "JASA_LAIN"
    ? { ...current, serviceType, qualification: null, requiresSbu: false, integrated: false }
    : { ...current, serviceType, qualification: "KECIL", requiresSbu: true });
  const submit = () => {
    setMessage("");
    create.mutate({ data: { ...form, effectiveTo: form.effectiveTo || null } }, {
      onSuccess: () => {
        client.invalidateQueries({ queryKey: getListTaxRulesQueryKey() });
        setForm(initialForm);
        setMessage("");
        onOpenChange(false);
      },
      onError: (error) => {
        const data = (error as { data?: { error?: string } }).data;
        setMessage(data?.error ?? "Aturan pajak gagal disimpan.");
      },
    });
  };
  const valid = form.version.trim() && form.regulatorySource.trim() && form.effectiveFrom && (!form.effectiveTo || form.effectiveTo >= form.effectiveFrom);
  const simulation = calculateTaxSimulation(sampleInvoiceValue, form);

  return <Dialog open={open} onOpenChange={(value) => { onOpenChange(value); if (!value) setMessage(""); }}>
    <DialogTrigger asChild><Button><Plus className="mr-2 h-4 w-4" />Tambah versi</Button></DialogTrigger>
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
      <DialogHeader><DialogTitle>Tambah versi aturan pajak</DialogTitle><DialogDescription>Versi yang tersimpan bersifat permanen. Pastikan kriteria, tarif, sumber, dan periode sudah benar.</DialogDescription></DialogHeader>
      <div className="grid gap-4 py-2 md:grid-cols-2">
        <Field label="Nama versi"><Input value={form.version} onChange={(e) => set("version", e.target.value)} placeholder="Contoh: PP 9/2022 - Kecil PKP" /></Field>
        <Field label="Jenis jasa"><Select value={form.serviceType} onValueChange={(value) => changeService(value as ServiceType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="KONSTRUKSI">Jasa konstruksi</SelectItem><SelectItem value="JASA_LAIN">Jasa lain</SelectItem></SelectContent></Select></Field>
        <Field label="Berlaku mulai"><Input type="date" value={form.effectiveFrom} onChange={(e) => set("effectiveFrom", e.target.value)} /></Field>
        <Field label="Berlaku sampai (opsional)"><Input type="date" min={form.effectiveFrom} value={form.effectiveTo ?? ""} onChange={(e) => set("effectiveTo", e.target.value || null)} /></Field>
        {form.serviceType === "KONSTRUKSI" && <Field label="Kualifikasi"><Select value={form.qualification ?? "KECIL"} onValueChange={(value) => set("qualification", value as Qualification)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["KECIL", "MENENGAH", "BESAR", "TANPA_KUALIFIKASI"].map((item) => <SelectItem key={item} value={item}>{item.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></Field>}
        <div className="grid grid-cols-2 gap-3">
          <Check label="Memerlukan SBU" checked={form.requiresSbu} disabled={form.serviceType !== "KONSTRUKSI"} onChange={(value) => set("requiresSbu", value)} />
          <Check label="Pekerjaan terintegrasi" checked={form.integrated} disabled={form.serviceType !== "KONSTRUKSI"} onChange={(value) => set("integrated", value)} />
          <Check label="Penyedia PKP" checked={form.supplierPkp} onChange={(value) => set("supplierPkp", value)} />
          <Check label="Pemungut pemerintah" checked={form.governmentCollector} onChange={(value) => set("governmentCollector", value)} />
        </div>
        <Field label="Basis DPP (%)"><Input aria-label="Basis DPP (%)" type="number" min="0" max="100" step="0.01" value={form.dppRateBasisPoints / 100} onChange={(e) => setRate("dppRateBasisPoints", e.target.value)} /></Field>
        <Field label="Tarif PPN (%)"><Input aria-label="Tarif PPN (%)" type="number" min="0" max="100" step="0.01" value={form.ppnRateBasisPoints / 100} onChange={(e) => setRate("ppnRateBasisPoints", e.target.value)} /></Field>
        <Field label="Tarif PPh Final (%)"><Input aria-label="Tarif PPh Final (%)" type="number" min="0" max="100" step="0.01" value={form.pphFinalRateBasisPoints / 100} onChange={(e) => setRate("pphFinalRateBasisPoints", e.target.value)} /></Field>
        <Field label="Tarif PPh 23 (%)"><Input aria-label="Tarif PPh 23 (%)" type="number" min="0" max="100" step="0.01" value={form.pph23RateBasisPoints / 100} onChange={(e) => setRate("pph23RateBasisPoints", e.target.value)} /></Field>
        <div className="space-y-2 md:col-span-2"><Label>Sumber regulasi</Label><Textarea value={form.regulatorySource} onChange={(e) => set("regulatorySource", e.target.value)} placeholder="Nomor dan nama regulasi, pasal, atau rujukan resmi" /></div>
        <Card className="md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Calculator className="h-4 w-4" />Simulasi dampak tarif</CardTitle>
            <p className="text-sm text-muted-foreground">Pratinjau lokal ini tidak disimpan dan tidak membuat catatan audit.</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Nilai invoice contoh">
              <Input
                aria-label="Nilai invoice contoh"
                type="number"
                min="0"
                step="1"
                value={sampleInvoiceValue}
                onChange={(e) => setSampleInvoiceValue(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <SimulationRow label="DPP kena pajak" value={simulation.dpp} />
              <SimulationRow label="PPN" value={simulation.ppn} />
              <SimulationRow label="PPh Final" value={simulation.pphFinal} negative />
              <SimulationRow label="PPh 23" value={simulation.pph23} negative />
            </div>
            <div className="flex items-center justify-between border-t pt-4">
              <span className="font-semibold">Total bersih</span>
              <span className="text-lg font-bold tabular-nums">{rupiah(simulation.total)}</span>
            </div>
            {form.governmentCollector && <p className="text-xs text-muted-foreground">PPN ditampilkan, tetapi tidak ditambahkan ke total bersih karena dipungut pemerintah.</p>}
          </CardContent>
        </Card>
      </div>
      {message && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>Tidak dapat menyimpan</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>}
      <div className="flex justify-end gap-3"><Button variant="outline" onClick={() => onOpenChange(false)}>Batal</Button><Button disabled={!valid || create.isPending} onClick={submit}>{create.isPending ? "Menyimpan..." : "Simpan versi permanen"}</Button></div>
    </DialogContent>
  </Dialog>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>;
}

function SimulationRow({ label, value, negative = false }: { label: string; value: number; negative?: boolean }) {
  return <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-medium tabular-nums">{negative && value > 0 ? "−" : ""}{rupiah(value)}</span>
  </div>;
}

function Check({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-center gap-2 text-sm"><Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />{label}</label>;
}