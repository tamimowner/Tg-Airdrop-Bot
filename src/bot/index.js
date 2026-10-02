const { Telegraf, Markup, session } = require('telegraf');
const { message } = require('telegraf/filters');
const prisma = require('../utils/prisma');
const { generateCaptcha, validateCaptcha } = require('../utils/captcha');
const { isValidBEP20Address, normalizeAddress } = require('../utils/wallet');

let botInstance = null;

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
      const referrer = await prisma.user.findUnique({ where: { referralCode } });
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

/** Extract @username from t.me link */
function extractChatFromLink(link) {
  if (!link) return null;
  const match = link.match(/(?:t\.me\/|telegram\.me\/)([a-zA-Z0-9_+\-]+)/i);
  if (!match) return null;
  const part = match[1];
  if (part.startsWith('+')) return null; // invite link
  return '@' + part.replace(/^@/, '');
}

/** Check if user is member. Bot must be admin in the channel/group. */
async function isUserMember(telegram, chatIdOrUsername, userId) {
  try {
    const member = await telegram.getChatMember(chatIdOrUsername, userId);
    const okStatus = ['creator', 'administrator', 'member', 'restricted'];
    return okStatus.includes(member.status);
  } catch (err) {
    console.error('getChatMember error:', chatIdOrUsername, err.message);
    return false;
  }
}

