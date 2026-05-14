import fs from 'node:fs/promises';
import path from 'node:path';
import { Telegraf } from 'telegraf';

function parseAllowedIds(raw) {
  if (!raw || !String(raw).trim()) return new Set();
  return new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function isApkDocument(doc) {
  const name = (doc.file_name || '').toLowerCase();
  if (name.endsWith('.apk')) return true;
  const mime = (doc.mime_type || '').toLowerCase();
  return mime === 'application/vnd.android.package-archive';
}

/** Safe on-disk name from Telegram document file_name (basename only). */
function sanitizeApkFileName(raw) {
  if (raw == null || String(raw).trim() === '') return 'luxy-spa.apk';
  let base = path.basename(String(raw).trim().replace(/\0/g, ''));
  if (!base) return 'luxy-spa.apk';
  if (!base.toLowerCase().endsWith('.apk')) base = `${base}.apk`;
  base = base.replace(/[^a-zA-Z0-9._\- ]+/g, '_').replace(/\s+/g, '_');
  if (base.length > 180) base = `upload_${Date.now()}.apk`;
  if (!/^[a-zA-Z0-9._\-]+\.apk$/i.test(base)) return 'luxy-spa.apk';
  if (base === '.apk' || base.startsWith('.')) return 'luxy-spa.apk';
  return base;
}

async function readBuildMeta(siteDir) {
  const p = path.join(siteDir, 'apk-build.json');
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return { v: '0', apk: 'luxy-spa.apk' };
  }
}

function currentApkPath(siteDir, meta) {
  const name = path.basename(String(meta?.apk != null ? meta.apk : 'luxy-spa.apk'));
  return path.join(siteDir, name);
}

/**
 * @param {string} siteDir Absolute path where APK files and apk-build.json live
 */
export async function startApkUpdateBot(siteDir) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allowed = parseAllowedIds(process.env.ALLOWED_USER_IDS);

  if (!token) {
    console.error('Missing telegramBotToken in config.json (project root).');
    process.exit(1);
  }
  if (allowed.size === 0) {
    console.error('Missing allowedUserIds in config.json (comma-separated Telegram user IDs).');
    process.exit(1);
  }

  const versionPath = path.join(siteDir, 'apk-build.json');

  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid == null) return;
    if (!allowed.has(String(uid))) {
      if (ctx.message || ctx.callbackQuery) {
        try {
          await ctx.reply('This bot is private.');
        } catch (_) {}
      }
      return;
    }
    return next();
  });

  bot.start(async (ctx) => {
    await ctx.reply(
      [
        'Luxy Spa APK updater.',
        '',
        'Send the new build as a *file* (document), not a photo.',
        'The site will use *your file’s name* (safe characters only) and update `apk-build.json`.',
        '',
        `Site folder: \`${siteDir}\``,
      ].join('\n'),
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('status', async (ctx) => {
    const meta = await readBuildMeta(siteDir);
    const apkFile = currentApkPath(siteDir, meta);
    try {
      const st = await fs.stat(apkFile);
      const v = meta && meta.v != null ? String(meta.v) : '';
      const apkName = path.basename(apkFile);
      await ctx.reply(
        `Current APK file: \`${apkName}\`\n` +
          `Size: ${(st.size / (1024 * 1024)).toFixed(2)} MB\n` +
          `apk-build.json v: ${v || '(none)'}\n` +
          `mtime: ${st.mtime.toISOString()}`,
        { parse_mode: 'Markdown' }
      );
    } catch {
      await ctx.reply('No APK on disk yet (or apk-build.json points to a missing file). Upload an APK.');
    }
  });

  bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    if (!isApkDocument(doc)) {
      await ctx.reply('Send an Android APK as a document (.apk).');
      return;
    }

    const maxBytes = 20 * 1024 * 1024;
    if (doc.file_size != null && doc.file_size > maxBytes) {
      await ctx.reply(
        'This APK is over Telegram’s **~20 MB** limit for bots (cloud Bot API). ' +
          'Use a smaller build, App Bundle + device splits, or host your own Bot API server with `--local` for larger files.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const targetName = sanitizeApkFileName(doc.file_name);
    const prevMeta = await readBuildMeta(siteDir);
    const prevBase = path.basename(String(prevMeta?.apk != null ? prevMeta.apk : 'luxy-spa.apk'));

    await ctx.reply('Downloading and installing…');

    let link;
    try {
      link = await ctx.telegram.getFileLink(doc.file_id);
    } catch (e) {
      const desc = e?.response?.description || e?.message || '';
      if (/too big/i.test(String(desc))) {
        await ctx.reply(
          'Telegram refused the download (file too big for the cloud Bot API, limit about **20 MB**).',
          { parse_mode: 'Markdown' }
        );
        return;
      }
      throw e;
    }
    const res = await fetch(link.href);
    if (!res.ok) {
      await ctx.reply(`Telegram file download failed: ${res.status}`);
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      await ctx.reply('That file does not look like a ZIP/APK (bad header).');
      return;
    }

    await fs.mkdir(siteDir, { recursive: true });
    const finalPath = path.join(siteDir, targetName);
    const tmp = path.join(siteDir, `${targetName}.partial`);
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, finalPath);

    if (prevBase && prevBase !== targetName) {
      const prevPath = path.join(siteDir, prevBase);
      if (prevPath !== finalPath) {
        await fs.unlink(prevPath).catch(() => {});
      }
    }

    const v = String(Date.now());
    await fs.writeFile(
      versionPath,
      JSON.stringify({ v, apk: targetName }, null, 0) + '\n',
      'utf8'
    );

    await ctx.reply(
      `Done. Site APK is now **${targetName}** (${(buf.length / (1024 * 1024)).toFixed(2)} MB).\n` +
        `Cache buster: ${v}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.catch((err, ctx) => {
    console.error('Bot error', err);
    ctx?.reply?.('Something went wrong. Check server logs.').catch(() => {});
  });

  await bot.launch();
  console.log('APK update bot running. SITE_DIR=%s', siteDir);

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
