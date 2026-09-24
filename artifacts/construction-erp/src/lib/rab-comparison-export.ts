export type RabComparisonItem = {
  code: string
  name: string
  unit: string
  quantity: number
  unitPrice: number
  budget: number
}

export type RabComparisonVersion = {
  projectId: string
  version: number
  status: string
  totalBudget: number
  items: RabComparisonItem[]
}

export type RabComparisonRow = {
  code: string
  from?: RabComparisonItem
  to?: RabComparisonItem
  status: "ADDED" | "REMOVED" | "CHANGED"
}

const STATUS_LABELS: Record<RabComparisonRow["status"], string> = {
  ADDED: "BARU",
  REMOVED: "DIHAPUS",
  CHANGED: "BERUBAH",
}

function csvCell(value: string | number) {
  const rawText = String(value)
  const text = typeof value === "string" && /^[=+\-@]/.test(rawText) ? `'${rawText}` : rawText
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function csvRow(values: Array<string | number>) {
  return values.map(csvCell).join(",")
}

export function getRabComparisonRows(
  fromVersion: RabComparisonVersion,
  toVersion: RabComparisonVersion,
): RabComparisonRow[] {
  const fromByCode = new Map(fromVersion.items.map((item) => [item.code, item]))
  const toByCode = new Map(toVersion.items.map((item) => [item.code, item]))

  return Array.from(new Set([...fromByCode.keys(), ...toByCode.keys()]))
    .sort()
    .map((code): RabComparisonRow | null => {
      const from = fromByCode.get(code)
      const to = toByCode.get(code)
      const status = !from
        ? "ADDED"
        : !to
          ? "REMOVED"
          : (
              from.quantity !== to.quantity ||
              from.unitPrice !== to.unitPrice ||
              from.budget !== to.budget ||
              from.name !== to.name ||
              from.unit !== to.unit
            )
            ? "CHANGED"
            : null

      return status ? { code, from, to, status } : null
    })
    .filter((row): row is RabComparisonRow => row !== null)
}

export function buildRabComparisonCsv(
  fromVersion: RabComparisonVersion,
  toVersion: RabComparisonVersion,
  rows = getRabComparisonRows(fromVersion, toVersion),
) {
  const lines = [
    csvRow(["PERBANDINGAN VERSI RAB"]),
    csvRow(["ID Proyek", fromVersion.projectId]),
    csvRow(["Versi awal", `v${fromVersion.version}.0`, "Status", fromVersion.status]),
    csvRow(["Versi pembanding", `v${toVersion.version}.0`, "Status", toVersion.status]),
    csvRow(["Total versi awal (IDR)", fromVersion.totalBudget]),
    csvRow(["Total versi pembanding (IDR)", toVersion.totalBudget]),
    csvRow(["Perubahan total (IDR)", toVersion.totalBudget - fromVersion.totalBudget]),
    "",
    csvRow([
      "Status",
      "Kode",
      "Nama sebelum",
      "Nama sesudah",
      "Satuan sebelum",
      "Satuan sesudah",
      "Kuantitas sebelum",
      "Kuantitas sesudah",
      "Harga satuan sebelum (IDR)",
      "Harga satuan sesudah (IDR)",
      "Total sebelum (IDR)",
      "Total sesudah (IDR)",
    ]),
    ...rows.map(({ status, code, from, to }) => csvRow([
      STATUS_LABELS[status],
      code,
      from?.name ?? "",
      to?.name ?? "",
      from?.unit ?? "",
      to?.unit ?? "",
      from?.quantity ?? "",
      to?.quantity ?? "",
      from?.unitPrice ?? "",
      to?.unitPrice ?? "",
      from?.budget ?? "",
      to?.budget ?? "",
    ])),
  ]

  return `\uFEFF${lines.join("\r\n")}\r\n`
}

export function getRabComparisonFilename(projectId: string, fromVersion: number, toVersion: number) {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]+/g, "-")
  return `perbandingan-rab-${safeProjectId}-v${fromVersion}-ke-v${toVersion}.csv`
}

export async function downloadRabComparisonCsv(
  fromVersion: RabComparisonVersion,
  toVersion: RabComparisonVersion,
  beforeDownload: () => Promise<void>,
) {
  const csv = buildRabComparisonCsv(fromVersion, toVersion)
  await beforeDownload()
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  link.download = getRabComparisonFilename(fromVersion.projectId, fromVersion.version, toVersion.version)
  link.click()
  URL.revokeObjectURL(url)
}