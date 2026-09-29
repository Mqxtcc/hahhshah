import { COMPONENTS_V2_FLAG, V2CardBuilder } from "../../utils/componentsV2.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { OWNER_ID } from "../../config.js";
import { errorEmbed } from "../../utils/embeds.js";
import { attachAutomodPanel } from "./otomodPanel.js";
import { addSlash } from "../../utils/slashBridge.js";

// ---------------------------------------------------------------------------
// Otomod yönetimi: SADECE dashboard + `!otomod` paneli üzerinden yapılır.
// Bütün alt komutlar (kelime ekle/sil, koruma aç/kapat, ceza eşik/süre,
// log, muaf rol vb.) kaldırıldı — hepsi interaktif panelden yönetiliyor.
// ---------------------------------------------------------------------------

const command: Command = {
  name: "otomod",
  aliases: ["automod"],
  description: "Otomod kontrol merkezini açar",
  usage: "!otomod",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;

    const isServerOwner = message.author.id === message.guild.ownerId;
    const isBotOwner = message.author.id === OWNER_ID;

    if (!isServerOwner && !isBotOwner) {
      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorEmbed("Yetkin Yok", "Bu komutu yalnızca sunucu sahibi kullanabilir.")],
      });
    }

    void args;
    return attachAutomodPanel(message, message.guild.id);
  },
};


addSlash(command, []);

export default command;
