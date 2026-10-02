const { Telegraf, Markup, session } = require('telegraf');
const { message } = require('telegraf/filters');
const prisma = require('../utils/prisma');
const { generateCaptcha, validateCaptcha } = require('../utils/captcha');
const { isValidBEP20Address, normalizeAddress } = require('../utils/wallet');

let bot = null;

async function getSettings() {
  let settings = await prisma.setting.findFirst();
  if (!settings) {
    settings = await prisma.setting.create({ data: {} });
  }
  return settings;
}

async function getOrCreateUser(ctx, referralCode = null) {
  const tgUser = ctx.from;
  let user = await prisma.user.findUnique({
    where: { telegramId: BigInt(tgUser.id) }
  });

  if (!user) {
    const code = 'r' + tgUser.id.toString().slice(-10) + Math.random().toString(36).slice(2, 6);
    let referredById = null;

    if (referralCode) {
      const referrer = await prisma.user.findUnique({
        where: { referralCode }
      });
      if (referrer && referrer.telegramId !== BigInt(tgUser.id)) {
        referredById = referrer.id;
        await prisma.user.update({
          where: { id: referrer.id },
          data: { referralCount: { increment: 1 } }
        });
      }
    }

    user = await prisma.user.create({
      data: {
        telegramId: BigInt(tgUser.id),
        username: tgUser.username || null,
        firstName: tgUser.first_name || null,
        lastName: tgUser.last_name || null,
        languageCode: tgUser.language_code || null,
        referralCode: code,
        referredById
      }
    });
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        username: tgUser.username || user.username,
        firstName: tgUser.first_name || user.firstName
      }
    });
  }
  return user;
}

