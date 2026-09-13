import assert from "node:assert/strict";
import test from "node:test";
import { buildInvoiceNumber } from "./invoice-number";

test("menggunakan bulan Romawi dan tahun dari tanggal penerbitan", () => {
  const expectedMonths = [
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
  ];

  expectedMonths.forEach((romanMonth, index) => {
    const month = String(index + 1).padStart(2, "0");
    assert.equal(
      buildInvoiceNumber("PRJ", `2027-${month}-15`, index + 1),
      `INV/PRJ/${romanMonth}/2027/${String(index + 1).padStart(3, "0")}`,
    );
  });
});

test("mempertahankan nilai sequence PostgreSQL dalam nomor invoice", () => {
  assert.equal(
    buildInvoiceNumber("SITE-A", "2031-01-01", 1234),
    "INV/SITE-A/I/2031/1234",
  );
});

test("menolak tanggal penerbitan yang tidak memiliki bulan valid", () => {
  assert.throws(
    () => buildInvoiceNumber("PRJ", "2027-13-01", 1),
    /Tanggal penerbitan invoice tidak valid/,
  );
});