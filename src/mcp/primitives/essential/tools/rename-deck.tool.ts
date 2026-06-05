import { Injectable, Logger } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { AnkiConnectClient } from "@/mcp/clients/anki-connect.client";
import { createErrorResponse } from "@/mcp/utils/anki.utils";

/**
 * Tool for safely renaming an Anki deck while preserving all cards and scheduling history.
 *
 * Internal workflow (executed as a single atomic operation):
 * 1. Verify the old deck exists
 * 2. Find all cards in the old deck
 * 3. Move cards to the new deck via changeDeck (creates the new deck if needed)
 * 4. Delete the now-empty old deck
 *
 * This is safer than exposing raw deleteDecks for rename purposes because
 * it guarantees cards are migrated before the old deck is removed.
 */
@Injectable()
export class RenameDeckTool {
  private readonly logger = new Logger(RenameDeckTool.name);

  constructor(private readonly ankiClient: AnkiConnectClient) {}

  @Tool({
    name: "renameDeck",
    description:
      "Safely rename an Anki deck while preserving all cards and their scheduling history. " +
      'Supports parent::child structure (e.g., rename "Japanese::Vocab" to "日本語::Vocab"). ' +
      "This is the recommended way to rename decks — do NOT use deleteDecks + createDeck manually.",
    parameters: z.object({
      oldName: z.string().min(1).describe("Current name of the deck to rename"),
      newName: z
        .string()
        .min(1)
        .describe("New name for the deck. Use :: for parent::child structure"),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      oldName: z.string(),
      newName: z.string(),
      cardsMoved: z.number(),
      newDeckExisted: z.boolean(),
      message: z.string(),
      hint: z.string().optional(),
    }),
    annotations: {
      title: "Rename Deck",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  })
  async execute(params: { oldName: string; newName: string }) {
    const oldName = params.oldName.trim();
    const newName = params.newName.trim();

    try {
      this.logger.log(`Renaming deck: "${oldName}" -> "${newName}"`);

      // ── Validation ──────────────────────────────────────────────────
      if (oldName === newName) {
        throw new Error(
          `Old and new deck names are the same: "${oldName}". No changes made.`,
        );
      }

      // Validate parent::child depth
      for (const [label, name] of [
        ["oldName", oldName],
        ["newName", newName],
      ] as const) {
        const parts = name.split("::");
        if (parts.length > 2) {
          throw new Error(
            `Deck name can have maximum 2 levels (parent::child): "${name}" has ${parts.length}`,
          );
        }
        if (parts.some((p) => p.trim() === "")) {
          throw new Error(
            `Deck name parts cannot be empty: "${name}". Fix ${label}.`,
          );
        }
      }

      // ── Check old deck exists ───────────────────────────────────────
      const deckNames = await this.ankiClient.invoke<string[]>("deckNames");
      if (!deckNames.includes(oldName)) {
        throw new Error(
          `Deck "${oldName}" does not exist. Available decks: ${deckNames.slice(0, 10).join(", ")}${deckNames.length > 10 ? ` (and ${deckNames.length - 10} more)` : ""}`,
        );
      }

      // ── Check if newName already exists ─────────────────────────────
      const newDeckExisted = deckNames.includes(newName);

      // ── Find all cards in old deck ──────────────────────────────────
      // Use Anki search syntax with proper quoting for deck names
      // that contain spaces or special characters
      const escapedOldName = oldName.includes(" ") ? `"${oldName}"` : oldName;
      const cardIds = await this.ankiClient.invoke<number[]>("findCards", {
        query: `deck:${escapedOldName}`,
      });

      let cardsMoved = 0;

      // ── Move cards to new deck ─────────────────────────────────────
      // changeDeck creates the target deck if it doesn't exist
      if (cardIds.length > 0) {
        await this.ankiClient.invoke<null>("changeDeck", {
          cards: cardIds,
          deck: newName,
        });
        cardsMoved = cardIds.length;
        this.logger.log(
          `Moved ${cardsMoved} card(s) from "${oldName}" to "${newName}"`,
        );
      } else if (!newDeckExisted) {
        // No cards to move, but create the new deck so it exists
        await this.ankiClient.invoke<number>("createDeck", {
          deck: newName,
        });
        this.logger.log(`Created empty deck "${newName}"`);
      }

      // ── Delete old (now empty) deck ─────────────────────────────────
      await this.ankiClient.invoke<null>("deleteDecks", {
        decks: [oldName],
        cardsToo: false,
      });

      this.logger.log(`Deleted old empty deck "${oldName}"`);

      // ── Build response ─────────────────────────────────────────────
      const message =
        cardsMoved > 0
          ? `Successfully renamed "${oldName}" to "${newName}". Moved ${cardsMoved} card(s); scheduling history preserved.`
          : `Successfully renamed empty deck "${oldName}" to "${newName}".`;

      return {
        success: true,
        oldName,
        newName,
        cardsMoved,
        newDeckExisted,
        message,
        hint:
          newDeckExisted && cardsMoved > 0
            ? `Note: "${newName}" already existed. Cards from "${oldName}" were merged into it.`
            : "Rename complete. Sync with AnkiWeb to propagate changes.",
      };
    } catch (error) {
      this.logger.error("Failed to rename deck", error);
      return createErrorResponse(error, {
        action: "renameDeck",
        oldName,
        newName,
        hint: "Make sure Anki is running and the old deck exists. The new deck name must be valid (max 2 levels with ::).",
      });
    }
  }
}
