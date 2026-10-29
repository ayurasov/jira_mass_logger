import { describe, expect, it } from 'vitest';
import { detectPlatform, osName, secretStoreName } from '../platform';

describe('detectPlatform', () => {
  it('WebView2 на Windows, WKWebView на macOS, остальное — Linux', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe('mac');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15')).toBe('linux');
  });

  it('системные названия под платформу', () => {
    expect(secretStoreName('mac')).toContain('Keychain');
    expect(secretStoreName('windows')).toContain('Credential Manager');
    expect(osName('mac')).toBe('macOS');
    expect(osName('windows')).toBe('Windows');
  });
});

describe('горячие клавиши', () => {
  it('на macOS подписи с ⌘, на Windows — Ctrl', async () => {
    const { hotkeyLabel } = await import('../platform');
    expect(hotkeyLabel('Ctrl+L', 'mac')).toBe('⌘L');
    expect(hotkeyLabel('Ctrl+Enter', 'mac')).toBe('⌘Enter');
    expect(hotkeyLabel('Ctrl+L', 'windows')).toBe('Ctrl+L');
    expect(hotkeyLabel('F1', 'mac')).toBe('F1');
  });

  it('на macOS срабатывает и ⌘, и Ctrl; на Windows — только Ctrl', async () => {
    const { isModKey } = await import('../platform');
    expect(isModKey({ ctrlKey: false, metaKey: true }, 'mac')).toBe(true);
    expect(isModKey({ ctrlKey: true, metaKey: false }, 'mac')).toBe(true);
    expect(isModKey({ ctrlKey: false, metaKey: true }, 'windows')).toBe(false);
    expect(isModKey({ ctrlKey: true, metaKey: false }, 'windows')).toBe(true);
  });
});
