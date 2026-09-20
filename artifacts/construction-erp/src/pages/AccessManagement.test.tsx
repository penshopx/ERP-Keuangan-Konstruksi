// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  acceptedAt: null,
  acceptedEmail: null,
} as const;

const acceptedInvitation = {
  ...verifiedInvitation,
  id: "inv_accepted",
  status: "ACCEPTED",
  acceptedAt: "2026-09-18T10:00:00.000Z",
  acceptedEmail: "email.sekunder@example.com",
} as const;

const legacyAcceptedInvitation = {
  ...acceptedInvitation,
  acceptedEmail: null,
} as const;

let invitationQuery: {
  data?: {
    invitations: Array<
      typeof verifiedInvitation
      | typeof acceptedInvitation
      | typeof legacyAcceptedInvitation
    >;
    verification: {
      status: "VERIFIED" | "DEGRADED";
      message: string;
      lastSuccessfulVerificationAt: string | null;
    };
  };
  isError: boolean;
};
let userQuery: {
  data?: [];
  isLoading: boolean;
};
let invitationParams: unknown;

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>();
  const idleMutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    ...original,
    useListAccessUsers: () => userQuery,
    useListAccessInvitations: (params: unknown) => {
      invitationParams = params;
      return invitationQuery;
    },
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
  test("mengirim pencarian email ke API dan menyediakan filter status", () => {
    userQuery = { data: [], isLoading: false };
    invitationQuery = {
      data: {
        invitations: [],
        verification: {
          status: "VERIFIED",
          message: "Semua status undangan telah diverifikasi.",
          lastSuccessfulVerificationAt: null,
        },
      },
      isError: false,
    };

    renderPage();

    fireEvent.change(screen.getByRole("searchbox", { name: "Cari email" }), {
      target: { value: " penerima@example.com " },
    });
    expect(invitationParams).toEqual({ email: "penerima@example.com" });
    expect(screen.getByRole("combobox", { name: "Status" }).textContent).toContain("Semua status");
    expect(screen.getByText("Tidak ada undangan yang cocok dengan pencarian dan status ini.")).toBeTruthy();
  });

  test("menampilkan peringatan gangguan Clerk dan undangan yang sudah terverifikasi", () => {
    userQuery = { data: [], isLoading: false };
    invitationQuery = {
      data: {
        invitations: [verifiedInvitation],
        verification: {
          status: "DEGRADED",
          message: "Clerk sedang tidak dapat dijangkau. Hanya undangan terverifikasi yang ditampilkan.",
          lastSuccessfulVerificationAt: "2026-09-16T08:30:00.000Z",
        },
      },
      isError: false,
    };

    renderPage();

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Status undangan belum dapat dipastikan")).toBeTruthy();
    expect(within(alert).getByText(/Hanya undangan terverifikasi yang ditampilkan/)).toBeTruthy();
    expect(within(alert).getByText(/Terakhir berhasil diverifikasi melalui Clerk:/)).toBeTruthy();
    expect(screen.getByText("Staf Terverifikasi")).toBeTruthy();
    expect(screen.getByText(/staf@example\.com/)).toBeTruthy();
  });

  test("menampilkan pesan kegagalan request yang berbeda dari peringatan degradasi", () => {
    userQuery = { data: [], isLoading: false };
    invitationQuery = {
      data: undefined,
      isError: true,
    };

    renderPage();

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Daftar undangan tidak dapat dimuat. Coba lagi beberapa saat.")).toBeTruthy();
    expect(screen.queryByText("Status undangan belum dapat dipastikan")).toBeNull();
  });

  test("tetap menampilkan peringatan degradasi saat daftar pengguna masih dimuat", () => {
    userQuery = { data: undefined, isLoading: true };
    invitationQuery = {
      data: {
        invitations: [verifiedInvitation],
        verification: {
          status: "DEGRADED",
          message: "Clerk sedang tidak dapat dijangkau. Hanya undangan terverifikasi yang ditampilkan.",
          lastSuccessfulVerificationAt: null,
        },
      },
      isError: false,
    };

    renderPage();

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Status undangan belum dapat dipastikan")).toBeTruthy();
    expect(within(alert).getByText(/Hanya undangan terverifikasi yang ditampilkan/)).toBeTruthy();
    expect(screen.getByText("Memuat pengguna...")).toBeTruthy();
    expect(screen.getByText("Staf Terverifikasi")).toBeTruthy();
  });

  test("menampilkan email terverifikasi yang digunakan untuk menerima undangan", () => {
    userQuery = { data: [], isLoading: false };
    invitationQuery = {
      data: {
        invitations: [acceptedInvitation],
        verification: {
          status: "VERIFIED",
          message: "Semua status undangan telah diverifikasi.",
          lastSuccessfulVerificationAt: "2026-09-18T10:00:00.000Z",
        },
      },
      isError: false,
    };

    renderPage();

    expect(screen.getByText("Diterima")).toBeTruthy();
    expect(screen.getByText("Diterima menggunakan email.sekunder@example.com")).toBeTruthy();
  });

  test("menampilkan fallback untuk undangan lama tanpa email penerimaan", () => {
    userQuery = { data: [], isLoading: false };
    invitationQuery = {
      data: {
        invitations: [legacyAcceptedInvitation],
        verification: {
          status: "VERIFIED",
          message: "Semua status undangan telah diverifikasi.",
          lastSuccessfulVerificationAt: null,
        },
      },
      isError: false,
    };

    renderPage();

    expect(screen.getByText("Email penerimaan tidak tercatat pada data lama")).toBeTruthy();
  });
});