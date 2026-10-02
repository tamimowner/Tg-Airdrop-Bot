require('dotenv').config();
const express = require('express');
const adminApp = require('./admin/app');
const { startBot } = require('./bot');

const PORT = process.env.PORT || 3000;

async function main() {
  console.log('🚀 Starting Zycot Airdrop Bot + Admin Panel...');

  const app = express();

  app.use(adminApp);

  app.get('/', (req, res) => {
    res.send(`
      <html>
        <head><title>Zycot Airdrop Bot</title>
        <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-gray-900 text-white min-h-screen flex items-center justify-center">
          <div class="text-center">
            <h1 class="text-4xl font-bold text-yellow-400 mb-4">ZYCOT AIRDROP BOT</h1>
            <p class="text-gray-400 mb-6">Bot is running. Admin panel available at <a href="/admin" class="text-yellow-400 underline">/admin</a></p>
            <a href="/admin" class="bg-yellow-500 text-gray-900 px-6 py-3 rounded-lg font-bold">Go to Admin Panel</a>
          </div>
        </body>
      </html>
    `);
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  const botResult = await startBot();

  if (botResult && botResult.secretPath && botResult.bot) {
    app.use(botResult.secretPath, (req, res) => {
      botResult.bot.handleUpdate(req.body, res);
    });
  }

  app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
