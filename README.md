# Zycot Airdrop Telegram Bot + Admin Panel

Complete airdrop bot system matching the provided screenshots. Built with Node.js, Telegraf, Express, Prisma & PostgreSQL. Ready for Railway deployment.

## Features

### Telegram Bot
- `/start` with referral support
- CAPTCHA verification
- Task system (Join channels, Follow X, etc.)
- X Profile + BEP-20 Wallet submission
- Referral tracking & personal referral links
- Statistics, Leaderboard, Airdrop Rules
- Fully configurable via Admin Panel

### Web Admin Panel (`/admin`)
- Dashboard with stats
- User management (search, ban/unban)
- Task management (CRUD)
- Verification queue
- Settings (airdrop amounts, rules, captcha toggle etc.)
- Leaderboard view
- Random Winner Selection
- Payment tracking (mark as paid + TX hash)
- Broadcast messaging

## Quick Start (Local)

```bash
# 1. Clone / enter folder
cd zycot-bot

# 2. Install
npm install

# 3. Setup env
cp .env.example .env
# Edit .env with your DATABASE_URL, BOT_TOKEN, ADMIN_PASSWORD etc.

# 4. Push DB schema
npx prisma db push

# 5. Run
npm run dev
```

Admin login: `admin` / (the password you set in .env)

## Railway Deployment

1. Create new project on Railway
2. Add **PostgreSQL** plugin
3. Deploy this repo (GitHub or CLI)
4. Set environment variables:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
PRISMA_DB_PUSH=true
BOT_TOKEN=your_bot_token_from_BotFather
BOT_USERNAME=YourBotUsername
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_strong_password
SESSION_SECRET=random_long_string
JWT_SECRET=another_random_string
NODE_ENV=production
```

5. Railway will run `npm start` which does `prisma generate` via postinstall + starts the server.
6. For webhook (recommended on Railway): set `WEBHOOK_DOMAIN=https://your-app.up.railway.app`

After deploy, open `https://your-app.up.railway.app/admin` and login.

## Default Tasks (auto-seeded)

1. Join Zycot Telegram
2. Join Advertiser Telegram Channel
3. Follow X accounts
4. Follow Advertiser Twitter + like/retweet
5. Join Advertiser Telegram Group

You can change everything from Admin → Tasks & Settings.

## Structure

```
zycot-bot/
├── prisma/schema.prisma
├── src/
│   ├── index.js          # Entry point
│   ├── bot/index.js      # Telegraf bot
│   ├── admin/app.js      # Express admin
│   ├── admin/views/      # EJS templates
│   └── utils/
├── public/
├── package.json
└── .env.example
```

## Notes

- Captcha is text-based for Railway compatibility (no native canvas needed).
- Membership verification for channels is simplified (user presses Done). For real verification use Telegram's `getChatMember` with bot as admin in channels.
- Random winners selection is available in Admin → Winners.
- One registration per Telegram ID enforced.

Made for the exact flow shown in the screenshots.
