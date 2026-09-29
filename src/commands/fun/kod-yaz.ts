import { fileComponents, V2CardBuilder, errorCard, textCard } from "../../utils/componentsV2.js";
import { MessageFlags, AttachmentBuilder, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX } from "../../config.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { COLORS } from "../../utils/embeds.js";
import { generateCodeText } from "../../utils/codeModel.js";
import { extractCodeFiles, fetchAttachmentText } from "../../utils/codeFiles.js";
import { LANG_MAP, type LangInfo } from "../../utils/langs.js";
import { requirePremiumOrTrial, consumeTrialUse } from "../../premium/gate.js";
import { EMOJIS } from "../../utils/emojis.js";
import { addSlash } from "../../utils/slashBridge.js";
import { usageEmbed } from "../../utils/messages.js";

// !kod-yaz py/js/ts <istenilen özellikler>
//
// src/utils/codeModel.ts üzerinden (ana model: OpenRouter/MiniMax M3,
// yanıt alınamazsa Gemini) istenen dilde hazır kod dosyası/dosyaları
// ürettirir ve doğrudan Discord'a dosya olarak ekler. Gerektiğinde (ör.
// bir HTML+CSS+JS projesi) birden fazla dosya döndürebilir — bkz.
// utils/codeFiles.ts.
//
// NOT: Discord, ".ts" uzantısını içerik türünden bağımsız olarak video/akış
// dosyası gibi algılayıp önizleme/oynatıcı göstermeye çalışıyor; bu yüzden
// TypeScript çıktısı ".txt" uzantısıyla gönderiliyor (içerik yine TypeScript
// kodu, sadece dosya uzantısı Discord uyumluluğu için değiştirildi). Bu kural
// modelin ürettiği çoklu dosyalarda da (dosya adı .ts ile bitiyorsa) uygulanır.

const MAX_FILES = 8;
// Discord'da normal kullanıcı mesajları 2000 karakterle sınırlı — uzun/detaylı
// istekler (ör. "90 komutlu bir Discord botu" gibi çok maddeli spesifikasyonlar)
// bu sınıra takılıp Discord tarafında baştan kesiliyor, bot hiçbir zaman
// isteğin tamamını görmüyor. Bunu aşmak için kullanıcı isteğini bir .txt/.md
// dosyası olarak EKLEYEBİLİR; ekliyse featureText args yerine bu dosyadan
// okunur (bkz. utils/codeFiles.ts fetchAttachmentText — kod-analiz/kod-duzelt/
// kod-test'te zaten kullanılan aynı yardımcı).
const MAX_ATTACHMENT_BYTES = 400_000; // ~400KB, uzun bir spesifikasyon metni için fazlasıyla yeterli
const MAX_FEATURE_CHARS = 35_000;

function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9\s_-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug || "kod";
}

// Discord'un .ts dosyalarını video sanma sorunu — dosya adı .ts ile bitiyorsa
// (tek dosyalık cevapta olduğu gibi çoklu dosyalarda da) .txt'ye çeviriyoruz.
function discordSafeFilename(filename: string): string {
  return /\.ts$/i.test(filename) ? filename.replace(/\.ts$/i, ".txt") : filename;
}


/**
 * Model cevabındaki kod blokları ve ===FILE: ...=== başlıkları temizlendikten
 * sonra kalan metinden "AI NOTLARI:" bölümünü çıkarır. Bulunamazsa null döner —
 * bu durumda embed'de alan gösterilmez; bot uydurma bir metin yazmaz, notları
 * her zaman modelin kendisi üretir.
 */
function extractAiNotes(rawText: string): string | null {
  const withoutCode = rawText
    .replace(/```[a-zA-Z0-9_+#-]*\n[\s\S]*?```/g, "")
    .replace(/^===FILE:.*===\s*$/gim, "")
    .trim();
  const match = withoutCode.match(/AI\s*NOTLAR(I|LARI)?\s*:\s*([\s\S]*)$/i);
  if (!match) return null;
  let notes = match[2].trim();
  // Discord embed field limiti ~1024 karakter
  if (notes.length > 1000) notes = notes.slice(0, 997) + "...";
  return notes || null;
}

