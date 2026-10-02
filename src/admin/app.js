const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const morgan = require('morgan');
const prisma = require('../utils/prisma');

const app = express();

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'zycot-super-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, '../../public')));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  res.redirect('/admin/login');
}

// Login
app.get('/admin/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin');
  res.render('login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await prisma.admin.findUnique({ where: { username } });
    if (!admin || !(await bcrypt.compare(password, admin.password))) {
      return res.render('login', { error: 'Invalid username or password' });
    }
    req.session.adminId = admin.id;
    req.session.username = admin.username;
    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Server error' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// Dashboard
app.get('/admin', requireAuth, async (req, res) => {
  try {
    const [
      totalUsers,
      verifiedUsers,
      pendingSubmissions,
      totalReferrals,
      settings,
      recentUsers
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isVerified: true } }),
      prisma.taskSubmission.count({ where: { status: 'PENDING' } }),
      prisma.user.aggregate({ _sum: { referralCount: true } }),
      prisma.setting.findFirst(),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true, telegramId: true, username: true, firstName: true,
          referralCount: true, isVerified: true, createdAt: true
        }
      })
    ]);

    res.render('dashboard', {
      username: req.session.username,
      stats: {
        totalUsers,
        verifiedUsers,
        pendingSubmissions,
        totalReferrals: totalReferrals._sum.referralCount || 0
      },
      settings,
      recentUsers
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading dashboard');
  }
});

// Users
app.get('/admin/users', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const search = req.query.search || '';
    const where = search ? {
      OR: [
        { username: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { walletAddress: { contains: search, mode: 'insensitive' } }
      ]
    } : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { referredBy: { select: { username: true, telegramId: true } } }
      }),
      prisma.user.count({ where })
    ]);

    res.render('users', {
      username: req.session.username,
      users,
      page,
      totalPages: Math.ceil(total / limit),
      search,
      total
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

app.post('/admin/users/:id/ban', requireAuth, async (req, res) => {
  await prisma.user.update({
    where: { id: req.params.id },
    data: { isBanned: true }
  });
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/unban', requireAuth, async (req, res) => {
  await prisma.user.update({
    where: { id: req.params.id },
    data: { isBanned: false }
  });
  res.redirect('/admin/users');
});

// Tasks
app.get('/admin/tasks', requireAuth, async (req, res) => {
  const tasks = await prisma.task.findMany({ orderBy: { order: 'asc' } });
  res.render('tasks', { username: req.session.username, tasks });
});

app.post('/admin/tasks', requireAuth, async (req, res) => {
  const { title, description, type, link, order, isRequired } = req.body;
  await prisma.task.create({
    data: {
      title,
      description,
      type: type || 'CUSTOM',
      link,
      order: parseInt(order) || 0,
      isRequired: isRequired === 'on' || isRequired === true
    }
  });
  res.redirect('/admin/tasks');
});

app.post('/admin/tasks/:id/toggle', requireAuth, async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.params.id } });
  await prisma.task.update({
    where: { id: req.params.id },
    data: { isActive: !task.isActive }
  });
  res.redirect('/admin/tasks');
});

app.post('/admin/tasks/:id/delete', requireAuth, async (req, res) => {
  await prisma.task.delete({ where: { id: req.params.id } });
  res.redirect('/admin/tasks');
});

// Verification
app.get('/admin/verification', requireAuth, async (req, res) => {
  const submissions = await prisma.taskSubmission.findMany({
    where: { status: 'PENDING' },
    include: { user: true, task: true },
    orderBy: { createdAt: 'asc' },
    take: 100
  });
  res.render('verification', { username: req.session.username, submissions });
});

app.post('/admin/verification/:id/approve', requireAuth, async (req, res) => {
  await prisma.taskSubmission.update({
    where: { id: req.params.id },
    data: { status: 'APPROVED', verifiedAt: new Date(), verifiedBy: req.session.username }
  });
  res.redirect('/admin/verification');
});

app.post('/admin/verification/:id/reject', requireAuth, async (req, res) => {
  await prisma.taskSubmission.update({
    where: { id: req.params.id },
    data: { status: 'REJECTED', verifiedAt: new Date(), verifiedBy: req.session.username }
  });
  res.redirect('/admin/verification');
});

// Settings
app.get('/admin/settings', requireAuth, async (req, res) => {
  let settings = await prisma.setting.findFirst();
  if (!settings) {
    settings = await prisma.setting.create({ data: {} });
  }
  res.render('settings', { 
    username: req.session.username, 
    settings,
    success: req.query.success
  });
});

