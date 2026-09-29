import { resolveEmojis, textCard } from "../utils/componentsV2.js";
import { MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type Message,
} from "discord.js";
import type { Command } from "../types.js";
import { infoEmbed, errorEmbed } from "../utils/embeds.js";
import { addNote, listNotes, deleteNote, countNotes, MAX_NOTES_PER_USER, MAX_NOTE_LENGTH } from "../notes/store.js";
import { addSlash } from "../utils/slashBridge.js";

export const notEkle: Command = {
  name: "not",
  aliases: ["notekle", "note"],
  description: "Kendine özel bir not kaydedersin (sadece sen görürsün)",
  usage: "!not <metin>  →  silmek için: !not sil <no>",
  category: "genel",

  async execute(message: Message, args: string[]) {
    const sub = (args[0] ?? "").toLocaleLowerCase("tr-TR");

    if (sub === "sil" || sub === "delete") {
      const id = parseInt(args[1] ?? "", 10);
      if (isNaN(id)) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hatalı Kullanım", `Hangi not? Kullanım: \`!not sil <no>\` (numarayı \`!notlar\`da görürsün)`)] });
      }
      const ok = await deleteNote(message.author.id, id).catch(() => false);
      if (!ok) {
        return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Bulunamadı", "Bu numarada sana ait bir not yok.")] });
      }
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [infoEmbed("🗑️ Not Silindi", `#${id} numaralı not silindi.`)] });
    }

    const text = args.join(" ").trim().slice(0, MAX_NOTE_LENGTH);
    if (!text) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hatalı Kullanım", `Boş not kaydedemem. Kullanım: \`${notEkle.usage}\``)] });
    }
    const count = await countNotes(message.author.id).catch(() => 0);
    if (count >= MAX_NOTES_PER_USER) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [errorEmbed("Dolu", `En fazla ${MAX_NOTES_PER_USER} not tutabilirsin. Eskilerden silmek için \`!notlar\`.`)],
      });
    }
    const note = await addNote(message.author.id, text).catch(() => null);
    if (!note) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [errorEmbed("Hata", "Not kaydedilemedi, bir daha dene.")] });
    }
    return message.reply({
      flags: MessageFlags.IsComponentsV2, components: [infoEmbed("📝 Not Kaydedildi", `#${note.id}: ${text.slice(0, 300)}`)] });
  },
};

export const notlar: Command = {
  name: "notlar",
  aliases: ["notlarım", "notes", "notlistesi"],
  description: "Kaydettiğin notları listeler (butonla silebilirsin)",
  usage: "!notlar",
  category: "genel",

  async execute(message: Message) {
    const notes = await listNotes(message.author.id).catch(() => []);
    if (notes.length === 0) {
      return message.reply({
      flags: MessageFlags.IsComponentsV2,
        components: [infoEmbed("📝 Notların", "Henüz notun yok. `!not <metin>` ile ilk notunu kaydet.")],
      });
    }

    const desc = notes
      .slice(0, 10)
      .map((n) => {
        const date = new Date(n.createdAt).toLocaleDateString("tr-TR");
        return `**#${n.id}** (${date})\n${n.content.slice(0, 200)}`;
      })
      .join("\n\n");

    const buttons = notes.slice(0, 5).map((n) =>
      new ButtonBuilder()
        .setCustomId(`notsil:${message.author.id}:${n.id}`)
        .setLabel(resolveEmojis(`#${n.id} sil`))
        .setStyle(ButtonStyle.Danger),
    );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

    const reply = await message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [infoEmbed(
          `📝 Notların (${notes.length})`,
          notes.length > 10 ? `${desc}\n\n_...ilk 10 gösteriliyor_` : desc,
        ), row],
    });

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 120_000,
    });

    collector.on("collect", (interaction) => {
      void (async () => {
        const [, ownerId, idStr] = interaction.customId.split(":");
        if (interaction.user.id !== ownerId) {
          await interaction.reply({
      flags: MessageFlags.IsComponentsV2, components: textCard("Bunlar senin notların değil 😏"), ephemeral: true }).catch(() => null);
          return;
        }
        const ok = await deleteNote(ownerId, parseInt(idStr, 10)).catch(() => false);
        await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
          components: textCard(ok ? `🗑️ #${idStr} silindi.` : "Zaten silinmiş."),
          ephemeral: true,
        }).catch(() => null);
        if (ok) {
          // Listeyi tazele
          const fresh = await listNotes(ownerId).catch(() => []);
          if (fresh.length === 0) {
            await reply.edit({
      flags: MessageFlags.IsComponentsV2,
              components: [infoEmbed("📝 Notların", "Hiç notun kalmadı."), ],
            }).catch(() => null);
            collector.stop();
            return;
          }
          const freshDesc = fresh.slice(0, 10).map((n) => {
            const date = new Date(n.createdAt).toLocaleDateString("tr-TR");
            return `**#${n.id}** (${date})\n${n.content.slice(0, 200)}`;
          }).join("\n\n");
          const freshBtns = fresh.slice(0, 5).map((n) =>
            new ButtonBuilder()
              .setCustomId(`notsil:${ownerId}:${n.id}`)
              .setLabel(resolveEmojis(`#${n.id} sil`))
              .setStyle(ButtonStyle.Danger),
          );
          await reply.edit({
      flags: MessageFlags.IsComponentsV2,
            components: [infoEmbed(`📝 Notların (${fresh.length})`, freshDesc), new ActionRowBuilder<ButtonBuilder>().addComponents(freshBtns)],
          }).catch(() => null);
        }
      })().catch(() => null);
    });

    collector.on("end", () => {
      void reply.edit({
      flags: MessageFlags.IsComponentsV2, components: [] }).catch(() => null);
    });

    return null;
  },
};

addSlash(
  notEkle,
  [{ name: "metin", description: "Kaydedilecek not", type: "string", required: true }],
  (v) => [v.str("metin") ?? ""],
);
addSlash(notlar, []);