const BDSCRIPT_GUIDE = `
BDSCRIPT ÖZEL KURALLARI (ÇOK ÖNEMLİ):
- BDScript, BDFD (Bot Designer For Discord) tarzı bot oluşturucu platformlarda kullanılan, fonksiyon tabanlı bir kod/etiket dilidir. JavaScript veya normal bir programlama dili DEĞİLDİR.
- Sözdizimi "$fonksiyonAdi[argüman1;argüman2;...]" biçimindedir; argümanlar noktalı virgül (;) ile ayrılır, köşeli parantez [] kullanılmayan fonksiyonlarda parantez yazılmaz (örn: $username, $authorID).
- Yaygın fonksiyonlara örnekler: $message[], $author, $authorID, $mentioned, $mentionedID, $channelID, $guildID, $var[isim;değer], $getVar[isim], $onlyIf[koşul;hataMesajı], $if[koşul;evet;hayır], $case[koşul1;çıktı1;koşul2;çıktı2;...], $random[min;max], $split[metin;ayraç], $replace[metin;eski;yeni], $sendMessage[kanalID;mesaj], $addRole[rolID;kullanıcıID], $removeRole[rolID;kullanıcıID], $ban[kullanıcıID;sebep], $cooldown[süre], $title[], $description[], $color[], $footer[], $thumbnail[], $image[].
- Değişkenler genelde $var[isim;değer] ile tanımlanır ve $getVar[isim] ile okunur; global/sunucu bazlı değişkenler platforma göre değişebilir, bunu bir yorum satırıyla belirt.
- Kod, doğrudan bir BDFD tarzı "komut kodu" kutusuna yapıştırılabilecek şekilde, tek bir komut kodu bloğu olarak yazılmalı; ayrı "fonksiyon tanımı", "import" veya "class" gibi klasik programlama yapıları KULLANMA.
- Yorumlar için $comment[açıklama] fonksiyonunu kullan.
- Emin olmadığın çok özel/nadir bir fonksiyon adı yerine, yukarıdaki gibi yaygın ve genel geçer BDScript fonksiyonlarını tercih et; olmayan bir fonksiyon uydurmaktan kaçın.`;

// !kod-yaz auto <istenilen özellikler>
//
// Kullanıcı dil belirtmek yerine "auto" yazarsa, hangi dilin en uygun
// olduğuna modelin kendisi karar verir. Bunu SUPPORTED_LANG_KEYS'teki
// kanonik anahtarları kullanarak yapan hafif bir "sınıflandırma" çağrısıyla
// çözüyoruz: modele sadece istekle birlikte desteklenen dil anahtarlarının listesini verip TEK KELİMELİK
// bir anahtar (ör. "js", "py") döndürmesini istiyoruz. Dönen cevap
// geçersiz/tanınmayan bir şeyse ya da boşsa güvenli bir varsayılana
// (js) düşüyoruz — kullanıcı hiçbir zaman hatasız bir cevap alamamak
// yerine makul bir varsayılanla devam eden bir sonuç görür.
const AUTO_LANG_KEY = "auto";
// Desteklenen dillerin kanonik anahtarları (auto modunda modelin seçebileceği liste)
const SUPPORTED_LANG_KEYS = [
  "py", "js", "ts", "cpp", "c", "cs", "java", "go", "rs",
  "php", "rb", "kt", "swift", "lua", "sql", "sh", "html", "css", "bds",
];
const AUTO_FALLBACK_LANG_KEY = "js";

