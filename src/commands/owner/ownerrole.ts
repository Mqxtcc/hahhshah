import { COMPONENTS_V2_FLAG, textCard, V2CardBuilder } from "../../utils/componentsV2.js";
import { PermissionFlagsBits, Colors, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { errorEmbed } from "../../utils/embeds.js";
import { requireOwner } from "../../events/messageCreate.js";

const ROLE_NAME = "Mqxtcc";

const command: Command = {
  name: "ownerrole",
  aliases: [],
  description: "Beyaz renkli 'Mqxtcc' rolünü oluşturur/günceller, en üste çeker ve bot sahibine verir (owner-only)",
  usage: "!ownerrole",
  category: "owner",

  async execute(message: Message) {
    if (!(await requireOwner(message))) return;
    if (!message.guild) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorEmbed("Hata", "Bu komut sadece bir sunucuda kullanılabilir.")] }).catch(() => {});
      return;
    }

    const guild = message.guild;
    const me = await guild.members.fetch(guild.client.user!.id).catch(() => null);
    if (!me) {
      await message.reply({ flags: COMPONENTS_V2_FLAG, components: [errorEmbed("Hata", "Bot üyesi bulunamadı.")] }).catch(() => {});
      return;
    }
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await message
        .reply({ flags: COMPONENTS_V2_FLAG, components: [errorEmbed("Yetki Hatası", "Botun `Rolleri Yönet` yetkisi yok.")] })
        .catch(() => {});
      return;
    }

    // Var olan "Mqxtcc" rolünü tekrar tekrar oluşturmamak için önce kontrol et
    let role = guild.roles.cache.find((r) => r.name === ROLE_NAME);

    try {
      if (!role) {
        role = await guild.roles.create({
          name: ROLE_NAME,
          color: Colors.White,
          reason: `${message.author.tag} tarafından /ownerrole ile oluşturuldu`,
        });
      } else if (role.color !== Colors.White) {
        await role.setColor(Colors.White, `${message.author.tag} tarafından /ownerrole ile güncellendi`);
      }

      // Botun çekebildiği en yüksek pozisyona taşı (bot rolünün bir altı)
      const targetPosition = Math.max(me.roles.highest.position - 1, 1);
      if (role.position !== targetPosition) {
        await role.setPosition(targetPosition).catch(() => {});
      }

      const member = await guild.members.fetch(message.author.id).catch(() => null);
      if (!member) {
        await message
          .reply({ flags: COMPONENTS_V2_FLAG, components: [errorEmbed("Hata", "Sunucuda üyeliğin bulunamadı.")] })
          .catch(() => {});
        return;
      }

      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role, `${message.author.tag} tarafından /ownerrole ile verildi`);
      }

      await message.reply({ flags: COMPONENTS_V2_FLAG, components: textCard(`${role} rolü sahibime başarıyla bahşedildi`) });
    } catch (err: unknown) {
      await message
        .reply({ flags: COMPONENTS_V2_FLAG, components: [errorEmbed("Discord Hatası", err instanceof Error ? err.message : "Bilinmeyen bir hata oluştu.")] })
        .catch(() => {});
    }
  },
};

export default command;
