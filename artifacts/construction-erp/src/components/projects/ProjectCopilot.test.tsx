// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement } from "react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ProjectCopilot } from "./ProjectCopilot"

const { askProjectCopilot } = vi.hoisted(() => ({
  askProjectCopilot: vi.fn(),
}))

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>()
  return { ...original, askProjectCopilot }
})

vi.mock("wouter", () => ({
  Link: ({ children, ...props }: { children: ReactNode; href: string }) => createElement("a", props, children),
}))

afterEach(() => {
  cleanup()
  askProjectCopilot.mockReset()
})

describe("ProjectCopilot", () => {
  test("mengunci pertanyaan ke proyek aktif dan membuka citation record", async () => {
    const user = userEvent.setup()
    askProjectCopilot.mockResolvedValue({
      answer: "invoices: 1 record ditemukan.",
      tool: "invoices",
      result: [],
      sources: [{ source: "invoices", id: "invoice-123456789" }],
    })
    render(<ProjectCopilot projectId="project-aktif" projectName="Gedung Utama" />)

    await user.type(screen.getByTestId("input-copilot-question"), "Ringkas invoice proyek ini")
    await user.click(screen.getByTestId("button-ask-copilot"))

    await waitFor(() => expect(askProjectCopilot).toHaveBeenCalledWith({
      projectId: "project-aktif",
      prompt: "Ringkas invoice proyek ini",
    }))
    expect(screen.getByTestId("text-copilot-answer").textContent).toContain("1 record")

    await user.click(screen.getByTestId("button-citation-0"))
    expect(screen.getByTestId("dialog-copilot-citation").textContent).toContain("invoice-123456789")
    expect(screen.getByTestId("link-open-citation-record").getAttribute("href")).toBe("/portal/invoices?projectId=project-aktif")
  })

  test("menampilkan loading dan penolakan izin secara jelas", async () => {
    const user = userEvent.setup()
    let rejectRequest: (reason: unknown) => void = () => undefined
    askProjectCopilot.mockReturnValue(new Promise((_resolve, reject) => {
      rejectRequest = reject
    }))
    render(<ProjectCopilot projectId="project-aktif" projectName="Gedung Utama" />)

    await user.type(screen.getByTestId("input-copilot-question"), "Tampilkan audit")
    await user.click(screen.getByTestId("button-ask-copilot"))
    expect(screen.getByTestId("button-ask-copilot").textContent).toContain("Menganalisis")

    rejectRequest({ status: 403, data: { error: "Jabatan Anda tidak memiliki hak untuk tool ini" } })

    await waitFor(() => expect(screen.getByTestId("status-copilot-error").textContent).toContain("Akses ditolak"))
    expect(screen.getByTestId("status-copilot-error").textContent).toContain("tidak memiliki hak")
  })

  test("menjelaskan kuota tercapai tanpa menampilkan jawaban palsu", async () => {
    const user = userEvent.setup()
    askProjectCopilot.mockRejectedValue({
      status: 429, data: { error: "Kuota harian copilot untuk proyek ini telah tercapai. Coba lagi besok (UTC)." },
    })
    render(<ProjectCopilot projectId="project-aktif" projectName="Gedung Utama" />)
    await user.type(screen.getByTestId("input-copilot-question"), "Ringkas invoice")
    await user.click(screen.getByTestId("button-ask-copilot"))
    await waitFor(() => expect(screen.getByTestId("status-copilot-error").textContent).toContain("Kuota copilot tercapai"))
    expect(screen.getByTestId("status-copilot-error").textContent).toContain("besok (UTC)")
    expect(screen.queryByTestId("text-copilot-answer")).toBeNull()
  })

  test("menghapus jawaban lama saat pertanyaan berikutnya gagal", async () => {
    const user = userEvent.setup()
    askProjectCopilot
      .mockResolvedValueOnce({
        answer: "Jawaban lama",
        tool: "project_context",
        result: {},
        sources: [],
      })
      .mockRejectedValueOnce({ status: 504, data: { error: "Waktu tunggu copilot habis" } })
    render(<ProjectCopilot projectId="project-aktif" projectName="Gedung Utama" />)

    await user.type(screen.getByTestId("input-copilot-question"), "Detail proyek")
    await user.click(screen.getByTestId("button-ask-copilot"))
    await waitFor(() => expect(screen.getByTestId("text-copilot-answer").textContent).toContain("Jawaban lama"))

    await user.clear(screen.getByTestId("input-copilot-question"))
    await user.type(screen.getByTestId("input-copilot-question"), "Detail proyek terbaru")
    await user.click(screen.getByTestId("button-ask-copilot"))

    await waitFor(() => expect(screen.getByTestId("status-copilot-error").textContent).toContain("Waktu tunggu habis"))
    expect(screen.queryByTestId("text-copilot-answer")).toBeNull()
  })
})