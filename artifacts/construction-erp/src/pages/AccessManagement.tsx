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

const roles = ["DIRECTOR", "PROJECT_MANAGER", "SITE_MANAGER", "FINANCE", "TAX_STAFF", "PROCUREMENT"] as const;

export default function AccessManagement() {
  const { data: users, isLoading } = useListAccessUsers();
  const { data: invitationList, isError: invitationListFailed } = useListAccessInvitations();
  const { data: projects } = useListProjects();
  const invitations = invitationList?.invitations;
  if (isLoading) return <div>Memuat pengguna...</div>;
  return <div className="space-y-6"><div><h1 className="text-3xl font-bold">Hak Akses</h1><p className="text-muted-foreground">Undang staf dan siapkan jabatan serta proyek sebelum mereka pertama kali masuk.</p></div>
    <InviteCard projects={projects ?? []} />
    {invitationList?.verification.status === "DEGRADED" && <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <p className="font-semibold">Status undangan belum dapat dipastikan</p>
      <p className="mt-1">{invitationList.verification.message}</p>
    </div>}
    {invitationListFailed && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-950">
      Daftar undangan tidak dapat dimuat. Coba lagi beberapa saat.
    </div>}
    {invitations && invitations.length > 0 && <Card><CardHeader><CardTitle className="text-base">Undangan staf</CardTitle></CardHeader><CardContent className="grid gap-3">
      {invitations.map((invite) => <InvitationRow key={invite.id} invite={invite} />)}
    </CardContent></Card>}
    <div className="grid gap-4">{users?.map((user) => <AccessCard key={user.userId} user={user} projects={projects ?? []} />)}</div>
  </div>;
}

function InvitationRow({ invite }: { invite: AccessInvitation }) {
  const revoke = useRevokeAccessInvitation();
  const resend = useResendAccessInvitation();
  const client = useQueryClient();
  const [message, setMessage] = useState("");
  const refresh = () => client.invalidateQueries({ queryKey: getListAccessInvitationsQueryKey() });
  const status = invite.status === "PENDING" ? "Tertunda" : invite.status === "EXPIRED" ? "Kedaluwarsa" : "Dibatalkan";
  const statusClass = invite.status === "PENDING"
    ? "text-amber-600"
    : invite.status === "EXPIRED"
      ? "text-red-600"
      : "text-muted-foreground";
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
    <div><p className="font-medium">{invite.displayName}</p><p className="text-sm text-muted-foreground">{invite.email} · {invite.role.replaceAll("_", " ")}</p></div>
    <div className="flex flex-wrap items-center gap-3">
      <div className="text-right"><span className={`text-sm font-medium ${statusClass}`}>{status}</span><p className="text-xs text-muted-foreground">berakhir {new Date(invite.expiresAt).toLocaleDateString("id-ID")}</p></div>
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
    create.mutate({ data: { email, displayName, role, assignedProjectIds: role === "PROJECT_MANAGER" ? assigned : [] } }, {
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
    <div className="space-y-2"><Label>Jabatan</Label><Select value={role} onValueChange={(value) => setRole(value as typeof role)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{roles.map((item) => <SelectItem key={item} value={item}>{item.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></div>
    <div className="space-y-2"><Label>Proyek PM</Label><div className="flex min-h-10 flex-wrap items-center gap-3">{role === "PROJECT_MANAGER" ? projects.map((project) => <label key={project.id} className="flex items-center gap-2 text-sm"><Checkbox checked={assigned.includes(project.id)} onCheckedChange={() => toggle(project.id)} />{project.code}</label>) : <span className="text-sm text-muted-foreground">Hanya diperlukan untuk Project Manager</span>}</div></div>
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
    <div className="space-y-2"><Label>Jabatan</Label><Select value={role} onValueChange={(value) => setRole(value as typeof role)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{roles.map((item) => <SelectItem key={item} value={item}>{item.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></div>
    <div className="space-y-2"><Label>Proyek PM</Label><div className="flex flex-wrap gap-3">{projects.map((project) => <label key={project.id} className="flex items-center gap-2 text-sm"><Checkbox checked={assigned.includes(project.id)} onCheckedChange={() => toggle(project.id)} />{project.code}</label>)}</div></div>
    <Button disabled={update.isPending || !displayName.trim()} onClick={() => update.mutate({ userId: user.userId, data: { displayName, role, assignedProjectIds: role === "PROJECT_MANAGER" ? assigned : [] } }, { onSuccess: () => client.invalidateQueries({ queryKey: getListAccessUsersQueryKey() }) })}>Simpan</Button>
  </CardContent></Card>;
}