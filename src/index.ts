import { loadEnv } from "./utils/env.js";
loadEnv();

import http from "http";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");
import { warmGuardConfigCache } from "./utils/guard.js";
import { warmAutomodConfigCache } from "./automod/store.js";
import { loadEmojiOverrides } from "./utils/componentsV2.js";

import { closeDatabase, ensureTables } from "./db/index.js";
import { setReservedCommandNames } from "./customEvents/store.js";
import { flushWelcomeBackActivityNow } from "./welcomeback/store.js";
import { commandList, createCommandCollection } from "./commands/registry.js";
import { setSlashPrefixResolver } from "./utils/slashBridge.js";
import { getGuildPrefix } from "./events/messageCreate.js";
import { installConsoleCapture } from "./utils/runtimeLogs.js";
import {
  createDiscordClient,
  initializePersistentState,
  registerDiscordEvents,
} from "./app/botClient.js";
import { startDashboardApi } from "./api/dashboardApi.js";

installConsoleCapture();

const TOKEN = process.env.TOKEN?.trim();
if (!TOKEN) {
  console.error("TOKEN yok la, env'e bak");
  process.exit(1);
}

const commands = createCommandCollection(commandList);
setReservedCommandNames(commands.keys());
// Slash bridge, content sentezi için sunucuya özel prefix'i buradan alır.
setSlashPrefixResolver((guildId) => getGuildPrefix(guildId));
const client = createDiscordClient();
registerDiscordEvents(client, {
  token: TOKEN,
  commands,
  slashCommands: commandList,
});
process.on("unhandledRejection", (err) =>
  console.error("yakalanmayan promise patladı:", err),
);
process.on("uncaughtException", (err) => {
  console.error("bot çöktü la:", err);
  void shutdown(1);
});

// HTTP health check — sadece production'da (PORT env varı varsa)
let healthServer: http.Server | null = null;
if (process.env.PORT) {
  const HTTP_PORT = Number.parseInt(process.env.PORT, 10);
  if (Number.isInteger(HTTP_PORT) && HTTP_PORT > 0 && HTTP_PORT < 65_536) {
    healthServer = http.createServer((req, res) => {
      if (req.url !== "/healthz") {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      const ready = client.isReady();
      res.writeHead(ready ? 200 : 503, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(
        JSON.stringify({ ok: ready, ping: ready ? client.ws.ping : null }),
      );
    });
    healthServer.listen(HTTP_PORT, () => {
      console.log(`health :${HTTP_PORT}'ta dinliyor`);
    });
  } else {
    console.error(`PORT saçma gelmiş: ${process.env.PORT}`);
  }
}

// 🔎 Bağlantı tanı modu: yalnızca DEBUG_NETWORK=true iken çalışır. Login
// takılıp kalırsa (ne başarılı ne hatalı döner) ağ/DNS seviyesinde bir
// sorunu ayıklamak için kullanılır — üretimde varsayılan olarak kapalıdır.
const DEBUG_NETWORK = process.env.DEBUG_NETWORK === "true";
if (DEBUG_NETWORK) {
  fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${TOKEN}` },
  })
    .then((res) => res.json())
    .then((data) => console.log("rest testi:", data.username ?? data))
    .catch((err) => console.error("rest testi patladı:", err));
}

// Başlangıç sırasında (ör. Neon compute henüz uyanmadıysa) DB'ye ilk erişim
// başarısız olursa artan gecikmelerle birkaç kez daha dener; hepsi başarısız
// olursa hatayı olduğu gibi yukarı fırlatır (start() zaten bunu yakalayıp
// düzgün kapatıyor).
async function withStartupRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 5,
): Promise<T> {
  const delays = [1_000, 2_000, 5_000, 10_000, 15_000];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = delays[attempt - 1] ?? 15_000;
      console.warn(
        `başlangıç adımı "${label}" tutmadı (${attempt}/${maxAttempts}), ${delay}ms sonra tekrar:`,
        err instanceof Error ? err.message : err,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("unreachable");
}

let shuttingDown = false;

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  healthServer?.close();
  client.destroy();
  await flushWelcomeBackActivityNow();
  try {
    await closeDatabase();
  } catch (err) {
    console.error("db kapanırken patladı:", err);
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

async function start(): Promise<void> {
  try {
    // Discord'a bağlanmadan önce JSON veritabanı (data/db) yüklenir; ilk açılışta
    // .env'deki DATABASE_URL'den (Neon) tüm veri tek seferlik data klasörüne
    // aktarılır. Böylece ilk mesajlar yarış durumuna girmez ve hata gizlenmez.
    // Aktarım geçici bir ağ hatasına takılırsa birkaç kez daha denenir.
    console.log("── veri ──");
    await withStartupRetry(() => ensureTables(), "ensureTables");
    await loadEmojiOverrides();
    await warmAutomodConfigCache().catch((err: unknown) => {
      console.error(
        "otomod cache ısınmadı, ilk istekte yüklenir:",
        err,
      );
    });
    await warmGuardConfigCache().catch((err: unknown) => {
      console.error(
        "guard cache ısınmadı, ilk istekte yüklenir:",
        err,
      );
    });
    await initializePersistentState();
    console.log("db hazır, açılıyorum");

    // Dashboard paneli API'si (Vercel'deki panel buraya bağlanır)
    await startDashboardApi(client);

    console.log("── bağlantı ──");
    console.log("discord'a bağlanıyorum...");
    const loginStuckTimer = setTimeout(() => {
      console.warn(
        "15 sn'dir giriş olmadı, gateway/dns'e bak la; " +
          "detay için DEBUG_NETWORK=true açabilirsin.",
      );
    }, 15_000);
    loginStuckTimer.unref?.();

    try {
      await client.login(TOKEN);
    } finally {
      clearTimeout(loginStuckTimer);
    }
  } catch (err) {
    console.error("bot açılamadı la:", err);
    await shutdown(1);
  }
}

void start();
