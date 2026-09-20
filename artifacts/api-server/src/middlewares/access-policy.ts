export const roles = ["DIRECTOR", "PROJECT_MANAGER", "SITE_MANAGER", "FINANCE", "TAX_STAFF", "PROCUREMENT", "JURU_HITUNG", "ESTIMATOR", "QUANTITY_SURVEYOR"] as const;
export type Role = typeof roles[number];

export const rolePermissions: Record<Role, readonly string[]> = {
  DIRECTOR: ["projects:view", "projects:write", "rab:estimate", "rab:review", "rab:approve", "commitments:view", "commitments:write", "commitments:approve", "commitments:post", "invoices:view", "invoices:write", "invoices:approve", "tax:view", "tax-rules:manage", "budget-alerts:manage", "audit:view", "petty-cash:view", "petty-cash:request", "petty-cash:approve", "petty-cash:disburse", "petty-cash:settle", "petty-cash:reconcile"],
  PROJECT_MANAGER: ["projects:view", "projects:write", "rab:review", "commitments:view", "commitments:write", "commitments:approve", "commitments:post", "invoices:view", "invoices:approve", "budget-alerts:manage", "petty-cash:view", "petty-cash:approve"],
  SITE_MANAGER: ["projects:view", "commitments:view", "invoices:view", "petty-cash:view", "petty-cash:request", "petty-cash:settle"],
  FINANCE: ["projects:view", "commitments:view", "commitments:write", "commitments:approve", "commitments:post", "invoices:view", "invoices:write", "invoices:approve", "tax:view", "tax-rules:manage", "audit:view", "petty-cash:view", "petty-cash:approve", "petty-cash:disburse", "petty-cash:reconcile"],
  TAX_STAFF: ["invoices:view", "tax:view", "audit:view"],
  PROCUREMENT: ["projects:view", "commitments:view", "commitments:write"],
  JURU_HITUNG: ["projects:view", "rab:estimate", "rab:volume:write"],
  ESTIMATOR: ["projects:view", "rab:estimate", "rab:volume:write"],
  QUANTITY_SURVEYOR: ["projects:view", "rab:estimate", "rab:review", "rab:approve"],
};

export function isRole(value: string): value is Role {
  return roles.includes(value as Role);
}

export function roleHasPermission(role: Role, permission: string) {
  return rolePermissions[role].includes(permission);
}

export function roleCanAccessProject(role: Role, assignedProjectIds: readonly string[], projectId: string) {
  return !["PROJECT_MANAGER", "JURU_HITUNG", "ESTIMATOR", "QUANTITY_SURVEYOR"].includes(role)
    || assignedProjectIds.includes(projectId);
}