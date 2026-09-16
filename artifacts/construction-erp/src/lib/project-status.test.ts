import { describe, expect, test } from "vitest";
import {
  getProjectStatusBadgeVariant,
  isProjectCompleted,
  PROJECT_STATUS,
} from "./project-status";

describe("pemetaan status proyek", () => {
  test("menonjolkan hanya proyek BERJALAN sebagai aktif", () => {
    expect(getProjectStatusBadgeVariant(PROJECT_STATUS.ACTIVE)).toBe("default");
    expect(getProjectStatusBadgeVariant(PROJECT_STATUS.PREPARATION)).toBe("secondary");
    expect(getProjectStatusBadgeVariant(PROJECT_STATUS.COMPLETED)).toBe("secondary");
  });

  test("menganggap hanya status SELESAI sebagai proyek selesai", () => {
    expect(isProjectCompleted(PROJECT_STATUS.COMPLETED)).toBe(true);
    expect(isProjectCompleted(PROJECT_STATUS.ACTIVE)).toBe(false);
    expect(isProjectCompleted(PROJECT_STATUS.PREPARATION)).toBe(false);
  });
});