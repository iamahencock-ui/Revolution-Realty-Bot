# Revolution Realty Bot

A Discord bot for a DemocracyCraft real-estate firm. Clients open **Buy** or
**Sell** tickets, realtors handle deals in private channels, and (coming next)
issue signable contracts with PDF records, an archive, commission tracking, and
anti-spam.

**Build status — milestone by milestone:**

1. ✅ **Tickets** — Buy/Sell panel → private channel with Realtor/Manager roles → close
2. ✅ **Contracts** — Seller's & Purchase agreements, click-to-sign, PDF export
3. ✅ **IGN verification** — micropayment + memo proof, gates the Client Desk
4. ✅ **Contract archive / lookup** — search past contracts, re-pull PDFs *(this build)*
5. ⏳ DC economy / commission tracking
6. ⏳ Anti-spam / automod

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
