// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import Invoices from "./Invoices"

const mutateInvoice = vi.fn()

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>()
  return {
    ...original,
    useListInvoices: () => ({ data: [], isLoading: false }),
    useListProjects: () => ({
      data: [{ id: "project-1", code: "PRJ-001", name: "Proyek Jakarta", status: "BERJALAN" }],
    }),
    useCreateInvoice: () => ({ mutate: mutateInvoice, isPending: false }),
    useDecideInvoice: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

vi.mock("@/lib/access", () => ({
  useAccess: () => ({ permissions: ["invoices:write"] }),
  hasPermission: (access: { permissions: string[] }, permission: string) =>
    access.permissions.includes(permission),
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
  }) => createElement(
    "select",
    {
      value,
      onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
    },
    children,
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => children,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) =>
    createElement("option", { value }, children),
}))

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Invoices),
    ),
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-09-19T17:30:00.000Z"))
  mutateInvoice.mockReset()
  mutateInvoice.mockImplementation((_variables, options) => options.onSuccess())
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("form invoice", () => {
  test("mengirim tanggal pilihan pengguna lalu kembali ke tanggal kalender Jakarta setelah berhasil", () => {
    renderPage()

    fireEvent.click(screen.getByRole("button", { name: "Create Invoice" }))

    const dateInput = screen.getByLabelText("Invoice Date")
    expect(dateInput).toHaveProperty("value", "2026-09-20")

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "project-1" } })
    fireEvent.change(screen.getByLabelText("Billing Period (Termin)"), {
      target: { value: "Termin 1" },
    })
    fireEvent.change(screen.getByLabelText("Gross Progress Value (IDR)"), {
      target: { value: "1000000" },
    })
    fireEvent.change(dateInput, { target: { value: "2026-09-18" } })
    fireEvent.click(screen.getByRole("button", { name: "Generate Invoice" }))

    expect(mutateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "project-1",
          issuedAt: "2026-09-18",
        }),
      }),
      expect.any(Object),
    )

    fireEvent.click(screen.getByRole("button", { name: "Create Invoice" }))
    expect(screen.getByLabelText("Invoice Date")).toHaveProperty("value", "2026-09-20")
  })
})