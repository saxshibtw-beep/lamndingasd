import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Reads project-root config.json and copies values into process.env
 * so the bot code stays unchanged. No .env files required.
 *
 * @param {string} rootDir Absolute path to repo root (folder with config.json)
 */
export async function loadAppConfig(rootDir) {
  const p = path.join(rootDir, 'config.json');
  let data;
  try {
    data = JSON.parse(await fs.readFile(p, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      console.error(
        'Missing config.json in project root.\n' +
          'First step: copy config.example.json to config.json and edit it.'
      );
      process.exit(1);
    }
    console.error('Invalid config.json:', e.message);
    process.exit(1);
  }

  const token = data.telegramBotToken ?? data.TELEGRAM_BOT_TOKEN;
  const ids = data.allowedUserIds ?? data.ALLOWED_USER_IDS;
  if (token != null && String(token).trim()) process.env.TELEGRAM_BOT_TOKEN = String(token).trim();
  if (ids != null && String(ids).trim()) process.env.ALLOWED_USER_IDS = String(ids).trim();

  const site = data.siteDir ?? data.SITE_DIR;
  if (site != null && String(site).trim()) {
    const s = String(site).trim();
    process.env.SITE_DIR = path.isAbsolute(s) ? s : path.resolve(rootDir, s);
  }

  const persist = data.persistDir ?? data.PERSIST_DIR;
  if (persist != null && String(persist).trim()) {
    const s = String(persist).trim();
    process.env.PERSIST_DIR = path.isAbsolute(s) ? s : path.resolve(rootDir, s);
  }

  return data;
}

/** HTTP port when process.env.PORT is unset (local runs). */
export function httpPortFromConfig(configData, fallback = 3000) {
  const n = Number(configData?.httpPort ?? configData?.PORT);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}
