import { COMPONENTS_V2_FLAG, V2CardBuilder } from "../../utils/componentsV2.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { requireOwnerOrHalfOwner } from "../../events/messageCreate.js";
import { getAllPremiumUsers } from "../../premium/store.js";
import { premiumEmbed, infoEmbed } from "../../utils/embeds.js";

// Discord embed description limiti 4096 karakter; payı güvenli tutuyoruz.
const CHUNK_CHAR_LIMIT = 3800;
// Bir mesajda en fazla 10 embed gönderilebilir (Discord limiti).
const MAX_EMBEDS = 10;

// Owner VEYA half-owner kullanabilir (bkz. !halfowner) — salt okunur, kimseye
// zarar vermez.
const command: Command = {
  name: "premium-liste",
  aliases: ["premiumliste", "premium-list", "premiumlist"],
  description: "Tüm premium kullanıcıları listeler (owner ve half-owner kullanabilir)",
  usage: "!premium-liste",
  category: "owner",

  async execute(message: Message) {
    if (!(await requireOwnerOrHalfOwner(message))) return;

    const users = await getAllPremiumUsers();
    if (users.length === 0) {
      await message
        .reply({ flags: COMPONENTS_V2_FLAG, components: [infoEmbed("Premium Listesi", "Şu anda hiç premium üye yok.")] })
        .catch(() => null);
      return;
    }

    const lines = users.map(
      (u, i) =>
        `\`${i + 1}.\` <@${u.userId}> — veren: <@${u.grantedBy}> • <t:${Math.floor(u.grantedAt.getTime() / 1000)}:d>`,
    );

    // Uzun listeyi birden fazla embed'e böl (her biri Discord'un tek embed
    // description limitinin altında kalacak şekilde).
    const chunks: string[] = [];
    let current = "";
    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length > CHUNK_CHAR_LIMIT) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);

    const shownChunks = chunks.slice(0, MAX_EMBEDS);
    const shownCount = shownChunks.reduce((sum, c) => sum + c.split("\n").length, 0);
    const truncated = shownCount < users.length;

    const components = shownChunks.map((chunk, i) =>
      premiumEmbed(
        i === 0 ? `Premium Listesi — Toplam: ${users.length}` : `Premium Listesi (devam ${i + 1}/${shownChunks.length})`,
        chunk,
        truncated && i === shownChunks.length - 1
          ? { footer: `${users.length} premium üyeden ilk ${shownCount} tanesi gösteriliyor (mesaj limiti nedeniyle).` }
          : undefined,
      ),
    );

    await message.reply({ flags: COMPONENTS_V2_FLAG, components }).catch(() => null);
  },
};

export default command;
