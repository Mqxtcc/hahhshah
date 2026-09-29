import fs from "node:fs";
import path from "node:path";

// !görsel <model> ile owner'ın seçtiği PixRouter görsel modeli.
// DB (Neon) KULLANMAZ — yerel JSON dosyasına yazılır: data/image-model.json
// (Neon -> JSON geçişiyle uyumlu; data klasörü yoksa otomatik oluşturulur.)

export const DEFAULT_PIXROUTER_IMAGE_MODEL = "firefly-image-5";

const DATA_DIR = process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "image-model.json");

let cached: string | null = null;

function readFromDisk(): string | null {
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf8");
    const data: unknown = JSON.parse(raw);
    if (data && typeof data === "object") {
      const model = (data as { pixrouterModel?: unknown }).pixrouterModel;
      if (typeof model === "string" && model.trim()) return model.trim();
    }
  } catch {
    // dosya yok / bozuk -> varsayılan
  }
  return null;
}

export function getPixRouterImageModel(): string {
  if (cached !== null) return cached;
  const model: string =
    readFromDisk() ||
    process.env.PIXROUTER_IMAGE_MODEL?.trim() ||
    DEFAULT_PIXROUTER_IMAGE_MODEL;
  cached = model;
  return model;
}

function writeAtomic(model: string): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE_PATH}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ pixrouterModel: model, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  fs.renameSync(tmp, FILE_PATH);
}

export function setPixRouterImageModel(model: string): void {
  const clean = model.trim();
  writeAtomic(clean);
  cached = clean;
}

/** Kayıtlı seçimi siler, varsayılana (env veya firefly-image-5) döner. */
export function resetPixRouterImageModel(): string {
  try {
    fs.rmSync(FILE_PATH, { force: true });
  } catch {
    // yoksay
  }
  cached = null;
  return getPixRouterImageModel();
}
