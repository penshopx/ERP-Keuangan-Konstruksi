// @vitest-environment jsdom

import type { TaxRuleInput } from "@workspace/api-client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { calculateTaxSimulation } from "../lib/tax-simulation.ts";
import TaxRules from "./TaxRules";

const mutate = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...original,
    useListTaxRules: () => ({ data: [], isLoading: false, error: null }),
    useCreateTaxRule: () => ({ mutate, isPending: false }),
  };
});

afterEach(() => {
  cleanup();
  mutate.mockClear();
});

const rule: TaxRuleInput = {
  version: "simulasi",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  regulatorySource: "uji",
  serviceType: "KONSTRUKSI",
  qualification: "KECIL",
  requiresSbu: true,
  supplierPkp: true,
  governmentCollector: false,
  integrated: false,
  dppRateBasisPoints: 9_167,
  ppnRateBasisPoints: 1_100,
  pphFinalRateBasisPoints: 175,
  pph23RateBasisPoints: 200,
};

test("simulasi mengikuti urutan pembulatan invoice", () => {
  expect(calculateTaxSimulation(12_345, rule)).toEqual({
    dpp: 11_317,
    ppn: 1_245,
    pphFinal: 216,
    pph23: 247,
    total: 13_127,
  });
});

test("PPN pemungut pemerintah ditampilkan tetapi tidak menambah total", () => {
  const result = calculateTaxSimulation(100_000, { ...rule, governmentCollector: true });
  expect(result.ppn).toBe(10_084);
  expect(result.total).toBe(96_250);
});

test("penyedia non-PKP menghasilkan PPN nol", () => {
  const result = calculateTaxSimulation(100_000, { ...rule, supplierPkp: false });
  expect(result.ppn).toBe(0);
  expect(result.total).toBe(96_250);
});

describe("dialog simulasi aturan pajak", () => {
  test("memperbarui ringkasan dari nilai invoice, seluruh tarif, PKP, dan pemungut tanpa menyimpan", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client }, createElement(TaxRules)));

    await user.click(screen.getByRole("button", { name: "Tambah versi" }));
    const dialog = await screen.findByRole("dialog", { name: "Tambah versi aturan pajak" });
    const input = (name: string) => within(dialog).getByRole("spinbutton", { name });

    await user.clear(input("Nilai invoice contoh"));
    await user.type(input("Nilai invoice contoh"), "200000");
    await user.clear(input("Basis DPP (%)"));
    await user.type(input("Basis DPP (%)"), "80");
    await user.clear(input("Tarif PPN (%)"));
    await user.type(input("Tarif PPN (%)"), "12");
    await user.clear(input("Tarif PPh Final (%)"));
    await user.type(input("Tarif PPh Final (%)"), "2");
    await user.clear(input("Tarif PPh 23 (%)"));
    await user.type(input("Tarif PPh 23 (%)"), "3");

    expect(within(dialog).getByText(/Rp\s*160\.000/)).toBeTruthy();
    expect(within(dialog).getByText(/Rp\s*19\.200/)).toBeTruthy();
    expect(within(dialog).getByText(/−Rp\s*4\.000/)).toBeTruthy();
    expect(within(dialog).getByText(/−Rp\s*6\.000/)).toBeTruthy();
    expect(within(dialog).getByText(/Rp\s*209\.200/)).toBeTruthy();

    await user.click(within(dialog).getByRole("checkbox", { name: "Penyedia PKP" }));
    expect(within(dialog).getByText(/Rp\s*0/)).toBeTruthy();
    expect(within(dialog).getByText(/Rp\s*190\.000/)).toBeTruthy();

    await user.click(within(dialog).getByRole("checkbox", { name: "Penyedia PKP" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Pemungut pemerintah" }));
    expect(within(dialog).getByText(/Rp\s*19\.200/)).toBeTruthy();
    expect(within(dialog).getByText(/Rp\s*190\.000/)).toBeTruthy();
    expect(within(dialog).getByText(/tidak ditambahkan ke total bersih karena dipungut pemerintah/)).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });
});