import { describe, expect, it } from "vitest";
import { parseSearchArgs } from "../src/search.js";

describe("parseSearchArgs", () => {
  it("joins positional words into a query with defaults", () => {
    expect(parseSearchArgs(["machine", "learning", "notes"])).toEqual({
      query: "machine learning notes",
      k: 8,
      scope: "all",
    });
  });

  it("accepts a single quoted-style query", () => {
    expect(parseSearchArgs(["what did I save about HNSW"])).toMatchObject({
      query: "what did I save about HNSW",
      k: 8,
      scope: "all",
    });
  });

  it("parses --scope and --k (space-separated)", () => {
    expect(parseSearchArgs(["rust", "--scope", "wiki", "--k", "5"])).toEqual({
      query: "rust",
      k: 5,
      scope: "wiki",
    });
  });

  it("parses inline --scope= and --k= forms", () => {
    expect(parseSearchArgs(["rust", "--scope=library", "--k=3"])).toEqual({
      query: "rust",
      k: 3,
      scope: "library",
    });
  });

  it("rejects an out-of-range k", () => {
    expect(parseSearchArgs(["x", "--k", "99"]).error).toMatch(/--k must be/);
    expect(parseSearchArgs(["x", "--k", "0"]).error).toMatch(/--k must be/);
  });

  it("rejects an invalid scope", () => {
    expect(parseSearchArgs(["x", "--scope", "bogus"]).error).toMatch(/--scope must be/);
  });

  it("returns an empty query when only flags are given", () => {
    expect(parseSearchArgs(["--scope", "all"]).query).toBe("");
  });
});
