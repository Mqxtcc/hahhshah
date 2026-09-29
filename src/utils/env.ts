import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

// Pterodactyl/Wisp kurulumlarında .env container kökündedir. Yerel ve
// Replit çalıştırmalarında ise proje kökündeki .env kullanılır. İki ortamı
// desteklerken rastgele dosya taraması yapmıyoruz; yalnızca bilinen iki yolu
// kontrol ediyoruz. ENV_FILE verilirse açıkça seçilen yol önceliklidir.
const containerEnvPath = "/home/container/.env";
const localEnvPath = path.resolve(process.cwd(), ".env");
const ENV_PATH =
  process.env.ENV_FILE?.trim() ||
  (fs.existsSync(containerEnvPath) ? containerEnvPath : localEnvPath);

let loaded = false;

/**
 * Süreç boyunca yalnızca bir kez çalışır (idempotent). index.ts, db/index.ts
 * ve messageCreate.ts gibi birden çok giriş noktasından güvenle çağrılabilir.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  dotenv.config({ path: ENV_PATH });
}