function createBot(token) {
  bot = new Telegraf(token);
  bot.use(session());

  bot.start(async (ctx) => {
    try {
      const payload = ctx.startPayload;
      const user = await getOrCreateUser(ctx, payload || null);
      const settings = await getSettings();

      if (user.isBanned) {
        return ctx.reply('⛔ You are banned from this airdrop.');
      }

      const welcome = settings.welcomeMessage || 
        `Hi <b>${user.firstName || user.username || 'User'}</b>! I am your friendly Zycot Bot\n\n` +
        `✅ Please complete all the tasks and submit details correctly to be eligible for the airdrop\n\n` +
        `$ Total for airdrop: ${settings.totalAirdropAmount} USDT\n` +
        `🔹 ${settings.randomWinnersCount} Random winners will receive ${settings.randomWinnerAmount} USDT each\n` +
        `👥 Top ${settings.topReferrersCount} Referrers will receive ${settings.topReferrerAmount} USDT each\n\n` +
        `📘 By Participating you are agreeing to the Zycot (Airdrop) Program Terms and Conditions.\n\n` +
        `Click "Continue" to proceed`;

      await ctx.replyWithHTML(welcome, Markup.keyboard([['Continue']]).resize().oneTime());
    } catch (err) {
      console.error('Start error:', err);
      ctx.reply('Something went wrong. Please try again later.');
    }
  });

  bot.hears('Continue', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const settings = await getSettings();

    if (settings.captchaEnabled && !user.captchaPassed) {
      const captcha = generateCaptcha();
      ctx.session = ctx.session || {};
      ctx.session.captcha = captcha.text;

      await ctx.reply(
        `🔐 Please enter the captcha:\n\n<code>${captcha.display}</code>\n\nType the text above:`,
        { parse_mode: 'HTML', ...Markup.removeKeyboard() }
      );
      return;
    }

    await showTasks(ctx, user);
  });

  bot.on(message('text'), async (ctx, next) => {
    if (ctx.session && ctx.session.captcha) {
      const input = ctx.message.text.trim();
      if (validateCaptcha(input, ctx.session.captcha)) {
        await prisma.user.update({
          where: { telegramId: BigInt(ctx.from.id) },
          data: { captchaPassed: true }
        });
        delete ctx.session.captcha;
        await ctx.reply('✅ Captcha passed!');
        const user = await getOrCreateUser(ctx);
        await showTasks(ctx, user);
      } else {
        const captcha = generateCaptcha();
        ctx.session.captcha = captcha.text;
        await ctx.reply(`❌ Wrong captcha. Try again:\n\n<code>${captcha.display}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }
    return next();
  });

  async function showTasks(ctx, user) {
    const tasks = await prisma.task.findMany({
      where: { isActive: true },
      orderBy: { order: 'asc' }
    });

    let text = '📋 <b>Complete the tasks below!</b>\n\nYou must complete all the tasks.\n\n';
    
    for (const t of tasks) {
      text += `🔹 ${t.title}`;
      if (t.link) text += `\n   ${t.link}`;
      text += '\n';
    }

    text += '\nAfter you have completed the tasks, press "✅ Check"';

    await ctx.replyWithHTML(text, Markup.keyboard([
      ['✅ Check'],
      ['Statistics', 'Airdrop Rules'],
      ['Leaderboard', 'Main Menu']
    ]).resize());
  }

  bot.hears('✅ Check', async (ctx) => {
    await ctx.reply(
      'Click "Submit Details" to submit your details to verify whether you completed all the tasks or not.',
      Markup.keyboard([['Submit Details'], ['Main Menu']]).resize()
    );
  });

  bot.hears('Submit Details', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const settings = await getSettings();
    ctx.session = ctx.session || {};
    ctx.session.step = 'x_profile';

    if (settings.requireXProfile) {
      await ctx.reply(
        '🔹 Follow the below X accounts and submit your X profile link:\n\n' +
        'Example: https://www.x.com/yourusername\n\n' +
        'Submit your X profile link:',
        Markup.removeKeyboard()
      );
    } else {
      ctx.session.step = 'wallet';
      await askWallet(ctx);
    }
  });

  bot.on(message('text'), async (ctx, next) => {
    if (!ctx.session || !ctx.session.step) return next();

    const user = await getOrCreateUser(ctx);
    const text = ctx.message.text.trim();

    if (ctx.session.step === 'x_profile') {
      if (!text.includes('x.com') && !text.includes('twitter.com')) {
        return ctx.reply('Please submit a valid X (Twitter) profile link.');
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { xProfileLink: text }
      });
      ctx.session.step = 'wallet';
      await askWallet(ctx);
      return;
    }

    if (ctx.session.step === 'wallet') {
      if (!isValidBEP20Address(text)) {
        return ctx.reply('❌ Invalid BEP-20 address. It should start with 0x and be 42 characters long.\n\nTry again:');
      }
      await prisma.user.update({
        where: { id: user.id },
        data: {
          walletAddress: normalizeAddress(text),
          detailsSubmitted: true,
          isVerified: true
        }
      });
      delete ctx.session.step;

      const settings = await getSettings();
      const refLink = `https://t.me/${settings.botUsername || process.env.BOT_USERNAME || 'Zycot_Airdrop_bot'}?start=${user.referralCode}`;

      await ctx.replyWithHTML(
        `✅ Details submitted successfully!\n\n` +
        `📎 Your personal referral link:\n<code>${refLink}</code>\n\n` +
        `Share this link to earn more referrals and increase your chance for Top Referrer rewards!`,
        Markup.keyboard([
          ['Statistics', 'Airdrop Rules'],
          ['Leaderboard', 'Main Menu']
        ]).resize()
      );
      return;
    }

    return next();
  });

  async function askWallet(ctx) {
    await ctx.reply(
      'Submit your BEP-20 USDT wallet address to receive USDT rewards\n' +
      '(Recommended wallet to use: Binance, Trust wallet, Metamask)',
      Markup.removeKeyboard()
    );
  }

  bot.hears('Statistics', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const settings = await getSettings();
    const refLink = `https://t.me/${settings.botUsername || process.env.BOT_USERNAME || 'Zycot_Airdrop_bot'}?start=${user.referralCode}`;

    await ctx.replyWithHTML(
      `Hi <b>${user.firstName || user.username}</b>\n\n` +
      `🔹 ${settings.randomWinnersCount} Random winners will receive ${settings.randomWinnerAmount} USDT each\n` +
      `👥 Top ${settings.topReferrersCount} Referrers will receive ${settings.topReferrerAmount} USDT each\n` +
      `[Top ${settings.topReferrersCount} referral winners list can be viewed from the leaderboard]\n\n` +
      `📎 Referral link: <code>${refLink}</code>\n\n` +
      `👥 Referrals: <b>${user.referralCount}</b>\n\n` +
      `Your Submitted details:\n` +
      `---------------------\n` +
      `Telegram: ${user.username || user.telegramId}\n` +
      `X Profile: ${user.xProfileLink || 'Not submitted'}\n` +
      `Wallet: ${user.walletAddress || 'Not submitted'}`,
      Markup.keyboard([
        ['Statistics', 'Airdrop Rules'],
        ['Leaderboard', 'Main Menu']
      ]).resize()
    );
  });

  bot.hears('Airdrop Rules', async (ctx) => {
    const settings = await getSettings();
    let rules = settings.rulesText;
    if (!rules) {
      rules = 
        `📌 Zycot AIRDROP RULES, READ CAREFULLY 📌\n\n` +
        `✅ Mandatory Actions:\n` +
        `• You must complete all the tasks\n` +
        `- You must submit a valid BEP-20 USDT wallet address\n` +
        `- You must be active on the social media\n\n` +
        `📈 Increase winning chances by:\n` +
        `- Completing all the mandatory tasks\n` +
        `- Refer your friends as much as possible\n` +
        `- Be active on the project social media\n\n` +
        `🚫 Actions prohibited\n` +
        `- Only valid users will be rewarded.\n` +
        `- All fake accounts and bot won't earn rewards.\n` +
        `- One registration per user\n\n` +
        `💬 Airdrop details\n` +
        `- Airdrop will close on the set end date\n` +
        `- Rewards will be distributed within a week after airdrop ends\n\n` +
        `🚨 Zycot is responsible for the airdrop distribution on time, free and fairly!`;
    }
    await ctx.reply(rules, Markup.keyboard([
      ['Statistics', 'Airdrop Rules'],
      ['Leaderboard', 'Main Menu']
    ]).resize());
  });

  bot.hears('Leaderboard', async (ctx) => {
    const top = await prisma.user.findMany({
      where: { isBanned: false },
      orderBy: { referralCount: 'desc' },
      take: 10,
      select: { username: true, firstName: true, referralCount: true }
    });

    let text = '🏆 Top 10 Referrers are below (List updates every 1 hour):\n\n';
    top.forEach((u, i) => {
      text += `${i + 1}. ${u.username || u.firstName || 'User'} - ${u.referralCount}\n`;
    });

    await ctx.reply(text, Markup.keyboard([
      ['Statistics', 'Airdrop Rules'],
      ['Leaderboard', 'Main Menu']
    ]).resize());
  });

  bot.hears('Main Menu', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    await showTasks(ctx, user);
  });

  bot.hears(['✅ Done', '✅ Yes'], async (ctx) => {
    await ctx.reply('Great! Continue with the next tasks or press Submit Details when ready.', 
      Markup.keyboard([['Submit Details'], ['✅ Check'], ['Main Menu']]).resize());
  });

  bot.catch((err, ctx) => {
    console.error(`Bot error for ${ctx.updateType}:`, err);
  });

  return bot;
}

