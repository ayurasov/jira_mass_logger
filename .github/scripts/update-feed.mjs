#!/usr/bin/env node
// Канал автообновления: собирает latest.json для tauri-plugin-updater из подписей (*.sig)
// опубликованного релиза. Собираем сами, а не берём из tauri-action: сборки Windows и macOS
// идут параллельно и при слиянии latest.json затирают платформы друг друга.
//
//   node .github/scripts/update-feed.mjs <папка с *.sig> --version 1.0.13 \
//        --base-url https://github.com/OWNER/REPO/releases/download/TAG \
//        [--notes-file notes.md] [--out latest.json]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Порядок важен: arm64 проверяем раньше x64. Для Windows NSIS-установщик — основной вариант
// (ставится без прав администратора), MSI — для тех, кто ставил MSI.
const RULES = [
  { re: /(arm64|aarch64)[^/]*-setup\.exe\.sig$/i, os: 'windows', arch: 'aarch64', kind: 'nsis' },
  { re: /(x64|x86_64|amd64)[^/]*-setup\.exe\.sig$/i, os: 'windows', arch: 'x86_64', kind: 'nsis' },
  { re: /(arm64|aarch64)[^/]*\.msi\.sig$/i, os: 'windows', arch: 'aarch64', kind: 'msi' },
  { re: /(x64|x86_64|amd64)[^/]*\.msi\.sig$/i, os: 'windows', arch: 'x86_64', kind: 'msi' },
  { re: /(arm64|aarch64)[^/]*\.app\.tar\.gz\.sig$/i, os: 'darwin', arch: 'aarch64', kind: 'app' },
  { re: /(x64|x86_64)[^/]*\.app\.tar\.gz\.sig$/i, os: 'darwin', arch: 'x86_64', kind: 'app' },
];

/**
 * @param {{ files: { name: string, signature: string }[], version: string, baseUrl: string, notes?: string, pubDate?: string }} input
 * @returns {{ version: string, notes: string, pub_date: string, platforms: Record<string, { signature: string, url: string }> }}
 */
export function buildFeed({ files, version, baseUrl, notes = '', pubDate = new Date().toISOString() }) {
  const version_ = String(version).replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+/.test(version_)) throw new Error(`Некорректная версия: ${version}`);
  const base = baseUrl.replace(/\/+$/, '');
  /** @type {Record<string, { signature: string, url: string }>} */
  const platforms = {};
  /** @type {Record<string, string>} */
  const defaultKind = {};
  for (const f of files) {
    const rule = RULES.find((r) => r.re.test(f.name));
    if (!rule) continue;
    const asset = f.name.replace(/\.sig$/i, '');
    const entry = { signature: f.signature.trim(), url: `${base}/${encodeURIComponent(asset)}` };
    const key = `${rule.os}-${rule.arch}`;
    platforms[`${key}-${rule.kind}`] = entry;
    // Ключ без типа установщика — запасной: NSIS важнее MSI.
    if (!platforms[key] || (defaultKind[key] === 'msi' && rule.kind === 'nsis')) {
      platforms[key] = entry;
      defaultKind[key] = rule.kind;
    }
  }
  if (!Object.keys(platforms).length) throw new Error('Не найдено ни одной подписи обновления (*.sig) — включён ли createUpdaterArtifacts?');
  return { version: version_, notes: notes.trim(), pub_date: pubDate, platforms };
}

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(argv) {
  const dir = argv[0];
  const version = arg(argv, '--version');
  const baseUrl = arg(argv, '--base-url');
  if (!dir || !version || !baseUrl) {
    console.error('usage: update-feed.mjs <dir> --version X.Y.Z --base-url URL [--notes-file F] [--out latest.json]');
    process.exit(2);
  }
  const notesFile = arg(argv, '--notes-file');
  const out = arg(argv, '--out') ?? 'latest.json';
  const files = readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.sig'))
    .map((name) => ({ name, signature: readFileSync(join(dir, name), 'utf8') }));
  const feed = buildFeed({ files, version, baseUrl, notes: notesFile ? readFileSync(notesFile, 'utf8') : '' });
  writeFileSync(out, JSON.stringify(feed, null, 2) + '\n');
  console.log(`latest.json: версия ${feed.version}, платформы: ${Object.keys(feed.platforms).join(', ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
