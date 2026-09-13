import { createContext, useContext } from "react";
import type { CurrentUser } from "@workspace/api-client-react";

const AccessContext = createContext<CurrentUser | null>(null);

export const AccessProvider = AccessContext.Provider;

export function useAccess() {
  const access = useContext(AccessContext);
  if (!access) throw new Error("AccessProvider tidak tersedia");
  return access;
}

export function hasPermission(access: CurrentUser, permission: string) {
  return access.permissions.includes(permission);
}