// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement } from "react"
import type { ReactNode } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import ProjectRab from "./ProjectRab"
import { downloadRabComparisonPdf } from "@/lib/rab-comparison-pdf"
import { recordRabComparisonDownload } from "@workspace/api-client-react"

vi.mock("@/lib/rab-comparison-pdf", () => ({
  downloadRabComparisonPdf: vi.fn().mockImplementation(
    async (_from, _to, _name, beforeDownload: () => Promise<void>) => beforeDownload(),
  ),
}))

const latestRab = {
  projectId: "project-1",
  version: 2,
  status: "DRAF",
  totalBudget: 2_000_000,
  committed: 0,
  actual: 0,
  remaining: 2_000_000,
  items: [
    { id: "new-1", code: "A.1", name: "Pekerjaan lama", category: "Struktur", parentCode: null, level: 0, unit: "m2", quantity: 12, unitPrice: 125_000, materialCost: 0, laborCost: 0, equipmentCost: 0, budget: 1_500_000, committed: 0, actual: 0, variance: 1_500_000, utilization: 0 },
    { id: "new-2", code: "C.1", name: "Item baru", category: "Arsitektur", parentCode: null, level: 0, unit: "ls", quantity: 1, unitPrice: 500_000, materialCost: 0, laborCost: 0, equipmentCost: 0, budget: 500_000, committed: 0, actual: 0, variance: 500_000, utilization: 0 },
  ],
}

const historicalRab = {
  ...latestRab,
  version: 1,
  totalBudget: 1_000_000,
  remaining: 1_000_000,
  items: [
    { id: "old-1", code: "A.1", name: "Pekerjaan lama", category: "Struktur", parentCode: null, level: 0, unit: "m2", quantity: 10, unitPrice: 100_000, materialCost: 0, laborCost: 0, equipmentCost: 0, budget: 1_000_000, committed: 0, actual: 0, variance: 1_000_000, utilization: 0 },
    { id: "old-2", code: "B.1", name: "Item dihapus", category: "Struktur", parentCode: null, level: 0, unit: "ls", quantity: 1, unitPrice: 100_000, materialCost: 0, laborCost: 0, equipmentCost: 0, budget: 100_000, committed: 0, actual: 0, variance: 100_000, utilization: 0 },
  ],
}

vi.mock("wouter", () => ({
  useParams: () => ({ id: "project-1" }),
  Link: ({ children, ...props }: { children: ReactNode; href: string }) => createElement("a", props, children),
}))

vi.mock("@/components/rab/ImportTemplateSheet", () => ({
  ImportTemplateSheet: () => createElement("button", { "data-testid": "button-import-rab" }, "Impor Template RAB"),
}))

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode
    value: string
    onValueChange: (value: string) => void
  }) => createElement("select", {
    value,
    onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
    "data-testid": "select-rab-version",
  }, children),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, value, ...props }: { children: ReactNode; value: string }) => (
    createElement("option", { ...props, value }, children)
  ),
}))

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>()
  return {
    ...original,
    useGetProject: () => ({ data: { id: "project-1", name: "Proyek Contoh" }, isLoading: false, isError: false }),
    useGetProjectRab: () => ({ data: latestRab, isLoading: false, isError: false }),
    useListProjectRabVersions: () => ({
      data: [
        { version: 2, status: "DRAF", createdAt: "2026-09-16T10:00:00.000Z", updatedAt: "2026-09-16T10:00:00.000Z" },
        { version: 1, status: "DRAF", createdAt: "2026-09-15T10:00:00.000Z", updatedAt: "2026-09-15T10:00:00.000Z" },
      ],
      isLoading: false,
      isError: false,
    }),
    useGetProjectRabVersion: (_projectId: string, version: number) => ({ data: version === 1 ? historicalRab : latestRab, isLoading: false, isError: false }),
    recordRabComparisonDownload: vi.fn().mockResolvedValue({}),
    useListProjectCommitments: () => ({ data: [], isLoading: false, isError: false }),
  }
})


beforeAll(() => {
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.setPointerCapture = () => undefined
  HTMLElement.prototype.releasePointerCapture = () => undefined
  HTMLElement.prototype.scrollIntoView = () => undefined
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(recordRabComparisonDownload).mockResolvedValue({} as never)
  window.history.replaceState({}, "", "/portal/projects/project-1/rab")
  URL.createObjectURL = vi.fn(() => "blob:rab-comparison")
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
})

