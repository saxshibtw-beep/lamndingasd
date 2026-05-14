import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAppConfig } from '../app-config.mjs';
import { startApkUpdateBot } from './bot-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const root = path.resolve(__dirname, '..');
  await loadAppConfig(root);

  const siteDir = process.env.SITE_DIR
    ? path.resolve(process.env.SITE_DIR)
    : path.resolve(__dirname, '..');

  await startApkUpdateBot(siteDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
