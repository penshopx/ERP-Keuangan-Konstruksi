import assert from "node:assert/strict";
import test from "node:test";
import { roleCanAccessProject, roleHasPermission, roles } from "./access-policy";

const expected: Record<(typeof roles)[number], string[]> = {
  DIRECTOR: ["projects:view", "projects:write", "invoices:view", "invoices:write", "invoices:approve", "tax:view", "audit:view"],
  PROJECT_MANAGER: ["projects:view", "projects:write", "invoices:view", "invoices:approve"],
  SITE_MANAGER: ["projects:view", "invoices:view"],
  FINANCE: ["projects:view", "invoices:view", "invoices:write", "invoices:approve", "tax:view", "audit:view"],
  TAX_STAFF: ["invoices:view", "tax:view", "audit:view"],
  PROCUREMENT: ["projects:view"],
};

test("setiap jabatan hanya memperoleh izin dalam matriks RBAC", () => {
  const allPermissions = [...new Set(Object.values(expected).flat())];
  for (const role of roles) {
    for (const permission of allPermissions) {
      assert.equal(roleHasPermission(role, permission), expected[role].includes(permission), `${role} / ${permission}`);
    }
  }
});

test("Project Manager hanya dapat mengakses proyek yang ditugaskan", () => {
  assert.equal(roleCanAccessProject("PROJECT_MANAGER", ["prj-001"], "prj-001"), true);
  assert.equal(roleCanAccessProject("PROJECT_MANAGER", ["prj-001"], "prj-002"), false);
  assert.equal(roleCanAccessProject("PROJECT_MANAGER", [], "prj-001"), false);
});

test("jabatan non-PM tidak terkena filter penugasan proyek PM", () => {
  for (const role of roles.filter((item) => item !== "PROJECT_MANAGER")) {
    assert.equal(roleCanAccessProject(role, [], "prj-001"), true, role);
  }
});