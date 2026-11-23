# Live demo (demo.virunthu.shop)

A public copy of the POS that anyone can try from the website. It runs the normal code with
`DEMO_MODE=true`:

- **Sign-in:** the login screen shows the demo PINs. One tap signs in as **Manager** (0000),
  **Captain** (1234) or **Kitchen** (1111).
- **Data:** a lived-in restaurant: about 140 paid orders over 9 days, 8 busy tables, kitchen tickets,
  stock and suppliers.
- **Dates:**
  - the sales history is moved forward so it always ends today;
  - busy tables are always seated 10 to 75 minutes ago;
  - the cash shift opens at 9:30 this morning.
- **Plan:** every feature is unlocked (Business plan), and the demo never expires.
- **Reset:** a red bar explains the demo and has **Reset demo** and **Start your free trial** buttons.
  The demo resets by itself every night at 3 AM (`DEMO_RESET_HOUR`). A visitor can reset it at most
  once a minute.
- **Locked in the demo**, so visitors can't lock each other out or reach outside the server:
  - staff and PINs, the licence and devices;
  - printers (bills print through the browser);
  - email integration (n8n);
  - uploading pictures.

## Put it online (Railway, about 10 minutes)

1. In your Railway project: **+ New → GitHub repo** (the same repo as the POS), and **+ New → Database →
   PostgreSQL** for it. Use a *separate* database, never a real restaurant's.
2. On the new service, under **Variables**, set:
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}   (the demo's own Postgres)
   DEMO_MODE=true
   POS_MODE=standalone
   ```
   Optional: `DEMO_RESET_HOUR=3`, and `DEMO_TRIAL_URL=https://virunthu.shop/#trial`.
3. Under **Settings → Networking**, add the custom domain `demo.virunthu.shop`. Railway shows a
   **CNAME** target.
4. In Hostinger, under **DNS** for virunthu.shop, add a **CNAME** record: name `demo`, pointing to that
   target. HTTPS starts by itself within a few minutes.

On first start the server loads the snapshot. The log shows `Demo: data loaded`.

## Changing what the demo shows

The demo restaurant is the file `server/demo/demo-data.json.gz`. To change it:

1. Set up a restaurant the way the demo should look: a normal POS with its own database, your menu,
   tables, a week or two of sales, and some open tables.
2. Run:
   ```
   DATABASE_URL=postgres://... npm run demo:export
   ```
3. Commit the new file and redeploy. The next reset (or a visitor's **Reset demo**) loads it.

The export leaves out printers, the licence, the n8n settings, the print bridge token, devices and
sessions.

## Free-trial form (website)

The **Start your free trial** form on virunthu.shop posts to the n8n workflow
**"Virundhu POS – Trial Form Leads"**:
`https://n8n.srv834342.hstgr.cloud/webhook/virundhu-trial`. The workflow:

1. checks the request and rejects bots (a hidden field, and forms sent in under 3 seconds);
2. saves the lead in the n8n data table **Virundhu POS – Trial Leads**;
3. e-mails you, with a one-tap WhatsApp link to the owner;
4. sends the owner a thank-you e-mail, if they gave an address.

The webhook accepts requests only from `https://virunthu.shop` and `https://www.virunthu.shop`.
