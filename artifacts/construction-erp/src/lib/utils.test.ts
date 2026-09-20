import { describe, expect, it } from "vitest"
import { formatDate } from "./utils"

describe("formatDate", () => {
  it("keeps a calendar-only invoice date on the same day", () => {
    expect(formatDate("2026-09-18")).toBe("18 Sep 2026")
  })

  it("uses the previous Indonesian calendar day immediately before midnight WIB", () => {
    expect(formatDate("2026-09-18T16:59:59.999Z")).toBe("18 Sep 2026")
  })

  it("advances at midnight WIB even while UTC is on the previous day", () => {
    expect(formatDate("2026-09-18T17:00:00.000Z")).toBe("19 Sep 2026")
  })
})