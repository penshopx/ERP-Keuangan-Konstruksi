export const roles = ["DIRECTOR", "PROJECT_MANAGER", "SITE_MANAGER", "FINANCE", "TAX_STAFF", "PROCUREMENT", "JURU_HITUNG", "ESTIMATOR", "QUANTITY_SURVEYOR"] as const;
export type Role = typeof roles[number];

export type ProtectedMutationEndpoint = {
  id: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  routePath: string;
  requestPath: string;
  requiredPermission?: string;
  allowedRoles?: readonly Role[];
  body?: Readonly<Record<string, unknown>>;
};

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

/**
 * Security inventory for every state-changing production route.
 * access.integration.test.ts compares this list with the mounted production
 * router, then exercises every authorization case through that router.
 */
export const protectedMutationEndpoints: readonly ProtectedMutationEndpoint[] = [
  { id: "invite-staff", method: "POST", routePath: "/access/invitations", requestPath: "/access/invitations", allowedRoles: ["DIRECTOR"] },
  { id: "revoke-invitation", method: "POST", routePath: "/access/invitations/:invitationId/revoke", requestPath: "/access/invitations/missing/revoke", allowedRoles: ["DIRECTOR"] },
  { id: "resend-invitation", method: "POST", routePath: "/access/invitations/:invitationId/resend", requestPath: "/access/invitations/missing/resend", allowedRoles: ["DIRECTOR"] },
  { id: "update-access", method: "PUT", routePath: "/access/users/:userId", requestPath: "/access/users/missing", allowedRoles: ["DIRECTOR"] },
  { id: "update-copilot-limit", method: "PUT", routePath: "/ai/limits", requestPath: "/ai/limits", allowedRoles: ["DIRECTOR"], body: { scope: "role", scopeId: "DIRECTOR", dailyLimit: 100 } },
  { id: "decide-invoice", method: "POST", routePath: "/invoices/:invoiceId/decision", requestPath: "/invoices/missing/decision", requiredPermission: "invoices:approve" },
  { id: "acknowledge-budget-alert", method: "POST", routePath: "/budget-alerts/:alertId/acknowledge", requestPath: "/budget-alerts/missing/acknowledge", requiredPermission: "budget-alerts:manage" },
  { id: "resolve-budget-alert", method: "POST", routePath: "/budget-alerts/:alertId/resolve", requestPath: "/budget-alerts/missing/resolve", requiredPermission: "budget-alerts:manage" },
  { id: "create-invoice", method: "POST", routePath: "/invoices", requestPath: "/invoices", requiredPermission: "invoices:write" },
  { id: "create-project", method: "POST", routePath: "/projects", requestPath: "/projects", requiredPermission: "projects:write" },
  { id: "update-project", method: "PATCH", routePath: "/projects/:projectId", requestPath: "/projects/missing", requiredPermission: "projects:write" },
  { id: "import-rab", method: "POST", routePath: "/projects/:projectId/rab/import", requestPath: "/projects/missing/rab/import", requiredPermission: "projects:write" },
  { id: "request-petty-cash", method: "POST", routePath: "/petty-cash", requestPath: "/petty-cash", requiredPermission: "petty-cash:request" },
  { id: "decide-petty-cash", method: "POST", routePath: "/petty-cash/:requestId/decision", requestPath: "/petty-cash/missing/decision", requiredPermission: "petty-cash:approve" },
  { id: "disburse-petty-cash", method: "POST", routePath: "/petty-cash/:requestId/disburse", requestPath: "/petty-cash/missing/disburse", requiredPermission: "petty-cash:disburse" },
  { id: "settle-petty-cash", method: "POST", routePath: "/petty-cash/:requestId/settle", requestPath: "/petty-cash/missing/settle", requiredPermission: "petty-cash:settle" },
  { id: "reconcile-petty-cash", method: "POST", routePath: "/petty-cash/:requestId/reconcile", requestPath: "/petty-cash/missing/reconcile", requiredPermission: "petty-cash:reconcile" },
  { id: "create-commitment", method: "POST", routePath: "/projects/:projectId/commitments", requestPath: "/projects/missing/commitments", requiredPermission: "commitments:write" },
  { id: "transition-commitment", method: "POST", routePath: "/projects/:projectId/commitments/:commitmentId/transition", requestPath: "/projects/missing/commitments/missing/transition", requiredPermission: "commitments:write" },
  { id: "create-material-requirement", method: "POST", routePath: "/projects/:projectId/material-requirements", requestPath: "/projects/missing/material-requirements", requiredPermission: "projects:write" },
  { id: "create-inventory-movement", method: "POST", routePath: "/projects/:projectId/inventory-movements", requestPath: "/projects/missing/inventory-movements", requiredPermission: "projects:write" },
  { id: "update-material-exception", method: "PATCH", routePath: "/projects/:projectId/material-exceptions/:exceptionId", requestPath: "/projects/missing/material-exceptions/missing", requiredPermission: "projects:write" },
  {
    id: "update-competency-profile",
    method: "PUT",
    routePath: "/competencies/profiles/:userId",
    requestPath: "/competencies/profiles/missing",
    allowedRoles: ["DIRECTOR"],
    body: { catalogEntryId: "missing", verificationStatus: "UNVERIFIED" },
  },
  { id: "preview-estimate", method: "POST", routePath: "/projects/:projectId/estimates/preview", requestPath: "/projects/missing/estimates/preview", requiredPermission: "rab:estimate" },
  { id: "baseline-estimate", method: "POST", routePath: "/projects/:projectId/estimates/baseline", requestPath: "/projects/missing/estimates/baseline", requiredPermission: "rab:estimate" },
  {
    id: "submit-rab",
    method: "POST",
    routePath: "/projects/:projectId/rab/transition",
    requestPath: "/projects/missing/rab/transition",
    requiredPermission: "rab:estimate",
    body: { baselineId: "missing", decision: "SUBMIT" },
  },
  {
    id: "approve-rab",
    method: "POST",
    routePath: "/projects/:projectId/rab/transition",
    requestPath: "/projects/missing/rab/transition",
    requiredPermission: "rab:approve",
    body: { baselineId: "missing", decision: "APPROVE" },
  },
  {
    id: "reject-rab",
    method: "POST",
    routePath: "/projects/:projectId/rab/transition",
    requestPath: "/projects/missing/rab/transition",
    requiredPermission: "rab:review",
    body: { baselineId: "missing", decision: "REJECT" },
  },
  { id: "create-tax-rule", method: "POST", routePath: "/tax/rules", requestPath: "/tax/rules", requiredPermission: "tax-rules:manage" },
] as const;

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