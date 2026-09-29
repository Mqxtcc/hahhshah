import type { Client } from "discord.js";

/**
 * Reports pending changelog for restart.
 * Called after bot ready event to notify about changes made before restart.
 */
export async function reportPendingChangelog(client: Client): Promise<void> {
  // Placeholder implementation - add changelog logic here if needed
  return Promise.resolve();
}