describe("riwayat versi RAB", () => {
  test("membuka versi lama sebagai hanya-baca dan kembali ke versi terbaru", async () => {
    const user = userEvent.setup()
    render(createElement(ProjectRab))

    expect(screen.getByTestId("text-rab-total-budget").textContent).toContain("2.000.000")
    expect(screen.getByTestId("button-import-rab")).toBeTruthy()

    await user.selectOptions(screen.getByTestId("select-rab-version"), "1")

    expect(window.location.search).toBe("?rabVersion=1")
    expect(screen.getByTestId("alert-rab-historical")).toBeTruthy()
    expect(screen.getByText("Anda sedang melihat RAB v1.0. Versi aktif proyek tidak berubah.")).toBeTruthy()
    expect(screen.getByTestId("text-rab-total-budget").textContent).toContain("1.000.000")
    expect(screen.queryByTestId("button-import-rab")).toBeNull()

    await user.click(screen.getByTestId("button-rab-return-latest"))

    expect(window.location.search).toBe("")
    expect(screen.queryByTestId("alert-rab-historical")).toBeNull()
    expect(screen.getByTestId("text-rab-total-budget").textContent).toContain("2.000.000")
    expect(screen.getByTestId("button-import-rab")).toBeTruthy()
  })

  test("membandingkan item berubah, baru, dihapus, dan total dua versi", async () => {
    const user = userEvent.setup()
    render(createElement(ProjectRab))

    await user.click(screen.getByTestId("button-compare-rab-versions"))

    expect(window.location.search).toBe("?compareFrom=1&compareTo=2")
    expect(screen.getByText("Perbandingan Versi RAB")).toBeTruthy()
    expect(screen.getByTestId("text-rab-comparison-total-delta").textContent).toContain("+Rp")
    expect(screen.getByTestId("row-rab-comparison-A.1").textContent).toContain("BERUBAH")
    expect(screen.getByTestId("row-rab-comparison-A.1").textContent).toContain("10")
    expect(screen.getByTestId("row-rab-comparison-A.1").textContent).toContain("12")
    expect(screen.getByTestId("row-rab-comparison-B.1").textContent).toContain("DIHAPUS")
    expect(screen.getByTestId("row-rab-comparison-C.1").textContent).toContain("BARU")
    expect(screen.getByTestId("button-download-rab-comparison")).not.toHaveProperty("disabled", true)
    expect(screen.getByTestId("button-download-rab-comparison-pdf")).not.toHaveProperty("disabled", true)
  })

  test("memulihkan pasangan perbandingan dari URL yang dapat dibagikan", async () => {
    window.history.replaceState({}, "", "/portal/projects/project-1/rab?compareFrom=1&compareTo=2")

    render(createElement(ProjectRab))

    expect(await screen.findByText("Perbandingan Versi RAB")).toBeTruthy()
    expect(screen.getByTestId("row-rab-comparison-A.1")).toBeTruthy()
  })

  test("mengunduh PDF dari versi yang terlihat dengan identitas proyek", async () => {
    const user = userEvent.setup()
    render(createElement(ProjectRab))
    await user.click(screen.getByTestId("button-compare-rab-versions"))
    await user.click(screen.getByTestId("button-download-rab-comparison-pdf"))
    await waitFor(() => expect(downloadRabComparisonPdf).toHaveBeenCalledWith(historicalRab, latestRab, "Proyek Contoh", expect.any(Function)))
    expect(recordRabComparisonDownload).toHaveBeenCalledWith("project-1", {
      fromVersion: 1, toVersion: 2, format: "PDF",
    })
  })

  test("CSV hanya diunduh sesudah audit berhasil; kegagalan audit tidak membuat berkas", async () => {
    const user = userEvent.setup()
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    render(createElement(ProjectRab))
    await user.click(screen.getByTestId("button-compare-rab-versions"))
    vi.mocked(recordRabComparisonDownload).mockRejectedValueOnce(new Error("Audit unavailable"))
    await user.click(screen.getByTestId("button-download-rab-comparison"))
    await waitFor(() => expect(recordRabComparisonDownload).toHaveBeenCalledWith("project-1", {
      fromVersion: 1, toVersion: 2, format: "CSV",
    }))
    await waitFor(() => expect(screen.getByTestId("button-download-rab-comparison").hasAttribute("disabled")).toBe(false))
    expect(click).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("button-download-rab-comparison"))
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
    click.mockRestore()
  })

  test("mengabaikan parameter versi yang tidak valid tanpa meminta versi tersebut", async () => {
    window.history.replaceState({}, "", "/portal/projects/project-1/rab?rabVersion=abc&compareFrom=1&compareTo=999")

    render(createElement(ProjectRab))

    await waitFor(() => expect(window.location.search).toBe(""))
    expect(screen.queryByText("Perbandingan Versi RAB")).toBeNull()
    expect(screen.getByTestId("text-rab-total-budget").textContent).toContain("2.000.000")
  })
})