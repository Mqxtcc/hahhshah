import { COMPONENTS_V2_FLAG, errorCard, textCard } from "../../utils/componentsV2.js";
import type { Message } from "discord.js";
import type { Command } from "../../types.js";
import { DEFAULT_PREFIX } from "../../config.js";
import { getGuildPrefix, requireOwner } from "../../events/messageCreate.js";
import { EMOJIS } from "../../utils/emojis.js";
import {
  DEFAULT_PIXROUTER_IMAGE_MODEL,
  getPixRouterImageModel,
  resetPixRouterImageModel,
  setPixRouterImageModel,
} from "../../utils/imageModelSettings.js";

// !görsel            -> aktif PixRouter görsel modelini gösterir
// !görsel <model>    -> modeli değiştirir (ör. !görsel gpt-image-2)
// !görsel sıfırla    -> varsayılana (firefly-image-5) döner
//
// Sadece OWNER. Bu model, !çiz'de Cloudflare başarısız olunca devreye giren
// PixRouter fallback'inde kullanılır.
//

const MODEL_PATTERN = /^[\w./:@-]{1,100}$/;
const RESET_WORDS = new Set(["sıfırla", "sifirla", "reset", "varsayılan", "varsayilan", "default"]);

const command: Command = {
  name: "görsel",
  aliases: ["gorsel"],
  description: "PixRouter fallback görsel modelini değiştirir (owner)",
  usage: `${DEFAULT_PREFIX}görsel <model>`,
  category: "owner",

  async execute(message: Message, args: string[]) {
    if (!(await requireOwner(message))) return;

    const prefix = getGuildPrefix(message.guild?.id);
    const input = args.join(" ").trim();
    const noMentions = { repliedUser: false, parse: [] as never[] };

    if (!input) {
      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: textCard(
          `🖼️ Aktif PixRouter görsel modeli: \`${getPixRouterImageModel()}\`\n` +
          `Değiştirmek için: \`${prefix}görsel <model>\` • Varsayılan: \`${DEFAULT_PIXROUTER_IMAGE_MODEL}\` (\`${prefix}görsel sıfırla\`)`,
        ),
        allowedMentions: noMentions,
      });
    }

    if (RESET_WORDS.has(input.toLowerCase())) {
      const model = resetPixRouterImageModel();
      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: textCard(`✅ Görsel modeli varsayılana döndü: \`${model}\``),
        allowedMentions: noMentions,
      });
    }

    if (!MODEL_PATTERN.test(input)) {
      return message.reply({
        flags: COMPONENTS_V2_FLAG,
        components: [errorCard({ description: `${EMOJIS.error} Geçersiz model adı. Örnek: \`${prefix}görsel firefly-image-5\`` })],
        allowedMentions: noMentions,
      });
    }

    const previous = getPixRouterImageModel();
    setPixRouterImageModel(input);
    return message.reply({
      flags: COMPONENTS_V2_FLAG,
      components: textCard(`✅ PixRouter görsel modeli değişti: \`${previous}\` → \`${input}\``),
      allowedMentions: noMentions,
    });
  },
};

export default command;