async function startBot() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.warn('⚠️ BOT_TOKEN not set. Bot will not start.');
    return null;
  }

  const botInstance = createBot(token);
  await seedDefaults();

  if (process.env.WEBHOOK_DOMAIN) {
    const secretPath = `/telegraf/${token.split(':')[1]}`;
    await botInstance.telegram.setWebhook(`${process.env.WEBHOOK_DOMAIN}${secretPath}`);
    console.log('Webhook set');
    return { bot: botInstance, secretPath };
  } else {
    await botInstance.launch();
    console.log('🤖 Bot started with polling');
    process.once('SIGINT', () => botInstance.stop('SIGINT'));
    process.once('SIGTERM', () => botInstance.stop('SIGTERM'));
    return { bot: botInstance };
  }
}

async function seedDefaults() {
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const existingAdmin = await prisma.admin.findUnique({ where: { username: adminUser } });
  if (!existingAdmin) {
    const bcrypt = require('bcryptjs');
    await prisma.admin.create({
      data: {
        username: adminUser,
        password: await bcrypt.hash(adminPass, 10)
      }
    });
    console.log(`✅ Default admin created: ${adminUser} / ${adminPass}`);
  }

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
  }

  const taskCount = await prisma.task.count();
  if (taskCount === 0) {
    await prisma.task.createMany({
      data: [
        { title: 'Join Zycot Telegram', type: 'JOIN_CHANNEL', link: 'https://t.me/Zycot', order: 1, isRequired: true },
        { title: 'Join Advertiser Telegram Channel', type: 'JOIN_CHANNEL', link: 'https://t.me/airdropinspector', order: 2, isRequired: true },
        { title: 'Follow the below X accounts', type: 'FOLLOW_X', description: 'Follow Zycot_Agency, Cryptoloophq, CryptoRecords01, Edenside_H_F', order: 3, isRequired: true },
        { title: 'Follow Advertiser Twitter, like and retweet the airdrop post', type: 'LIKE_RETWEET', order: 4, isRequired: true },
        { title: 'Join Advertiser Telegram Group', type: 'JOIN_GROUP', link: 'https://t.me/AirdropSupportGroup', order: 5, isRequired: true }
      ]
    });
    console.log('✅ Default tasks seeded');
  }
}

module.exports = { startBot, createBot };
