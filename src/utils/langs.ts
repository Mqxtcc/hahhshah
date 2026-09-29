// src/utils/langs.ts
// !kod-yaz / !kod-duzelt / !kod-test komutları arasında paylaşılan dil
// tanımları. `key` alanı, üretilen kodun gerçekten istenen dilde olup
// olmadığını denetlemek için LANG_SIGNATURES ile eşleştirilen KANONİK
// kimliktir (ör. hem "ts" hem "typescript" -> key: "ts").

export interface LangInfo {
  key: string;
  label: string;
  fence: string;
  attachExt: string;
  commentPrefix: string;
}

export const LANG_MAP: Record<string, LangInfo> = {
  py: { key: "py", label: "Python", fence: "python", attachExt: "py", commentPrefix: "#" },
  python: { key: "py", label: "Python", fence: "python", attachExt: "py", commentPrefix: "#" },

  js: { key: "js", label: "JavaScript", fence: "javascript", attachExt: "js", commentPrefix: "//" },
  javascript: { key: "js", label: "JavaScript", fence: "javascript", attachExt: "js", commentPrefix: "//" },

  // Discord .ts dosyalarını video sanıp önizlemeye çalıştığı için TypeScript
  // çıktısı .txt olarak gönderiliyor.
  ts: { key: "ts", label: "TypeScript", fence: "typescript", attachExt: "txt", commentPrefix: "//" },
  typescript: { key: "ts", label: "TypeScript", fence: "typescript", attachExt: "txt", commentPrefix: "//" },

  cpp: { key: "cpp", label: "C++", fence: "cpp", attachExt: "cpp", commentPrefix: "//" },
  "c++": { key: "cpp", label: "C++", fence: "cpp", attachExt: "cpp", commentPrefix: "//" },
  cxx: { key: "cpp", label: "C++", fence: "cpp", attachExt: "cpp", commentPrefix: "//" },

  c: { key: "c", label: "C", fence: "c", attachExt: "c", commentPrefix: "//" },

  cs: { key: "cs", label: "C#", fence: "csharp", attachExt: "cs", commentPrefix: "//" },
  csharp: { key: "cs", label: "C#", fence: "csharp", attachExt: "cs", commentPrefix: "//" },

  java: { key: "java", label: "Java", fence: "java", attachExt: "java", commentPrefix: "//" },

  go: { key: "go", label: "Go", fence: "go", attachExt: "go", commentPrefix: "//" },
  golang: { key: "go", label: "Go", fence: "go", attachExt: "go", commentPrefix: "//" },

  rs: { key: "rs", label: "Rust", fence: "rust", attachExt: "rs", commentPrefix: "//" },
  rust: { key: "rs", label: "Rust", fence: "rust", attachExt: "rs", commentPrefix: "//" },

  php: { key: "php", label: "PHP", fence: "php", attachExt: "php", commentPrefix: "//" },

  rb: { key: "rb", label: "Ruby", fence: "ruby", attachExt: "rb", commentPrefix: "#" },
  ruby: { key: "rb", label: "Ruby", fence: "ruby", attachExt: "rb", commentPrefix: "#" },

  kt: { key: "kt", label: "Kotlin", fence: "kotlin", attachExt: "kt", commentPrefix: "//" },
  kotlin: { key: "kt", label: "Kotlin", fence: "kotlin", attachExt: "kt", commentPrefix: "//" },

  swift: { key: "swift", label: "Swift", fence: "swift", attachExt: "swift", commentPrefix: "//" },

  lua: { key: "lua", label: "Lua", fence: "lua", attachExt: "lua", commentPrefix: "--" },

  sql: { key: "sql", label: "SQL", fence: "sql", attachExt: "sql", commentPrefix: "--" },

  sh: { key: "sh", label: "Bash", fence: "bash", attachExt: "sh", commentPrefix: "#" },
  bash: { key: "sh", label: "Bash", fence: "bash", attachExt: "sh", commentPrefix: "#" },

  html: { key: "html", label: "HTML", fence: "html", attachExt: "html", commentPrefix: "<!--" },

  css: { key: "css", label: "CSS", fence: "css", attachExt: "css", commentPrefix: "/*" },

  // BDScript: bot oluşturucu (BDFD tarzı) platformlarda kullanılan,
  // $fonksiyon[argüman;argüman] biçimli, fonksiyon tabanlı script dili.
  bds: { key: "bds", label: "BDScript", fence: "js", attachExt: "bds", commentPrefix: "$comment" },
  bdscript: { key: "bds", label: "BDScript", fence: "js", attachExt: "bds", commentPrefix: "$comment" },
};

// Dosya uzantısından kanonik dil anahtarına hızlı erişim (kod-duzelt /
// kod-test gibi, dilin komuta değil ekli dosyadan geldiği komutlar için).
const EXT_TO_KEY: Record<string, string> = {
  py: "py",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",
  ts: "ts",
  tsx: "ts",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  c: "c",
  h: "c",
  cs: "cs",
  java: "java",
  go: "go",
  rs: "rs",
  php: "php",
  rb: "rb",
  kt: "kt",
  swift: "swift",
  lua: "lua",
  sql: "sql",
  sh: "sh",
  bash: "sh",
  html: "html",
  htm: "html",
  css: "css",
  bds: "bds",
};

