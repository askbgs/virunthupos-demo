# Shop server: keep selling when the internet is down

> **Two setups.** This guide is for *shop first*: the shop PC is the main POS and Railway is a read-only copy.
> If you'd rather work on the **cloud POS** and use the shop PC only when the internet drops, follow
> **[CLOUD-FIRST.md](CLOUD-FIRST.md)** instead.

The POS runs on a small PC **inside the restaurant**. Tablets, the kitchen screen and the receipt and
kitchen printers all talk to that PC over the shop Wi-Fi/LAN, so **taking orders, sending KOTs,
printing and charging never need the internet**.

Railway becomes the **cloud copy**: read-only, always up to date when the internet is up. Use it for
reports, History and Stock from anywhere, and as an off-site backup.

```
   Tablets ─┐                                         ┌──────────────────────┐
   Kitchen ─┼── shop Wi-Fi / LAN ──►  SHOP PC         │  RAILWAY (cloud copy) │
   screen   │                        POS + Postgres ──┼─►  read-only           │
   Printers ┘                        (the master)  internet, when available   │
                                                      └──────────────────────┘
```

**How sync works.** Every change in the shop database is recorded in a queue *in the same
transaction* as the change itself, so nothing can be missed. A background worker uploads the queue
whenever the internet is up. While it's down, the queue grows. When the internet comes back,
everything is sent in order, usually within seconds. Orders never wait for the upload.

The header shows the state:
- **Cloud synced**: the internet is up and the cloud copy is current.
- **Offline · 12 to sync**: no internet. The POS keeps working, and 12 changes will upload later.

Admin → Settings → *Shop server & cloud sync* shows the details.

---

## What you need

- **An always-on PC** in the shop. Any Windows 10/11 or Linux PC with 4 GB RAM is plenty; a mini PC
  (e.g. Intel N100) is ideal. It must stay on during opening hours.
- **A UPS** for the PC, the Wi-Fi router and the network printers. The internet can be down, but
  the shop network must have power.
- **A fixed address for the PC** on the router (DHCP reservation), e.g. `192.168.1.10`. Tablets use
  `http://192.168.1.10:3000`.
- **Network (LAN/Wi-Fi) thermal printers**, also with fixed addresses. The shop server prints to them
  directly. USB printers shared from a Windows PC still use `print-bridge.js` on that PC.

---

## Step 1: make Railway the cloud copy

1. Make up a long random secret, e.g. 40+ letters and numbers. This is the **SYNC_TOKEN**.
2. Finish open orders, close the shift, then in Railway → your app service → **Variables** add:
   - `POS_MODE` = `mirror`
   - `SYNC_TOKEN` = your secret

   Then redeploy. From now on Railway is read-only: logins work, Reports and History work, and changes
   are refused with a clear message.

## Step 2: install the shop server

### Option A: Docker (recommended)

1. Install **Docker Desktop** on the shop PC and turn on *Start Docker Desktop when you sign in*.
2. Copy this project folder to the PC, e.g. `C:\pos`.
3. Copy `.env.shop.example` to `.env` and fill in:
   - `DB_PASSWORD`: any long password (for the database on this PC)
   - `CLOUD_URL`: your Railway address, e.g. `https://your-pos.up.railway.app`
   - `SYNC_TOKEN`: the same secret as on Railway
4. In that folder: `docker compose up -d`

Docker starts three things and restarts them automatically after a reboot or crash:
- the database
- the POS (`POS_MODE=local`, direct printing on)
- a **nightly backup** into `.\backups`, keeping 14 days

### Option B: without Docker (Windows)

1. Install **Node.js 20+** and **PostgreSQL 17**. Create a database `pos` and a user for it.
2. In the project folder: `npm ci --omit=dev`
3. Create `.env`:
   ```
   DATABASE_URL=postgres://pos:YOURPASSWORD@localhost:5432/pos
   POS_MODE=local
   PRINT_DIRECT=true
   CLOUD_URL=https://your-pos.up.railway.app
   SYNC_TOKEN=your-secret
   ```
4. Double-click `start-shop-server.bat`. It restarts the POS if it ever stops. To start it automatically,
   add it to Task Scheduler with the trigger *At log on*.

## Step 3: bring your existing data from Railway (one time)

Do this after Step 1, so nothing new is written on Railway meanwhile, and before the first real
service on the shop server.

1. In Railway → Postgres → *Connect*, copy the **public** connection URL (`postgresql://…proxy.rlwy.net:…`).
2. With Docker:
   ```
   docker compose up -d db
   docker compose exec -e SRC="postgresql://...railway public url..." db sh -c 'pg_dump --no-owner --no-acl "$SRC" | psql -q -U pos -d pos'
   docker compose up -d
   ```
   Without Docker: `pg_dump --no-owner --no-acl "<railway url>" | psql -U pos -d pos`, then start the POS.
3. On first start the shop server sets up change tracking and sends one full copy to Railway. The header
   shows **Copying to cloud…**, then **Cloud synced**.

If you skip this step, the shop server starts with the demo data instead.

## Step 4: point the tablets at the shop server

On each tablet and the kitchen screen, open `http://<shop-PC-address>:3000` and add it to the home screen.
In Admin → Printers, set the printers' network addresses (e.g. `192.168.1.50:9100`) and press **Test print**.

---

## Day to day

- **Internet down:** nothing changes for staff. The header shows **Offline**.
- **Internet back:** queued changes upload by themselves. No action is needed.
- **Menu, prices, staff, settings:** change them on the shop server. The cloud copy is read-only.
- **Card machines** use their own connection and are not affected by the POS being offline.

## If the shop PC fails

You have two copies to recover from:
- **The nightly backup in `backups\`:** restore with `pg_restore -d pos pos-YYYY-MM-DD.dump`.
- **The cloud copy on Railway:** it holds everything up to the last sync.

To keep trading while the PC is replaced, set Railway's `POS_MODE` to `standalone` (or remove it)
and redeploy. Staff can then use the Railway address directly; the order and ticket number counters
are repaired automatically on start. When the new shop PC is ready, follow Steps 1–3 again to move
the data back.

## Security notes

- Keep `SYNC_TOKEN` secret. It is the only thing that lets data into the cloud copy.
- Don't expose the shop PC to the internet (no port forwarding). It only needs to reach Railway
  *outbound*, and the tablets reach it on the local network.
- Change the demo PINs before going live.
