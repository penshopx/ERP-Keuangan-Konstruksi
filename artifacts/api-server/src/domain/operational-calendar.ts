export const OPERATIONAL_TIME_ZONE = "Asia/Jakarta";

const operationalDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: OPERATIONAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function operationalDateParts(now: Date) {
  const parts = operationalDateFormatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Gagal menentukan tanggal pada zona waktu operasional.");
  }
  return { year, month, day };
}

export function currentOperationalDate(now = new Date()) {
  const { year, month, day } = operationalDateParts(now);
  return `${year}-${month}-${day}`;
}

export function currentOperationalMonth(now = new Date()) {
  const { year, month } = operationalDateParts(now);
  return `${year}-${month}`;
}