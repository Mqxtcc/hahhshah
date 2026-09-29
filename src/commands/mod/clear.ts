import { COMPONENTS_V2_FLAG, errorCard, textCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, TextChannel, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { EMOJIS } from "../../utils/emojis.js";
import { parseMention } from "../../utils/parse.js";
import { hasPermission } from "../../utils/permissions.js";
import { OWNER_ID } from "../../config.js";
import { markPermissionDenied } from "../../utils/notifyOwner.js";
import { NO_PING, msg } from "./_shared.js";
import { addSlash } from "../../utils/slashBridge.js";

const BULK_DELETE_CHUNK = 100;
const MAX_CLEAR_AMOUNT = 1501;
const MAX_USER_SCAN = 10_000;
const RESULT_DELETE_DELAY = 5_000;

type DeleteResult = {
  deleted: number;
  skippedOld: number;
  failed: boolean;
};

async function deleteIds(channel: TextChannel, ids: string[]): Promise<DeleteResult> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += BULK_DELETE_CHUNK) {
    chunks.push(ids.slice(i, i + BULK_DELETE_CHUNK));
  }

  // Chunk'ları paralel gönderiyoruz (discord.js istekleri kendi rate-limit
  // kuyruğundan geçirdiği için sıralı beklemekten çok daha hızlı olur).
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const result = await channel.bulkDelete(chunk, true);
        return { deleted: result.size, skippedOld: chunk.length - result.size, failed: false };
      } catch {
        return { deleted: 0, skippedOld: 0, failed: true };
      }
    }),
  );

  return results.reduce(
    (acc, r) => ({
      deleted: acc.deleted + r.deleted,
      skippedOld: acc.skippedOld + r.skippedOld,
      failed: acc.failed || r.failed,
    }),
    { deleted: 0, skippedOld: 0, failed: false },
  );
}

async function fetchMessageIds(
  channel: TextChannel,
  amount: number,
  predicate?: (message: Message) => boolean,
): Promise<{ ids: string[]; scanned: number; reachedEnd: boolean }> {
  const ids: string[] = [];
  let scanned = 0;
  let before: string | undefined;

  while (scanned < amount) {
    const limit = Math.min(BULK_DELETE_CHUNK, amount - scanned);
    const batch = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });

    if (batch.size === 0) {
      return { ids, scanned, reachedEnd: true };
    }

    for (const msg of batch.values()) {
      if (!predicate || predicate(msg)) ids.push(msg.id);
    }

    scanned += batch.size;
    const oldest = batch.last();
    if (!oldest || batch.size < limit) {
      return { ids, scanned, reachedEnd: true };
    }
    before = oldest.id;
  }

  return { ids, scanned, reachedEnd: false };
}

function formatResult(
  result: DeleteResult,
  requested: number,
  scanned: number,
  targetMention?: string,
  reachedEnd = false,
): string {
  const targetText = targetMention ? ` (${targetMention})` : "";
  let text = `${EMOJIS.success} **${result.deleted}** mesaj silindi${targetText}.`;

  if (targetMention) {
    text += ` Son **${scanned}** mesaj tarandı, bunlardan **${result.deleted}** tanesi silindi.`;
    if (result.deleted < requested && reachedEnd) {
      text += " Daha fazla mesaj bulunamadı.";
    }
  } else if (result.skippedOld > 0) {
    text += ` ${result.skippedOld} mesaj 14 günden eski olduğu için atlandı.`;
  }

  if (result.failed) {
    text += " Bazı mesajlar silinemedi; yetkileri kontrol et.";
  }

  return text;
}