app.post('/admin/settings', requireAuth, async (req, res) => {
  const data = {
    airdropName: req.body.airdropName,
    totalAirdropAmount: parseFloat(req.body.totalAirdropAmount) || 300,
    randomWinnersCount: parseInt(req.body.randomWinnersCount) || 100,
    randomWinnerAmount: parseFloat(req.body.randomWinnerAmount) || 2,
    topReferrersCount: parseInt(req.body.topReferrersCount) || 10,
    topReferrerAmount: parseFloat(req.body.topReferrerAmount) || 10,
    captchaEnabled: req.body.captchaEnabled === 'on',
    requireWallet: req.body.requireWallet === 'on',
    requireXProfile: req.body.requireXProfile === 'on',
    welcomeMessage: req.body.welcomeMessage,
    rulesText: req.body.rulesText,
    botToken: req.body.botToken || undefined,
    botUsername: req.body.botUsername || undefined
  };
  if (req.body.airdropEndDate) {
    data.airdropEndDate = new Date(req.body.airdropEndDate);
  }

  const existing = await prisma.setting.findFirst();
  if (existing) {
    await prisma.setting.update({ where: { id: existing.id }, data });
  } else {
    await prisma.setting.create({ data });
  }
  res.redirect('/admin/settings?success=1');
});

// Leaderboard
app.get('/admin/leaderboard', requireAuth, async (req, res) => {
  const top = await prisma.user.findMany({
    where: { isBanned: false },
    orderBy: { referralCount: 'desc' },
    take: 50,
    select: {
      id: true, username: true, firstName: true, telegramId: true,
      referralCount: true, isVerified: true
    }
  });
  res.render('leaderboard', { username: req.session.username, top });
});

// Winners
app.get('/admin/winners', requireAuth, async (req, res) => {
  const winners = await prisma.winner.findMany({
    orderBy: { selectedAt: 'desc' },
    take: 200
  });
  const userIds = winners.map(w => w.userId);
  const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));
  res.render('winners', { 
    username: req.session.username, 
    winners: winners.map(w => ({ ...w, user: userMap[w.userId] }))
  });
});

app.post('/admin/winners/select-random', requireAuth, async (req, res) => {
  try {
    const settings = await prisma.setting.findFirst();
    const count = settings?.randomWinnersCount || 100;
    const amount = settings?.randomWinnerAmount || 2;

    const eligible = await prisma.user.findMany({
      where: {
        isVerified: true,
        isBanned: false,
        walletAddress: { not: null },
        detailsSubmitted: true
      },
      select: { id: true }
    });

    if (eligible.length === 0) {
      return res.redirect('/admin/winners?error=no_eligible');
    }

    const shuffled = eligible.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, Math.min(count, eligible.length));
    const batchId = `batch_${Date.now()}`;

    await prisma.$transaction([
      ...selected.map(u => prisma.winner.create({
        data: { userId: u.id, type: 'RANDOM_WINNER', amount, batchId }
      })),
      ...selected.map(u => prisma.reward.create({
        data: { userId: u.id, type: 'RANDOM_WINNER', amount, status: 'PENDING' }
      }))
    ]);

    res.redirect('/admin/winners?success=selected');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/winners?error=failed');
  }
});

// Payments
app.get('/admin/payments', requireAuth, async (req, res) => {
  const rewards = await prisma.reward.findMany({
    include: { user: true },
    orderBy: { createdAt: 'desc' },
    take: 100
  });
  res.render('payments', { username: req.session.username, rewards });
});

app.post('/admin/payments/:id/mark-paid', requireAuth, async (req, res) => {
  const { txHash } = req.body;
  await prisma.reward.update({
    where: { id: req.params.id },
    data: { status: 'PAID', txHash: txHash || null, paidAt: new Date() }
  });
  res.redirect('/admin/payments');
});

// Broadcast
app.get('/admin/broadcast', requireAuth, async (req, res) => {
  const broadcasts = await prisma.broadcast.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20
  });
  res.render('broadcast', { username: req.session.username, broadcasts });
});

app.post('/admin/broadcast', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.redirect('/admin/broadcast');

  const broadcast = await prisma.broadcast.create({
    data: { message, status: 'DRAFT' }
  });
  res.redirect('/admin/broadcast?created=' + broadcast.id);
});

app.get('/api/settings', async (req, res) => {
  const settings = await prisma.setting.findFirst();
  res.json(settings || {});
});

module.exports = app;
