# Postre Food Products — Setup & Deployment Guide

Detailed steps to go from this codebase to a working Messenger ordering system.

---

## 1. Prerequisites

- **Node.js 22+** (required — the project uses the built-in `node:sqlite` module)
- **npm** (comes with Node)
- A **Facebook Page** (the ordering bot will run on this page)
- A **Meta developer account** → https://developers.facebook.com
- (For production) A **public HTTPS URL** — required by Meta for webhooks. Free options: Render, Railway, Fly.io, or a VPS with a reverse proxy (Caddy/Nginx + Let's Encrypt).

---

## 2. Local Setup

```powershell
# inside the project folder
npm install

# create your environment file
Copy-Item .env.example .env
```

Edit `.env`:

```env
PORT=3000
JWT_SECRET=some-long-random-string        # used to sign admin login tokens
ADMIN_USER=admin                          # admin panel username
ADMIN_PASSWORD=use-a-real-password        # admin panel password
PAGE_ACCESS_TOKEN=                        # filled in later (step 4)
VERIFY_TOKEN=postre_verify                # any random string, you choose it
DATABASE_FILE=./data/postre.db
```

Build, seed sample data, and run:

```powershell
npm run build
npm run seed     # sample menu, packages, delivery areas (skips if data exists)
npm start        # server on http://localhost:3000
```

Verify it works:

- `GET http://localhost:3000/health` → `{"ok":true}`
- `POST http://localhost:3000/api/login` with `{"username":"admin","password":"..."}` → returns a JWT token

---

## 3. Create the Meta App

1. Go to https://developers.facebook.com → **My Apps** → **Create App**.
2. App type: **Business**. Fill in a name (e.g. "Postre Ordering") and contact email.
3. In the app dashboard, find **Add products to your app** → add **Messenger**.
4. In the Messenger settings you will see your **Page Access Token** section — you need a Page linked to the app first. If you don't have one yet, create a Facebook Page, then click **Add or remove pages** and connect it.

---

## 4. Get the Page Access Token

1. In **Messenger → Settings → Access Tokens**, select your Page.
2. Click **Generate Token** (grant the permission prompts).
3. Copy the token into your `.env`:

```env
PAGE_ACCESS_TOKEN=EAAG...your-long-token...
```

> ⚠️ Tokens from the dev dashboard are for your own accounts. For a live app in
> **Business Verification / App Review**, generate a token via the System User
> (Business Settings → System Users) so it doesn't expire.

---

## 5. Configure the Webhook URL

**Local testing:** Meta requires HTTPS, so expose your localhost with a tunnel:

```powershell
npx ngrok http 3000
# or: cloudflared tunnel --url http://localhost:3000
```

Copy the public URL it prints, e.g. `https://abc123.ngrok.app`.

**Production:** use your deployed server's URL instead.

Then in Meta:

1. **Messenger → Settings → Webhooks** → **Configure Webhooks**.
2. **Callback URL**: `https://YOUR-URL/webhook`
3. **Verify token**: exactly the value of `VERIFY_TOKEN` in your `.env` (e.g. `postre_verify`)
4. Click **Verify and save** — the server answers the challenge automatically.
5. Under **Webhook fields**, subscribe to:
   - `messages`
   - `messaging_postbacks`

---

## 6. Enable Messaging on the Page

1. In Messenger settings → **Built-in NPP (Get Started button)** → enable it, and add a **postback** with payload `GET_STARTED` (the bot's main menu handles this payload).
2. Optional: add a **Persistent Menu** with postback payloads:
   - "🛒 Order Now" → `MENU_ORDER`
   - "🔥 Packages" → `MENU_PACKAGES`
   - "📅 Reservation" → `MENU_RESERVE`
   - "🛒 My Cart" → `MENU_CART`

---

## 7. Set Up the Get Started Postback

The bot's `GET_STARTED` payload shows the main menu. If Meta's "Get Started"
button doesn't send it automatically, set it once with the Page token:

```powershell
$token = "YOUR_PAGE_ACCESS_TOKEN"
Invoke-RestMethod -Uri "https://graph.facebook.com/v19.0/me/messenger_profile?access_token=$token" `
  -Method Post -ContentType 'application/json' `
  -Body '{"get_started":{"payload":"GET_STARTED"}}'
```

---

## 8. Test End-to-End (Messenger Test Mode)

While the app is in Development mode, anyone with a role on the app (admin,
developer, tester) can message the Page.

1. Add yourself as a tester: **App Roles → Roles → Testers**.
2. Open the Page in Messenger and send "hi" → you should get the main menu.
3. Walk through: Order Now → category → product → size → quantity → cart →
   checkout → place order.
4. Check the admin side:

```powershell
$login = Invoke-RestMethod -Uri http://localhost:3000/api/login `
  -Method Post -ContentType 'application/json' `
  -Body '{"username":"admin","password":"YOUR_PASSWORD"}'
$h = @{ Authorization = "Bearer $($login.token)" }
Invoke-RestMethod -Uri http://localhost:3000/api/admin/orders -Headers $h
```

5. Change the order status in the admin API — the customer receives an
   automatic Messenger notification (Confirmed / Preparing / Ready / Cancelled).

---

## 9. Replace Sample Data with the Real Menu

Once seeded, manage everything through the admin API (or your admin panel):

| What | Endpoint |
|---|---|
| Categories | `GET/POST/PUT/DELETE /api/admin/categories` |
| Products + variants (M/L prices) | `/api/admin/products`, `PUT /products/:id/variants` |
| Packages + slots + upgrades | `/api/admin/packages`, `PUT /packages/:id/slots` |
| Delivery areas & fees | `/api/admin/delivery-areas` |
| Business hours / closed dates / slot capacity | `/api/admin/business-hours`, `/blocked-dates`, `/time-slots` |

Sample data is insert-only (the seed skips if products exist), so add real
products on top of or instead of the samples via the API.

---

## 10. Production Deployment (₱0/month target)

### Option A — Render / Railway free tier

1. Push this repo to GitHub.
2. Create a **Web Service** on Render/Railway from the repo.
3. Build command: `npm install && npm run build`
4. Start command: `npm start`
5. Add all the `.env` variables in the dashboard (same keys as `.env.example`).
6. Attach a persistent disk mounted at `/app/data` (or set `DATABASE_FILE` to a
   persistent path) so the SQLite database survives restarts.
7. Copy the generated HTTPS URL → use it as the webhook Callback URL (step 5).

### Option B — Own VPS (e.g. cheap/free Oracle Cloud)

```bash
npm install && npm run build
# run under pm2
npm i -g pm2
pm2 start dist/server.js --name postre
pm2 save && pm2 startup
# reverse proxy with Caddy (auto-HTTPS):
# caddy reverse-proxy --from ordering.yourdomain.com --to localhost:3000
```

### After deploying

1. Update the webhook Callback URL in Meta to the production HTTPS URL.
2. Set a strong `JWT_SECRET` and `ADMIN_PASSWORD` in production env.
3. Submit the app for **App Review** (permission `pages_messaging`) and complete
   **Business Verification** so real customers can message the Page.
4. Toggle the app to **Live** mode.

---

## 11. Security Checklist Before Going Live

- [ ] Strong `JWT_SECRET` and `ADMIN_PASSWORD` (not the defaults)
- [ ] HTTPS only (Meta enforces this for webhooks anyway)
- [ ] `DATABASE_FILE` points to persistent storage (backups!)
- [ ] Webhook verify token is a random private string
- [ ] Rate limiting / reverse-proxy limits on `/api/login` (add later if needed)
- [ ] Regular `sqlite3 data/postre.db ".backup ..."` backups (cron/scheduled task)
- [ ] Page token from a System User (non-expiring) rather than a dev token

---

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| Webhook "Verify and save" fails | `VERIFY_TOKEN` mismatch, or server not reachable at the URL. Check the tunnel/server logs. |
| Bot receives nothing | Webhook fields not subscribed (`messages`, `messaging_postbacks`), or app not Live and user isn't a tester. |
| Messages not sending | Wrong/expired `PAGE_ACCESS_TOKEN`; check server log for "Messenger send failed". |
| `Cannot find module 'node:sqlite'` | Node < 22. Upgrade Node. |
| Bot replies "Time slot is full" | Intended behavior — capacity per slot is enforced server-side. Adjust via `PUT /api/admin/time-slots/:id`. |
| Prices look wrong | Prices are always read from the DB (`product_variants`, `package_options`) — update them in the admin API. |
