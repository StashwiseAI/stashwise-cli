import { afterEach, describe, expect, it, vi } from "vitest";
import { StashwiseApi } from "../src/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StashwiseApi folder management", () => {
  it("uses the hosted agent endpoint shapes for list, create, and move", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const responses = [
      {
        categories: [
          {
            id: "eeg",
            name: "EEG Research",
            parent_id: "ai",
            path: ["AI", "EEG Research"],
            depth: 1,
            child_count: 0,
            content_count: 1,
            subtree_content_count: 1,
          },
        ],
      },
      {
        created: true,
        category: {
          id: "eeg",
          name: "EEG Research",
          parent_id: "ai",
          path: ["AI", "EEG Research"],
          depth: 1,
          child_count: 0,
          content_count: 0,
          subtree_content_count: 0,
        },
      },
      {
        moved_count: 1,
        content_ids: ["paper"],
        category_id: "eeg",
        path: ["AI", "EEG Research"],
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const api = new StashwiseApi({
      apiBaseUrl: "https://api.example/api/v1",
      webBaseUrl: "https://example.com",
    });
    const listed = await api.listCategories("token");
    const created = await api.createFolder("token", "EEG Research", "ai");
    const moved = await api.moveItems("token", ["paper"], "eeg");

    expect(listed.categories[0].path).toEqual(["AI", "EEG Research"]);
    expect(created.category).toMatchObject({ id: "eeg", depth: 1 });
    expect(moved).toEqual({
      moved_count: 1,
      content_ids: ["paper"],
      category_id: "eeg",
      path: ["AI", "EEG Research"],
    });
    expect(calls.map((call) => [call.url, call.init.method ?? "GET"])).toEqual([
      ["https://api.example/api/v1/agent/categories", "GET"],
      ["https://api.example/api/v1/agent/categories", "POST"],
      ["https://api.example/api/v1/agent/items/move", "POST"],
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      name: "EEG Research",
      parent_id: "ai",
    });
    expect(JSON.parse(String(calls[2].init.body))).toEqual({
      content_ids: ["paper"],
      category_id: "eeg",
    });
  });
});
