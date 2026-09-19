import { describe, expect, it } from "vitest"
import { getJakartaCalendarDate } from "./indonesia-date"

describe("getJakartaCalendarDate", () => {
  it("uses the previous Jakarta calendar day immediately before midnight WIB", () => {
    const date = new Date("2026-09-18T16:59:59.999Z")

    expect(getJakartaCalendarDate(date)).toBe("2026-09-18")
  })

  it("advances to the Jakarta calendar day when UTC is still on the previous day", () => {
    const date = new Date("2026-09-18T17:00:00.000Z")

    expect(date.toISOString().slice(0, 10)).toBe("2026-09-18")
    expect(getJakartaCalendarDate(date)).toBe("2026-09-19")
  })
})