import { useState } from "react";
import { getListAccessUsersQueryKey, useListAccessUsers, useListProjects, useUpdateAccessUser, type AccessUser, type AccessUserUpdateRole, type Project } from "@workspace/api-client-react";
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
  const { data: projects } = useListProjects();
  if (isLoading) return <div>Memuat pengguna...</div>;
  return <div className="space-y-6"><div><h1 className="text-3xl font-bold">Hak Akses</h1><p className="text-muted-foreground">Tetapkan jabatan dan proyek untuk setiap pengguna yang pernah masuk.</p></div>
    <div className="grid gap-4">{users?.map((user) => <AccessCard key={user.userId} user={user} projects={projects ?? []} />)}</div>
  </div>;
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