import { v2Payload } from "../utils/messages.js";
import { ChannelType, Client, Events, type GuildMember, type PartialGuildMember } from "discord.js";
import { getGuildWelcomeConfig } from "../welcome/store.js";
import { renderWelcomeMessage } from "../welcome/render.js";

// index.ts'te şöyle çağrılmalı:
//   import { registerWelcomeEvents } from "./events/welcome.js";
//   registerWelcomeEvents(client);
export function registerWelcomeEvents(client: Client): void {
  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    try {
      const cfg = await getGuildWelcomeConfig(member.guild.id);
      if (!cfg.enabled || !cfg.channelId || !cfg.message) return;

      const channel = await member.guild.channels.fetch(cfg.channelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) return;

      const content = renderWelcomeMessage(cfg.message, member);
      const full = cfg.welcomeImage ? `${content}\n${cfg.welcomeImage}` : content;
      await channel.send(v2Payload({ content: full, allowedMentions: { users: [member.id] } })).catch((err) => {
        console.error("hoşgeldin mesajı gitmedi:", err);
      });
    } catch (err) {
      console.error("hoşgeldin patladı:", err);
    }
  });

  // 👋 Görüşürüz mesajı: aynı hoşgeldin kanalına, üye ayrıldığında atılır.
  // leaveMessage ayarlanmamışsa (null) hiçbir şey göndermez — opsiyoneldir.
  client.on(Events.GuildMemberRemove, async (member: GuildMember | PartialGuildMember) => {
    try {
      const cfg = await getGuildWelcomeConfig(member.guild.id);
      if (!cfg.enabled || !cfg.channelId || !cfg.leaveMessage) return;

      const channel = await member.guild.channels.fetch(cfg.channelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) return;

      // GuildMemberRemove partial gelebilir ama .user ve .guild her zaman doludur;
      // renderWelcomeMessage sadece bunlara ihtiyaç duyduğu için sorunsuz çalışır.
      const content = renderWelcomeMessage(cfg.leaveMessage, member as GuildMember);
      const full = cfg.leaveImage ? `${content}\n${cfg.leaveImage}` : content;
      // Ayrılan üyeyi mention etmenin bildirim göndermesi için allowedMentions'a
      // dahil etmiyoruz; kişi zaten sunucuda değil, yine de metinde {kullanici}
      // olarak görünmesi (etiketlenmeden) yeterli.
      await channel.send(v2Payload({ content: full, allowedMentions: { parse: [] } })).catch((err) => {
        console.error("görüşürüz mesajı gitmedi:", err);
      });
    } catch (err) {
      console.error("görüşürüz patladı:", err);
    }
  });
}
