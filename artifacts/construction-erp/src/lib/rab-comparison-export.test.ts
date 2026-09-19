import { describe, expect, test } from "vitest"
import {
  buildRabComparisonCsv,
  getRabComparisonFilename,
  getRabComparisonRows,
  type RabComparisonVersion,
} from "./rab-comparison-export"

const fromVersion: RabComparisonVersion = {
  projectId: "proyek/audit 1",
  version: 1,
  status: "DISETUJUI",
  totalBudget: 1_100_000,
  items: [
    { code: "A.1", name: "Beton, lama", unit: "m3", quantity: 10, unitPrice: 100_000, budget: 1_000_000 },
    { code: "B.1", name: "Dihapus", unit: "ls", quantity: 1, unitPrice: 100_000, budget: 100_000 },
  ],
}

const toVersion: RabComparisonVersion = {
  projectId: "proyek/audit 1",
  version: 2,
  status: "DRAF",
  totalBudget: 1_700_000,
  items: [
    { code: "A.1", name: "Beton, baru", unit: "m3", quantity: 12, unitPrice: 100_000, budget: 1_200_000 },
    { code: "C.1", name: "Baru", unit: "ls", quantity: 1, unitPrice: 500_000, budget: 500_000 },
  ],
}

describe("ekspor perbandingan RAB", () => {
  test("mengelompokkan item berubah, dihapus, dan baru", () => {
    expect(getRabComparisonRows(fromVersion, toVersion).map(({ code, status }) => ({ code, status }))).toEqual([
      { code: "A.1", status: "CHANGED" },
      { code: "B.1", status: "REMOVED" },
      { code: "C.1", status: "ADDED" },
    ])
  })

  test("memuat identitas versi, perubahan total, dan nilai sebelum-sesudah", () => {
    const csv = buildRabComparisonCsv(fromVersion, toVersion)

    expect(csv.startsWith("\uFEFF")).toBe(true)
    expect(csv).toContain("ID Proyek,proyek/audit 1")
    expect(csv).toContain("Versi awal,v1.0,Status,DISETUJUI")
    expect(csv).toContain("Versi pembanding,v2.0,Status,DRAF")
    expect(csv).toContain("Perubahan total (IDR),600000")
    expect(csv).toContain("BERUBAH,A.1,\"Beton, lama\",\"Beton, baru\",m3,m3,10,12,100000,100000,1000000,1200000")
    expect(csv).toContain("DIHAPUS,B.1,Dihapus,,ls,,1,,100000,,100000,")
    expect(csv).toContain("BARU,C.1,,Baru,,ls,,1,,500000,,500000")
  })

  test("membuat nama berkas yang aman", () => {
    expect(getRabComparisonFilename("proyek/audit 1", 1, 2))
      .toBe("perbandingan-rab-proyek-audit-1-v1-ke-v2.csv")
  })

  test("menetralkan teks yang dapat dibaca sebagai formula spreadsheet", () => {
    const riskyVersion = {
      ...toVersion,
      items: [
        { code: "=1+1", name: "@SUM(A1:A2)", unit: "ls", quantity: 1, unitPrice: 1, budget: 1 },
      ],
    }

    const csv = buildRabComparisonCsv({ ...fromVersion, items: [] }, riskyVersion)

    expect(csv).toContain("BARU,'=1+1,,'@SUM(A1:A2)")
    expect(csv).not.toContain("BARU,=1+1,,@SUM(A1:A2)")
  })
})