export const roles = ["DIRECTOR", "PROJECT_MANAGER", "SITE_MANAGER", "FINANCE", "TAX_STAFF", "PROCUREMENT"] as const;
export type Role = typeof roles[number];

export const rolePermissions: Record<Role, readonly string[]> = {
  DIRECTOR: ["projects:view", "projects:write", "commitments:view", "commitments:write", "commitments:approve", "commitments:post", "invoices:view", "invoices:write", "invoices:approve", "tax:view", "tax-rules:manage", "audit:view", "petty-cash:view", "petty-cash:request", "petty-cash:approve", "petty-cash:disburse", "petty-cash:settle", "petty-cash:reconcile"],
  PROJECT_MANAGER: ["projects:view", "projects:write", "commitments:view", "commitments:write", "commitments:approve", "commitments:post", "invoices:view", "invoices:approve", "petty-cash:view", "petty-cash:approve"],
  SITE_MANAGER: ["projects:view", "commitments:view", "invoices:view", "petty-cash:view", "petty-cash:request", "petty-cash:settle"],
  FINANCE: ["projects:view", "commitments:view", "commitments:write", "commitments:approve", "commitments:post", "invoices:view", "invoices:write", "invoices:approve", "tax:view", "tax-rules:manage", "audit:view", "petty-cash:view", "petty-cash:approve", "petty-cash:disburse", "petty-cash:reconcile"],
  TAX_STAFF: ["invoices:view", "tax:view", "audit:view"],
  PROCUREMENT: ["projects:view", "commitments:view", "commitments:write"],
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