function createBot(token) {
  const bot = new Telegraf(token);
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
      ctx.session.step = null;

      await ctx.reply(
        `🔐 Please enter the captcha:\n\n<code>${captcha.display}</code>\n\nType the text above:`,
        { parse_mode: 'HTML', ...Markup.removeKeyboard() }
      );
      return;
    }

    await showTasks(ctx);
  });

  // Single text handler
  bot.on(message('text'), async (ctx, next) => {
    ctx.session = ctx.session || {};
    const text = ctx.message.text.trim();

    if (ctx.session.captcha) {
      if (validateCaptcha(text, ctx.session.captcha)) {
        await prisma.user.update({
          where: { telegramId: BigInt(ctx.from.id) },
          data: { captchaPassed: true }
        });
        delete ctx.session.captcha;
        await ctx.reply('✅ Captcha passed!');
        await showTasks(ctx);
      } else {
        const captcha = generateCaptcha();
        ctx.session.captcha = captcha.text;
        await ctx.reply(`❌ Wrong captcha. Try again:\n\n<code>${captcha.display}</code>`, { parse_mode: 'HTML' });
      }
      return;
    }

    if (ctx.session.step === 'x_profile') {
      if (!text.includes('x.com') && !text.includes('twitter.com')) {
        return ctx.reply('Please submit a valid X (Twitter) profile link.\nExample: https://x.com/yourusername');
      }
      const user = await getOrCreateUser(ctx);
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
        return ctx.reply('❌ Invalid BEP-20 address.\nIt must start with 0x and be 42 characters long.\n\nTry again:');
      }
      const user = await getOrCreateUser(ctx);
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
      const botUsername = settings.botUsername || process.env.BOT_USERNAME || 'Zycot_Airdrop_bot';
      const refLink = `https://t.me/${botUsername}?start=${user.referralCode}`;

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

  async function showTasks(ctx) {
    const tasks = await prisma.task.findMany({
      where: { isActive: true },
      orderBy: { order: 'asc' }
    });

    let text = '📋 <b>Complete the tasks below!</b>\n\nYou must complete all the tasks.\n\n';
    for (const t of tasks) {
      text += `🔹 <b>${t.title}</b>`;
      if (t.link) text += `\n   ${t.link}`;
      text += '\n\n';
    }
    text += 'After you have completed the tasks, press "✅ Check"';

    await ctx.replyWithHTML(text, Markup.keyboard([
      ['✅ Check'],
      ['Statistics', 'Airdrop Rules'],
      ['Leaderboard', 'Main Menu']
    ]).resize());
  }

  // ✅ Check with real channel verification
  bot.hears('✅ Check', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const tasks = await prisma.task.findMany({
      where: { isActive: true, isRequired: true },
      orderBy: { order: 'asc' }
    });

    const failed = [];
    const passed = [];

    for (const task of tasks) {
      if (task.type === 'JOIN_CHANNEL' || task.type === 'JOIN_GROUP') {
        const chat = extractChatFromLink(task.link);
        if (!chat) {
          passed.push(task.title);
          continue;
        }
        const isMember = await isUserMember(ctx.telegram, chat, ctx.from.id);
        if (isMember) {
          passed.push(task.title);
          await prisma.taskSubmission.upsert({
            where: { userId_taskId: { userId: user.id, taskId: task.id } },
            create: { userId: user.id, taskId: task.id, status: 'APPROVED', verifiedAt: new Date() },
            update: { status: 'APPROVED', verifiedAt: new Date() }
          });
        } else {
          failed.push({ title: task.title, link: task.link });
        }
      } else {
        passed.push(task.title);
        await prisma.taskSubmission.upsert({
          where: { userId_taskId: { userId: user.id, taskId: task.id } },
          create: { userId: user.id, taskId: task.id, status: 'PENDING' },
          update: {}
        });
      }
    }

    if (failed.length > 0) {
      let msg = '❌ You have not completed all required tasks:\n\n';
      failed.forEach(f => {
        msg += `• ${f.title}\n  ${f.link || ''}\n`;
      });
      msg += '\nPlease join the channels/groups above and press "✅ Check" again.';
      return ctx.reply(msg, Markup.keyboard([['✅ Check'], ['Main Menu']]).resize());
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { tasksCompleted: true }
    });

    await ctx.reply(
      '✅ All join tasks verified!\n\nNow click "Submit Details" to submit your X profile and wallet.',
      Markup.keyboard([['Submit Details'], ['Main Menu']]).resize()
    );
  });

  bot.hears('Submit Details', async (ctx) => {
    const settings = await getSettings();
    ctx.session = ctx.session || {};

    if (settings.requireXProfile) {
      ctx.session.step = 'x_profile';
      await ctx.reply(
        '🔹 Submit your X (Twitter) profile link\n\nExample: https://x.com/yourusername\n\nSend the link now:',
        Markup.removeKeyboard()
      );
    } else {
      ctx.session.step = 'wallet';
      await askWallet(ctx);
    }
  });

  async function askWallet(ctx) {
    await ctx.reply(
      'Submit your BEP-20 USDT wallet address to receive USDT rewards\n' +
      '(Recommended: Binance, Trust Wallet, Metamask)',
      Markup.removeKeyboard()
    );
  }

  bot.hears('Statistics', async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const settings = await getSettings();
    const botUsername = settings.botUsername || process.env.BOT_USERNAME || 'Zycot_Airdrop_bot';
    const refLink = `https://t.me/${botUsername}?start=${user.referralCode}`;

    await ctx.replyWithHTML(
      `Hi <b>${user.firstName || user.username}</b>\n\n` +
      `🔹 ${settings.randomWinnersCount} Random winners will receive ${settings.randomWinnerAmount} USDT each\n` +
      `👥 Top ${settings.topReferrersCount} Referrers will receive ${settings.topReferrerAmount} USDT each\n\n` +
      `📎 Referral link:\n<code>${refLink}</code>\n\n` +
      `👥 Your Referrals: <b>${user.referralCount}</b>\n\n` +
      `Your Submitted details:\n` +
      `---------------------\n` +
      `Telegram: ${user.username || user.telegramId}\n` +
      `X Profile: ${user.xProfileLink || 'Not submitted'}\n` +
      `Wallet: ${user.walletAddress || 'Not submitted'}\n` +
      `Tasks: ${user.tasksCompleted ? '✅ Completed' : '❌ Pending'}`,
      Markup.keyboard([
        ['Statistics', 'Airdrop Rules'],
        ['Leaderboard', 'Main Menu']
      ]).resize()
    );
  });

  bot.hears('Airdrop Rules', async (ctx) => {
    const settings = await getSettings();
    const rules = settings.rulesText ||
      `📌 Zycot AIRDROP RULES, READ CAREFULLY 📌\n\n` +
      `✅ Mandatory Actions:\n` +
      `• You must complete all the tasks\n` +
      `• You must submit a valid BEP-20 USDT wallet address\n` +
      `• You must be active on social media\n\n` +
      `📈 Increase winning chances by:\n` +
      `• Completing all mandatory tasks\n` +
      `• Refer your friends as much as possible\n` +
      `• Be active on project social media\n\n` +
      `🚫 Prohibited:\n` +
      `• Fake accounts / bots will not be rewarded\n` +
      `• One registration per user\n\n` +
      `🚨 Zycot is responsible for fair & on-time distribution!`;

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

    let text = '🏆 Top 10 Referrers (updates every hour):\n\n';
    top.forEach((u, i) => {
      text += `${i + 1}. ${u.username || u.firstName || 'User'} — ${u.referralCount}\n`;
    });

    await ctx.reply(text, Markup.keyboard([
      ['Statistics', 'Airdrop Rules'],
      ['Leaderboard', 'Main Menu']
    ]).resize());
  });

  bot.hears('Main Menu', async (ctx) => {
    await showTasks(ctx);
  });

  bot.hears(['✅ Done', '✅ Yes'], async (ctx) => {
    await ctx.reply('Great! Press "✅ Check" when you have finished all tasks.',
      Markup.keyboard([['✅ Check'], ['Submit Details'], ['Main Menu']]).resize());
  });

  bot.catch((err, ctx) => {
    console.error(`Bot error (${ctx?.updateType}):`, err);
  });

  return bot;
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
    console.log(`✅ Default admin created: ${adminUser}`);
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

async function startBot() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.warn('⚠️ BOT_TOKEN not set. Bot will not start.');
    return null;
  }

  const bot = createBot(token);
  botInstance = bot;
  await seedDefaults();

  const domain = process.env.WEBHOOK_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN;
  if (domain) {
    const webhookDomain = domain.startsWith('http') ? domain : `https://${domain}`;
    const secretPath = `/telegraf/${token.split(':')[1]}`;
    await bot.telegram.setWebhook(`${webhookDomain}${secretPath}`);
    console.log(`✅ Webhook set: ${webhookDomain}${secretPath}`);
    return { bot, secretPath };
  } else {
    await bot.launch();
    console.log('🤖 Bot started with long polling');
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    return { bot };
  }
}

module.exports = { startBot, createBot };
