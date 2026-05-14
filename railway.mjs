/**
 * Railway (and similar) entry: HTTPS site + Telegram APK updater.
 * - Listens on process.env.PORT when the host sets it (e.g. Railway); otherwise
 *   uses httpPort from config.json.
 * - Serves only an allowlist (never exposes apk-update-bot/, node_modules).
 * - Optional persistDir in config.json: mount a volume there for durable APK storage.
 */
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpPortFromConfig, loadAppConfig } from './app-config.mjs';
import { startApkUpdateBot } from './apk-update-bot/bot-core.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const PUBLIC_NAMES = new Set([
  'index.html',
  'apk-build.json',
  'model1.jpg',
  'model2.jpg',
  'model3.jpg',
  'notify-config.js',
]);

const SEED_FROM_IMAGE = [
  'index.html',
  'apk-build.json',
  'luxy-spa.apk',
  'model1.jpg',
  'model2.jpg',
  'model3.jpg',
  'notify-config.js',
];

async function seedPersistIfNeeded(persistDir) {
  await fs.mkdir(persistDir, { recursive: true });
  for (const name of SEED_FROM_IMAGE) {
    const dst = path.join(persistDir, name);
    try {
      await fs.access(dst);
      continue;
    } catch {
      /* missing */
    }
    const src = path.join(ROOT, name);
    try {
      await fs.copyFile(src, dst);
      console.log('[railway] Seeded %s → persist', name);
    } catch (e) {
      console.warn('[railway] Could not seed %s: %s', name, (e && e.message) || e);
    }
  }
}

async function main() {
  const configData = await loadAppConfig(ROOT);

  let siteDir = process.env.SITE_DIR ? path.resolve(process.env.SITE_DIR) : ROOT;

  if (process.env.PERSIST_DIR) {
    const persist = path.resolve(process.env.PERSIST_DIR);
    await seedPersistIfNeeded(persist);
    siteDir = persist;
  }

  startApkUpdateBot(siteDir).catch((e) => {
    console.error(e);
    process.exit(1);
  });

  const app = express();

  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.type('text/plain').send('ok'));

  app.get('/', (_req, res, next) => {
    res.sendFile(path.join(siteDir, 'index.html'), (err) => err && next(err));
  });

  app.get('/:basename', async (req, res, next) => {
    const name = path.basename(String(req.path).split('?')[0] || '');

    const sendFileSafe = (filePath) => {
      res.sendFile(filePath, (err) => {
        if (!err) return;
        if (err.code === 'ENOENT') {
          return res.status(404).type('text/plain').send('Not found');
        }
        next(err);
      });
    };

    if (name.toLowerCase().endsWith('.apk')) {
      try {
        const raw = await fs.readFile(path.join(siteDir, 'apk-build.json'), 'utf8');
        const meta = JSON.parse(raw);
        const current = path.basename(String(meta.apk != null ? meta.apk : 'luxy-spa.apk'));
        if (name === current && /^[a-zA-Z0-9._\-]+\.apk$/i.test(name)) {
          return sendFileSafe(path.join(siteDir, name));
        }
      } catch (_) {
        /* fall through */
      }
    }

    if (!PUBLIC_NAMES.has(name)) return next();
    sendFileSafe(path.join(siteDir, name));
  });

  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

  const port = Number(process.env.PORT) || httpPortFromConfig(configData, 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log('[railway] HTTP listening on %s (siteDir=%s)', port, siteDir);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
