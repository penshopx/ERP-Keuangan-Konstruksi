const JAKARTA_TIME_ZONE = "Asia/Jakarta"

export function getJakartaCalendarDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: JAKARTA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)

  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type === "year" || type === "month" || type === "day")
      .map(({ type, value }) => [type, value]),
  )

  return `${values.year}-${values.month}-${values.day}`
}