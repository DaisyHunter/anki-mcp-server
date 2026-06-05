import { Injectable, Logger } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { AnkiConnectClient } from "@/mcp/clients/anki-connect.client";
import { createErrorResponse } from "@/mcp/utils/anki.utils";

/**
 * Tool for deleting Anki decks.
 *
 * Wraps AnkiConnect's deleteDecks action with safety guards:
 * - Default mode (cardsToo=false) only deletes EMPTY decks
 * - cardsToo=true requires explicit confirmation
 * - Pre-validates which decks exist vs which don't
 */
@Injectable()
export class DeleteDecksTool {
  private readonly logger = new Logger(DeleteDecksTool.name);

  constructor(private readonly ankiClient: AnkiConnectClient) {}

  @Tool({
    name: "deleteDecks",
    description:
      "Delete Anki decks. By default, only EMPTY decks can be deleted. " +
      "Set cardsToo=true to delete decks even if they contain cards (this will permanently delete ALL cards in those decks). " +
      "IMPORTANT: For renaming decks, use renameDeck instead — it safely migrates cards and preserves scheduling history. " +
      "CRITICAL: This action is irreversible. Deleted cards cannot be recovered unless you have a recent backup.",
    parameters: z.object({
      decks: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe("Array of deck names to delete (max 50 at once)"),
      cardsToo: z
        .boolean()
        .optional()
        .describe(
          "If true, also delete decks that contain cards (permanently deleting all cards in them). " +
            "Defaults to false — only empty decks will be deleted. Must be explicitly set to true to delete non-empty decks.",
        ),
      confirmDeletion: z
        .boolean()
        .optional()
        .describe(
          "Must be set to true to confirm you want to permanently delete these decks. " +
            "Required when cardsToo is true.",
        ),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      deletedDecks: z.array(z.string()),
      notFound: z.array(z.string()),
      skippedNonEmpty: z.array(z.string()).optional(),
      cardsAlsoDeleted: z.boolean(),
      message: z.string(),
      hint: z.string().optional(),
    }),
    annotations: {
      title: "Delete Decks",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  })
  async execute(params: {
    decks: string[];
    cardsToo?: boolean;
    confirmDeletion?: boolean;
  }) {
    const { decks, cardsToo = false, confirmDeletion } = params;

    try {
      this.logger.log(`Deleting ${decks.length} deck(s), cardsToo=${cardsToo}`);

      // ── Safety gate: confirmDeletion required when cardsToo is true ─
      if (cardsToo && !confirmDeletion) {
        return createErrorResponse(
          new Error("Deletion with cardsToo=true requires confirmation"),
          {
            requestedDecks: decks,
            cardsToo,
            hint: "Set confirmDeletion=true to confirm you want to permanently delete these decks AND all cards in them. This cannot be undone!",
            warning:
              "This will permanently delete ALL cards in the specified decks. Ensure you have a recent backup.",
          },
        );
      }

      // ── Validate input ─────────────────────────────────────────────
      if (!decks || decks.length === 0) {
        throw new Error("At least one deck name is required");
      }

      const normalizedDecks = decks.map((d) => d.trim()).filter(Boolean);
      if (normalizedDecks.length === 0) {
        throw new Error("No valid deck names provided after trimming");
      }

      // ── Check which decks exist ────────────────────────────────────
      const existingDecks = await this.ankiClient.invoke<string[]>("deckNames");
      const existingSet = new Set(existingDecks);

      const validDecks = normalizedDecks.filter((d) => existingSet.has(d));
      const notFound = normalizedDecks.filter((d) => !existingSet.has(d));

      if (validDecks.length === 0) {
        return {
          success: true,
          deletedDecks: [],
          notFound,
          cardsAlsoDeleted: false,
          message: `None of the specified deck(s) were found: ${notFound.join(", ")}`,
          hint: "Check deck names with listDecks and try again.",
        };
      }

      // ── When cardsToo=false, check for non-empty decks ─────────────
      let skippedNonEmpty: string[] = [];
      let decksToDelete = validDecks;

      if (!cardsToo) {
        // Query each deck to see if it has cards
        const nonEmptyDecks: string[] = [];
        for (const deckName of validDecks) {
          const escapedName = deckName.includes(" ")
            ? `"${deckName}"`
            : deckName;
          const cardIds = await this.ankiClient.invoke<number[]>("findCards", {
            query: `deck:${escapedName}`,
          });
          if (cardIds.length > 0) {
            nonEmptyDecks.push(deckName);
          }
        }

        if (nonEmptyDecks.length > 0) {
          skippedNonEmpty = nonEmptyDecks;
          decksToDelete = validDecks.filter((d) => !nonEmptyDecks.includes(d));

          if (decksToDelete.length === 0) {
            return {
              success: true,
              deletedDecks: [],
              notFound,
              skippedNonEmpty,
              cardsAlsoDeleted: false,
              message: `None of the specified deck(s) are empty. Skipped: ${skippedNonEmpty.join(", ")}`,
              hint: "Set cardsToo=true and confirmDeletion=true to delete decks that contain cards. Or use renameDeck if you want to reorganize.",
            };
          }
        }
      }

      // ── Execute deletion ───────────────────────────────────────────
      await this.ankiClient.invoke<null>("deleteDecks", {
        decks: decksToDelete,
        cardsToo,
      });

      this.logger.log(`Deleted ${decksToDelete.length} deck(s)`);

      // ── Build response ─────────────────────────────────────────────
      const parts: string[] = [];
      if (decksToDelete.length > 0) {
        parts.push(
          `Successfully deleted ${decksToDelete.length} deck(s): ${decksToDelete.join(", ")}`,
        );
        if (cardsToo) {
          parts.push("All cards in these decks were permanently deleted.");
        }
      }
      if (notFound.length > 0) {
        parts.push(
          `${notFound.length} deck(s) not found: ${notFound.join(", ")}`,
        );
      }
      if (skippedNonEmpty.length > 0) {
        parts.push(
          `${skippedNonEmpty.length} non-empty deck(s) skipped: ${skippedNonEmpty.join(", ")}`,
        );
      }

      return {
        success: true,
        deletedDecks: decksToDelete,
        notFound,
        skippedNonEmpty:
          skippedNonEmpty.length > 0 ? skippedNonEmpty : undefined,
        cardsAlsoDeleted: cardsToo && decksToDelete.length > 0,
        message: parts.join(" "),
        hint:
          skippedNonEmpty.length > 0
            ? "Non-empty decks were skipped. Set cardsToo=true and confirmDeletion=true to delete them with all their cards."
            : "Decks deleted. Sync with AnkiWeb to propagate changes.",
      };
    } catch (error) {
      this.logger.error("Failed to delete decks", error);
      return createErrorResponse(error, {
        action: "deleteDecks",
        requestedDecks: decks,
        hint: "Make sure Anki is running and the deck names are correct.",
      });
    }
  }
}
