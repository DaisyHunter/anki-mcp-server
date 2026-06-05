import { Test, TestingModule } from "@nestjs/testing";
import { DeleteDecksTool } from "../delete-decks.tool";
import { AnkiConnectClient } from "@/mcp/clients/anki-connect.client";
import { parseToolResult } from "@/test-fixtures/test-helpers";

jest.mock("@/mcp/clients/anki-connect.client");

describe("DeleteDecksTool", () => {
  let tool: DeleteDecksTool;
  let ankiClient: jest.Mocked<AnkiConnectClient>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DeleteDecksTool, AnkiConnectClient],
    }).compile();

    tool = module.get<DeleteDecksTool>(DeleteDecksTool);
    ankiClient = module.get(
      AnkiConnectClient,
    ) as jest.Mocked<AnkiConnectClient>;
    jest.clearAllMocks();
  });

  // ── Happy path: delete empty decks ─────────────────────────────────

  it("should delete an empty deck", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Empty Deck", "Other"]) // deckNames
      .mockResolvedValueOnce([]) // findCards — empty
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      decks: ["Empty Deck"],
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.deletedDecks).toEqual(["Empty Deck"]);
    expect(result.notFound).toEqual([]);
    expect(result.cardsAlsoDeleted).toBe(false);
    expect(result.message).toContain("Successfully deleted");
    expect(ankiClient.invoke).toHaveBeenCalledWith("deleteDecks", {
      decks: ["Empty Deck"],
      cardsToo: false,
    });
  });

  it("should delete multiple empty decks at once", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Deck A", "Deck B", "Deck C"]) // deckNames
      .mockResolvedValueOnce([]) // findCards A
      .mockResolvedValueOnce([]) // findCards B
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      decks: ["Deck A", "Deck B"],
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.deletedDecks).toEqual(["Deck A", "Deck B"]);
    expect(result.notFound).toEqual([]);
  });

  // ── Delete with cards ──────────────────────────────────────────────

  it("should delete decks with cards when cardsToo=true and confirmed", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Deck With Cards"]) // deckNames
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      decks: ["Deck With Cards"],
      cardsToo: true,
      confirmDeletion: true,
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.deletedDecks).toEqual(["Deck With Cards"]);
    expect(result.cardsAlsoDeleted).toBe(true);
    expect(ankiClient.invoke).toHaveBeenCalledWith("deleteDecks", {
      decks: ["Deck With Cards"],
      cardsToo: true,
    });
  });

  it("should reject cardsToo=true without confirmDeletion", async () => {
    const rawResult = await tool.execute({
      decks: ["Some Deck"],
      cardsToo: true,
      // confirmDeletion intentionally omitted
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(false);
    expect(result.error).toContain("confirmation");
    expect(result.hint).toContain("confirmDeletion=true");
    expect(ankiClient.invoke).not.toHaveBeenCalledWith(
      "deleteDecks",
      expect.anything(),
    );
  });

  // ── Non-empty deck with cardsToo=false ─────────────────────────────

  it("should skip non-empty decks when cardsToo is false", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Empty Deck", "Full Deck"]) // deckNames
      .mockResolvedValueOnce([]) // findCards Empty — empty
      .mockResolvedValueOnce([1, 2, 3]) // findCards Full — has cards
      .mockResolvedValueOnce(null); // deleteDecks (only empty)

    const rawResult = await tool.execute({
      decks: ["Empty Deck", "Full Deck"],
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.deletedDecks).toEqual(["Empty Deck"]);
    expect(result.skippedNonEmpty).toEqual(["Full Deck"]);
    expect(result.message).toContain("skipped");
    expect(ankiClient.invoke).toHaveBeenCalledWith("deleteDecks", {
      decks: ["Empty Deck"],
      cardsToo: false,
    });
  });

  it("should report when all decks are non-empty and skipped", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Full A", "Full B"]) // deckNames
      .mockResolvedValueOnce([1, 2]) // findCards Full A
      .mockResolvedValueOnce([3, 4]); // findCards Full B

    const rawResult = await tool.execute({
      decks: ["Full A", "Full B"],
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.deletedDecks).toEqual([]);
    expect(result.skippedNonEmpty).toEqual(["Full A", "Full B"]);
    expect(result.message).toContain("None");
    expect(result.hint).toContain("cardsToo=true");
    expect(ankiClient.invoke).not.toHaveBeenCalledWith(
      "deleteDecks",
      expect.anything(),
    );
  });

  // ── Not found decks ────────────────────────────────────────────────

  it("should report decks that do not exist", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Existing Deck"]) // deckNames
      .mockResolvedValueOnce([]) // findCards for Existing Deck (empty)
      .mockResolvedValueOnce(null); // deleteDecks (for the existing one)

    const rawResult = await tool.execute({
      decks: ["Existing Deck", "Ghost Deck"],
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.notFound).toEqual(["Ghost Deck"]);
    expect(result.message).toContain("not found");
  });

  it("should handle all decks not found", async () => {
    ankiClient.invoke.mockResolvedValueOnce(["A", "B"]); // deckNames

    const rawResult = await tool.execute({
      decks: ["X", "Y", "Z"],
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.deletedDecks).toEqual([]);
    expect(result.notFound).toEqual(["X", "Y", "Z"]);
    expect(result.hint).toContain("listDecks");
  });

  // ── Validation ─────────────────────────────────────────────────────

  it("should trim whitespace from deck names", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Clean Deck"]) // deckNames
      .mockResolvedValueOnce([]) // findCards — empty
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      decks: ["  Clean Deck  "],
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.deletedDecks).toEqual(["Clean Deck"]);
  });

  // ── Error handling ─────────────────────────────────────────────────

  it("should handle AnkiConnect connection errors", async () => {
    ankiClient.invoke.mockRejectedValueOnce(new Error("fetch failed"));

    const rawResult = await tool.execute({
      decks: ["Some Deck"],
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(false);
    expect(result.error).toContain("fetch failed");
  });

  it("should handle deleteDecks API errors", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Problem Deck"]) // deckNames
      .mockResolvedValueOnce([]) // findCards — empty
      .mockRejectedValueOnce(new Error("AnkiConnect deleteDecks error"));

    const rawResult = await tool.execute({
      decks: ["Problem Deck"],
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(false);
  });

  // ── Response structure ─────────────────────────────────────────────

  it("should include proper summary in message", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Deck 1", "Deck 2"]) // deckNames
      .mockResolvedValueOnce([]) // findCards Deck 1
      .mockResolvedValueOnce([]) // findCards Deck 2
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      decks: ["Deck 1", "Deck 2"],
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.deletedDecks).toHaveLength(2);
    expect(result.message).toContain("2 deck(s)");
    expect(result.message).toContain("Deck 1");
    expect(result.message).toContain("Deck 2");
  });

  it("should include sync hint after successful deletion", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Deck"]) // deckNames
      .mockResolvedValueOnce([]) // findCards — empty
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      decks: ["Deck"],
    });
    const result = parseToolResult(rawResult);

    expect(result.hint).toContain("Sync");
  });

  it("should properly quote deck names with spaces in findCards query", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Deck With Spaces"]) // deckNames
      .mockResolvedValueOnce([]) // findCards
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      decks: ["Deck With Spaces"],
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(ankiClient.invoke).toHaveBeenCalledWith("findCards", {
      query: 'deck:"Deck With Spaces"',
    });
  });
});