export function keyFromExtension(ext: string): string | null {
  return EXT_TO_KEY[ext.toLowerCase()] ?? null;
}

export function labelForKey(key: string): string {
  const entry = Object.values(LANG_MAP).find((info) => info.key === key);
  return entry?.label ?? key;
}

// Yorum satırı biçimi tek bir "prefix" ile ifade edilemeyen diller (HTML, CSS
// gibi hem açılış hem kapanış işareti gerektirenler) için satırı saran
// yardımcı fonksiyon. Diğer diller için düz "prefix + metin" yeterli.
export function wrapComment(info: LangInfo, line: string): string {
  switch (info.commentPrefix) {
    case "<!--":
      return `<!-- ${line} -->`;
    case "/*":
      return `/* ${line} */`;
    case "$comment":
      return `$comment[${line}]`;
    default:
      return `${info.commentPrefix} ${line}`;
  }
}

// ---------------------------------------------------------------------------
// Dil doğrulama: modelin gerçekten istenen dilde kod ürettiğini kontrol etmek
// için her dilin ayırt edici söz dizimine ait "en az biri eşleşmeli" imzalar.
// Amaç kusursuz bir dil tespiti değil (bu imkansız), asıl hedeflenen somut
// hata durumu: "TS istendi ama düz JS döndü" gibi bariz karışıklıkları
// yakalayıp bir kez daha denemek. "js" için kasıtlı olarak imza YOK — JS,
// diğer dillerin aksine ayırt edici zorunlu bir söz dizimine sahip değil ve
// birçok "temel" kod bloğuyla örtüşür, o yüzden her zaman geçerli sayılır.
// ---------------------------------------------------------------------------
export const LANG_SIGNATURES: Record<string, RegExp[]> = {
  ts: [
    /:\s*(string|number|boolean|void|any|unknown|never|object)\b/,
    /\binterface\s+\w+/,
    /\btype\s+\w+\s*=/,
    /\bas\s+const\b/,
    /<[A-Za-z_]\w*>/,
    /\b(public|private|readonly)\s+\w+/,
    /\benum\s+\w+/,
  ],
  py: [/^\s*def\s+\w+\(/m, /^\s*import\s+\w+/m, /^\s*from\s+\w+\s+import/m, /\bself\b/, /:\s*$/m, /\bprint\(/],
  java: [/\bpublic\s+(static\s+)?(class|void|int|String|final)\b/, /\bSystem\.out\.print/, /\bpackage\s+[\w.]+;/],
  cpp: [/#include\s*<\w+>/, /\bstd::/, /\bcout\s*<</, /::\w+/],
  c: [/#include\s*<\w+\.h>/, /\bprintf\s*\(/, /\bint\s+main\s*\(/],
  cs: [/\busing\s+System/, /\bConsole\.WriteLine/, /\bnamespace\s+\w+/, /\bpublic\s+class\b/],
  go: [/\bpackage\s+main\b/, /\bfunc\s+\w+\(/, /\bfmt\./],
  rs: [/\bfn\s+\w+\(/, /\blet\s+mut\b/, /\bprintln!\(/, /::</],
  php: [/<\?php/, /\becho\s+/],
  rb: [/\bdef\s+\w+/, /\bend\b/, /\bputs\s+/],
  kt: [/\bfun\s+\w+\(/, /\bval\s+\w+/, /\bprintln\(/],
  swift: [/\bfunc\s+\w+\(/, /\bimport\s+Foundation/, /\blet\s+\w+\s*[:=]/, /\bvar\s+\w+\s*[:=]/],
  lua: [/\blocal\s+\w+/, /\bfunction\s+\w+\(/, /\bend\b/],
  sql: [/\bSELECT\b/i, /\bINSERT\s+INTO\b/i, /\bCREATE\s+TABLE\b/i, /\bUPDATE\s+\w+\s+SET\b/i],
  sh: [/^#!/, /\bfi\b/, /\becho\s+/, /\$\{?\w+\}?/],
  html: [/<html/i, /<!DOCTYPE/i, /<div/i, /<body/i],
  css: [/\{[^{}]*:[^{}]*;[^{}]*\}/, /^[.#]?[\w-]+\s*\{/m],
  bds: [/\$\w+\[/],
};

/** Kodun (heuristik olarak) beklenen dile ait ayırt edici bir söz dizimi içerip içermediğini kontrol eder. */
export function validateLanguage(code: string, key: string): boolean {
  const patterns = LANG_SIGNATURES[key];
  if (!patterns || patterns.length === 0) return true; // js gibi ayırt edici imzası olmayan diller için her zaman geçerli
  return patterns.some((pattern) => pattern.test(code));
}
