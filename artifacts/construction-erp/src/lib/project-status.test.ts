import { describe, expect, test } from "vitest";
import { ProjectStatus } from "@workspace/api-client-react";
import {
  getProjectStatusBadgeVariant,
  isProjectCompleted,
} from "./project-status";

describe("pemetaan status proyek", () => {
  test("menonjolkan hanya proyek BERJALAN sebagai aktif", () => {
    expect(getProjectStatusBadgeVariant(ProjectStatus.BERJALAN)).toBe("default");
    expect(getProjectStatusBadgeVariant(ProjectStatus.PERSIAPAN)).toBe("secondary");
    expect(getProjectStatusBadgeVariant(ProjectStatus.SELESAI)).toBe("secondary");
  });

  test("menganggap hanya status SELESAI sebagai proyek selesai", () => {
    expect(isProjectCompleted(ProjectStatus.SELESAI)).toBe(true);
    expect(isProjectCompleted(ProjectStatus.BERJALAN)).toBe(false);
    expect(isProjectCompleted(ProjectStatus.PERSIAPAN)).toBe(false);
  });
});