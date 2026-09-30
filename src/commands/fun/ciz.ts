import { fileComponent, errorCard, textCard } from "../../utils/componentsV2.js";
import { MessageFlags, AttachmentBuilder, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX } from "../../config.js";
import { getGuildPrefix } from "../../events/messageCreate.js";
import { requirePremiumOrTrial, consumeTrialUse } from "../../premium/gate.js";
import {
  CLOUDFLARE_MAX_PROMPT_CHARS,
  enrichDrawPrompt,
} from "../../utils/cloudflareAi.js";
import { generateImage } from "../../utils/imageGen.js";
import { EMOJIS } from "../../utils/emojis.js";
import { addSlash } from "../../utils/slashBridge.js";
import { usageEmbed } from "../../utils/messages.js";

// !çiz <istek>
//
// Cloudflare Workers AI (varsayılan: @cf/black-forest-labs/flux-2-klein-9b)
// ile görsel üretir; Cloudflare başarısız olursa PixRouter'a düşer (model:
// owner'ın !görsel <model> komutuyla seçtiği, varsayılan firefly-image-5).
//
// Akış:
//   1) Kullanıcının Türkçe isteği, !modeller > "Groq ve Diğerleri" grubunda
//      o an seçili olan modelle (bkz. utils/groq.ts, utils/modelSettings.ts)
//      detaylı, İngilizce bir görsel prompt'una çevrilip zenginleştirilir
//      (bkz. enrichDrawPrompt).
//   2) Zenginleştirilmiş prompt Cloudflare FLUX.2 [klein] 9B'ye gönderilir.
//   3) Cloudflare hata verirse aynı prompt PixRouter'a gönderilir (fallback).
//
// Gerekli .env değişkenleri: CLOUDFLARE_API_TOKEN_1, CLOUDFLARE_ACCOUNT_ID
// (+ zenginleştirme adımı için groq.ts'in beklediği sağlayıcı anahtarları,
// ör. GROQ_API_KEY_1), fallback için PIXROUTER_API_KEY (veya _1.._3)

const command: Command = {
  name: "çiz",
  aliases: ["ciz", "draw"],
  description: "Cloudflare AI ile istediğin görseli çizer",
  usage: `${DEFAULT_PREFIX}çiz <istek>`,
  category: "fun",

  async execute(message: Message, args: string[]) {
    const prefix = getGuildPrefix(message.guild?.id);
    const request = args.join(" ").trim();

    if (!request) {
      return await message.reply({ flags: MessageFlags.IsComponentsV2,
      components: [usageEmbed(
        `${EMOJIS.usage} Kullanım: \`${prefix}çiz <istek>\`\n` +
          `Örnek: \`${prefix}çiz gün batımında dağ manzarası\``,
      )] });
    }

    if (request.length > CLOUDFLARE_MAX_PROMPT_CHARS) {
      return await message.reply({ flags: MessageFlags.IsComponentsV2, components: [errorCard({ description: `${EMOJIS.error} İstek çok uzun (maks ${CLOUDFLARE_MAX_PROMPT_CHARS} karakter).` })] });
    }

    // Görsel üretimi maliyetli (Groq zenginleştirme + FLUX/PixRouter):
    // rate limit + premium/deneme kontrolü — premium'suz sınırsız açık bırakılamaz.
    if (!(await requirePremiumOrTrial(message, "çiz"))) return;

    const channel = message.channel as unknown as {
      sendTyping?: () => Promise<unknown>;
    };
    await channel.sendTyping?.().catch(() => null);
    const typingRefresh = setInterval(() => {
      void channel.sendTyping?.().catch(() => null);
    }, 8_000);

    const loadingMsg = await message
      .reply({
        flags: MessageFlags.IsComponentsV2,
        components: textCard(`${EMOJIS.loading} Prompt hazırlanıyor...`),
        allowedMentions: { repliedUser: false, parse: [] },
      })
      .catch(() => null);

    try {
      const enrichedPrompt = await enrichDrawPrompt(request);

      await loadingMsg
        ?.edit({ flags: MessageFlags.IsComponentsV2, components: textCard(`${EMOJIS.loading} Çiziliyor... (biraz zaman alabilir)`) })
        .catch(() => null);

      const image = await generateImage(enrichedPrompt);

      // ✅ AI başarılı sonuç üretti → deneme hakkını şimdi harca.
      await consumeTrialUse(message, "çiz");
      const attachment = new AttachmentBuilder(image.buffer, {
        name: `ciz.${image.extension}`,
      });

      if (loadingMsg) {
        return await loadingMsg.edit({
          flags: MessageFlags.IsComponentsV2,
          components: [...textCard("🎨 Oluşturulan görsel"), fileComponent(attachment.name ?? "ciz.png")],
          files: [attachment],
          allowedMentions: { repliedUser: false, parse: [] },
        });
      }
      return await message.reply({ flags: MessageFlags.IsComponentsV2, components: [...textCard("🎨 Oluşturulan görsel"), fileComponent(attachment.name ?? "ciz.png")], files: [attachment],
        allowedMentions: { repliedUser: false, parse: [] },
      });
    } catch (err: unknown) {
      console.error("çiz patladı la:", err);
      const errorContent = `${EMOJIS.error} Görsel çizilemedi:\n${err instanceof Error ? err.message : String(err)}`.slice(0, 1_900);
      if (loadingMsg) {
        return await loadingMsg.edit({ flags: MessageFlags.IsComponentsV2, components: textCard(errorContent) }).catch(() => null);
      }
      return message
        .reply({
          flags: MessageFlags.IsComponentsV2,
          components: textCard(errorContent),
          allowedMentions: { repliedUser: false, parse: [] },
        })
        .catch(() => null);
    } finally {
      clearInterval(typingRefresh);
    }
  },
};


addSlash(command, [
  { name: "istek", description: "Çizilmesini istediğiniz şey", type: "string", required: true },
]);

export default command;
