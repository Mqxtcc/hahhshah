import type {
  ChatInputCommandInteraction,
  Message,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

type AnySlashData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder
  | Omit<SlashCommandBuilder, "addSubcommand" | "addSubcommandGroup">;

export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  category: "mod" | "rol" | "fun" | "genel" | "admin" | "owner";
  execute: (message: Message, args: string[]) => Promise<unknown>;
  /** Slash komut desteği (isteğe bağlı) */
  slashData?: AnySlashData;
  slashExecute?: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
  /**
   * Slash'e kayıtlı ad (Türkçe karakterler dönüştürülmüş hali, örn. "çiz" -> "ciz").
   * addSlash() tarafından otomatik doldurulur; dispatch bu adla da bulunur.
   */
  slashName?: string;
}
