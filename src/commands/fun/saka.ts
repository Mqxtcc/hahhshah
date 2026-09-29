import { MessageFlags,
  SlashCommandBuilder,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../../types.js";
import { infoEmbed } from "../../utils/embeds.js";

const SAKALAR = [
  "Temel çarşıya gitmiş, kasabın önünde durmuş: \"Bu et kaç lira?\" Kasap: \"200 lira.\" Temel: \"Vay canına, benim ineğim 100 liraya süt veriyor.\" Kasap: \"Benim ineğim de bağırmıyor.\"",
  "Doktor hastaya: \"Sigarayı bırakmanız lazım.\" Hasta: \"Neden, sigara mı öldürüyor?\" Doktor: \"Hayır, ama siz bırakmazken ben sizi bırakıyorum.\"",
  "Öğretmen: \"2 + 2 = kaç?\" Temel: \"4.\" Öğretmen: \"Bravo!\" Temel: \"Bravo mu? Ya 4 yanlış çıksaydı?\"",
  "Adam arabaya binmiş, gaz yok. Mekanik: \"Gazı basmadınız mı?\" Adam: \"Basa basa geldim işte, hâlâ yok!\"",
  "Deli, doktora: \"Herkes beni görmezden geliyor.\" Doktor: \"Sıradaki hasta!\"",
  "İki arkadaş konuşuyor. Biri: \"Dün gece rüyamda uçtum.\" Diğeri: \"Ben de! Ama parayı kim ödeyecek?\"",
  "Temel köyden kente gelmiş, asansöre binmiş, düğmeye basmış. Köye dönünce: \"Şehirliler delidir, odaları var ama içeri girince dışarı çıkarıyor!\"",
  "Öğretmen: \"Türkiye'nin en uzun nehri hangisi?\" Temel: \"Kızılırmak.\" Öğretmen: \"Yanlış, Fırat.\" Temel: \"Hoca, sen sordun ben de bildim, ne karışıyorsun?\"",
  "Dişçi hastaya: \"Çok ağrıyor mu?\" Hasta: \"Hayır.\" Dişçi: \"O zaman neden bağırıyorsunuz?\" Hasta: \"Parmaklarınız ağzımda, başka ne yapayım?\"",
  "Temel balığa gitmiş. Saatlerce beklemiş, hiçbir şey çıkmamış. Yanındaki sormuş: \"Bugün kaç tane tuttu?\" Temel: \"Bu benim dördüncü saatim, sen kaçıncısınasın?\"",
];

const command: Command = {
  name: "saka",
  aliases: ["joke", "espri"],
  description: "Rastgele bir Türk şakası söyler",
  usage: "!saka",
  category: "fun",

  slashData: new SlashCommandBuilder()
    .setName("saka")
    .setDescription("Rastgele bir Türk şakası söyler"),

  async execute(message: Message) {
    const saka = SAKALAR[Math.floor(Math.random() * SAKALAR.length)];
    return message.reply({ flags: MessageFlags.IsComponentsV2,
    components: [infoEmbed("😄 Şaka", saka)] });
  },

  async slashExecute(interaction: ChatInputCommandInteraction) {
    const saka = SAKALAR[Math.floor(Math.random() * SAKALAR.length)];
    await interaction.reply({ flags: MessageFlags.IsComponentsV2,
    components: [infoEmbed("😄 Şaka", saka)] });
  },
};

export default command;
