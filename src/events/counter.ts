import { Client, Events } from "discord.js";
import { refreshCounterFor, reconcileAllCounters } from "../counter/store.js";

/**
 * 📊 Sayaç olayları: üye girip çıktıkça sayaç kanalının adını tazeler,
 * açılışta da tüm sayaçları elden geçirir (restart sonrası güncel kalsın).
 */
export function registerCounterEvents(client: Client): void {
  client.on(Events.GuildMemberAdd, (member) => {
    void refreshCounterFor(client, member.guild.id);
  });
  client.on(Events.GuildMemberRemove, (member) => {
    void refreshCounterFor(client, member.guild.id);
  });
  client.once(Events.ClientReady, () => {
    void reconcileAllCounters(client).catch((err) => {
      console.error("[sayaç] açılış taraması patladı:", err);
    });
  });
  console.log("[sayaç] dinleyici bağlandı");
}
