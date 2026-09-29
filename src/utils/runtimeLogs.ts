export const BOT_START_TIME = Date.now();

export type ErrorLogEntry = {
  message: string;
  timestamp: number;
};

export type ConsoleLogEntry = {
  level: "log" | "warn" | "info" | "error";
  message: string;
  timestamp: number;
};

const ERROR_LOG_MAX = 20;
const CONSOLE_LOG_MAX_ENTRIES = 1_500;
const CONSOLE_LOG_MAX_AGE_MS = 60 * 60_000;

export const errorLog: ErrorLogEntry[] = [];
export const consoleLogBuffer: ConsoleLogEntry[] = [];

function formatLogValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[serileştirilemeyen değer]";
  }
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map(formatLogValue).join(" ");
}

function pushConsoleLog(level: ConsoleLogEntry["level"], args: unknown[]): void {
  const now = Date.now();
  consoleLogBuffer.push({
    level,
    message: formatConsoleArgs(args),
    timestamp: now,
  });

  const cutoff = now - CONSOLE_LOG_MAX_AGE_MS;
  while (consoleLogBuffer[0]?.timestamp < cutoff) consoleLogBuffer.shift();
  while (consoleLogBuffer.length > CONSOLE_LOG_MAX_ENTRIES) {
    consoleLogBuffer.shift();
  }
}

function pushErrorLog(args: unknown[]): void {
  errorLog.push({
    message: formatConsoleArgs(args),
    timestamp: Date.now(),
  });
  while (errorLog.length > ERROR_LOG_MAX) errorLog.shift();
}

let consoleCaptureInstalled = false;

/**
 * Tanı komutları için process loglarını bellekte tutar.
 * Import yan etkisi değildir; uygulama giriş noktası tarafından bir kez çağrılır.
 */
export function installConsoleCapture(): void {
  if (consoleCaptureInstalled) return;
  consoleCaptureInstalled = true;

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalInfo = console.info.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    originalLog(...args);
    pushConsoleLog("log", args);
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    pushConsoleLog("warn", args);
  };
  console.info = (...args: unknown[]) => {
    originalInfo(...args);
    pushConsoleLog("info", args);
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    pushErrorLog(args);
    pushConsoleLog("error", args);
  };
}