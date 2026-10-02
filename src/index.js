require('dotenv').config();
const express = require('express');
const { execSync } = require('child_process');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 3000;

async function ensureDatabase() {
  // Always try to push schema so Admin table exists
  try {
    console.log('📦 Running prisma db push...');
    execSync('npx prisma db push --accept-data-loss', {
      stdio: 'inherit',
      env: process.env
    });
    console.log('✅ Database schema ready');
  } catch (err) {
    console.error('⚠️ prisma db push failed:', err.message);
    console.error('   Make sure DATABASE_URL is set correctly');
  }
}

async function seedAdmin() {
  try {
    const prisma = require('./utils/prisma');
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';

    const existing = await prisma.admin.findUnique({ where: { username: adminUser } });
    if (!existing) {
      await prisma.admin.create({
        data: {
          username: adminUser,
          password: await bcrypt.hash(adminPass, 10)
        }
      });
      console.log('✅ Admin created: ' + adminUser);
    } else {
      console.log('ℹ️ Admin already exists: ' + adminUser);
    }

    // Seed settings if missing
    let settings = await prisma.setting.findFirst();
    if (!settings) {
      await prisma.setting.create({
        data: {
          airdropName: 'ZYCOT AIRDROP',
          totalAirdropAmount: 300,
          randomWinnersCount: 100,
          randomWinnerAmount: 2,
          topReferrersCount: 10,
          topReferrerAmount: 10,
          captchaEnabled: true,
          botUsername: process.env.BOT_USERNAME || 'Zycot_Airdrop_bot'
        }
      });
      console.log('✅ Default settings created');
    }

    // Seed tasks if missing
    const taskCount = await prisma.task.count();
    if (taskCount === 0) {
      await prisma.task.createMany({
        data: [
          { title: 'Join Zycot Telegram', type: 'JOIN_CHANNEL', link: 'https://t.me/Zycot', order: 1, isRequired: true },
          { title: 'Join Advertiser Telegram Channel', type: 'JOIN_CHANNEL', link: 'https://t.me/airdropinspector', order: 2, isRequired: true },
          { title: 'Follow the below X accounts', type: 'FOLLOW_X', description: 'Follow X accounts', order: 3, isRequired: true },
          { title: 'Follow Advertiser Twitter, like and retweet', type: 'LIKE_RETWEET', order: 4, isRequired: true },
          { title: 'Join Advertiser Telegram Group', type: 'JOIN_GROUP', link: 'https://t.me/AirdropSupportGroup', order: 5, isRequired: true }
        ]
      });
      console.log('✅ Default tasks seeded');
    }
  } catch (err) {
    console.error('❌ seedAdmin failed:', err.message);
    console.error(err);
  }
}

async function main() {
  console.log('🚀 Starting Zycot Airdrop Bot + Admin Panel...');
  console.log('   NODE_ENV=', process.env.NODE_ENV);
  console.log('   DATABASE_URL set?', !!process.env.DATABASE_URL);
  console.log('   BOT_TOKEN set?', !!process.env.BOT_TOKEN);

  await ensureDatabase();
  await seedAdmin();

  const adminApp = require('./admin/app');
  const { startBot } = require('./bot');

  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(adminApp);

  app.get('/', function(req, res) {
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

  app.get('/health', function(req, res) {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Listen first
  await new Promise(function(resolve) {
    app.listen(PORT, '0.0.0.0', function() {
      console.log('🌐 Server running on port ' + PORT);
      console.log('📊 Admin: /admin  (user: ' + (process.env.ADMIN_USERNAME || 'admin') + ')');
      resolve();
    });
  });

  // Bot + webhook
  try {
    const botResult = await startBot();
    if (botResult && botResult.secretPath && botResult.bot) {
      app.use(botResult.bot.webhookCallback(botResult.secretPath));
      console.log('🔗 Webhook mounted at', botResult.secretPath);
    }
  } catch (err) {
    console.error('⚠️ Bot failed to start:', err.message);
  }
}

main().catch(function(err) {
  console.error('Fatal error:', err);
  process.exit(1);
});
