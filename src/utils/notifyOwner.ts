import { V2CardBuilder } from "./componentsV2.js";
import { v2Payload } from "./messages.js";
import type { Client, Guild, User } from "discord.js";
import { OWNER_ID } from "../config.js";
import { EMOJIS } from "./emojis.js";

// Owner çözümleme sonucu önbelleği: her komutta client.application.fetch()
// çağırmak gereksiz bir Discord API isteği demekti. 1 saat TTL'li cache.
let cachedOwner: User | null = null;
let cachedOwnerAt = 0;
const OWNER_CACHE_TTL_MS = 60 * 60_000;

async function resolveOwner(client: Client): Promise<User | null> {
  if (cachedOwner && Date.now() - cachedOwnerAt < OWNER_CACHE_TTL_MS) return cachedOwner;
  // Öncelik Discord Application owner bilgisinde; böylece eski/yanlış
  // OWNER_ID yüzünden bildirim başka hesaba gitmez.
  try {
    const application = await client.application?.fetch();
    const owner = application?.owner;
    if (owner && "send" in owner && typeof owner.send === "function") {
      cachedOwner = owner as User;
      cachedOwnerAt = Date.now();
      return cachedOwner;
    }
  } catch (error) {
    console.error("owner app bilgisinden çözülmedi:", error);
  }

  try {
    cachedOwner = await client.users.fetch(OWNER_ID);
    cachedOwnerAt = Date.now();
    return cachedOwner;
  } catch (error) {
    console.error(`owner (${OWNER_ID}) bulunamadı:`, error);
    return null;
  }
}

/** Yönetim/moderasyon ağırlıklı komutlar — rapor bu komutlarda turuncu/kırmızı vurgulu görünür. */
const SENSITIVE_COMMANDS = new Set([
  "ban", "kick", "timeout", "clear", "unban", "warn", "uyarilar", "setnick",
  "otomod", "guard", "izin", "logkanal",
]);

// ---------------------------------------------------------------------------
// Yetkisiz deneme işaretleme: bazı mod komutları (ör. ban.ts), gerçek bir
// hata fırlatmadan sadece "Yetkin Yok" cevabı verip erken return eder — bu
// yüzden dışarıdaki genel try/catch bunu "başarılı" sanır. Komutlar, erken
// dönmeden hemen önce markPermissionDenied(message, sebep) çağırarak bunu
// işaretleyebilir; messageCreate.ts execute'tan sonra consumePermissionDenied
// ile okuyup DM raporuna yansıtır. message.id anahtarlı, aynı tick içinde
// tüketildiği için birikip sızıntı yapmaz.
// ---------------------------------------------------------------------------
const deniedReasons = new Map<string, string>();

export function markPermissionDenied(message: { id: string }, reason: string): void {
  deniedReasons.set(message.id, reason);
}

export function consumePermissionDenied(message: { id: string }): string | undefined {
  const reason = deniedReasons.get(message.id);
  if (reason !== undefined) deniedReasons.delete(message.id);
  return reason;
}

/** Komut çalıştırıldığında owner'a kısa bir embed rapor DM'i gönderir.
 *
 * 9 sunuculu bir botta HER komut için DM atmak DM seline yol açar (ve Discord
 * DM rate-limit'ine takılır). Bu yüzden rutin başarılı komutlar raporlanmaz;
 * sadece şunlar bildirilir:
 *  - yetkisiz kullanım denemeleri (deniedReason),
 *  - hata ile sonuçlanan komutlar (!success),
 *  - hassas yönetim/moderasyon komutları (SENSITIVE_COMMANDS).
 */
export async function notifyOwnerCommandUsed(
  client: Client,
  params: {
    commandName: string;
    user: User;
    guild: Guild | null;
    success: boolean;
    source: "slash" | "prefix";
    /** Komutun argümanları — "!ban @kullanıcı 1d küfür" -> "@kullanıcı 1d küfür" */
    detail?: string;
    /** Komut yetki reddiyle sonuçlandıysa sebebi (bkz. markPermissionDenied). */
    deniedReason?: string;
  },
): Promise<void> {
  // Agent için siteye özel bildirim ayrı gönderilir; genel komut DM'iyle
  // aynı owner bildiriminin iki kez gitmesini önle.
  if (params.user.id === OWNER_ID || params.commandName === "agent" || params.commandName === "manus") return;

  // Rutin başarılı komutlarda owner'ı rahatsız etme — sadece yetkisiz
  // deneme, hata veya hassas komutlarda bildir.
  const sensitive = SENSITIVE_COMMANDS.has(params.commandName.toLowerCase());
  const noteworthy = params.deniedReason !== undefined || !params.success || sensitive;
  if (!noteworthy) return;

  try {
    const owner = await resolveOwner(client);
    if (!owner) return;

    const prefix = params.source === "slash" ? "/" : "!";
    const detail = params.detail?.trim();
    const color = params.deniedReason ? 0xed4245 : !params.success ? 0xed4245 : sensitive ? 0xfaa61a : 0x57f287;
    const titleIcon = params.deniedReason ? EMOJIS.alert : params.success ? EMOJIS.success : EMOJIS.error;

    const embed = new V2CardBuilder()
      .setColor(color)
      .setAuthor({ name: `${params.user.tag}`, iconURL: params.user.displayAvatarURL() })
      .setTitle(`${titleIcon} ${prefix}${params.commandName}`)
      .addFields(
        { name: "Kullanıcı", value: `<@${params.user.id}>\n\`${params.user.id}\``, inline: true },
        { name: "Sunucu", value: params.guild ? `${params.guild.name}\n\`${params.guild.id}\`` : "DM", inline: true },
        { name: "Kaynak", value: params.source === "slash" ? "Slash (/)" : "Prefix (!)", inline: true },
      )
      .setTimestamp();

    if (params.deniedReason) {
      embed.addFields({ name: `${EMOJIS.alert} Yetkisiz deneme`, value: params.deniedReason });
    }
    if (detail) {
      embed.addFields({ name: "Argümanlar", value: `\`\`\`${detail.slice(0, 950)}\`\`\`` });
    }
    if (!params.success && !params.deniedReason) {
      embed.setFooter({ text: "Komut hata ile sonuçlandı" });
    }

    await owner.send(v2Payload({ components: [embed] }));
  } catch (error) {
    console.error("owner'a dm gitmedi (komut):", error);
  }
}

