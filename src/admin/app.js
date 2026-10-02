const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const morgan = require('morgan');
const prisma = require('../utils/prisma');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(session({
  secret: process.env.SESSION_SECRET || 'zycot-super-secret-change-me',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: 'auto',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, '../../public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  res.redirect('/admin/login');
}

app.get('/admin/login', function(req, res) {
  if (req.session && req.session.adminId) return res.redirect('/admin');
  res.render('login', { error: null });
});

app.post('/admin/login', async function(req, res) {
  try {
    const username = (req.body && req.body.username) ? String(req.body.username).trim() : '';
    const password = (req.body && req.body.password) ? String(req.body.password) : '';

    if (!username || !password) {
      return res.render('login', { error: 'Username and password required' });
    }

    const admin = await prisma.admin.findUnique({ where: { username: username } });
    if (!admin) {
      return res.render('login', { error: 'Invalid username or password' });
    }

    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) {
      return res.render('login', { error: 'Invalid username or password' });
    }

    req.session.adminId = admin.id;
    req.session.username = admin.username;
    req.session.save(function(err) {
      if (err) {
        return res.render('login', { error: 'Session error. Try again.' });
      }
      return res.redirect('/admin');
    });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    const msg = err.message || 'Server error';
    if (msg.includes('does not exist') || msg.includes('P2021')) {
      return res.render('login', { error: 'Database table missing. Check DATABASE_URL / redeploy.' });
    }
    if (msg.includes('connect') || msg.includes('P1001')) {
      return res.render('login', { error: 'Cannot connect to database. Check DATABASE_URL.' });
    }
    return res.render('login', { error: 'Server error: ' + msg });
  }
});

app.get('/admin/logout', function(req, res) {
  req.session.destroy(function() {
    res.redirect('/admin/login');
  });
});

// Dashboard
app.get('/admin', requireAuth, async function(req, res) {
  try {
    const totalUsers = await prisma.user.count();
    const verifiedUsers = await prisma.user.count({ where: { isVerified: true } });
    const pendingSubmissions = await prisma.taskSubmission.count({ where: { status: 'PENDING' } });
    const totalReferralsAgg = await prisma.user.aggregate({ _sum: { referralCount: true } });
    const settings = await prisma.setting.findFirst();
    const recentUsers = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, telegramId: true, username: true, firstName: true,
        referralCount: true, isVerified: true, createdAt: true
      }
    });

    res.render('dashboard', {
      username: req.session.username,
      stats: {
        totalUsers: totalUsers,
        verifiedUsers: verifiedUsers,
        pendingSubmissions: pendingSubmissions,
        totalReferrals: (totalReferralsAgg._sum && totalReferralsAgg._sum.referralCount) || 0
      },
      settings: settings,
      recentUsers: recentUsers
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Error loading dashboard: ' + err.message);
  }
});

