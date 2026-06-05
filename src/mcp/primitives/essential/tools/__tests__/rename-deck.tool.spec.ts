import { Test, TestingModule } from "@nestjs/testing";
import { RenameDeckTool } from "../rename-deck.tool";
import { AnkiConnectClient } from "@/mcp/clients/anki-connect.client";
import { parseToolResult } from "@/test-fixtures/test-helpers";

jest.mock("@/mcp/clients/anki-connect.client");

describe("RenameDeckTool", () => {
  let tool: RenameDeckTool;
  let ankiClient: jest.Mocked<AnkiConnectClient>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RenameDeckTool, AnkiConnectClient],
    }).compile();

    tool = module.get<RenameDeckTool>(RenameDeckTool);
    ankiClient = module.get(
      AnkiConnectClient,
    ) as jest.Mocked<AnkiConnectClient>;
    jest.clearAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────

  it("should rename a deck with cards", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Old Deck", "Other Deck"]) // deckNames
      .mockResolvedValueOnce([111, 222, 333]) // findCards
      .mockResolvedValueOnce(null) // changeDeck
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      oldName: "Old Deck",
      newName: "New Deck",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.oldName).toBe("Old Deck");
    expect(result.newName).toBe("New Deck");
    expect(result.cardsMoved).toBe(3);
    expect(result.newDeckExisted).toBe(false);
    expect(result.message).toContain("Successfully renamed");
    expect(result.message).toContain("3 card(s)");
    expect(ankiClient.invoke).toHaveBeenCalledWith("deckNames");
    expect(ankiClient.invoke).toHaveBeenCalledWith("findCards", {
      query: 'deck:"Old Deck"',
    });
    expect(ankiClient.invoke).toHaveBeenCalledWith("changeDeck", {
      cards: [111, 222, 333],
      deck: "New Deck",
    });
    expect(ankiClient.invoke).toHaveBeenCalledWith("deleteDecks", {
      decks: ["Old Deck"],
      cardsToo: false,
    });
  });

  it("should rename an empty deck", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Empty Deck"]) // deckNames
      .mockResolvedValueOnce([]) // findCards - empty
      .mockResolvedValueOnce(1651445861967) // createDeck
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      oldName: "Empty Deck",
      newName: "Renamed Deck",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.cardsMoved).toBe(0);
    expect(result.message).toContain("empty deck");
    expect(ankiClient.invoke).toHaveBeenCalledWith("createDeck", {
      deck: "Renamed Deck",
    });
  });

  it("should handle parent::child deck names", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Parent::Child"]) // deckNames
      .mockResolvedValueOnce([42]) // findCards
      .mockResolvedValueOnce(null) // changeDeck
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      oldName: "Parent::Child",
      newName: "NewParent::Child",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.oldName).toBe("Parent::Child");
    expect(result.newName).toBe("NewParent::Child");
    expect(result.cardsMoved).toBe(1);
  });

  // ── Merging into existing deck ─────────────────────────────────────

  it("should merge cards when new deck already exists", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Old Deck", "Existing Deck"]) // deckNames
      .mockResolvedValueOnce([1, 2, 3, 4, 5]) // findCards
      .mockResolvedValueOnce(null) // changeDeck
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      oldName: "Old Deck",
      newName: "Existing Deck",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.newDeckExisted).toBe(true);
    expect(result.cardsMoved).toBe(5);
    expect(result.hint).toContain("already existed");
    expect(result.hint).toContain("merged");
  });

  // ── Validation ─────────────────────────────────────────────────────

  it("should reject identical old and new names", async () => {
    const rawResult = await tool.execute({
      oldName: "Same Deck",
      newName: "Same Deck",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(false);
    expect(result.error).toContain("same");
    expect(ankiClient.invoke).not.toHaveBeenCalled();
  });

  it("should reject names with more than 2 levels", async () => {
    const rawResult = await tool.execute({
      oldName: "A::B::C",
      newName: "A::B",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(false);
    expect(result.error).toContain("maximum 2 levels");
    expect(ankiClient.invoke).not.toHaveBeenCalled();
  });

  it("should reject names with empty parts", async () => {
    const rawResult = await tool.execute({
      oldName: "Valid",
      newName: "::Invalid",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(false);
    expect(result.error).toContain("empty");
    expect(ankiClient.invoke).not.toHaveBeenCalled();
  });

  it("should trim whitespace from names", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Old Deck"]) // deckNames
      .mockResolvedValueOnce([1]) // findCards
      .mockResolvedValueOnce(null) // changeDeck
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      oldName: "  Old Deck  ",
      newName: "  New Deck  ",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.oldName).toBe("Old Deck");
    expect(result.newName).toBe("New Deck");
  });

  // ── Error handling ─────────────────────────────────────────────────

  it("should return error when old deck does not exist", async () => {
    ankiClient.invoke.mockResolvedValueOnce(["Deck A", "Deck B"]); // deckNames

    const rawResult = await tool.execute({
      oldName: "Nonexistent Deck",
      newName: "New Deck",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not exist");
    expect(result.error).toContain("Nonexistent Deck");
    expect(ankiClient.invoke).toHaveBeenCalledTimes(1); // only deckNames
  });

  it("should handle AnkiConnect connection errors", async () => {
    ankiClient.invoke.mockRejectedValueOnce(new Error("fetch failed"));

    const rawResult = await tool.execute({
      oldName: "Old Deck",
      newName: "New Deck",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(false);
    expect(result.error).toContain("fetch failed");
  });

  it("should handle findCards error mid-workflow", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Old Deck"]) // deckNames
      .mockRejectedValueOnce(new Error("AnkiConnect error mid-workflow")); // findCards

    const rawResult = await tool.execute({
      oldName: "Old Deck",
      newName: "New Deck",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(false);
  });

  // ── Response structure ─────────────────────────────────────────────

  it("should include hint about merging when new deck existed", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Old", "New"]) // deckNames — new exists
      .mockResolvedValueOnce([1, 2]) // findCards
      .mockResolvedValueOnce(null) // changeDeck
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      oldName: "Old",
      newName: "New",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.newDeckExisted).toBe(true);
    expect(result.hint).toContain("merged");
  });

  it("should include sync hint when new deck did not exist", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Old"]) // deckNames — new doesn't exist
      .mockResolvedValueOnce([1]) // findCards
      .mockResolvedValueOnce(null) // changeDeck
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      oldName: "Old",
      newName: "New",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(result.newDeckExisted).toBe(false);
    expect(result.hint).toContain("Sync");
  });

  it("should properly quote deck names with spaces in findCards query", async () => {
    ankiClient.invoke
      .mockResolvedValueOnce(["Deck With Spaces"]) // deckNames
      .mockResolvedValueOnce([99]) // findCards
      .mockResolvedValueOnce(null) // changeDeck
      .mockResolvedValueOnce(null); // deleteDecks

    const rawResult = await tool.execute({
      oldName: "Deck With Spaces",
      newName: "New Deck",
    });
    const result = parseToolResult(rawResult);

    expect(result.success).toBe(true);
    expect(ankiClient.invoke).toHaveBeenCalledWith("findCards", {
      query: 'deck:"Deck With Spaces"',
    });
  });
});
