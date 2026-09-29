import { Collection } from "discord.js";
import type { Command } from "../types.js";
import { setLoadedCommands } from "./loader.js";

import { modCommands } from "./mod/index.js";
import restart from "./restart.js";
import evalCmd from "./owner/eval.js";
import vip from "./owner/vip.js";
import premium from "./owner/premium.js";
import premiumKaldir from "./owner/premium-kaldir.js";
import premiumListe from "./owner/premium-liste.js";
import halfowner from "./owner/halfowner.js";
import modeller from "./owner/modeller.js";
import gorsel from "./owner/gorsel.js";
import { cevapOlustur, cevapSil, cevapListe } from "./owner/cevap.js";
import { duyuru, say, yeniEmbed } from "./owner/mesaj.js";
import {
  hataLog,
  consoleLog,
  istatistik,
  ping,
  uptime,
  sunucular,
} from "./owner/diagnostik.js";
import mentionai from "./owner/mentionai.js";
import veribak from "./owner/veribak.js";
import rol from "./rol/rol.js";
import sekiztop from "./fun/sekiztop.js";
import zar from "./fun/zar.js";
import yazitura from "./fun/yazitura.js";
import saka from "./fun/saka.js";
import fikra from "./fun/fikra.js";
import avatar from "./fun/avatar.js";
import kodYaz from "./fun/kod-yaz.js";
import kodAnaliz from "./fun/kod-analiz.js";
import kodDuzelt from "./fun/kod-duzelt.js";
import kod from "./fun/kod.js";
import sor from "./fun/sor.js";
import ozetle from "./fun/ozetle.js";
import ozet from "./fun/ozet.js";
import ceviri from "./fun/ceviri.js";
import kodTest from "./fun/kod-test.js";
import yaz from "./fun/yaz.js";
import ciz from "./fun/ciz.js";
import fikir from "./fun/fikir.js";
import bilgiyarismasi from "./fun/bilgiyarismasi.js";
import bilgiyarismasiSkor from "./fun/bilgiyarismasi-skor.js";
import kelime from "./fun/kelime.js";
import hesapla from "./fun/hesapla.js";
import sifre from "./fun/sifre.js";
import anket from "./fun/anket.js";
import agent from "./fun/agent.js";
import help from "./help.js";
import prefixCmd from "./prefix.js";
import bilgi from "./bilgi.js";
import info from "./info.js";
import sunucubilgi from "./sunucubilgi.js";
import halfownerBilgi from "./halfowner-bilgi.js";
import afk from "./afk.js";
import davet from "./davet.js";
import davetTop from "./davet-top.js";
import hediye from "./hediye.js";
import hatirlat from "./hatirlat.js";
import renk from "./renk.js";
import premiumbilgi from "./premiumbilgi.js";
import customEventCmd from "./customevent.js";
import customSil from "./custom-sil.js";
import customEventListe from "./customevent-liste.js";
import customEventAyar from "./customevent-ayar.js";
import ownerRole from "./owner/ownerrole.js";
import tekrarHosgeldin from "./tekrarhosgeldin.js";
import ask from "./fun/ask.js";
import { evlen, bosan, es } from "./fun/evlilik.js";
import burc from "./fun/burc.js";
import ppboyu from "./fun/ppboyu.js";
import sec from "./fun/sec.js";
import slot from "./fun/slot.js";
import tahmin from "./fun/tahmin.js";
import sayac from "./sayac.js";
import firstmsg from "./firstmsg.js";
import kanalbilgi from "./kanalbilgi.js";
import { notEkle, notlar } from "./not.js";
import botkontrol from "./botkontrol.js";
import rep from "./rep.js";
import snipe from "./snipe.js";
import { dogumgunu, dogumgunleri } from "./dogumgunu.js";
import botOwner from "./botowner.js";
import emojiOverridesCommand from "./emojidegistir.js";

/** Botun tüm yerleşik komutlarının tek ve denetlenebilir kayıt noktası. */
export const commandList: readonly Command[] = [
  ...modCommands,
  restart,
  rol,
  sekiztop,
  zar,
  yazitura,
  saka,
  fikra,
  avatar,
  kodYaz,
  kodAnaliz,
  kodDuzelt,
  kodTest,
  kod,
  sor,
  ozetle,
  ozet,
  ceviri,
  yaz,
  ciz,
  fikir,
  bilgiyarismasi,
  bilgiyarismasiSkor,
  kelime,
  agent,
  hesapla,
  sifre,
  anket,
  ask,
  evlen,
  bosan,
  es,
  burc,
  ppboyu,
  sec,
  slot,
  tahmin,
  sayac,
  firstmsg,
  kanalbilgi,
  notEkle,
  notlar,
  botkontrol,
  rep,
  snipe,
  dogumgunu,
  dogumgunleri,
  help,
  prefixCmd,
  bilgi,
  info,
  sunucubilgi,
  halfownerBilgi,
  afk,
  davet,
  davetTop,
  hediye,
  tekrarHosgeldin,
  hatirlat,
  renk,
  premiumbilgi,
  customEventCmd,
  customSil,
  customEventListe,
  customEventAyar,
  evalCmd,
  vip,
  cevapOlustur,
  cevapSil,
  cevapListe,
  ownerRole,
  premium,
  premiumKaldir,
  premiumListe,
  halfowner,
  modeller,
  gorsel,
  duyuru,
  say,
  yeniEmbed,
  hataLog,
  consoleLog,
  istatistik,
  ping,
  uptime,
  sunucular,
  botOwner,
  emojiOverridesCommand,
  mentionai,
  veribak,
];
setLoadedCommands(commandList);

function commandKeys(command: Command): string[] {
  return [command.name, ...(command.aliases ?? [])];
}

/** Komut ve alias çakışmalarını bot açılmadan önce görünür biçimde reddeder. */
export function createCommandCollection(
  commands: readonly Command[] = commandList,
): Collection<string, Command> {
  const collection = new Collection<string, Command>();
  const owners = new Map<string, string>();

  for (const command of commands) {
    for (const key of new Set(commandKeys(command))) {
      const normalized = key.trim().toLocaleLowerCase("tr-TR");
      if (!normalized) {
        throw new Error(`Boş komut adı/alias bulundu: ${command.name}`);
      }
      const previous = owners.get(normalized);
      if (previous) {
        throw new Error(
          `Komut/alias çakışması: ${normalized} (${previous} ve ${command.name})`,
        );
      }
      owners.set(normalized, command.name);
      collection.set(key, command);
      collection.set(normalized, command);
    }
    // Slash adı (örn. "ciz") prefix adından farklıysa onu da indeksle ki
    // /ciz etkileşimi komuta ulaşabilsin.
    if (command.slashName && command.slashName !== command.name) {
      const sNorm = command.slashName.trim().toLocaleLowerCase("tr-TR");
      if (sNorm && !owners.has(sNorm)) {
        owners.set(sNorm, command.name);
        collection.set(command.slashName, command);
        collection.set(sNorm, command);
      }
    }
  }

  return collection;
}
