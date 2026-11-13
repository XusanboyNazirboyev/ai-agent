import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { LeadsBoard } from "./leads-board";

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    formatDateTime: () => "date",
  }),
}));

vi.mock("./app-shell", () => ({
  useShell: () => ({
    operator: { id: "op1", displayName: "Op", role: "OPERATOR" },
    timeZone: "UTC",
  }),
}));

vi.mock("./ui/toast", () => ({
  useToast: () => vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("view=funnel"),
}));

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
  errorKey: () => "error",
}));

vi.mock("@/lib/export-csv", () => ({
  downloadCsv: vi.fn(),
}));

const board = {
  stages: [
    {
      id: "stage-new",
      code: "NEW",
      name: "New",
      position: 0,
      pipelineId: "pipe-1",
      kind: "OPEN",
      count: 1,
      totals: [{ currency: "UZS", amount: "150000.00" }],
    },
    {
      id: "stage-won",
      code: "WON",
      name: "Won",
      position: 1,
      pipelineId: "pipe-1",
      kind: "WON",
      count: 0,
      totals: [],
    },
  ],
};

const leads = {
  items: [
    {
      id: "lead-1",
      pipelineId: "pipe-1",
      pipelineStageId: "stage-new",
      ownerOperatorId: null,
      owner: null,
      amount: "150000.00",
      currency: "UZS",
      source: null,
      expectedCloseDate: null,
      lostReason: null,
      stageSetBy: "OPERATOR",
      suggestedStageId: null,
      suggestedReasonCodes: [],
      score: "HOT",
      status: "NEW",
      summary: "",
      createdAt: "2026-11-11T09:00:00.000Z",
      updatedAt: "2026-11-11T10:00:00.000Z",
      contact: { name: "Ada Lovelace", phone: null },
      conversation: {
        id: "conv-1",
        state: "BOT_ACTIVE",
        channelType: "telegram",
      },
      tags: [],
      customFields: [],
    },
  ],
  nextCursor: null,
};

function setupApi(): void {
  const mockedApi = vi.mocked(api);
  mockedApi.mockImplementation((path: string) => {
    if (path === "/api/v1/pipelines")
      return Promise.resolve({
        items: [{ id: "pipe-1", name: null, position: 0, isDefault: true }],
      });
    if (path.startsWith("/api/v1/pipelines/pipe-1/board"))
      return Promise.resolve(board);
    if (path.startsWith("/api/v1/leads?")) return Promise.resolve(leads);
    if (path === "/api/v1/tags") return Promise.resolve({ items: [] });
    return new Promise(() => {});
  });
}

describe("LeadsBoard", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders board columns with counts and per-currency totals", async () => {
    setupApi();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <LeadsBoard />
      </QueryClientProvider>,
    );

    await screen.findByTestId("lead-column-NEW");
    await screen.findByTestId("lead-column-WON");
    const counts = await screen.findAllByTestId("lead-count");
    expect(counts).toHaveLength(2);
    expect(await screen.findByTestId("lead-column-total")).toBeInTheDocument();
  });

  it("stage select calls PATCH /leads/:id/stage", async () => {
    setupApi();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <LeadsBoard />
      </QueryClientProvider>,
    );

    const cards = await screen.findAllByTestId("lead-card");
    const stage = within(cards[0]).getByTestId("lead-card-stage");
    fireEvent.change(stage, { target: { value: "stage-won" } });

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        "/api/v1/leads/lead-1/stage",
        expect.objectContaining({
          method: "PATCH",
          body: { stageId: "stage-won" },
        }),
      );
    });
  });

  it("does not call deprecated score/status routes", async () => {
    setupApi();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <LeadsBoard />
      </QueryClientProvider>,
    );

    await screen.findByTestId("lead-card");
    expect(screen.queryByTestId("lead-card-score")).toBeNull();
    expect(screen.queryByTestId("lead-card-status")).toBeNull();
    expect(api).not.toHaveBeenCalledWith(
      expect.stringContaining("/conversations/"),
      expect.objectContaining({ method: "PUT" }),
    );
  });
});
