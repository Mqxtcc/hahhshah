import { COMPONENTS_V2_FLAG, V2CardBuilder } from "../../utils/componentsV2.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import {
  requireOwner,
  resolveTargetUserId,
  getGuildPrefix,
  OWNER_ID,
} from "../../events/messageCreate.js";
import {
  addHalfOwner,
  removeHalfOwner,
  listHalfOwnerIds,
  ensureHalfOwnersLoaded,
} from "../../premium/halfOwners.js";
import { warningEmbed, infoEmbed, successEmbed } from "../../utils/embeds.js";

// Half-owner: bot sahibinin, GERİ ALINABİLİR ve zararsız birkaç owner
// yetkisini devrettiği kişi. Şu an half-owner'ların erişebildiği komutlar:
//   • !premium        — premium verir
//   • !premium-kaldir — premium geri alır
//   • !premium-liste  — premium listesini görür (salt okunur)
//   • !özelüye        — VIP rozeti verir/alır
//   • !hata-log       — son hataları görür (salt okunur)
//   • !console-log     — konsol çıktısını görür (salt okunur)
//   • !veribak        — veritabanını görüntüler (salt okunur)
// Half-owner'lar eval/restart/modeller/ownerrole/halfowner gibi
// TEHLİKELİ hiçbir owner komutuna ASLA erişemez — bu komutların hepsi
// doğrudan OWNER_ID kontrolü yapıyor, half-owner listesine hiç bakmıyor.
// Bu komutun kendisi de owner-only: half-owner başka bir half-owner
// ekleyemez/çıkaramaz, kendi yetkisini genişletemez.
const command: Command = {
  name: "halfowner",
  aliases: ["yariyetkili", "halfowners"],
  description:
    "Premium ve VIP yönetimi yetkisine sahip half-owner ekler/çıkarır/listeler (owner-only)",
  usage: "!halfowner ekle|sil|liste [@kullanıcı]",
  category: "owner",

  async execute(message: Message, args: string[]) {
    if (!(await requireOwner(message))) return;

    const prefix = getGuildPrefix(message.guild?.id);
    const sub = args[0]?.toLocaleLowerCase("tr-TR");

    if (
      !sub ||
      !["ekle", "add", "sil", "kaldir", "remove", "liste", "list"].includes(sub)
    ) {
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            warningEmbed(
              "Eksik kullanım",
              [
                `Kullanım:`,
                `\`${prefix}halfowner ekle @kullanıcı\``,
                `\`${prefix}halfowner sil @kullanıcı\``,
                `\`${prefix}halfowner liste\``,
                ``,
                `Half-owner'lar şunları yapabilir: \`${prefix}premium\`, \`${prefix}premium-kaldir\`, \`${prefix}premium-liste\`, \`${prefix}özelüye\`, \`${prefix}hata-log\`, \`${prefix}konsol-log\`, \`${prefix}veribak\`. Bunların dışında (restart, eval, modeller, ownerrole, half-owner ekleme/çıkarma vb.) HİÇBİR owner komutuna erişemezler.`,
              ].join("\n"),
            ),
          ],
        })
        .catch(() => null);
      return;
    }

    if (sub === "liste" || sub === "list") {      await ensureHalfOwnersLoaded();
      const ids = listHalfOwnerIds();
      if (ids.length === 0) {
        await message
          .reply({
            flags: COMPONENTS_V2_FLAG,
            components: [
              infoEmbed("Half-Owner Listesi", "Henüz hiç half-owner yok."),
            ],
          })
          .catch(() => null);
        return;
      }
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            infoEmbed(
              `Half-Owner Listesi — Toplam: ${ids.length}`,
              ids.map((id, i) => `\`${i + 1}.\` <@${id}>`).join("\n"),
            ),
          ],
        })
        .catch(() => null);
      return;
    }

    const targetId = resolveTargetUserId(message, args.slice(1));
    if (!targetId) {
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            warningEmbed(
              "Eksik kullanım",
              `Kullanım: \`${prefix}halfowner ${sub} @kullanıcı\``,
            ),
          ],
        })
        .catch(() => null);
      return;
    }

    if (targetId === OWNER_ID) {
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            warningEmbed(
              "Geçersiz hedef",
              "Bot sahibi zaten tüm yetkilere sahip, half-owner yapılamaz.",
            ),
          ],
        })
        .catch(() => null);
      return;
    }

    if (sub === "ekle" || sub === "add") {
      const added = await addHalfOwner(targetId, message.author.id);
      if (!added) {
        await message
          .reply({
            flags: COMPONENTS_V2_FLAG,
            components: [
              warningEmbed(
                "Zaten half-owner",
                `<@${targetId}> zaten half-owner.`,
              ),
            ],
          })
          .catch(() => null);
        return;
      }
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            successEmbed(
              "Half-Owner Eklendi",
              `<@${targetId}> artık **half-owner**. \`${prefix}premium\`, \`${prefix}premium-kaldir\`, \`${prefix}premium-liste\`, \`${prefix}özelüye\`, \`${prefix}hata-log\`, \`${prefix}konsol-log\`, \`${prefix}veribak\` komutlarını kullanabilir — başka hiçbir owner yetkisi yok.`,
              {
                fields: [
                  {
                    name: "👤 Half-Owner",
                    value: `<@${targetId}>`,
                    inline: true,
                  },
                  {
                    name: "🎁 Ekleyen",
                    value: `${message.author}`,
                    inline: true,
                  },
                ],
              },
            ),
          ],
        })
        .catch(() => null);
      return;
    }

    // sil / kaldir / remove
    const removed = await removeHalfOwner(targetId);
    if (!removed) {
      await message
        .reply({
          flags: COMPONENTS_V2_FLAG,
          components: [
            warningEmbed(
              "Half-owner değil",
              `<@${targetId}> zaten half-owner değil.`,
            ),
          ],
        })
        .catch(() => null);
      return;
    }
    await message
      .reply({
        flags: COMPONENTS_V2_FLAG,
        components: [
          infoEmbed(
            "Half-Owner Kaldırıldı",
            `<@${targetId}> kişisinin half-owner yetkisi geri alındı.`,
          ),
        ],
      })
      .catch(() => null);
  },
};

export default command;
