require('dotenv').config();
const express = require('express');
const { execSync } = require('child_process');
const adminApp = require('./admin/app');
const { startBot } = require('./bot');

const PORT = process.env.PORT || 3000;

async function ensureDatabase() {
  if (process.env.PRISMA_DB_PUSH === 'true' || process.env.PRISMA_DB_PUSH === '1') {
    try {
      console.log('📦 Running prisma db push...');
      execSync('npx prisma db push --skip-generate', { stdio: 'inherit' });
      console.log('✅ Database schema pushed');
    } catch (err) {
      console.error('⚠️ prisma db push failed (continuing anyway):', err.message);
    }
  }
}

async function main() {
  console.log('🚀 Starting Zycot Airdrop Bot + Admin Panel...');

  await ensureDatabase();

  const app = express();

  // Important for Railway / reverse proxy (secure cookies)
  app.set('trust proxy', 1);

  // Body parsers for webhook + admin
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Mount admin panel
  app.use(adminApp);

  // Landing page
  app.get('/', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Zycot Airdrop Bot</title>
          <script src="https://cdn.tailwindcss.com"></script>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body class="bg-gray-900 text-white min-h-screen flex items-center justify-center">
          <div class="text-center px-4">
            <h1 class="text-4xl font-bold text-yellow-400 mb-4">ZYCOT AIRDROP BOT</h1>
            <p class="text-gray-400 mb-6">Bot is running. Admin panel available below.</p>
            <a href="/admin" class="bg-yellow-500 hover:bg-yellow-600 text-gray-900 px-6 py-3 rounded-lg font-bold inline-block">
              Go to Admin Panel
            </a>
          </div>
        </body>
      </html>
    `);
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Start Telegram bot (webhook or polling)
  const botResult = await startBot();

  if (botResult && botResult.secretPath && botResult.bot) {
    // Webhook mode
    app.post(botResult.secretPath, (req, res) => {
      botResult.bot.handleUpdate(req.body, res);
    });
    app.get(botResult.secretPath, (req, res) => res.send('ok'));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
