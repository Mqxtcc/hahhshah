// Kullanıcı bazlı basit mutex: aynı kullanıcının davet/hediye işlemleri
// birbirine girip çift sayım / çift hediye yapmasın diye.
// (Node tek thread — yarış, await'ler arası geçişte olur; bu zincir onu engeller.)
const locks = new Map<string, Promise<void>>();

/**
 * fn'i userId kilidi altında çalıştırır. Aynı userId için çağrılar
 * sıraya girer, üst üste binmez.
 */
export function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((res) => {
    release = res;
  });
  const tail = prev.then(() => mine);
  locks.set(userId, tail);

  const result = prev.then(() => fn());
  // fn bitince (başarılı/hatalı) kilidi bırak.
  result.then(release, release);
  // Kuyrukta bizden sonra kimse yoksa kaydı temizle (bellek sızıntısı olmasın).
  tail.then(() => {
    if (locks.get(userId) === tail) locks.delete(userId);
  });
  return result;
}
