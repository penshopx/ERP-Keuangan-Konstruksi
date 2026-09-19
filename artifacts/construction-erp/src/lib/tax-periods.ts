import { getJakartaCalendarDate } from "@/lib/indonesia-date"

export const TAX_PERIOD_OPTION_COUNT = 6

export function getTaxPeriodOptions(
  now = new Date(),
  count = TAX_PERIOD_OPTION_COUNT,
): string[] {
  const [year, month] = getJakartaCalendarDate(now)
    .slice(0, 7)
    .split("-")
    .map(Number)

  return Array.from({ length: count }, (_, offset) => {
    const date = new Date(Date.UTC(year, month - 1 - offset, 1))
    return date.toISOString().slice(0, 7)
  })
}