/**
 * Manus görevi oluşturulur oluşturulmaz sohbet bağlantısını yalnızca owner'a DM yollar.
 * Bu bağlantı kanala, agent sonucuna veya başka kullanıcıya aktarılmaz.
 */
export async function notifyOwnerAgentTaskCreated(
  client: Client,
  params: { requester: User; prompt: string; taskUrl: string },
): Promise<boolean> {
  try {
    const owner = await resolveOwner(client);
    if (!owner) return false;
    await owner.send(v2Payload(
      "🔗 **Manus sohbeti hazır.**\n" +
        `İstek: ${params.prompt.slice(0, 700)}\n\n` +
        `${params.taskUrl}\n\n` +
        "Siteyi yayınlamak için sohbeti açıp **‘Sitemi yayınla / Web sitesini yayınla ve canlı bağlantıyı oluştur’** mesajını gönder.",
    ));
    return true;
  } catch (error) {
    console.error("owner'a dm gitmedi (task url):", error);
    return false;
  }
}

/**
 * !agent bir onay/bilgi beklediğinde owner'a güvenli DM yollar.
 */
export async function notifyOwnerAgentWaiting(
  client: Client,
  params: {
    requester: User;
    prompt: string;
    detail: string;
    type?: string;
  },
): Promise<boolean> {
  try {
    const owner = await resolveOwner(client);
    if (!owner) return false;

    await owner.send(v2Payload(
      `${EMOJIS.alert} **Manus agent onay/bilgi bekliyor.**\n` +
        `İsteyen: ${params.requester.tag} (${params.requester.id})\n` +
        `İstek: ${params.prompt.slice(0, 700)}\n` +
        `Bekleyen işlem: ${params.detail}\n` +
        (params.type ? `Tür: ${params.type}\n` : "") +
        "Sohbet bağlantısı bu akışın başında yalnızca owner’a DM edildi. DM’deki sohbeti açıp gerekli onayı ver veya “Sitemi yayınla / Web sitesini yayınla ve canlı bağlantıyı oluştur” mesajını gönder.",
    ));
    return true;
  } catch (error) {
    console.error("owner'a dm gitmedi (waiting):", error);
    return false;
  }
}

/** !agent bir web sitesi/uygulama çıktısı ürettiğinde owner'a DM yollar. */
export async function notifyOwnerAgentSiteReady(
  client: Client,
  params: {
    requester: User;
    prompt: string;
    outputLinks: string[];
    fileNames: string[];
  },
): Promise<boolean> {
  try {
    const owner = await resolveOwner(client);
    if (!owner) return false;

    const links = params.outputLinks.length
      ? `\nYayın/önizleme bağlantıları:\n${params.outputLinks.map((link) => `• ${link}`).join("\n")}`
      : "";
    const files = params.fileNames.length
      ? `\nÜretilen dosyalar: ${params.fileNames.slice(0, 10).join(", ")}`
      : "";

    await owner.send(v2Payload(
      "🌐 **Manus site/uygulama çıktısı hazır.**\n" +
        `İsteyen: ${params.requester.tag} (${params.requester.id})\n` +
        `İstek: ${params.prompt.slice(0, 700)}\n\n` +
        "Manus sohbet bağlantısı başlangıçta yalnızca owner’a DM edildi. " +
        "İlgili sohbetten **‘Sitemi yayınla / Web sitesini yayınla ve canlı bağlantıyı oluştur’** şeklinde onay ver. " +
        "Yayın bağlantısı oluştuğunda Discord’daki sonuç mesajında görünecek." +
        links +
        files,
    ));
    return true;
  } catch (error) {
    console.error("owner'a dm gitmedi (site):", error);
    return false;
  }
}

export async function notifyOwnerAgentFailure(
  client: Client,
  params: { requester: User; prompt: string; error: string },
): Promise<boolean> {
  try {
    const owner = await resolveOwner(client);
    if (!owner) return false;
    await owner.send(v2Payload(
      `${EMOJIS.error} **Manus agent işlemi başarısız oldu.**\n` +
        `İsteyen: ${params.requester.tag} (${params.requester.id})\n` +
        `İstek: ${params.prompt.slice(0, 700)}\n` +
        `Hata: ${params.error.slice(0, 1000)}`,
    ));
    return true;
  } catch (error) {
    console.error("owner'a dm gitmedi (agent hata):", error);
    return false;
  }
}

