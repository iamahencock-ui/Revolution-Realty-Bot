# Revolution Realty Bot

A Discord bot for a DemocracyCraft real-estate firm. Clients open **Buy** or
**Sell** tickets, realtors handle deals in private channels, and (coming next)
issue signable contracts with PDF records, an archive, commission tracking, and
anti-spam.

**Build status — milestone by milestone:**

1. ✅ **Tickets** — Buy/Sell panel → private channel with Realtor/Manager roles → close
2. ✅ **Contracts** — Seller's & Purchase agreements, click-to-sign, PDF export
3. ✅ **IGN verification** — micropayment + memo proof, gates the Client Desk
4. ✅ **Contract archive / lookup** — search past contracts, re-pull PDFs
5. ✅ **Escrow / autopay** — verify buyer payment, auto-pay seller + commission
6. ✅ **Listings** — category forum channels + `/list`
7. ✅ **Lease Agreement** — `/lease-agreement` (rental contract)
8. ✅ **Contractors** — apply → approve → advertise
9. ✅ **Panel update + `/panel`** — Buy/Sell/Rent/Contractors + staff control panel
10. ✅ **Anti-spam / AutoMod** — invite/spam blocking + raid guard *(this build)*

## Anti-spam / AutoMod (Milestone 11)

Two layers, set up automatically:

1. **Native Discord AutoMod rules** (enforced server-side, even when the bot is
   offline) — created on setup if the bot has **Manage Server**:
   - **Block invite links** (the scam-server ad spam summerock described)
   - **Mention spam** (caps mass-pings)
   - **Spam** (Discord's built-in detection)
   Staff roles (Manager/Realtor/Contractor) are exempt; blocked messages alert an
   **#automod-log** channel.
2. **Bot-side raid guard** — if a user posts the **same message across 3+
   channels** within 30s (a classic ad raid), the bot deletes every copy and
   times the user out. Needs **Moderate Members** + **Manage Messages**.

All thresholds live in `config.js → automod`. AutoMod rule creation needs the bot
to have **Manage Server**; if it doesn't, that layer is skipped (the raid guard
still works).

## Panel + staff control panel (Milestone 10)

The Client Desk now offers **Buy a plot · Sell a plot · Rent a plot · Become a
Contractor · Find Contractors**. Renting opens a `rent-` ticket (handled by
realtors) for apartments/commercial space.

Realtors/managers get **`/panel`** — an ephemeral control panel listing every
command they can run (contracts, deals, listings, lookups), with quick buttons:
**Recent contracts**, and (managers) **Post client panel here**.

## Contractors (Milestone 9)

Setup creates a **Contractor** role and a public, read-only **#contractors**
channel. The Client Desk panel gains two buttons:

