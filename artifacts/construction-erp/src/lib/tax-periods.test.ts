import { describe, expect, test } from "vitest"
import { formatTaxPeriodLabel, getTaxPeriodOptions } from "./tax-periods"

describe("pilihan periode pajak", () => {
  test("dimulai dari bulan operasional Asia/Jakarta dan memakai format YYYY-MM", () => {
    const periods = getTaxPeriodOptions(new Date("2026-09-30T17:30:00.000Z"))

    expect(periods).toEqual([
      "2026-10",
      "2026-09",
      "2026-08",
      "2026-07",
      "2026-06",
      "2026-05",
    ])
    expect(periods.every(period => /^\d{4}-(0[1-9]|1[0-2])$/.test(period))).toBe(true)
  })

  test("melewati pergantian tahun tanpa daftar bulan tetap", () => {
    expect(getTaxPeriodOptions(new Date("2027-01-15T05:00:00.000Z"), 3)).toEqual([
      "2027-01",
      "2026-12",
      "2026-11",
    ])
  })

  test("menampilkan nama bulan Indonesia tanpa mengubah nilai periode", () => {
    const period = "2026-09"

    expect(formatTaxPeriodLabel(period)).toBe("September 2026")
    expect(period).toBe("2026-09")
  })
})