// Users
app.get('/admin/users', requireAuth, async function(req, res) {
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

    const users = await prisma.user.findMany({
      where: where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { referredBy: { select: { username: true, telegramId: true } } }
    });
    const total = await prisma.user.count({ where: where });

    res.render('users', {
      username: req.session.username,
      users: users,
      page: page,
      totalPages: Math.ceil(total / limit) || 1,
      search: search,
      total: total
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error: ' + err.message);
  }
});

app.post('/admin/users/:id/ban', requireAuth, async function(req, res) {
  await prisma.user.update({ where: { id: req.params.id }, data: { isBanned: true } });
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/unban', requireAuth, async function(req, res) {
  await prisma.user.update({ where: { id: req.params.id }, data: { isBanned: false } });
  res.redirect('/admin/users');
});

// ========== TASKS (full edit) ==========
app.get('/admin/tasks', requireAuth, async function(req, res) {
  try {
    const tasks = await prisma.task.findMany({ orderBy: { order: 'asc' } });
    let editTask = null;
    if (req.query.edit) {
      editTask = await prisma.task.findUnique({ where: { id: req.query.edit } });
    }
    res.render('tasks', {
      username: req.session.username,
      tasks: tasks,
      editTask: editTask
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error: ' + err.message);
  }
});

app.post('/admin/tasks', requireAuth, async function(req, res) {
  await prisma.task.create({
    data: {
      title: req.body.title,
      description: req.body.description || null,
      type: req.body.type || 'CUSTOM',
      link: req.body.link || null,
      order: parseInt(req.body.order) || 0,
      isRequired: req.body.isRequired === 'on' || req.body.isRequired === true
    }
  });
  res.redirect('/admin/tasks');
});

app.post('/admin/tasks/:id/edit', requireAuth, async function(req, res) {
  try {
    await prisma.task.update({
      where: { id: req.params.id },
      data: {
        title: req.body.title,
        description: req.body.description || null,
        type: req.body.type || 'CUSTOM',
        link: req.body.link || null,
        order: parseInt(req.body.order) || 0,
        isRequired: req.body.isRequired === 'on',
        isActive: req.body.isActive === 'on'
      }
    });
    res.redirect('/admin/tasks');
  } catch (err) {
    console.error('Task edit error:', err);
    res.status(500).send('Edit failed: ' + err.message);
  }
});

app.post('/admin/tasks/:id/toggle', requireAuth, async function(req, res) {
  const task = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (task) {
    await prisma.task.update({ where: { id: req.params.id }, data: { isActive: !task.isActive } });
  }
  res.redirect('/admin/tasks');
});

app.post('/admin/tasks/:id/delete', requireAuth, async function(req, res) {
  await prisma.task.delete({ where: { id: req.params.id } });
  res.redirect('/admin/tasks');
});

// Verification
app.get('/admin/verification', requireAuth, async function(req, res) {
  const submissions = await prisma.taskSubmission.findMany({
    where: { status: 'PENDING' },
    include: { user: true, task: true },
    orderBy: { createdAt: 'asc' },
    take: 100
  });
  res.render('verification', { username: req.session.username, submissions: submissions });
});

app.post('/admin/verification/:id/approve', requireAuth, async function(req, res) {
  await prisma.taskSubmission.update({
    where: { id: req.params.id },
    data: { status: 'APPROVED', verifiedAt: new Date(), verifiedBy: req.session.username }
  });
  res.redirect('/admin/verification');
});

app.post('/admin/verification/:id/reject', requireAuth, async function(req, res) {
  await prisma.taskSubmission.update({
    where: { id: req.params.id },
    data: { status: 'REJECTED', verifiedAt: new Date(), verifiedBy: req.session.username }
  });
  res.redirect('/admin/verification');
});

// Settings
app.get('/admin/settings', requireAuth, async function(req, res) {
  let settings = await prisma.setting.findFirst();
  if (!settings) {
    settings = await prisma.setting.create({ data: {} });
  }
  res.render('settings', {
    username: req.session.username,
    settings: settings,
    success: req.query.success
  });
});

app.post('/admin/settings', requireAuth, async function(req, res) {
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
    await prisma.setting.update({ where: { id: existing.id }, data: data });
  } else {
    await prisma.setting.create({ data: data });
  }
  res.redirect('/admin/settings?success=1');
});

// Leaderboard
app.get('/admin/leaderboard', requireAuth, async function(req, res) {
  const top = await prisma.user.findMany({
    where: { isBanned: false },
    orderBy: { referralCount: 'desc' },
    take: 50,
    select: {
      id: true, username: true, firstName: true, telegramId: true,
      referralCount: true, isVerified: true
    }
  });
  res.render('leaderboard', { username: req.session.username, top: top });
});

// Winners
app.get('/admin/winners', requireAuth, async function(req, res) {
  const winners = await prisma.winner.findMany({ orderBy: { selectedAt: 'desc' }, take: 200 });
  const userIds = winners.map(function(w) { return w.userId; });
  const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
  const userMap = {};
  users.forEach(function(u) { userMap[u.id] = u; });
  res.render('winners', {
    username: req.session.username,
    winners: winners.map(function(w) { return Object.assign({}, w, { user: userMap[w.userId] }); })
  });
});

app.post('/admin/winners/select-random', requireAuth, async function(req, res) {
  try {
    const settings = await prisma.setting.findFirst();
    const count = (settings && settings.randomWinnersCount) || 100;
    const amount = (settings && settings.randomWinnerAmount) || 2;

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

    const shuffled = eligible.sort(function() { return 0.5 - Math.random(); });
    const selected = shuffled.slice(0, Math.min(count, eligible.length));
    const batchId = 'batch_' + Date.now();

    for (let i = 0; i < selected.length; i++) {
      const u = selected[i];
      await prisma.winner.create({
        data: { userId: u.id, type: 'RANDOM_WINNER', amount: amount, batchId: batchId }
      });
      await prisma.reward.create({
        data: { userId: u.id, type: 'RANDOM_WINNER', amount: amount, status: 'PENDING' }
      });
    }

    res.redirect('/admin/winners?success=selected');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/winners?error=failed');
  }
});

// Payments
app.get('/admin/payments', requireAuth, async function(req, res) {
  const rewards = await prisma.reward.findMany({
    include: { user: true },
    orderBy: { createdAt: 'desc' },
    take: 100
  });
  res.render('payments', { username: req.session.username, rewards: rewards });
});

app.post('/admin/payments/:id/mark-paid', requireAuth, async function(req, res) {
  await prisma.reward.update({
    where: { id: req.params.id },
    data: { status: 'PAID', txHash: req.body.txHash || null, paidAt: new Date() }
  });
  res.redirect('/admin/payments');
});

// Broadcast
app.get('/admin/broadcast', requireAuth, async function(req, res) {
  const broadcasts = await prisma.broadcast.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20
  });
  res.render('broadcast', { username: req.session.username, broadcasts: broadcasts });
});

app.post('/admin/broadcast', requireAuth, async function(req, res) {
  if (!req.body.message) return res.redirect('/admin/broadcast');
  await prisma.broadcast.create({ data: { message: req.body.message, status: 'DRAFT' } });
  res.redirect('/admin/broadcast');
});

app.get('/api/settings', async function(req, res) {
  const settings = await prisma.setting.findFirst();
  res.json(settings || {});
});

module.exports = app;
