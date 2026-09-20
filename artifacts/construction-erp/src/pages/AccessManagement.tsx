import { useState } from "react";
import {
  getListAccessInvitationsQueryKey,
  getListAccessUsersQueryKey,
  useCreateAccessInvitation,
  useListAccessInvitations,
  useListAccessUsers,
  useListProjects,
  useResendAccessInvitation,
  useRevokeAccessInvitation,
  useUpdateAccessUser,
  type AccessInvitation,
  type AccessInvitationInputRole,
  type AccessUser,
  type AccessUserUpdateRole,
  type Project,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const roles = ["DIRECTOR", "PROJECT_MANAGER", "SITE_MANAGER", "FINANCE", "TAX_STAFF", "PROCUREMENT", "JURU_HITUNG", "ESTIMATOR", "QUANTITY_SURVEYOR"] as const;
const invitationStatuses = ["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"] as const;
type InvitationStatusFilter = typeof invitationStatuses[number] | "ALL";

const roleLabels: Record<typeof roles[number], string> = {
  DIRECTOR: "Direktur (Eksekutif)",
  PROJECT_MANAGER: "Manajer Proyek (PM)",
  SITE_MANAGER: "Manajer Lapangan (SM)",
  FINANCE: "Keuangan (Pusat)",
  TAX_STAFF: "Staf Pajak",
  PROCUREMENT: "Pengadaan (Procurement)",
  JURU_HITUNG: "Juru Hitung (Field)",
  ESTIMATOR: "Estimator (RAB/AHS)",
  QUANTITY_SURVEYOR: "Quantity Surveyor (QS)",
};

function formatVerificationTime(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function AccessManagement() {
  const [invitationEmail, setInvitationEmail] = useState("");
  const [invitationStatus, setInvitationStatus] = useState<InvitationStatusFilter>("ALL");
  const { data: users, isLoading } = useListAccessUsers();
  const normalizedInvitationEmail = invitationEmail.trim();
  const invitationFilters = {
    ...(normalizedInvitationEmail ? { email: normalizedInvitationEmail } : {}),
    ...(invitationStatus !== "ALL" ? { status: invitationStatus } : {}),
  };
  const { data: invitationList, isError: invitationListFailed } = useListAccessInvitations(invitationFilters);
  const { data: projects } = useListProjects();
  const invitations = invitationList?.invitations;
  return <div className="space-y-6"><div><h1 className="text-3xl font-bold">Hak Akses</h1><p className="text-muted-foreground">Undang staf dan siapkan jabatan serta proyek sebelum mereka pertama kali masuk.</p></div>
    <InviteCard projects={projects ?? []} />
    {invitationList?.verification.status === "DEGRADED" && <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <p className="font-semibold">Status undangan belum dapat dipastikan</p>
      <p className="mt-1">{invitationList.verification.message}</p>
      <p className="mt-2 font-medium">
        {invitationList.verification.lastSuccessfulVerificationAt
          ? `Terakhir berhasil diverifikasi melalui Clerk: ${formatVerificationTime(invitationList.verification.lastSuccessfulVerificationAt)}.`
          : "Belum ada verifikasi Clerk yang berhasil sejak layanan dimulai."}
      </p>
    </div>}
    {invitationListFailed && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-950">
      Daftar undangan tidak dapat dimuat. Coba lagi beberapa saat.
    </div>}
    {invitations && <Card>
      <CardHeader><CardTitle className="text-base">Riwayat undangan staf</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
          <div className="grid gap-2">
            <Label htmlFor="invitation-email-filter">Cari email</Label>
            <Input
              id="invitation-email-filter"
              type="search"
              value={invitationEmail}
              onChange={(event) => setInvitationEmail(event.target.value)}
              placeholder="Email undangan atau penerimaan"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="invitation-status-filter">Status</Label>
            <Select value={invitationStatus} onValueChange={(value) => setInvitationStatus(value as InvitationStatusFilter)}>
              <SelectTrigger id="invitation-status-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Semua status</SelectItem>
                <SelectItem value="PENDING">Tertunda</SelectItem>
                <SelectItem value="ACCEPTED">Diterima</SelectItem>
                <SelectItem value="EXPIRED">Kedaluwarsa</SelectItem>
                <SelectItem value="REVOKED">Dibatalkan</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {invitations.length > 0
          ? <div className="grid gap-3">{invitations.map((invite) => <InvitationRow key={invite.id} invite={invite} />)}</div>
          : <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Tidak ada undangan yang cocok dengan pencarian dan status ini.
            </p>}
      </CardContent>
    </Card>}
    {isLoading
      ? <div>Memuat pengguna...</div>
      : <div className="grid gap-4">{users?.map((user) => <AccessCard key={user.userId} user={user} projects={projects ?? []} />)}</div>}
  </div>;
}

function InvitationRow({ invite }: { invite: AccessInvitation }) {
  const revoke = useRevokeAccessInvitation();
  const resend = useResendAccessInvitation();
  const client = useQueryClient();
  const [message, setMessage] = useState("");
  const refresh = () => client.invalidateQueries({ queryKey: getListAccessInvitationsQueryKey() });
  const status = invite.status === "PENDING"
    ? "Tertunda"
    : invite.status === "EXPIRED"
      ? "Kedaluwarsa"
      : invite.status === "ACCEPTED"
        ? "Diterima"
        : "Dibatalkan";
  const statusClass = invite.status === "PENDING"
    ? "text-amber-600"
    : invite.status === "ACCEPTED"
      ? "text-emerald-600"
    : invite.status === "EXPIRED"
      ? "text-red-600"
      : "text-muted-foreground";
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
    <div>
      <p className="font-medium">{invite.displayName}</p>
      <p className="text-sm text-muted-foreground">{invite.email} · {roleLabels[invite.role as keyof typeof roleLabels]}</p>
      {invite.status === "ACCEPTED" && <p className="mt-1 text-xs text-muted-foreground">
        {invite.acceptedEmail
          ? `Diterima menggunakan ${invite.acceptedEmail}`
          : "Email penerimaan tidak tercatat pada data lama"}
      </p>}
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <div className="text-right">
        <span className={`text-sm font-medium ${statusClass}`}>{status}</span>
        <p className="text-xs text-muted-foreground">
          {invite.status === "ACCEPTED" && invite.acceptedAt
            ? `diterima ${new Date(invite.acceptedAt).toLocaleDateString("id-ID")}`
            : `berakhir ${new Date(invite.expiresAt).toLocaleDateString("id-ID")}`}
        </p>
      </div>
      {invite.status === "PENDING" && <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => {
        if (!window.confirm(`Batalkan undangan untuk ${invite.email}? Tautan undangan tidak dapat digunakan lagi.`)) return;
        setMessage("");
        revoke.mutate({ invitationId: invite.id }, {
          onSuccess: () => { setMessage("Undangan dibatalkan."); refresh(); },
          onError: () => setMessage("Undangan gagal dibatalkan."),
        });
      }}>{revoke.isPending ? "Membatalkan..." : "Batalkan"}</Button>}
      {invite.status === "EXPIRED" && <Button variant="outline" size="sm" disabled={resend.isPending} onClick={() => {
        setMessage("");
        resend.mutate({ invitationId: invite.id }, {
          onSuccess: () => { setMessage("Undangan dikirim ulang."); refresh(); },
          onError: () => setMessage("Undangan gagal dikirim ulang."),
        });
      }}>{resend.isPending ? "Mengirim..." : "Kirim ulang"}</Button>}
      {message && <p className="w-full text-right text-xs text-muted-foreground">{message}</p>}
    </div>
  </div>;
}

function InviteCard({ projects }: { projects: Project[] }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<AccessInvitationInputRole>("SITE_MANAGER");
  const [assigned, setAssigned] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const create = useCreateAccessInvitation();
  const client = useQueryClient();
  const toggle = (id: string) => setAssigned((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const submit = () => {
    setMessage("");
    create.mutate({ data: { email, displayName, role, assignedProjectIds: ["PROJECT_MANAGER", "JURU_HITUNG", "ESTIMATOR", "QUANTITY_SURVEYOR"].includes(role) ? assigned : [] } }, {
      onSuccess: () => {
        setEmail(""); setDisplayName(""); setAssigned([]);
        setMessage("Undangan berhasil dikirim.");
        client.invalidateQueries({ queryKey: getListAccessInvitationsQueryKey() });
      },
      onError: () => setMessage("Undangan gagal dikirim. Periksa email atau undangan yang masih aktif."),
    });
  };
  return <Card><CardHeader><CardTitle className="text-base">Undang staf baru</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
    <div className="space-y-2"><Label>Nama staf</Label><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Nama lengkap" /></div>
    <div className="space-y-2"><Label>Email kerja</Label><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nama@perusahaan.com" /></div>
    <div className="space-y-2"><Label>Jabatan</Label><Select value={role} onValueChange={(value) => setRole(value as typeof role)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{roles.map((item) => <SelectItem key={item} value={item}>{roleLabels[item as keyof typeof roleLabels]}</SelectItem>)}</SelectContent></Select></div>
    <div className="space-y-2"><Label>Proyek penugasan</Label><div className="flex min-h-10 flex-wrap items-center gap-3">{["PROJECT_MANAGER", "JURU_HITUNG", "ESTIMATOR", "QUANTITY_SURVEYOR"].includes(role) ? projects.map((project) => <label key={project.id} className="flex items-center gap-2 text-sm"><Checkbox checked={assigned.includes(project.id)} onCheckedChange={() => toggle(project.id)} />{project.code}</label>) : <span className="text-sm text-muted-foreground">Tidak diperlukan untuk jabatan ini</span>}</div></div>
    <div className="flex items-center gap-3 md:col-span-2"><Button disabled={create.isPending || !displayName.trim() || !email.includes("@")} onClick={submit}>{create.isPending ? "Mengirim..." : "Kirim undangan"}</Button>{message && <p className="text-sm text-muted-foreground">{message}</p>}</div>
  </CardContent></Card>;
}

function AccessCard({ user, projects }: { user: AccessUser, projects: Project[] }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<AccessUserUpdateRole>(user.role === "UNASSIGNED" ? "SITE_MANAGER" : user.role);
  const [assigned, setAssigned] = useState(user.assignedProjectIds);
  const update = useUpdateAccessUser();
  const client = useQueryClient();
  const toggle = (id: string) => setAssigned((current: string[]) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  return <Card><CardHeader><CardTitle className="text-base">{user.displayName}</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_2fr_auto] md:items-end">
    <div className="space-y-2"><Label>Nama</Label><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></div>
    <div className="space-y-2"><Label>Jabatan</Label><Select value={role} onValueChange={(value) => setRole(value as typeof role)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{roles.map((item) => <SelectItem key={item} value={item}>{roleLabels[item as keyof typeof roleLabels]}</SelectItem>)}</SelectContent></Select></div>
     <div className="space-y-2"><Label>Proyek penugasan</Label><div className="flex flex-wrap gap-3">{["PROJECT_MANAGER", "JURU_HITUNG", "ESTIMATOR", "QUANTITY_SURVEYOR"].includes(role) ? projects.map((project) => <label key={project.id} className="flex items-center gap-2 text-sm"><Checkbox checked={assigned.includes(project.id)} onCheckedChange={() => toggle(project.id)} />{project.code}</label>) : <span className="text-sm text-muted-foreground">Tidak diperlukan untuk jabatan ini</span>}</div></div>
     <Button disabled={update.isPending || !displayName.trim()} onClick={() => update.mutate({ userId: user.userId, data: { displayName, role, assignedProjectIds: ["PROJECT_MANAGER", "JURU_HITUNG", "ESTIMATOR", "QUANTITY_SURVEYOR"].includes(role) ? assigned : [] } }, { onSuccess: () => client.invalidateQueries({ queryKey: getListAccessUsersQueryKey() }) })}>Simpan</Button>
  </CardContent></Card>;
}