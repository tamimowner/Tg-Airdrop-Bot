require('dotenv').config();
const express = require('express');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 3000;

async function ensureDatabase() {
  if (process.env.PRISMA_DB_PUSH === 'true' || process.env.PRISMA_DB_PUSH === '1') {
    try {
      console.log('📦 Running prisma db push...');
      execSync('npx prisma db push --accept-data-loss', {
        stdio: 'inherit',
        env: process.env
      });
      console.log('✅ Database schema pushed');
    } catch (err) {
      console.error('⚠️ prisma db push failed (continuing):', err.message);
    }
  }
}

async function main() {
  console.log('🚀 Starting Zycot Airdrop Bot + Admin Panel...');

  await ensureDatabase();

  const adminApp = require('./admin/app');
  const { startBot } = require('./bot');

  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(adminApp);

  app.get('/', (req, res) => {
    res.send(
      '<!DOCTYPE html><html><head><title>Zycot Airdrop Bot</title>' +
      '<script src="https://cdn.tailwindcss.com"></script>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '</head><body class="bg-gray-900 text-white min-h-screen flex items-center justify-center">' +
      '<div class="text-center px-4">' +
      '<h1 class="text-4xl font-bold text-yellow-400 mb-4">ZYCOT AIRDROP BOT</h1>' +
      '<p class="text-gray-400 mb-6">Bot is running.</p>' +
      '<a href="/admin" class="bg-yellow-500 text-gray-900 px-6 py-3 rounded-lg font-bold inline-block">Go to Admin Panel</a>' +
      '</div></body></html>'
    );
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Start HTTP server FIRST (important for webhook verification)
  await new Promise(function(resolve) {
    app.listen(PORT, '0.0.0.0', function() {
      console.log('🌐 Server running on port ' + PORT);
      console.log('📊 Admin panel: /admin');
      resolve();
    });
  });

  // Now start bot + set webhook (server is already listening)
  let botResult = null;
  try {
    botResult = await startBot();
  } catch (err) {
    console.error('⚠️ Bot failed to start:', err.message);
  }

  if (botResult && botResult.secretPath && botResult.bot) {
    // Telegraf recommended way
    app.use(botResult.bot.webhookCallback(botResult.secretPath));
    console.log('🔗 Webhook route mounted at', botResult.secretPath);
  }
}

main().catch(function(err) {
  console.error('Fatal error:', err);
  process.exit(1);
});
