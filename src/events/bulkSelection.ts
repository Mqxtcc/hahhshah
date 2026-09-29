import type { Interaction } from "discord.js";

/**
 * Panel "toplu silme" akışı için geçici seçim state'i.
 * interactionCreate.ts içinden ayrıldı — dosya boyutunu ve yan etki riskini
 * azaltmak için.
 */

const bulkDeleteSelections = new Map<
  string,
  { channels: string[]; roles: string[] }
>();
const bulkSelectionLastTouched = new Map<string, number>();
const BULK_SELECTION_TTL_MS = 15 * 60_000;

export function bulkSelectionKey(interaction: Interaction): string {
  return `${interaction.guildId ?? "dm"}:${interaction.user.id}`;
}

export function getBulkSelection(
  key: string,
): { channels: string[]; roles: string[] } | undefined {
  return bulkDeleteSelections.get(key);
}

export function saveBulkSelection(
  key: string,
  selection: { channels: string[]; roles: string[] },
): void {
  bulkDeleteSelections.set(key, selection);
  bulkSelectionLastTouched.set(key, Date.now());
}

export function deleteBulkSelection(key: string): void {
  bulkDeleteSelections.delete(key);
  bulkSelectionLastTouched.delete(key);
}

const bulkSelectionCleanup = setInterval(() => {
  const cutoff = Date.now() - BULK_SELECTION_TTL_MS;
  for (const [key, touchedAt] of bulkSelectionLastTouched) {
    if (touchedAt < cutoff) deleteBulkSelection(key);
  }
}, BULK_SELECTION_TTL_MS);
bulkSelectionCleanup.unref?.();
