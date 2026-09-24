import { readFile } from "node:fs/promises"
import { PDFDocument } from "pdf-lib"
import { describe, expect, test } from "vitest"
import { buildRabComparisonPdf } from "./rab-comparison-pdf"
import type { RabComparisonVersion } from "./rab-comparison-export"

const fontPath = "src/assets/DejaVuSans.ttf"
const from: RabComparisonVersion = {
  projectId: "proyek-1",
  version: 1,
  status: "DISETUJUI",
  totalBudget: 1_100_000,
  items: [
    { code: "A.1", name: "Pekerjaan beton", unit: "m³", quantity: 10, unitPrice: 100_000, budget: 1_000_000 },
    { code: "B.1", name: "Dihapus", unit: "ls", quantity: 1, unitPrice: 100_000, budget: 100_000 },
  ],
}
const to: RabComparisonVersion = {
  projectId: "proyek-1",
  version: 2,
  status: "DRAF",
  totalBudget: 1_700_000,
  items: [
    { code: "A.1", name: "Beton struktur", unit: "m³", quantity: 12, unitPrice: 100_000, budget: 1_200_000 },
    { code: "C.1", name: "Item baru", unit: "ls", quantity: 1, unitPrice: 500_000, budget: 500_000 },
  ],
}

describe("PDF perbandingan RAB", () => {
  test("menghasilkan PDF A4 landscape dengan identitas dan metadata versi", async () => {
    const bytes = await buildRabComparisonPdf(from, to, new Uint8Array(await readFile(fontPath)), "Proyek Contoh")
    const pdf = await PDFDocument.load(bytes)

    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe("%PDF-1.7")
    expect(pdf.getTitle()).toContain("proyek-1 v1 ke v2")
    expect(pdf.getPageCount()).toBe(1)
    expect(pdf.getPage(0).getSize().width).toBeGreaterThan(840)
    expect(pdf.getPage(0).getSize().height).toBeLessThan(600)
  })

  test("memindahkan rincian ke halaman baru tanpa kehilangan halaman tanda tangan", async () => {
    const many = {
      ...to,
      items: Array.from({ length: 75 }, (_, i) => ({
        code: `C.${i}`,
        name: `Pekerjaan lantai gedung ${i} dengan keterangan panjang yang tetap harus terbaca`,
        unit: "m²",
        quantity: 10 + i,
        unitPrice: 500_000,
        budget: (10 + i) * 500_000,
      })),
    }
    const bytes = await buildRabComparisonPdf(from, many, new Uint8Array(await readFile(fontPath)))
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBeGreaterThan(2)
    expect(pdf.getPages().every((page) => page.getSize().width > page.getSize().height)).toBe(true)
  })

  test("membagi uraian item yang sangat panjang antarhalaman", async () => {
    const longVersion = {
      ...to,
      items: [{ ...to.items[0], name: "Uraian pekerjaan struktur ".repeat(140) }],
    }
    const pdf = await PDFDocument.load(await buildRabComparisonPdf({ ...from, items: [] }, longVersion, new Uint8Array(await readFile(fontPath))))
    expect(pdf.getPageCount()).toBeGreaterThan(1)
  })

  test("menolak perbandingan lintas proyek atau versi identik", async () => {
    const font = new Uint8Array(await readFile(fontPath))
    await expect(buildRabComparisonPdf(from, { ...to, projectId: "lain" }, font)).rejects.toThrow()
    await expect(buildRabComparisonPdf(from, { ...to, version: 1 }, font)).rejects.toThrow()
  })
})