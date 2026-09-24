import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import fontkit from "@pdf-lib/fontkit"
import type { RabComparisonRow, RabComparisonVersion } from "./rab-comparison-export"
import { getRabComparisonRows, getRabComparisonFilename } from "./rab-comparison-export"
import fontUrl from "../assets/DejaVuSans.ttf?url"

const WIDTH = 841.89
const HEIGHT = 595.28
const LEFT = 36
const RIGHT = WIDTH - LEFT
const TABLE_TOP = 411
const HEADER_HEIGHT = 26
const BOTTOM = 61
const COLS = [36, 103, 170, 368, 458, 616, 806]
const dark = rgb(0.11, 0.18, 0.27)
const muted = rgb(0.35, 0.40, 0.46)
const line = rgb(0.81, 0.84, 0.88)

function money(value: number) {
  return `Rp ${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(value)}`
}

function quantity(value: number, unit: string) {
  return `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 }).format(value)} ${unit}`
}

function fitLines(value: string, font: PDFFont, size: number, maxWidth: number) {
  const result: string[] = []
  for (const paragraph of value.split(/\r?\n/)) {
    let current = ""
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue
      const candidate = current ? `${current} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate
      } else {
        if (current) result.push(current)
        current = ""
        for (const character of word) {
          if (current && font.widthOfTextAtSize(current + character, size) > maxWidth) {
            result.push(current)
            current = ""
          }
          current += character
        }
      }
    }
    result.push(current)
  }
  return result
}

function text(page: PDFPage, value: string, x: number, y: number, font: PDFFont, size = 9, color = dark) {
  page.drawText(value, { x, y, font, size, color })
}

function cellLines(page: PDFPage, values: string[], x: number, top: number, font: PDFFont, size = 8) {
  let y = top - 14
  for (const value of values) {
    text(page, value, x + 6, y, font, size)
    y -= 11
  }
}

function rowValues(row: RabComparisonRow, font: PDFFont) {
  const description = row.from?.name === row.to?.name
    ? [row.to?.name ?? row.from?.name ?? ""]
    : [
        ...(row.from ? [`Awal: ${row.from.name}`] : []),
        ...(row.to ? [`Akhir: ${row.to.name}`] : []),
      ]
  const cells = [
    [row.status === "ADDED" ? "BARU" : row.status === "REMOVED" ? "DIHAPUS" : "BERUBAH"],
    [row.code],
    description,
    [`Awal: ${row.from ? quantity(row.from.quantity, row.from.unit) : "—"}`, `Akhir: ${row.to ? quantity(row.to.quantity, row.to.unit) : "—"}`],
    [`Awal: ${row.from ? money(row.from.unitPrice) : "—"}`, `Akhir: ${row.to ? money(row.to.unitPrice) : "—"}`],
    [`Awal: ${row.from ? money(row.from.budget) : "—"}`, `Akhir: ${row.to ? money(row.to.budget) : "—"}`],
  ]
  return cells.map((values, i) => values.flatMap((value) => fitLines(value, font, 8, COLS[i + 1] - COLS[i] - 12)))
}

function drawHeader(page: PDFPage, font: PDFFont, from: RabComparisonVersion, to: RabComparisonVersion, projectName?: string) {
  text(page, "BUKTI PERBANDINGAN RAB", LEFT, 553, font, 17)
  const projectLines = fitLines(`Proyek: ${projectName || from.projectId}`, font, 10, RIGHT - LEFT)
  projectLines.slice(0, 2).forEach((value, i) => text(page, value, LEFT, 529 - i * 13, font, 10))
  if (projectName) text(page, `ID Proyek: ${from.projectId}`, LEFT, 503, font, 9, muted)
  text(page, `Versi awal: v${from.version}.0 (${from.status})    |    Versi pembanding: v${to.version}.0 (${to.status})`, LEFT, 486, font, 9)
  page.drawLine({ start: { x: LEFT, y: 474 }, end: { x: RIGHT, y: 474 }, color: line })
  text(page, `Total awal: ${money(from.totalBudget)}`, LEFT, 454, font, 9)
  text(page, `Total pembanding: ${money(to.totalBudget)}`, 299, 454, font, 9)
  text(page, `Perubahan: ${money(to.totalBudget - from.totalBudget)}`, 565, 454, font, 9)
  text(page, "Rincian item berubah, baru, dan dihapus (IDR)", LEFT, 429, font, 9)
  page.drawRectangle({ x: LEFT, y: TABLE_TOP - HEADER_HEIGHT, width: RIGHT - LEFT, height: HEADER_HEIGHT, color: rgb(0.91, 0.94, 0.97) })
  ;["Status", "Kode", "Item RAB", "Kuantitas", "Harga satuan", "Total"].forEach((label, i) => {
    text(page, label, COLS[i] + 6, TABLE_TOP - 16, font, 8)
  })
}

function drawSignatures(page: PDFPage, font: PDFFont, y: number) {
  text(page, "Diperiksa oleh,", 83, y, font)
  text(page, "Disetujui oleh,", 493, y, font)
  page.drawLine({ start: { x: 83, y: y - 57 }, end: { x: 300, y: y - 57 }, color: dark })
  page.drawLine({ start: { x: 493, y: y - 57 }, end: { x: 710, y: y - 57 }, color: dark })
  text(page, "Nama / tanggal", 83, y - 70, font, 8, muted)
  text(page, "Nama / tanggal", 493, y - 70, font, 8, muted)
}

export async function buildRabComparisonPdf(
  from: RabComparisonVersion,
  to: RabComparisonVersion,
  fontBytes: Uint8Array,
  projectName?: string,
): Promise<Uint8Array> {
  if (from.projectId !== to.projectId || from.version === to.version) {
    throw new Error("Versi perbandingan RAB tidak valid.")
  }
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(fontBytes, { subset: true })
  pdf.setTitle(`Perbandingan RAB ${from.projectId} v${from.version} ke v${to.version}`)
  let page = pdf.addPage([WIDTH, HEIGHT])
  drawHeader(page, font, from, to, projectName)
  let top = TABLE_TOP - HEADER_HEIGHT
  const rows = getRabComparisonRows(from, to)
  if (!rows.length) text(page, "Tidak ada perubahan item pada kedua versi.", LEFT + 6, top - 20, font)
  for (const row of rows) {
    const cells = rowValues(row, font)
    let offset = 0
    const maxLines = Math.max(...cells.map((values) => values.length))
    do {
      let available = Math.floor((top - BOTTOM - 9) / 11)
      if (available < 3) {
        page = pdf.addPage([WIDTH, HEIGHT])
        drawHeader(page, font, from, to, projectName)
        top = TABLE_TOP - HEADER_HEIGHT
        available = Math.floor((top - BOTTOM - 9) / 11)
      }
      const count = Math.min(maxLines - offset, available)
      cells.forEach((values, i) => cellLines(page, values.slice(offset, offset + count), COLS[i], top, font))
      top -= Math.max(36, count * 11 + 9)
      page.drawLine({ start: { x: LEFT, y: top }, end: { x: RIGHT, y: top }, color: line, thickness: 0.5 })
      offset += count
    } while (offset < maxLines)
  }
  if (top < 170) {
    page = pdf.addPage([WIDTH, HEIGHT])
    text(page, "PENGESAHAN PERBANDINGAN RAB", LEFT, 540, font, 14)
    text(page, `Proyek: ${from.projectId}    |    v${from.version}.0 ke v${to.version}.0`, LEFT, 517, font, 9)
    top = 460
  }
  drawSignatures(page, font, top - 35)
  pdf.getPages().forEach((sheet, index) => {
    text(sheet, `Perbandingan RAB • ${from.projectId} • Halaman ${index + 1} / ${pdf.getPageCount()}`, LEFT, 26, font, 8, muted)
  })
  return pdf.save()
}

export async function downloadRabComparisonPdf(from: RabComparisonVersion, to: RabComparisonVersion, projectName?: string) {
  const response = await fetch(fontUrl)
  if (!response.ok) throw new Error("Font dokumen PDF tidak dapat dimuat.")
  const bytes = await buildRabComparisonPdf(from, to, new Uint8Array(await response.arrayBuffer()), projectName)
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }))
  const link = document.createElement("a")
  link.href = url
  link.download = getRabComparisonFilename(from.projectId, from.version, to.version).replace(/\.csv$/, ".pdf")
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}