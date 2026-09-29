import { resolveEmojis, V2CardBuilder, errorCard, textCard } from "../../utils/componentsV2.js";
import { MessageFlags,
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
} from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX, OWNER_ID } from "../../config.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { COLORS } from "../../utils/embeds.js";
import {
  downloadManusAttachment,
  runAgentTask,
  ManusError,
  MAX_UPLOADABLE_ATTACHMENT_BYTES,
  type TaskAttachmentInput,
} from "../../utils/manus.js";
import {
  notifyOwnerAgentFailure,
  notifyOwnerAgentSiteReady,
  notifyOwnerAgentTaskCreated,
  notifyOwnerAgentWaiting,
} from "../../utils/notifyOwner.js";
import { EMOJIS } from "../../utils/emojis.js";
import { usageEmbed } from "../../utils/messages.js";

// !agent <istek>
//
// Manus AI'a tam teşekküllü bir "agent" görevi yollar (araştırma, dosya
// üretimi, çok adımlı görevler vb.). Güvenlik nedeniyle yalnızca bot sahibi
// kullanabilir; yetki kontrolü premium/trial ve API işlemlerinden önce yapılır.
//
// Güvenlik: Manus görev sohbeti hiçbir zaman Discord'a veya DM'e gönderilmez.
// Yalnızca Manus cevabında açıkça dönen yayın/önizleme URL'leri gösterilir.
//
// SAĞLAMLIK: aynı kullanıcı görevi bitmeden komutu tekrar çalıştırırsa
// (spam/çift tıklama), ikinci çağrı bir hata fırlatmak yerine kibarca
// reddedilir — iki paralel Manus görevi aynı kullanıcı için karışmasın diye.
// Ayrıca uzun süren görevlerde ~20 saniyede bir "hâlâ çalışıyor" güncellemesi
// gönderilir, böylece komut asılı/ölü gibi görünmez.

const MAX_INPUT_CHARS = 4_000;
const EMBED_PREVIEW_CHARS = 1_500;
const PROGRESS_UPDATE_INTERVAL_MS = 20_000;
const MAX_INPUT_ATTACHMENTS = 10; // Discord'un mesaj başına ek limitiyle uyumlu

/**
 * 🆕 YENİ ÖZELLİK: !agent komutuna eklenen Discord dosyalarını Manus'a
 * gönderilecek forma çevirir. Eskiden message.attachments HİÇ okunmuyordu —
 * kullanıcı bir dosya ekleyip "bunu analiz et" dese bile Manus'a sadece
 * metin gidiyor, dosyadan hiç haberi olmuyordu.
 */
function collectInputAttachments(message: Message): TaskAttachmentInput[] {
  const attachments = [...message.attachments.values()].slice(0, MAX_INPUT_ATTACHMENTS);
  const result: TaskAttachmentInput[] = [];
  for (const att of attachments) {
    // Discord CDN URL'leri zaten https'tir, ama yine de doğruluyoruz —
    // beklenmeyen bir attachment.url şeması varsa sessizce atlanır.
    try {
      const parsed = new URL(att.url);
      if (parsed.protocol !== "https:") continue;
    } catch {
      continue;
    }
    if (att.size > MAX_UPLOADABLE_ATTACHMENT_BYTES) continue; // Manus'un 512MB sınırını aşan dosya atlanır
    result.push({
      url: att.url,
      filename: att.name || "dosya",
      contentType: att.contentType ?? undefined,
      sizeBytes: att.size,
    });
  }
  return result;
}

// Kullanıcı başına: şu anda aktif bir !agent görevi var mı?
const activeUsers = new Set<string>();

async function isBotOwner(message: Message): Promise<boolean> {
  if (message.author.id === OWNER_ID) return true;
  try {
    const application = await message.client.application?.fetch();
    return application?.owner?.id === message.author.id;
  } catch (error) {
    console.error("agent: owner değilsin la:", error);
    return false;
  }
}

function safeHttpsUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function extractHttpsUrls(text: string): string[] {
  const matches = text.match(/https:\/\/[^\s<>()]+/gi) ?? [];
  const urls = new Set<string>();
  for (const match of matches) {
    const clean = match.replace(/[.,!?;:]+$/g, "");
    const url = safeHttpsUrl(clean);
    if (url) urls.add(url);
  }
  return [...urls];
}

function looksLikeWebOutput(answer: string, attachments: { filename: string }[]): boolean {
  const webFile = attachments.some(({ filename }) =>
    /\.(html?|css|js|jsx|tsx|vue|svelte|json|zip)$/i.test(filename),
  );
  // 🛠️ BUG FIX: eski regex "site", "app", "uygulama" gibi çok yaygın tek
  // kelimeleri de eşleştiriyordu — alakasız görevlerde (ör. "en iyi 5 mobil
  // app öner") bile owner'a gereksiz "web sitesi hazır" DM'i gidiyordu.
  // Artık yalnızca yayına/deploy'a açıkça işaret eden ifadeler eşleşiyor.
  const webText = /\b(web sitesi|website|yayınla|deploy|canlı bağlantı|hosting|domain)\b/i.test(answer);
  return webFile || webText;
}

function outputLinkComponents(outputText = ""): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];
  const seen = new Set<string>();
  for (const [index, url] of extractHttpsUrls(outputText).entries()) {
    const safeUrl = safeHttpsUrl(url);
    if (!safeUrl || seen.has(safeUrl) || buttons.length >= 5) continue;
    seen.add(safeUrl);
    buttons.push(
      new ButtonBuilder()
        .setLabel(resolveEmojis(index === 0 ? "Siteyi aç" : `Çıktı bağlantısı ${index + 1}`))
        .setStyle(ButtonStyle.Link)
        .setURL(safeUrl),
    );
  }

  return buttons.length
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)]
    : [];
}

