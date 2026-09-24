// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import PettyCash from "./PettyCash";

const state = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  funds: [] as Record<string, unknown>[],
  disburse: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>();
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    ...original,
    useListPettyCashRequests: () => ({ data: state.requests, isLoading: false }),
    useListPettyCashFunds: () => ({ data: state.funds }),
    useListPettyCashPolicies: () => ({ data: [] }),
    useListProjects: () => ({ data: [] }),
    useListAccessUsers: () => ({ data: [] }),
    useGetProjectRab: () => ({ data: undefined }),
    useCreatePettyCashRequest: mutation,
    useDecidePettyCashRequest: mutation,
    useDisbursePettyCashRequest: () => ({ mutate: state.disburse }),
    useSettlePettyCashRequest: mutation,
    useReconcilePettyCashRequest: mutation,
    useCreatePettyCashFund: mutation,
    useReplenishPettyCashFund: mutation,
    useCreatePettyCashPolicy: mutation,
    useResolvePettyCashEvidence: mutation,
    useVerifyPettyCashRequest: mutation,
    useEvaluatePettyCashRequest: mutation,
  };
});

vi.mock("@/lib/access", () => ({
  useAccess: () => ({ userId: "finance", role: "FINANCE", displayName: "Finance",
    permissions: ["petty-cash:view", "petty-cash:disburse"] }),
  hasPermission: (access: { permissions: string[] }, permission: string) => access.permissions.includes(permission),
}));

function request(id: string, fundId: string | null) {
  return {
    id, fundId, status: "DISETUJUI", projectCode: "PRJ", projectName: "Proyek",
    requesterUserId: "requester", requesterName: "Pemohon",
    approverUserId: "approver", purpose: "Keperluan lapangan",
    requestedAmount: 100_000, approvedAmount: 100_000, evidenceDueAt: "2026-09-30",
    expenses: [], exceptions: [],
  };
}

function renderPage() {
  return render(createElement(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  }, createElement(PettyCash)));
}

beforeEach(() => {
  state.requests = [];
  state.funds = [];
  state.disburse.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test("approved historical request without a fund can be disbursed from the page", () => {
  state.requests = [request("legacy", null)];
  vi.spyOn(window, "prompt").mockReturnValue("HANDOVER-LEGACY");
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Cairkan transaksi lama" }));
  expect(state.disburse).toHaveBeenCalledWith(
    { requestId: "legacy", data: { amount: 100_000, reference: "HANDOVER-LEGACY" } },
    expect.any(Object),
  );
});

test("new funded request stays restricted to its assigned custodian", () => {
  state.requests = [request("funded", "fund-1")];
  state.funds = [{
    id: "fund-1", projectId: "project-1", location: "Site",
    custodianUserId: "another-finance", custodianName: "Another Finance", bookBalance: 100_000,
  }];
  const { rerender } = renderPage();
  expect(screen.queryByRole("button", { name: "Cairkan" })).toBeNull();
  state.funds = [{ ...state.funds[0], custodianUserId: "finance" }];
  rerender(createElement(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  }, createElement(PettyCash)));
  expect(screen.getByRole("button", { name: "Cairkan" })).toBeTruthy();
});