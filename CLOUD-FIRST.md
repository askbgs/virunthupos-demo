# Cloud first, with the shop PC as backup

Staff work on the **cloud POS on Railway**. A PC in the restaurant keeps a full, live copy of it.
When the internet drops, staff switch to the shop PC and carry on: orders, KOTs, printing, payments,
even closing the shift. When the internet is back, the shop PC uploads everything it did, and staff
switch back to the cloud.

```
                  internet up                                   internet down
   Tablets ──► CLOUD POS (Railway) ──changes──► SHOP PC        Tablets ──► SHOP PC (shop Wi-Fi)
                                    ◄─offline work, uploaded when the internet is back──┘
```

## How it works

- **The shop PC copies the cloud all the time.** Every change on the cloud reaches the shop PC within
  about 2 seconds while the PC is on. If the PC was switched off, it catches up when it starts.
  After more than 30 days off, it downloads everything again.
- **Offline records can't clash with cloud records.** The shop PC numbers its own orders from
  **#900001** and KOTs from **900001**, so a bill made offline is easy to recognise. Shifts opened
  offline are shown as **offline #1, #2…**.
- **Offline work wins.** The shop PC uploads its offline work *before* it downloads anything, and a
  download never overwrites a record that is still waiting to upload.
- **Z-report email:** a shift closed on the shop PC during an outage is emailed by the cloud as soon
  as it's uploaded (when n8n is set up on the cloud).
- **Printing:** the cloud prints through the print bridge, and the shop PC prints straight to the
  network printers. Both use the same printers.

## Setup

### 1. Railway (the cloud POS)
In the app service → **Variables**:
```
POS_MODE=cloud
SYNC_TOKEN=<a long random text, e.g. 40 letters and numbers>
```
Delete `CLOUD_URL` if it's there. Railway redeploys. The cloud now works normally (no "read-only" bar)
and keeps a change log for the shop PC.

For printing from the cloud, keep running the print bridge on a shop PC (Admin → Printers).

### 2. The shop PC (the backup)
Install it as in **SHOP-SERVER.md, Step 2** (Docker or the .bat file), with these settings in `.env`:
```
POS_MODE=standby
CLOUD_URL=https://your-pos.up.railway.app
SYNC_TOKEN=<the same text as on Railway>
PRINT_DIRECT=true
```
Without Docker, `.env` also needs `DATABASE_URL=postgres://postgres:PASSWORD@localhost:5432/pos`.

Use an **empty database** for the shop PC. On first start it downloads the whole restaurant from the
cloud (a minute or two). Don't take orders on it until the bar at the top stops saying
*getting ready*.

Give the shop PC a **fixed IP address** in your router (e.g. `192.168.1.20`), so its address never changes.

### 3. The tablets
On every tablet, phone and the counter PC, bookmark (or add to the home screen) **only this address**:
```
http://192.168.1.20:3000/start
```
That page checks the internet and opens the right POS by itself.

## What staff do

| Situation | What they see | What they do |
|---|---|---|
| Normal day | `/start` opens the cloud POS | Work as usual |
| Internet drops | A red bar on the cloud POS: **No connection to the cloud POS** | Tap **Switch to the shop PC**, sign in with their PIN, carry on |
| Working offline | Bar on the shop PC: **Offline mode: you're on the shop PC** | Work as usual. Everything is kept |
| Internet back | Bar turns green: **Internet is back and everything is uploaded** | Tap **Switch to the cloud POS** |

If a tablet was restarted during the outage, open the `/start` bookmark: it shows **No internet →
Continue on the shop PC**.

## Rules for the manager

1. **Keep the shop PC on during opening hours**, and put it and the Wi-Fi router on a small UPS.
   If the PC is off when the internet drops, its copy is from the last time it was on.
2. **Don't use the cloud POS during an outage** (e.g. from a phone on mobile data). If the same table
   gets an order on both, the upload stops with *Sync conflict: a table has an open order on both…*.
   Pay or void the extra order on the cloud, and the upload continues by itself.
3. Orders typed in the last 2 seconds before the internet dropped may not have reached the shop PC.
   Check the open tables after switching.

## Checking it

- Header pill on the cloud: **Shop PC in sync**. On the shop PC: **Up to date**, **Offline · 3 to upload**
  or **Uploading 3…**.
- Admin → Settings → *Shop server & cloud sync* shows the details on both.
- `http://192.168.1.20:3000/start` shows whether the shop PC can reach the cloud.
