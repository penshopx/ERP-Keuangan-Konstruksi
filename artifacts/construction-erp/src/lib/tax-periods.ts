import { getJakartaCalendarDate } from "@/lib/indonesia-date"

export const TAX_PERIOD_OPTION_COUNT = 6

const taxPeriodLabelFormatter = new Intl.DateTimeFormat("id-ID", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
})

export function formatTaxPeriodLabel(period: string): string {
  const [year, month] = period.split("-").map(Number)
  return taxPeriodLabelFormatter.format(new Date(Date.UTC(year, month - 1, 1)))
}

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

export function resolveTaxPeriod(
  requestedPeriod: string | null,
  availablePeriods: readonly string[],
): string {
  if (availablePeriods.length === 0) {
    throw new Error("At least one tax period must be available")
  }

  return requestedPeriod && availablePeriods.includes(requestedPeriod)
    ? requestedPeriod
    : availablePeriods[0]
}