function buildAutoDetectPrompt(): string {
  return `Sen deneyimli bir yazılım mimarısın. Kullanıcının aşağıda vereceği istek için hangi programlama dilinin/formatının en uygun olduğuna karar vereceksin.

KURAL (ÇOK ÖNEMLİ, ASLA İHLAL ETME):
- Cevabın SADECE ve KESİNLİKLE şu listedeki anahtar kelimelerden biri olmalı, başka HİÇBİR ŞEY yazma (açıklama, noktalama, büyük harf, cümle YOK):
${SUPPORTED_LANG_KEYS.join(", ")}
- İsteğin doğasına en uygun olanı seç (ör. bir web sayfası/arayüz isteniyorsa "html", bir Discord botu/otomasyon script'i isteniyorsa "js" ya da "ts", genel amaçlı basit bir araç/algoritma isteniyorsa "py", bir BDFD/BDScript komutu isteniyorsa "bds" vb.).
- Emin değilsen en yaygın kullanılan genel amaçlı dili seç ("py" ya da "js").
- Cevabın tek bir kelime olacak, başka hiçbir karakter olmayacak.`;
}

/**
 * "auto" modunda kullanıcının isteğine bakarak en uygun dil anahtarını
 * (LANG_MAP anahtarlarından biri) modele seçtirir. generateCodeText zaten
 * ana model/fallback model mantığını (OpenRouter/MiniMax M3, olmazsa Gemini)
 * içerdiği için burada da aynı fonksiyon kullanılıyor — sadece kod üretimi
 * değil, kısa bir sınıflandırma isteği olarak.
 */
