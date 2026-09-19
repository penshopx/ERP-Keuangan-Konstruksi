// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement } from "react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ImportTemplateSheet } from "./ImportTemplateSheet"

const template = {
  id: "template-rumah",
  name: "Rumah Tinggal Standar",
  projectType: "Residensial",
  description: "Template pekerjaan rumah tinggal.",
  itemCount: 12,
  totalBudget: 1_000_000,
  sourceNote: "Harga referensi pengujian",
}

const mutate = vi.fn()
const toast = vi.fn()

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>()
  return {
    ...original,
    useListRabTemplates: () => ({ data: [template], isLoading: false }),
    useImportProjectRabTemplate: () => ({ mutate, isPending: false }),
  }
})

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}))

vi.mock("@/components/ui/sheet", async () => {
  const { cloneElement, createContext, useContext } = await import("react")
  const SheetContext = createContext<{
    open: boolean
    onOpenChange: (open: boolean) => void
  } | null>(null)

  return {
    Sheet: ({
      children,
      open,
      onOpenChange,
    }: {
      children: ReactNode
      open: boolean
      onOpenChange: (open: boolean) => void
    }) => createElement(
      SheetContext.Provider,
      { value: { open, onOpenChange } },
      children,
    ),
    SheetTrigger: ({ children }: { children: ReactNode }) => {
      const context = useContext(SheetContext)
      return cloneElement(children as React.ReactElement<{ onClick?: () => void }>, {
        onClick: () => context?.onOpenChange(true),
      })
    },
    SheetContent: ({ children }: { children: ReactNode }) => {
      const context = useContext(SheetContext)
      return context?.open ? children : null
    },
    SheetHeader: ({ children }: { children: ReactNode }) => children,
    SheetTitle: ({ children }: { children: ReactNode }) => createElement("h2", null, children),
    SheetDescription: ({ children }: { children: ReactNode }) => createElement("p", null, children),
    SheetFooter: ({ children }: { children: ReactNode }) => children,
  }
})

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    defaultValue,
    onValueChange,
  }: {
    children: ReactNode
    defaultValue?: string
    onValueChange: (value: string) => void
  }) => createElement(
    "select",
    {
      "aria-label": "Pilih Template Standar",
      defaultValue,
      onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
    },
    createElement("option", { value: "" }, "Pilih template"),
    children,
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    createElement("option", { value }, children)
  ),
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}))

function renderSheet() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ImportTemplateSheet, {
        projectId: "project-1",
        currentTotal: 900_000,
      }),
    ),
  )
}

async function fillAndSubmit(priceFactor = "1.25") {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Impor Template RAB" }))
  await user.selectOptions(screen.getByLabelText("Pilih Template Standar"), template.id)

  const factorInput = screen.getByLabelText("Penyesuaian Harga (Multiplier)")
  await user.clear(factorInput)
  await user.type(factorInput, priceFactor)
  await user.click(screen.getByRole("button", { name: "Terapkan Draft WBS" }))
}

beforeEach(() => {
  mutate.mockReset()
  toast.mockReset()
})

afterEach(() => {
  cleanup()
})

describe("impor template RAB", () => {
  test("mempertahankan template dan faktor harga saat mencoba lagi setelah respons 503 retryable", async () => {
    mutate
      .mockImplementationOnce((_variables, options) => {
        options.onError({
          status: 503,
          data: { retryable: true },
          message: "HTTP 503 Service Unavailable",
        })
      })
      .mockImplementationOnce((_variables, options) => options.onSuccess())

    renderSheet()
    await fillAndSubmit()

    expect(screen.getByText("Impor RAB sedang sibuk")).toBeTruthy()
    expect(screen.getByText(/template dan faktor harga yang sama/)).toBeTruthy()

    const retryButton = screen.getByRole("button", { name: "Coba Lagi" })
    await userEvent.setup().click(retryButton)

    const expectedVariables = {
      projectId: "project-1",
      data: {
        templateId: template.id,
        priceFactor: 1.25,
      },
    }
    expect(mutate).toHaveBeenNthCalledWith(1, expectedVariables, expect.any(Object))
    expect(mutate).toHaveBeenNthCalledWith(2, expectedVariables, expect.any(Object))
    await waitFor(() => {
      expect(screen.queryByText("Impor Template RAB Baru")).toBeNull()
    })
  })

  test("menampilkan error non-retryable sebagai kegagalan biasa tanpa tombol coba lagi", async () => {
    mutate.mockImplementationOnce((_variables, options) => {
      options.onError({
        status: 400,
        data: { retryable: false },
        message: "Template tidak valid",
      })
    })

    renderSheet()
    await fillAndSubmit()

    expect(toast).toHaveBeenCalledWith({
      title: "Gagal Mengimpor",
      description: "Template tidak valid",
      variant: "destructive",
    })
    expect(screen.queryByRole("button", { name: "Coba Lagi" })).toBeNull()
    expect(screen.getByRole("button", { name: "Terapkan Draft WBS" })).toBeTruthy()
  })

  test("menutup dan mereset form setelah impor berhasil", async () => {
    mutate.mockImplementationOnce((_variables, options) => options.onSuccess())

    renderSheet()
    await fillAndSubmit("1.4")

    await waitFor(() => {
      expect(screen.queryByText("Impor Template RAB Baru")).toBeNull()
    })

    await userEvent.setup().click(screen.getByRole("button", { name: "Impor Template RAB" }))

    expect(screen.getByLabelText("Pilih Template Standar")).toHaveProperty("value", "")
    expect(screen.getByLabelText("Penyesuaian Harga (Multiplier)")).toHaveProperty("value", "1")
  })
})