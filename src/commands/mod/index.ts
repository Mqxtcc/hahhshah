import type { Command } from "../../types.js";

import ban from "./ban.js";
import clear from "./clear.js";
import guard from "./guard.js";
import hosgeldin from "./hosgeldin.js";
import izin from "./izin.js";
import kick from "./kick.js";
import logkanal from "./logkanal.js";
import otomod from "./otomod.js";
import setnick from "./setnick.js";
import timeout from "./timeout.js";
import unban from "./unban.js";
import unmute from "./unmute.js";
import uyarilar from "./uyarilar.js";
import warn from "./warn.js";
import butonrol from "../butonrol.js";
import emojirol from "../emojirol.js";
import kategorirol from "../kategorirol.js";
import rolmenu from "../rolmenu.js";
import kilit, { kilitac } from "../kilit.js";
import surelirol from "../surelirol.js";

/** Moderasyon komutlarının tek kayıt noktası. */
export const modCommands: Command[] = [
  ban,
  kick,
  timeout,
  unmute,
  unban,
  warn,
  uyarilar,
  clear,
  setnick,
  izin,
  guard,
  otomod,
  logkanal,
  hosgeldin,
  butonrol,
  emojirol,
  kategorirol,
  rolmenu,
  kilit,
  kilitac,
  surelirol,
];

export default modCommands;