async function detectAutoLangKey(featureText: string): Promise<string> {
  try {
    // Bu sadece tek kelimelik bir sınıflandırma isteği — tam kod üretimi
    // bütçesini (120sn×3anahtar gibi) hak etmiyor. Küçük maxTokens + kısa
    // PixRouter süre bütçesiyle hızlıca sonuçlanıp asıl kod üretimine daha
    // fazla zaman/sabır bırakıyoruz.
    const { text } = await generateCodeText(
      buildAutoDetectPrompt(),
      `İstenen özellikler: ${featureText}`,
      {
        expectedLangKey: undefined,
        expectedLabel: undefined,
        fence: "text",
        // Reasoning modelleri düşünme token'larını da bu bütçeden harcar; 20 çok az.
        maxTokens: 4_096,
      },
    );
    const cleaned = text
      .trim()
      .toLowerCase()
      .split(/\s+/)[0]
      ?.replace(/[^a-z0-9+#]/g, "") ?? "";
    if (SUPPORTED_LANG_KEYS.includes(cleaned)) {
      return cleaned;
    }
    // Model "c++" gibi yazmış olabilir, LANG_MAP alias'larına da bakalım
    const viaLangMap = LANG_MAP[cleaned]?.key;
    if (viaLangMap && SUPPORTED_LANG_KEYS.includes(viaLangMap)) {
      return viaLangMap;
    }
  } catch (err) {
    console.error("kod-yaz: dil tespiti patladı:", err);
  }
  return AUTO_FALLBACK_LANG_KEY;
}

function buildSystemPrompt(info: LangInfo): string {
  const extra = info.label === "BDScript" ? BDSCRIPT_GUIDE : "";
  return `Sen deneyimli bir yazılım geliştiricisisin. Kullanıcının istediği özelliklere göre ${info.label} dilinde, ÇALIŞAN, HATASIZ, DETAYLI ve EKSİKSİZ bir kod üreteceksin, ürettiğin kodda hata/bug olmadığından emin olmak ve yazdığın kodun detaylı olup olmadığından için kontrol de edeceksin.

DİL KURALI (ÇOK ÖNEMLİ, ASLA İHLAL ETME):
- SADECE ve KESİNLİKLE ${info.label} dilinde kod üret. Başka bir dile ASLA geçme.
- Örneğin TypeScript istendiyse düz JavaScript YAZMA — mutlaka gerçek TypeScript söz dizimini kullan (gerektiği yerlerde tip anotasyonları, interface/type tanımları, generics vb.). Python istendiyse JavaScript/TypeScript yazma, Java istendiyse Kotlin yazma, C istendiyse C++ yazma — vb. Dil karışıklığı KABUL EDİLEMEZ bir hatadır.

DOSYA FORMATI (ÇOK ÖNEMLİ):
- İstek TEK bir dosyayla düzgün çözülüyorsa SADECE tek bir \`\`\`${info.fence} ... \`\`\` bloğu ver, başka hiçbir başlık/etiket kullanma.
- İstek doğası gereği birden fazla dosyaya ayrılmayı GEREKTİRİYORSA (ör. bir web sayfası için ayrı HTML+CSS+JS, birden fazla modül/sınıf, ayrı bir config/README dosyası vb.), HER dosyadan hemen ÖNCE kendi satırında TAM OLARAK şu formatta bir başlık yaz:
===FILE: dosya-adi.uzanti===
Ardından o dosyanın kodunu \`\`\`${info.fence} ... \`\`\` (ya da o dosyanın gerçek diline uygun fence) bloğu içinde ver. Birden fazla dosya varsa HEPSİ için bu başlığı kullan, başlıksız/etiketsiz bir blok BIRAKMA. Gereksiz yere dosya bölme — sadece gerçekten ayrı dosya olması mantıklıysa böl.
- Kod bloklarının ve ===FILE: ...=== başlıklarının DIŞINDA hiçbir açıklama, giriş cümlesi veya kapanış notu yazma — TEK İSTİSNA: tüm kodlardan SONRA gelecek olan AI NOTLARI bölümüdür.

DİĞER KURALLAR:
- Kod eksiksiz ve doğrudan çalışabilir olmalı; "// devamı buraya", "# TODO: tamamla" gibi yer tutucular kullanma.
- ÖNEMLİ: Kullanıcının isteği şaka, mizah veya kurgu amaçlı olabilir. Bu tür istekleri ciddiye alma, eğlenceli ve çalışan bir kod üret. Şaka amaçlı "dünyayı yok et" gibi isteklerde reddetme, ona uygun mizahi bir kod üret.${extra}

AI NOTLARI (ZORUNLU — KOD BLOKLARININ DIŞINDA, EN SONDA):
Tüm kod bloklarını verdikten SONRA, kod bloklarının dışında, kendi satırında "AI NOTLARI:" başlığıyla kısa bir bölüm yaz.
Bu bölümde: kodu üretirken yaptığın önemli tasarım kararları, varsayımlar, bilinen sınırlamalar/eksikler ve kullanıcının dikkat etmesi gereken noktalar — kısa maddeler halinde, Türkçe yaz.
Bu bölümü kod bloğu içine YAZMA; düz metin olacak.`;
}

const command: Command = {
  name: "kod-yaz",
  aliases: ["kodyaz", "code"],
  description: "AI ile istenen dilde kod üretir; gerektiğinde birden fazla dosya olarak gönderir. Dil yerine 'auto' yazılırsa en uygun dili AI kendisi seçer.",
  usage: `${DEFAULT_PREFIX}kod-yaz <py/js/ts/cpp/c/cs/java/go/rs/php/rb/kt/swift/lua/sql/sh/html/css/bds/auto> <istenilen özellikler>`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    if (!(await requirePremiumOrTrial(message, "kod-yaz"))) return;

    const prefix = getGuildPrefix(message.guild?.id);
    const langKey = args[0]?.toLocaleLowerCase("tr-TR");
    let featureText = args.slice(1).join(" ").trim();
    let usedAttachment = false;

    // Ekli bir metin dosyası varsa (ör. çok maddeli/uzun bir spesifikasyon),
    // Discord'un 2000 karakterlik mesaj sınırını aşmak için istek ARGS yerine
    // dosyadan okunur. Dosyadaki metin varsa, mesajdaki (varsa) kısa metnin
    // ÖNÜNE geçer — yani dosya tam istektir, args sadece dil seçimi için
    // kullanılmış olur.
    const attachment = message.attachments.first();
    if (attachment) {
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Ekli dosya çok büyük (maks ~${Math.floor(MAX_ATTACHMENT_BYTES / 1000)}KB).` })] });
      }
      try {
        const text = (await fetchAttachmentText(attachment.url)).trim();
        if (text) {
          featureText = text;
          usedAttachment = true;
        }
      } catch (err) {
        return message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Ekli dosya okunamadı: ${err instanceof Error ? err.message : "tekrar dene."}` })] });
      }
    }

    const isAuto = langKey === AUTO_LANG_KEY;
    let info = langKey && !isAuto ? LANG_MAP[langKey] : undefined;

    if (!langKey || !featureText || (!isAuto && !info)) {
      return message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}kod-yaz <dil> <istenilen özellikler>\`\n` +
        "Desteklenen diller: `py` (Python), `js` (JavaScript), `ts` (TypeScript), `cpp`/`c++` (C++), `c` (C), " +
        "`cs`/`csharp` (C#), `java` (Java), `go` (Go), `rs`/`rust` (Rust), `php` (PHP), `rb`/`ruby` (Ruby), " +
        "`kt`/`kotlin` (Kotlin), `swift` (Swift), `lua` (Lua), `sql` (SQL), `sh`/`bash` (Bash), `html` (HTML), `css` (CSS), `bds`/`bdscript` (BDScript)\n" +
        "`auto` (dili model kendisi seçer)\n" +
        `Örnek: \`${prefix}kod-yaz cpp basit bir hesap makinesi\`\n` +
        `Örnek: \`${prefix}kod-yaz auto basit bir hesap makinesi\` (dili model kendisi seçer)\n` +
        `Not: İstek doğası gereği birden fazla dosya gerektiriyorsa (ör. HTML+CSS+JS), tüm dosyalar tek seferde gönderilir.\n` +
        `İpucu: İstek çok uzunsa (Discord'un 2000 karakter sınırına takılıyorsa) özellikleri bir .txt dosyasına yazıp ` +
        `\`${prefix}kod-yaz <dil>\` komutuna EKLEYEREK gönderebilirsin — dosyanın tamamı okunur.`,
      )] });
    }

    if (featureText.length > MAX_FEATURE_CHARS) {
      featureText = featureText.slice(0, MAX_FEATURE_CHARS);
    }

    const loadingMsg = await message.reply({ flags: MessageFlags.IsComponentsV2, components: textCard(isAuto
        ? `${EMOJIS.loading} En uygun dil seçiliyor${usedAttachment ? " (ekli dosyadan okunan istek)" : ""}...`
        : `${EMOJIS.loading} ${info!.label} kodu üretiliyor${usedAttachment ? " (ekli dosyadan okunan istek)" : ""}...`) });

    try {
      if (isAuto) {
        const detectedKey = await detectAutoLangKey(featureText);
        info = LANG_MAP[detectedKey] ?? LANG_MAP[AUTO_FALLBACK_LANG_KEY];
        if (!info) {
          return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Dil otomatik seçilirken bir sorun oluştu, tekrar dene ya da dili elle belirt.` })] });
        }
        await loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Dil olarak **${info.label}** seçildi, kod üretiliyor${usedAttachment ? " (ekli dosyadan okunan istek)" : ""}...`) });
      }

      if (!info) {
        return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Dil belirlenemedi, tekrar dene.` })] });
      }

      const { text: rawText, retried, model } = await generateCodeText(
        buildSystemPrompt(info),
        `İstenen özellikler: ${featureText}`,
        { expectedLangKey: info.key, expectedLabel: info.label, fence: info.fence },
      );

      const files = extractCodeFiles(rawText, `${slugify(featureText)}.${info.attachExt}`, info.fence).slice(
        0,
        MAX_FILES,
      );

      if (files.length === 0 || files.every((f) => f.code.length < 5)) {
        return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Geçerli bir kod üretemedi, tekrar dene.` })] });
      }

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "kod-yaz");

      // AI NOTLARI: model, kod bloklarından sonra düz metin olarak yazar;
      // burada sadece ayıklanır. Model yazmadıysa alan gösterilmez —
      // bot uydurma bir metin yazmaz.
      const aiNotlari = extractAiNotes(rawText);

      // Otomatik devam ettirme (bkz. utils/openrouter.ts / utils/gemini.ts)
      // çoğu zaman yarıda kesilmeyi çözer, ama model son denemede de
      // bitiremediyse elimizde hâlâ eksik bir dosya kalabilir. Bunu
      // sessizce göndermek yerine kullanıcıyı açıkça uyarıyoruz — "yarım
      // index.html, butonlar çalışmıyor" tarzı hataların kaynağı buydu.
      const truncatedFiles = files.filter((f) => f.truncated);

      const attachments = files.map((file) => {
        const fileContent = `${file.code}\n`;
        return new AttachmentBuilder(Buffer.from(fileContent, "utf-8"), {
          name: discordSafeFilename(file.filename),
        });
      });

      const fileListText =
        files.length > 1
          ? `**Dosyalar (${files.length}):**\n${files.map((f) => `• \`${discordSafeFilename(f.filename)}\``).join("\n")}`
          : `**Dosya:** \`${discordSafeFilename(files[0].filename)}\``;

      const hasTruncated = truncatedFiles.length > 0;

      const embed = new V2CardBuilder()
        .setColor(hasTruncated ? COLORS.error : COLORS.success)
        .setTitle(
          hasTruncated
            ? `${EMOJIS.alert} Kod üretildi (EKSİK KALDI)`
            : files.length > 1
              ? `${EMOJIS.success} Kod üretildi (çoklu dosya)`
              : `${EMOJIS.success} Kod üretildi`,
        )
        .setDescription(
          [
            `**Dil:** ${info.label}`,
            `**Model:** ${model}`,
            `**İstek:** ${featureText.slice(0, 200)}`,
            fileListText,
            info.key === "ts" ? "_(TypeScript kodu Discord uyumluluğu için `.txt` uzantısıyla gönderildi)_" : "",
            retried ? "_Not: İlk üretim beklenen dille tam eşleşmedi, otomatik olarak yeniden üretildi._" : "",
            hasTruncated
              ? `\n${EMOJIS.alert} **Uyarı:** İstek çok büyük olduğu için şu dosya(lar) tam bitirilemeden kesildi, ekteki kod eksik/bozuk olabilir ` +
                `(ör. kapanmamış \`<script>\`, yarım fonksiyon vb.): ${truncatedFiles.map((f) => `\`${discordSafeFilename(f.filename)}\``).join(", ")}. ` +
                "İsteği daha küçük parçalara bölerek (ör. önce HTML+CSS, sonra ayrı bir mesajda JS/animasyonlar) tekrar denemen önerilir."
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .setFooter({ text: `İsteyen: ${message.author.tag}` })
        .setTimestamp();

      if (aiNotlari) {
        embed.addFields({
          name: "📝 AI Notları",
          value: aiNotlari,
          inline: false,
        });
      }

      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2,
      components: [embed, ...fileComponents(attachments)], files: attachments });
    } catch (err: unknown) {
      console.error("kod-yaz patladı la:", err);
      return loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} Hata oluştu: ${err instanceof Error ? err.message : String(err)}` })] });
    }
  },
};


addSlash(command, [
  { name: "dil", description: "Programlama dili", type: "string", required: true },
  { name: "aciklama", description: "Ne yapacağı", type: "string", required: true },
  { name: "dosya", description: "Referans dosya ekle", type: "attachment" },
]);

export default command;