const command: Command = {
  name: "agent",
  aliases: ["manus"],
  description: "Sadece bot sahibinin kullanabildiği Manus AI agent komutu",
  usage: `${DEFAULT_PREFIX}agent <istek>`,
  category: "owner",

  async execute(message: Message, args: string[]) {
    // Güvenlik kontrolü tüm diğer işlemlerden önce yapılır: owner olmayan
    // kullanıcı ne premium/trial hakkı tüketebilir ne de Manus API'ye ulaşabilir.
    if (!(await isBotOwner(message))) {
      await message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Bu komut sadece bot sahibine açıktır.` })] }).catch(() => null);
      return;
    }

    const userId = message.author.id;

    if (activeUsers.has(userId)) {
      return await message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Zaten çalışan bir \`agent\` görevin var, onun bitmesini bekle.` })] });
    }

    // 🛠️ BUG FIX: bu komut zaten yukarıda isBotOwner() ile sadece bot sahibine
    // kısıtlanmış. Buna rağmen requirePremiumOrSingleTrial çağrılıyordu; bu da
    // owner'ı "premium olmayan kullanıcı" gibi 1 haklık deneme sistemine tabi
    // tutuyordu. Sonuç: owner premium tablosuna manuel eklenmediyse, kendi
    // tek erişebildiği komutu ikinci kullanımdan sonra "premium gerekiyor,
    // owner ile iletişime geç" diyerek KENDİSİNE kilitliyordu. Owner zaten
    // tek yetkili kullanıcı olduğu için bu gate anlamsız — kaldırıldı.

    const prefix = getGuildPrefix(message.guild?.id);
    const istek = args.join(" ").trim();
    const inputAttachments = collectInputAttachments(message);

    if (!istek && inputAttachments.length === 0) {
      return await message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}agent <istek>\`\n` +
          `Örnek: \`${prefix}agent Türkiye'deki en iyi 5 tatil beldesini karşılaştır ve kısa bir tablo çıkar\`\n` +
          `Mesaja dosya ekleyip metni boş bırakırsan Manus dosyayı kendi başına inceler.`,
      )] });
    }
    // Kullanıcı sadece dosya ekleyip metin yazmadıysa (ör. "!agent" + PDF eki),
    // Manus'a boş bir prompt göndermek yerine makul bir varsayılan talimat
    // veriyoruz — aksi halde API muhtemelen "content boş olamaz" hatası verir.
    const effectiveIstek =
      istek || "Ekteki dosyayı/dosyaları incele ve önemli noktaları özetle.";

    if (istek.length > MAX_INPUT_CHARS) {
      return await message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} İstek çok uzun (maks ${MAX_INPUT_CHARS} karakter).` })] });
    }

    if (message.attachments.size > MAX_INPUT_ATTACHMENTS) {
      return await message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} En fazla ${MAX_INPUT_ATTACHMENTS} dosya eklenebilir, ilk ${MAX_INPUT_ATTACHMENTS} tanesi kullanılacak şekilde devam ediliyor.` })] }).catch(() => null);
    }
    if (message.attachments.size > 0 && inputAttachments.length === 0) {
      // Tüm ekler boyut/protokol nedeniyle elendi — kullanıcıyı bilgilendir
      // ama görevi tamamen düşürme, metin varsa yine de devam edilebilir.
      await message
        .reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.alert} Eklediğin dosya(lar) işlenemedi (çok büyük veya desteklenmeyen bağlantı türü), yalnızca metinle devam ediliyor.` })] })
        .catch(() => null);
    }

    activeUsers.add(userId);

    let loadingMsg: Message;
    try {
      const attachmentNote =
        inputAttachments.length > 0
          ? ` (${inputAttachments.length} dosya Manus'a gönderiliyor)`
          : "";
      loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Manus AI görevi başlatıldı, çalışıyor...${attachmentNote} (bu birkaç dakika sürebilir)`) });
    } catch (err) {
      // İlk reply bile atılamadıysa (izin/rate limit sorunu) sessizce çık —
      // activeUsers kilidi finally'de zaten temizlenecek.
      console.error("agent ilk mesajı gönderemedi:", err);
      activeUsers.delete(userId);
      return;
    }

    try {
      let lastProgressEdit = Date.now();
      const { answer, attachments } = await runAgentTask(
        effectiveIstek,
        (elapsedMs, progress) => {
        if (Date.now() - lastProgressEdit < PROGRESS_UPDATE_INTERVAL_MS) return;
        lastProgressEdit = Date.now();
        const seconds = Math.round(elapsedMs / 1000);
        const detail = progress ? `\n> ${progress.slice(0, 300)}` : "";
        loadingMsg
          .edit({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Manus AI hâlâ çalışıyor... (${seconds}sn geçti)${detail}`) })
          .catch(() => null); // İlerleme mesajı başarısız olursa görevi düşürme, sonunda asıl cevabı yine de vermeyi dene.
        },
        async (detail, type) => {
          await loadingMsg
            .edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.alert} Manus ek onay/bilgi bekliyor: ${detail.slice(0, 500)}\nOwner bilgilendiriliyor; görev polling’e devam ediyor.` })] })
            .catch(() => null);
          const notified = await notifyOwnerAgentWaiting(message.client, {
            requester: message.author,
            prompt: effectiveIstek,
            detail,
            type,
          });
          if (!notified) {
            await loadingMsg
              .edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.alert} Manus onay/bilgi bekliyor; owner DM'i gönderilemedi. OWNER_ID ve Discord DM ayarlarını kontrol edin.` })] })
              .catch(() => null);
          }
        },
        async (taskUrl) => {
          const notified = await notifyOwnerAgentTaskCreated(message.client, {
            requester: message.author,
            prompt: effectiveIstek,
            taskUrl,
          });
          if (!notified) {
            await loadingMsg
              .edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.alert} Manus görevi oluşturuldu ancak owner’a sohbet linki DM ile gönderilemedi. OWNER_ID ve DM ayarlarını kontrol edin.` })] })
              .catch(() => null);
          }
        },
        inputAttachments,
      );

      const full = answer.trim() || (attachments.length ? "(Manus bir metin yazmadı, sadece dosya üretti.)" : "(Manus boş bir cevap döndü.)");
      const preview =
        full.length > EMBED_PREVIEW_CHARS
          ? `${full.slice(0, EMBED_PREVIEW_CHARS)}\n\n… *(devamı ekli dosyada)*`
          : full;

      const embed = new V2CardBuilder()
        .setColor(COLORS.premium)
        .setTitle(`${EMOJIS.success} Manus Agent Sonucu`)
        .setDescription(preview)
        .setFooter({ text: `İsteyen: ${message.author.tag}` })
        .setTimestamp();

      // Yalnızca Manus'un gerçekten ürettiği dosyaları indirip ekliyoruz.
      // Cevabı ayrıca .md dosyasına dönüştürmüyoruz; böylece kullanıcıya
      // aynı içeriğin hem normal mesajı hem de Markdown kopyası gitmiyor.
      // Discord mesaj başına en fazla 10 dosya kabul ettiği için ilk 10 dosya alınır.
      const files: AttachmentBuilder[] = [];
      const skipped: string[] = [];
      const toDownload = attachments.slice(0, 10);

      for (const att of toDownload) {
        const buffer = await downloadManusAttachment(att);
        if (!buffer) {
          skipped.push(att.filename);
          continue;
        }
        files.push(new AttachmentBuilder(buffer, { name: att.filename }));
      }
      if (attachments.length > toDownload.length) {
        skipped.push(...attachments.slice(toDownload.length).map((a) => a.filename));
      }
      if (skipped.length) {
        embed.addFields({
          name: "İndirilemeyen dosyalar",
          value: skipped.map((name) => `\`${name}\``).join(", ").slice(0, 1000),
        });
      }
      // Tek bir sonuç mesajı düzenlenir. Dosya yoksa boş `files` dizisi
      // gönderilmez; yalnızca Manus cevabı gösterilir.
      await loadingMsg.edit({
        flags: MessageFlags.IsComponentsV2,
        components: [embed, ...outputLinkComponents(full)],
        ...(files.length > 0 ? { files } : {}),
      });

      if (looksLikeWebOutput(full, attachments)) {
        const notified = await notifyOwnerAgentSiteReady(message.client, {
          requester: message.author,
          prompt: effectiveIstek,
          outputLinks: extractHttpsUrls(full),
          fileNames: attachments.map((attachment) => attachment.filename),
        });
        if (!notified) {
          embed.addFields({
            name: "Owner bildirimi",
            value: "Owner DM'i gönderilemedi. Konsol logunda ayrıntı var; OWNER_ID ve Discord DM ayarlarını kontrol edin.",
          });
          await loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
          components: [embed, ...outputLinkComponents(full)] }).catch(() => null);
        }
      }

    } catch (err: unknown) {
      const msg = err instanceof ManusError ? err.message : err instanceof Error ? err.message : String(err);
      console.error("agent patladı:", err);

      // Hatanın kullanıcıya MUTLAKA ulaşmasını garantiliyoruz: önce loading
      // mesajını düzenlemeyi dene, o başarısız olursa yeni bir mesajla yanıtla.
      const errorText = `${EMOJIS.error} Hata oluştu: ${msg}`;
      const edited = await loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: textCard(errorText) }).catch(() => null);
      await notifyOwnerAgentFailure(message.client, {
        requester: message.author,
        prompt: effectiveIstek,
        error: msg,
      });
      if (!edited) {
        await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(errorText) }).catch(() => null);
      }
    } finally {
      activeUsers.delete(userId);
    }
  },
};

export default command;
