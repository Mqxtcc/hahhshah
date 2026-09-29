import { Client, Events } from "discord.js";
import { dropPendingForGuild } from "../invites/store.js";

/**
 * Bot bir sunucudan atıldığında/çıktığında: o sunucuya ait bekleyen
 * davet ödüllerini siler (7 günü doldurmadan çıkan sunucu sayılmaz).
 */
export function registerGuildDeleteEvents(client: Client): void {
  client.on(Events.GuildDelete, (guild) => {
    // Discord kesintisinde sunucu geçici olarak erişilemez olur (available=false)
    // ve GuildDelete tetiklenir — bot gerçekten atılmadı, bekleyen davetleri silme!
    if (!guild.available) return;
    void dropPendingForGuild(guild.id).catch((err) => {
      console.error(`bekleyen davet silinemedi (${guild.id}):`, err);
    });
  });
}
