export const roles = ["DIRECTOR", "PROJECT_MANAGER", "SITE_MANAGER", "FINANCE", "TAX_STAFF", "PROCUREMENT"] as const;
export type Role = typeof roles[number];

export const rolePermissions: Record<Role, readonly string[]> = {
  DIRECTOR: ["projects:view", "projects:write", "invoices:view", "invoices:write", "invoices:approve", "tax:view", "audit:view"],
  PROJECT_MANAGER: ["projects:view", "projects:write", "invoices:view", "invoices:approve"],
  SITE_MANAGER: ["projects:view", "invoices:view"],
  FINANCE: ["projects:view", "invoices:view", "invoices:write", "invoices:approve", "tax:view", "audit:view"],
  TAX_STAFF: ["invoices:view", "tax:view", "audit:view"],
  PROCUREMENT: ["projects:view"],
};

export function isRole(value: string): value is Role {
  return roles.includes(value as Role);
}

export function roleHasPermission(role: Role, permission: string) {
  return rolePermissions[role].includes(permission);
}

export function roleCanAccessProject(role: Role, assignedProjectIds: readonly string[], projectId: string) {
  return role !== "PROJECT_MANAGER" || assignedProjectIds.includes(projectId);
}