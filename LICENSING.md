# Packages and licence keys (Basic / Pro / Business)

Each restaurant runs its own copy of the POS. What it can use depends on its **licence key**, a short
code you make and sign on your own computer. The POS checks the signature, so a client can't change
their plan by editing the database or the `.env` file.

## The packages

| | Basic | Pro | Business |
|---|:-:|:-:|:-:|
| Orders, floor plan, billing, KOT, kitchen screen | ✓ | ✓ | ✓ |
| Cash shifts, X/Z report, voids & refunds with manager PIN | ✓ | ✓ | ✓ |
| Bills in English / Tamil / Sinhala, thermal printing | ✓ | ✓ | ✓ |
| Reports | last 7 days | any range + CSV | any range + CSV |
| Devices signed in | 2 | 5 | no limit |
| Active staff | 5 | 20 | no limit |
| Stock, recipes & suppliers | – | ✓ | ✓ |
| Audit log | – | ✓ | ✓ |
| Z-report & cash-variance emails (n8n) | – | ✓ | ✓ |
| Shop PC backup (works when the internet drops) | – | – | ✓ |

**No key = free trial:** every feature, up to 3 devices, for 14 days from the first start.

The list lives in `server/license.js` (`PLANS`). Change the numbers or move a feature there, and it
applies to every installation after the next deploy.

## One-time setup (you, the vendor)

On **your own computer**, in the project folder:
```
npm run license:keygen
```
This makes:
- `~/virundhu-license-private.pem`: your **private key**. Keep it secret and back it up (USB stick,
  password manager). Whoever has it can make licence keys. If you lose it, you can't issue keys that
  existing installations accept.
- `server/license-public.pem`: the **public key**. Commit it and deploy it with the POS. It can only
  check keys, not make them.

Never put the private key in the project, on Railway or on a client's PC. `.gitignore` already
excludes `*-private.pem`.

## Issuing a key for a client

```
npm run license:issue -- --client "Seaside Cafe, Trincomalee" --plan pro --months 12
npm run license:issue -- --client "Hotel Blue" --plan business --until 2027-12-31
npm run license:issue -- --client "Kade" --plan basic --months 1 --devices 3
```
`--devices` and `--staff` override the plan's limit for that one client (`0` = no limit), e.g. when you
sell an extra device.

Then do one of these:
- **Send the key on WhatsApp.** The manager pastes it in **Admin → Plan & licence → Licence key**.
- **Set it yourself on Railway** as the variable `LICENSE_KEY`. The Admin page then shows "set on
  the server", and only you can change it.

Renewing, upgrading or downgrading means issuing a new key. Nothing in the client's data changes:
features that aren't in the new plan are hidden, and their data comes back when they upgrade again.

## What clients see

- **Locked features** stay visible, with a yellow **PRO** or **BUSINESS** tag. Opening one shows what
  it does and an **Upgrade on WhatsApp** button. The message is pre-filled with the restaurant name
  and goes to `VENDOR_WHATSAPP` (default 94786036092).
- **Admin → Plan & licence** shows:
  - the plan, who it's licensed to and the expiry date;
  - devices and staff used against the limits;
  - a comparison of the three plans;
  - the devices list, with **Remove**;
  - the licence key box.
- **Device limit.** A new tablet can sign in while the plan has room. When it's full:
  - other staff see *"already in use on 2 devices… ask a manager"*;
  - a **Manager** signing in on the new tablet replaces the device unused the longest.
  
  A device unused for 30 days stops counting by itself.
- **Staff limit.** Existing staff are never cut off. Only adding or re-activating someone is blocked.

## Expiry

| When | What happens |
|---|---|
| 7 days before | Managers see a reminder bar with **Renew on WhatsApp** |
| Expired, first 14 days (grace) | Everything works, with a red bar for managers |
| After the grace period | **New orders can't be started.** Open orders can still be finished, paid and printed. Reports, History and Admin still work |

Nothing is ever deleted, and a restaurant is never stopped in the middle of a service.

## Shop PC setups

The licence sits on the main server: the cloud in *cloud first*, the shop PC in *shop first*. A key on
the cloud is copied to its shop PC automatically. The shop PC backup works only on **Business**; on
other plans the shop PC shows *"Shop PC backup: available in the Business plan"*.
