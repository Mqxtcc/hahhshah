import { V2CardBuilder } from "../../utils/componentsV2.js";
import { MessageFlags, type Message } from "discord.js";
import type { Command } from "../../types.js";
import { addSlash } from "../../utils/slashBridge.js";

const jokes = [
  "Temel ile Dursun uçaktayken uçak düşmeye başlamış. Temel heyecanla sormuş: 'Dursun ne yapacağız?' Dursun kafasını sallamış: 'Üzülme Temel, nasıl olsa şirket bizim değil!'",
  "Hoca'ya sormuşlar: 'Hocam gölde maya tutarsa ne olur?' Hoca cevap vermiş: 'Tutmaz ama ya tutarsa?'",
  "Öğretmen öğrenciye sormuş: 'Çocuklar, gelecekte ne olmak istiyorsunuz?' Çocuğun biri atılmış: 'Emekli olmak istiyorum öğretmenim!'",
  "Temel mahkemede hâkime demiş ki: 'Hâkim bey, suçsuzum, beni serbest bırakın!' Hâkim sormuş: 'Neden?' Temel: 'Çünkü suçumu henüz planlamıştım, uygulamaya koymamıştım!'",
  "Dursun trende karşıdakine sormuş: 'Saat kaç acaba?' Karşıdaki adam cevap vermemiş. Dursun tekrar sormuş, yine ses yok. İnip giderken adam demiş ki: 'Saatim yoktu, onun için söylemedim.' Dursun kızmış: 'E peki niye başta söylemedin?'",
  "Nasreddin Hoca eşeğini kaybetmiş, ama neşe içinde bağırıyormuş: 'Çok şükür Allah'ım!' Çevredekiler şaşırmış: 'Hocam eşeği kaybettin, neden şükrediyorsun?' Hoca: 'Ya üstünde ben olsaydım?'",
  "Temel bir gün iddiaya girmiş ve boğazı yüzerek geçeceğini söylemiş. Yarı yola gelince yorulmuş ve geri dönmüş. Arkadaşı sormuş: 'Neden döndün Temel?' Temel nefes nefese: 'Yoruldum, karşı kıyı çok uzaktı, en iyisi başladığım yere dönmekti!'",
];

const command: Command = {
  name: "fikra",
  description: "Rastgele komik bir fıkra anlatır.",
  usage: "!fikra",
  category: "fun",
  async execute(message: Message, args: string[]) {
    const randomIndex = Math.floor(Math.random() * jokes.length);
    const selectedJoke = jokes[randomIndex];

	const embed = new V2CardBuilder()
	  .setColor(0xe8a0bf)
	  .setTitle("😂 Günün Fıkrası")
	  .setDescription(selectedJoke)
      .setFooter({
        text: `${message.author.tag} tarafından istendi.`,
        iconURL: message.author.displayAvatarURL(),
      })
	  .setTimestamp();

    await message.reply({ flags: MessageFlags.IsComponentsV2,
    components: [embed] });
  },
};


addSlash(command, []);

export default command;
