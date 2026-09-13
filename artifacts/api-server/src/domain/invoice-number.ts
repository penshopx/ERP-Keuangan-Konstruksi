const ROMAN_MONTHS = [
  "I",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
  "XI",
  "XII",
] as const;

export function buildInvoiceNumber(
  projectCode: string,
  issuedAt: string,
  sequence: number,
): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(issuedAt);
  const month = match ? Number(match[2]) : 0;

  if (!match || month < 1 || month > 12) {
    throw new Error(`Tanggal penerbitan invoice tidak valid: ${issuedAt}`);
  }

  return `INV/${projectCode}/${ROMAN_MONTHS[month - 1]}/${match[1]}/${String(sequence).padStart(3, "0")}`;
}