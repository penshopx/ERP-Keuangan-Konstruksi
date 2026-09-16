export const PROJECT_STATUS = {
  PREPARATION: "PERSIAPAN",
  ACTIVE: "BERJALAN",
  COMPLETED: "SELESAI",
} as const;

export function getProjectStatusBadgeVariant(status: string): "default" | "secondary" {
  return status === PROJECT_STATUS.ACTIVE ? "default" : "secondary";
}

export function isProjectCompleted(status: string): boolean {
  return status === PROJECT_STATUS.COMPLETED;
}