- **🛠️ Become a Contractor** — opens a private application ticket (handled by
  **managers**, not realtors). A manager clicks **Approve**/**Deny**; approval
  grants the **Contractor** role.
- **🔍 Find Contractors** — points users to the #contractors channel.

Approved contractors advertise with **`/contractor-ad`** (company, services,
contact, optional image) → the bot posts a formatted advert into #contractors.

## Lease Agreement (Milestone 7)

`/lease-agreement` issues a rental contract — **landlord + tenant + realtor**
all sign. Fields: plot, **rent (a number — the `/week` is added automatically)**,
term (default 4 weeks), security deposit, description, commission, special
requirements. Same sign-in-place embed + PDF record + archive flow.

## Payment panels + recurring rent (Milestone 8)

When a contract is fully signed, the bot posts a **payment panel** in the ticket
addressed to the buyer/tenant:

- **Get pay command** (buyer/tenant only) — shows, *privately*, the exact in-game
  pay command pre-filled with the amount and a **unique 32-char memo**.
- **Check payment** — verifies the firm received a payment with that memo for the
  **full amount**, then confirms and pings the realtor to transfer + `/complete-deal`.

**Sales** get a one-time panel for the full price. **Leases** get a **recurring
weekly** panel: every week the bot pings the tenant with a fresh memo for that
week's rent, until the lease term ends. Each week's payment is verified
independently. (Requires `DC_API_TOKEN` + `VERIFY_ACCOUNT_ID`.)

**Rent escrow:** when a weekly rent is verified, the bot automatically splits it
— the **landlord** receives `rent − commission`, the **realtor** their share of
the commission (default 50%), and the **company** keeps the rest. Idempotent per
week (no double-payouts). Toggle with `config.deal.rentEscrow`. (Sales still
release via `/complete-deal` after the plot is transferred.)

## Listings (Milestone 6)

First-run setup creates a **Listings** category with a **forum channel per
category** (Residential, Commercial, Skyscraper, Industrial), each with **Sale /
Rent / Sold** tags. (If forum channels aren't available on the server, it falls
back to text channels automatically.)

A realtor posts a listing with **`/list`** (intended for use inside a sell
ticket): pick category + Sale/Rent, enter plot, price, title, description, and
an optional image. The bot creates a **forum post** in the right category with
the Sale/Rent tag and the image, so users can browse and filter all listings in
one place. Listings are stored for later management (mark-sold coming next).

## Escrow / autopay (Milestone 5)

When a **purchase agreement** is fully signed (and `DC_API_TOKEN` +
`VERIFY_ACCOUNT_ID` are set), the bot posts payment instructions: the **buyer
pays the firm the full price** in-game with a unique memo.

Once the plot has been transferred, a realtor/manager runs
**`/complete-deal contract:<id>`**. The bot:

1. **Verifies** the firm actually received the buyer's payment (memo-matched).
2. Pays the **seller** their proceeds (`price − commission`) → seller's IGN.
3. Pays the **realtor** their share of the commission (default **50%**, set via
   `config.deal.realtorCommissionShare`) → realtor's IGN.
4. The **company keeps the remaining commission** in the firm account.

It only pays out on a confirmed payment, uses idempotency keys, and is safely
re-runnable — if one transfer fails, re-running pays only what's still owed
(no double-paying). Payouts are debited from `DC_FROM_ACCOUNT_ID` (defaults to
`VERIFY_ACCOUNT_ID`). IGNs come from each party's verified link.

## Contract lookup (Milestone 4)

Realtors/managers can find and re-pull any past contract:

- `!contracts` — the most recent contracts.
- `!contracts @user` — every contract a user is a party to.
- `!contracts signed` (or `pending` / `void`) — filter by status.
- `!contracts c244` — search by plot, party name, type, or price.
- `!contract <id>` — re-show a specific contract and re-attach its signed PDF.

Every fully-signed contract is also auto-filed in the private **contract-archive**
channel when it completes.

## IGN verification (micropayment proof)

When `DC_API_TOKEN` + `VERIFY_ACCOUNT_ID` are set, the bot **requires users to
verify the Minecraft account they deal under** before the Client Desk unlocks:

1. Setup creates a **Verified** role and a public **verify-here** channel, and
   locks **client-desk** to Verified + staff only.
2. A user clicks **Verify my IGN** → the bot gives them a unique **32-char memo**
   and asks them to send **$0.01** to the firm's account with that memo.
3. They pay in-game, then click **I've sent it**. The bot reads the receiving
   account's recent transactions via the DC Treasury API, finds the one carrying
   their memo, reads the payer's **UUID → IGN**, binds it to their Discord
   account, and grants the **Verified** role (unlocking the Client Desk).

An IGN can only be claimed by one Discord user. Configure the displayed pay
command, firm name, and amount in `config.js → verify`. To turn verification on
for an already-set-up server, add the env vars and run `!resetup`.

## Contracts (Milestone 2)

Realtors/managers issue contracts with **slash commands** (which give native
field UI, including user pickers):

- `/seller-agreement seller:@user plot:… price:… [commission] [term_days] …`
- `/purchase-agreement buyer:@user seller:@user plot:… price:… [payment_terms] [special] …`

The bot posts a **live contract embed** with the filled-in agreement and a
**Sign** button. Each named party clicks Sign; the bot stamps their name + UTC
timestamp and updates the embed in place. When **all** parties have signed, the
status flips to FULLY SIGNED, a **PDF record** is generated and posted in the
ticket, and a copy is filed in the private **contract-archive** channel. The
issuing realtor (or a manager) can **Void** a pending contract.

Defaults (in `config.js → contract`): 10% commission, 30-day term, "full payment
on transfer."

> Invite note: for slash commands to appear, invite the bot with **both** the
> `bot` and `applications.commands` scopes.

## Setup

1. Create a bot at <https://discord.com/developers/applications> → Bot →
   **enable the MESSAGE CONTENT INTENT** → copy the token.
2. Invite it with the `bot` scope and **Manage Channels**, **Manage Roles**,
   Send Messages, Embed Links, Attach Files, Read Message History.
3. Install & run:
   ```bash
   npm install
   cp .env.example .env     # paste your DISCORD_TOKEN
   npm start
   ```

Node 18+ required.

## First-run auto-setup

The first time the bot joins (or at startup), it creates a **Manager** role, a
**Realtor** role, a **Tickets** category, a public **client-desk** channel with
the Buy/Sell panel, and a private **contract-archive** channel — then DMs the
owner a summary. Assign the Realtor/Manager roles to your staff.

## How tickets work (Milestone 1)

- Clients click **Buy a plot** or **Sell a plot** on the panel.
- The bot opens a **private channel** (`buy-name` / `sell-name`) visible only to
  the client, Realtors, Managers, and the bot, and pings a realtor.
- The client or any realtor/manager can **close** it (button or `!close`), which
  deletes the channel after 5 seconds.

Commands: `!setup` (admin — re-post the panel), `!close`, `!help`.

## Files

- `index.js` — client, ticket buttons, slash commands, sign/void handling
- `config.js` — branding, panel/welcome text, contract defaults
- `setup.js` — first-run provisioning
- `embeds.js` — panel + ticket embeds and buttons
- `contracts.js` — contract templates, signing embed, PDF export
- `verify.js` — DC Treasury micropayment IGN verification
- `db.js` — JSON persistence (guild config, tickets, contracts, verification)
- `contract-templates.md` — the agreement drafts (reference)
