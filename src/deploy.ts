import { REST, Routes } from "discord.js";
import type { Command } from "./types.js";

/**
 * Slash komutlarını Discord'a kaydeder.
 *
 * Komutlar bot hazır olmadan da REST üzerinden kaydedilebilir; ancak client
 * ID'sini token'ın ilk parçasından çıkarmak kırılgan ve hata ayıklaması zor.
 * Ready event'inden gelen clientId'yi tercih ediyoruz. `SLASH_GUILD_ID`
 * (veya mevcut kurulumlarda kullanılan `GUILD_ID`) verilirse komutlar anında
 * o sunucuya, verilmezse global olarak kaydedilir.
 */
export async function deploySlashCommands(
  token: string,
  commands: Command[],
  clientId: string,
): Promise<void> {
  const slashCommands = commands
    .filter((c) => c.slashData != null)
    .map((c) => c.slashData!.toJSON());

  if (slashCommands.length === 0) return;

  const rest = new REST({ version: "10" }).setToken(token);
  const guildId = (process.env.SLASH_GUILD_ID ?? process.env.GUILD_ID)?.trim();
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  const scopeLabel = guildId ? `sunucu (${guildId})` : "global";

  console.log(`${slashCommands.length} slash komut kaydediliyor...`);
  try {
    await rest.put(route, { body: slashCommands });
    console.log(`${slashCommands.length} slash komut kaydedildi`);
  } catch (err: unknown) {
    console.error("slash komutlar kaydolmadı la:", err instanceof Error ? err.message : String(err));
  }
}
// PR dummy commit for submission
