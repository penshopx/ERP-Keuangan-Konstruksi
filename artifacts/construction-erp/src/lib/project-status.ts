import { ProjectStatus } from "@workspace/api-client-react";

export function getProjectStatusBadgeVariant(status: ProjectStatus): "default" | "secondary" {
  return status === ProjectStatus.BERJALAN ? "default" : "secondary";
}

export function isProjectCompleted(status: ProjectStatus): boolean {
  return status === ProjectStatus.SELESAI;
}