const command: Command = {
  name: "clear",
  aliases: ["sil", "purge", "temizle"],
  description: "Kanaldaki mesajları toplu siler; isteğe bağlı kullanıcı filtresi destekler",
  usage: "!clear <1-1000> [@kullanıcı|id]  (sıra fark etmez: !clear @kullanıcı 100)",
  category: "mod",

  async execute(message: Message, args: string[]) {
    if (!message.guild || !message.member) return;

    // BUGFIX: önceden sadece OWNER_ID / Mesajları Yönet kabul ediliyordu;
    // !izin ile verilen "clear" yetkisi de artık geçerli.
    const isOwner = message.author.id === OWNER_ID;
    const granted = await hasPermission(message, "clear");
    if (!isOwner && !granted && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      markPermissionDenied(message, "Mesajları Yönet yetkisi yok (clear)");
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorCard({ description: msg.err("Bu komut için **Mesajları Yönet** yetkin yok. Admin: `!izin clear @sen`") })],
        ...NO_PING,
      });
      return;
    }

    if (!message.channel.isTextBased() || !("bulkDelete" in message.channel)) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorCard({ description: msg.err("Bu komut yalnızca metin kanallarında kullanılabilir.") })],
        ...NO_PING,
      });
      return;
    }

    // Arg sırası esnek: "!clear 100 @kullanıcı" veya "!clear @kullanıcı 100"
    // ikisi de çalışır. Sayısal argüman = miktar, mention/ID = hedef.
    let rawAmount: string | undefined;
    let targetId: string | undefined;
    for (const a of args) {
      const asMention = parseMention(a);
      if (asMention && !targetId) {
        targetId = asMention;
        continue;
      }
      if (/^\d+$/.test(a) && !rawAmount) {
        rawAmount = a;
      }
    }
    if (!targetId) targetId = message.mentions.users.first()?.id;

    if (!rawAmount) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [msg.usageEmbed(`Kullanım: \`!clear <1-${MAX_CLEAR_AMOUNT}> [@kullanıcı]\` veya \`!clear [@kullanıcı] <1-${MAX_CLEAR_AMOUNT}>\``)],
        ...NO_PING,
      });
      return;
    }

    const amount = Number(rawAmount);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_CLEAR_AMOUNT) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: textCard(`${EMOJIS.warn} Miktar **1** ile **${MAX_CLEAR_AMOUNT}** arasında olmalı.`),
        ...NO_PING,
      });
      return;
    }

    const channel = message.channel as TextChannel;
    const botMember = message.guild.members.me;
    if (!botMember?.permissionsIn(channel).has(PermissionFlagsBits.ManageMessages)) {
      await message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorCard({ description: msg.err("Botun bu kanalda **Mesajları Yönet** yetkisi yok.") })],
        ...NO_PING,
      });
      return;
    }

    const targetUser = targetId ? await message.client.users.fetch(targetId).catch(() => null) : null;

    await message.delete().catch(() => undefined);

    const sendResult = async (text: string) => {
      const reply = await channel.send({ flags: COMPONENTS_V2_FLAG, components: textCard(text) });
      setTimeout(() => reply.delete().catch(() => undefined), RESULT_DELETE_DELAY);
    };

    try {
      if (targetUser) {
        const scanLimit = Math.min(MAX_USER_SCAN, Math.max(amount, amount * 10));
        const fetched = await fetchMessageIds(channel, scanLimit, (m) => m.author.id === targetUser.id);
        // GÜVENLİK: hedef modunda bile asla istenen miktardan fazla silinemez.
        const idsToDelete = fetched.ids.slice(0, amount);
        const deleteResult = await deleteIds(channel, idsToDelete);
        await sendResult(
          formatResult(deleteResult, amount, fetched.scanned, targetUser.toString(), fetched.reachedEnd),
        );
        return;
      }

      const fetched = await fetchMessageIds(channel, amount);
      const deleteResult = await deleteIds(channel, fetched.ids);
      await sendResult(formatResult(deleteResult, amount, fetched.scanned, undefined, fetched.reachedEnd));
    } catch {
      await sendResult(msg.err("Mesajlar silinirken hata oluştu. Botun **Mesajları Yönet** yetkisini kontrol et."));
    }
  },
};


addSlash(command, [
  { name: "miktar", description: "Silinecek mesaj sayısı (1-1000)", type: "integer", required: true, minValue: 1, maxValue: 1000 },
  { name: "kullanici", description: "Sadece bu kullanıcının mesajlarını sil", type: "user" },
]);

export default command;
