// Платформа, на которой запущено приложение: определяем по user agent встроенного браузера
// (WebView2 на Windows, WKWebView на macOS). Нужна для системных подписей в интерфейсе.
export type Platform = 'windows' | 'mac' | 'linux';

export function detectPlatform(ua: string): Platform {
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Windows/i.test(ua)) return 'windows';
  return 'linux';
}

export const platform: Platform = detectPlatform(typeof navigator !== 'undefined' ? navigator.userAgent : '');
export const isMac = platform === 'mac';
export const isWindows = platform === 'windows';

/** Как называется системное хранилище паролей на этой платформе. */
export function secretStoreName(p: Platform = platform): string {
  if (p === 'mac') return 'связке ключей macOS (Keychain)';
  if (p === 'windows') return 'диспетчере учётных данных Windows (Credential Manager)';
  return 'системном хранилище паролей';
}

/** Подпись сочетания клавиш под платформу: на macOS — ⌘ вместо Ctrl («⌘L»). */
export function hotkeyLabel(combo: string, p: Platform = platform): string {
  return p === 'mac' ? combo.replace(/Ctrl\+/g, '⌘') : combo;
}

/** Нажат ли модификатор горячих клавиш: Ctrl, а на macOS ещё и ⌘. */
export function isModKey(e: { ctrlKey: boolean; metaKey: boolean }, p: Platform = platform): boolean {
  return e.ctrlKey || (p === 'mac' && e.metaKey);
}

/** Название системы для фраз вида «при входе в …». */
export function osName(p: Platform = platform): string {
  if (p === 'mac') return 'macOS';
  if (p === 'windows') return 'Windows';
  return 'систему';
}
