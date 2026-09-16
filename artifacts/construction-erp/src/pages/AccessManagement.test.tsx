// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import AccessManagement from "./AccessManagement";

const verifiedInvitation = {
  id: "inv_verified",
  email: "staf@example.com",
  displayName: "Staf Terverifikasi",
  role: "FINANCE",
  assignedProjectIds: [],
  status: "PENDING",
  expiresAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
} as const;

let invitationQuery: {
  data?: {
    invitations: (typeof verifiedInvitation)[];
    verification: {
      status: "VERIFIED" | "DEGRADED";
      message: string;
    };
  };
  isError: boolean;
};

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>();
  const idleMutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    ...original,
    useListAccessUsers: () => ({ data: [], isLoading: false }),
    useListAccessInvitations: () => invitationQuery,
    useListProjects: () => ({ data: [] }),
    useCreateAccessInvitation: idleMutation,
    useResendAccessInvitation: idleMutation,
    useRevokeAccessInvitation: idleMutation,
    useUpdateAccessUser: idleMutation,
  };
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AccessManagement),
    ),
  );
}

afterEach(() => {
  cleanup();
});

describe("status verifikasi daftar undangan", () => {
  test("menampilkan peringatan gangguan Clerk dan undangan yang sudah terverifikasi", () => {
    invitationQuery = {
      data: {
        invitations: [verifiedInvitation],
        verification: {
          status: "DEGRADED",
          message: "Clerk sedang tidak dapat dijangkau. Hanya undangan terverifikasi yang ditampilkan.",
        },
      },
      isError: false,
    };

    renderPage();

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Status undangan belum dapat dipastikan")).toBeTruthy();
    expect(within(alert).getByText(/Hanya undangan terverifikasi yang ditampilkan/)).toBeTruthy();
    expect(screen.getByText("Staf Terverifikasi")).toBeTruthy();
    expect(screen.getByText(/staf@example\.com/)).toBeTruthy();
  });

  test("menampilkan pesan kegagalan request yang berbeda dari peringatan degradasi", () => {
    invitationQuery = {
      data: undefined,
      isError: true,
    };

    renderPage();

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Daftar undangan tidak dapat dimuat. Coba lagi beberapa saat.")).toBeTruthy();
    expect(screen.queryByText("Status undangan belum dapat dipastikan")).toBeNull();
  });
});