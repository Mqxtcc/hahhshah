import type { Client } from "discord.js";
import { ActivityType } from "discord.js";
import { reportRestartDone } from "../commands/restart.js"; // kendi dosya yoluna göre düzelt
import { vestAllMatured } from "../invites/store.js";
import { loadPendingReminders } from "../utils/reminders.js";
import { reconcileTimedRoles } from "../timedroles/store.js";
import { reconcileRoleMenus } from "../rolemenu/store.js";
import { runDataHygiene } from "../utils/hygiene.js";

export function readyEvent(client: Client<true>): void {
  console.log(`✅ bot açık: ${client.user.tag}`);
  console.log("── son işler ──");

  reportRestartDone(client).catch((err) => {
    console.error("restart raporu çalışmadı:", err);
  });

  // ⏰ Kalıcı hatırlatıcılar: açılışta bekleyenleri yükle + zamanla.
  loadPendingReminders(client).catch((err) => {
    console.error("hatırlatıcılar yüklenemedi:", err);
  });

  // 🎁 Davet ödülleri: süresi dolmuş bekleyen davetleri günde bir kez
  // hak kazandır (açılıştan 1 dk sonra ilk tur).
  const vestOnce = () => {
    void vestAllMatured(client).catch((err) => {
      console.error("davet hak dağıtımı patladı:", err);
    });
  };
  const vestTimeout = setTimeout(vestOnce, 60_000);
  vestTimeout.unref?.();
  const vestTimer = setInterval(vestOnce, 24 * 60 * 60 * 1000);
  vestTimer.unref?.();

  const updateActivity = () => {
    client.user.setPresence({
      status: "online", // online | idle | dnd
      activities: [
        {
          name: "!help & V8.82",
          type: ActivityType.Watching, // "İzliyor" yazısı bunun için
        },
      ],
    });
  };

  updateActivity();
  const presenceTimer = setInterval(updateActivity, 60_000);
  presenceTimer.unref?.();

  // ⏱️ Süreli roller: açılışta vadesi gelenleri düşür, kalanları zamanla.
  void reconcileTimedRoles(client).catch((err) => {
    console.error("süreli rol uzlaşması patladı:", err);
  });

  // 🎭 Rol menüleri: silinmiş menü mesajlarını yeniden gönder.
  void reconcileRoleMenus(client).catch((err) => {
    console.error("rol menüsü uzlaşması patladı:", err);
  });

  // 🧹 Veri hijyeni: kaldırılan özelliklerin ölü tablo/satırlarını temizle.
  void runDataHygiene().catch((err) => {
    console.error("temizlik patladı:", err);
  });
}
