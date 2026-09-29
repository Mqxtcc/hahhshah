// "pg" yalnızca tek seferlik Neon → JSON aktarımında (db/neonImport.ts) kullanılan
// opsiyonel bir bağımlılıktır; botun normal çalışmasında kurulu olması gerekmez.
// Tip denetiminin bu dosyayı da kapsaması için gevşek ortam bildirimi:
declare module "pg";
