#!/usr/bin/env node
// Включает автообновление в релизной сборке, если в репозитории настроена подпись:
//   секрет  TAURI_SIGNING_PRIVATE_KEY (+ TAURI_SIGNING_PRIVATE_KEY_PASSWORD) — приватный ключ,
//   переменная TAURI_UPDATER_PUBKEY — публичный ключ (вшивается в приложение),
//   переменная UPDATES_REPO (необязательно) — публичный репозиторий с обновлениями,
//   если основной репозиторий приватный.
// Пишет src-tauri/tauri.updater.conf.json и TAURI_UPDATER_ARGS=--config <файл> в $GITHUB_ENV.
// Без ключей сборка идёт как раньше, а приложение пишет, что обновления ставятся вручную.
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const hasKey = process.env.HAS_SIGNING_KEY === 'true';
const pubkey = (process.env.UPDATER_PUBKEY ?? '').trim();
const repo = (process.env.UPDATES_REPO ?? '').trim() || process.env.GITHUB_REPOSITORY;
const envFile = process.env.GITHUB_ENV;

function setEnv(line) {
  if (envFile) appendFileSync(envFile, line + '\n');
}

if (!hasKey || !pubkey) {
  const missing = [!hasKey && 'секрета TAURI_SIGNING_PRIVATE_KEY', !pubkey && 'переменной TAURI_UPDATER_PUBKEY'].filter(Boolean).join(' и ');
  console.log(`::warning::Автообновление в этой сборке выключено: нет ${missing}.`);
  setEnv('TAURI_UPDATER_ARGS=');
} else {
  const endpoint = `https://github.com/${repo}/releases/latest/download/latest.json`;
  const conf = {
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey, endpoints: [endpoint] } },
  };
  // Абсолютный путь с прямыми слэшами — его одинаково понимают Tauri CLI на Windows и macOS.
  const file = resolve('src-tauri/tauri.updater.conf.json').replace(/\\/g, '/');
  writeFileSync(file, JSON.stringify(conf, null, 2) + '\n');
  setEnv(`TAURI_UPDATER_ARGS=--config ${file}`);
  console.log(`Автообновление включено, канал: ${endpoint}`);
}
