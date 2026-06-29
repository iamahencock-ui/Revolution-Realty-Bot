// ---------------------------------------------------------------------------
// index.js — Revolution Realty bot. Milestone 1: ticket system.
// Buy/Sell panel → private deal channel with Realtor/Manager roles → close.
// ---------------------------------------------------------------------------
import "dotenv/config";
import http from "node:http";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  AttachmentBuilder,
} from "discord.js";
import { config } from "./config.js";
import * as store from "./db.js";
import { ensureGuildSetup } from "./setup.js";
import {
  panelEmbed,
  panelButtons,
  ticketWelcomeEmbed,
  closeButton,
  verifyConfirmButton,
  listingEmbed,
  helpEmbed,
  paymentPanelEmbed,
  paymentPanelButtons,
  contractorWelcomeEmbed,
  contractorReviewButtons,
  contractorAdEmbed,
  staffPanelEmbed,
  staffPanelButtons,
} from "./embeds.js";
import {
  contractEmbed,
  contractButtons,
  allSigned,
  pdfAttachment,
  todayISO,
  plusDaysISO,
} from "./contracts.js";
import {
  verifyEnabled,
  newMemoCode,
  findVerificationPayment,
  dealEnabled,
  payToPlayer,
} from "./verify.js";

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Per-guild config (auto-setup) first, .env fallback.
const ENV_FALLBACK = {
  realtorRoleId: process.env.REALTOR_ROLE_ID,
  managerRoleId: process.env.MANAGER_ROLE_ID,
  ticketCategoryId: process.env.TICKET_CATEGORY_ID,
  contractArchiveChannelId: process.env.CONTRACT_ARCHIVE_CHANNEL_ID,
  verifiedRoleId: process.env.VERIFIED_ROLE_ID,
  contractorRoleId: process.env.CONTRACTOR_ROLE_ID,
  contractorsChannelId: process.env.CONTRACTORS_CHANNEL_ID,
};
function gcfg(guildId, key) {
  const gc = store.getGuildConfig(guildId);
  return gc[key] ?? ENV_FALLBACK[key] ?? null;
}

// Is this member realtor/manager/admin (i.e. staff)?
function isStaff(member, guildId) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const realtor = gcfg(guildId, "realtorRoleId");
  const manager = gcfg(guildId, "managerRoleId");
  return (
    (realtor && member.roles.cache.has(realtor)) ||
    (manager && member.roles.cache.has(manager))
  );
}

// Manager-only (contractor approvals, etc.).
function isManager(member, guildId) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const manager = gcfg(guildId, "managerRoleId");
  return manager && member.roles.cache.has(manager);
}

// --- Slash commands for issuing contracts ----------------------------------
const sellerCmd = new SlashCommandBuilder()
  .setName("seller-agreement")
  .setDescription("Issue an Exclusive Listing (seller's) agreement here")
  .addUserOption((o) => o.setName("seller").setDescription("The seller").setRequired(true))
  .addStringOption((o) => o.setName("plot").setDescription("Plot number / /gps").setRequired(true))
  .addStringOption((o) => o.setName("price").setDescription("Listing price").setRequired(true))
  .addStringOption((o) => o.setName("description").setDescription("Property description").setRequired(false))
  .addStringOption((o) => o.setName("commission").setDescription("Commission (default 10%)").setRequired(false))
  .addIntegerOption((o) => o.setName("term_days").setDescription("Listing term in days (default 30)").setRequired(false));

const purchaseCmd = new SlashCommandBuilder()
  .setName("purchase-agreement")
  .setDescription("Issue a Purchase agreement here")
  .addUserOption((o) => o.setName("buyer").setDescription("The buyer").setRequired(true))
  .addUserOption((o) => o.setName("seller").setDescription("The seller").setRequired(true))
  .addStringOption((o) => o.setName("plot").setDescription("Plot number / /gps").setRequired(true))
  .addStringOption((o) => o.setName("price").setDescription("Purchase price").setRequired(true))
  .addStringOption((o) => o.setName("description").setDescription("Property description").setRequired(false))
  .addStringOption((o) => o.setName("payment_terms").setDescription("Payment terms").setRequired(false))
  .addStringOption((o) => o.setName("special").setDescription("Special requirements").setRequired(false))
  .addStringOption((o) => o.setName("commission").setDescription("Commission (default 10%)").setRequired(false));

const leaseCmd = new SlashCommandBuilder()
  .setName("lease-agreement")
  .setDescription("Issue a lease / rental agreement here")
  .addUserOption((o) => o.setName("landlord").setDescription("The landlord (property owner)").setRequired(true))
  .addUserOption((o) => o.setName("tenant").setDescription("The tenant (renter)").setRequired(true))
  .addStringOption((o) => o.setName("plot").setDescription("Plot number / /gps").setRequired(true))
  .addNumberOption((o) => o.setName("rent").setDescription("Weekly rent — number only (the /week is added automatically)").setRequired(true))
  .addStringOption((o) => o.setName("term").setDescription("Lease term (e.g. 4 weeks; default 4 weeks)").setRequired(false))
  .addStringOption((o) => o.setName("deposit").setDescription("Security deposit").setRequired(false))
  .addStringOption((o) => o.setName("description").setDescription("Property description").setRequired(false))
  .addStringOption((o) => o.setName("commission").setDescription("Commission (default 10%)").setRequired(false))
  .addStringOption((o) => o.setName("special").setDescription("Special requirements").setRequired(false));

const completeDealCmd = new SlashCommandBuilder()
  .setName("complete-deal")
  .setDescription("Confirm a plot transfer and release escrow + commission")
  .addIntegerOption((o) => o.setName("contract").setDescription("Contract # to complete").setRequired(true));

const listCmd = new SlashCommandBuilder()
  .setName("list")
  .setDescription("Post a plot listing to the category forum")
  .addStringOption((o) =>
    o.setName("category").setDescription("Listing category").setRequired(true)
      .addChoices(...config.listingCategories.map((c) => ({ name: c, value: c })))
  )
  .addStringOption((o) =>
    o.setName("type").setDescription("Sale or rent").setRequired(true)
      .addChoices({ name: "Sale", value: "Sale" }, { name: "Rent", value: "Rent" })
  )
  .addStringOption((o) => o.setName("plot").setDescription("Plot number / /gps").setRequired(true))
  .addStringOption((o) => o.setName("price").setDescription("Price (e.g. 50000, or 500/week)").setRequired(true))
  .addStringOption((o) => o.setName("title").setDescription("Short listing title").setRequired(true))
  .addStringOption((o) => o.setName("description").setDescription("Details, features, location").setRequired(false))
  .addAttachmentOption((o) => o.setName("image").setDescription("A picture of the plot").setRequired(false));

const contractorAdCmd = new SlashCommandBuilder()
  .setName("contractor-ad")
  .setDescription("Post your company advert to the contractors channel (approved contractors)")
  .addStringOption((o) => o.setName("company").setDescription("Your company name").setRequired(true))
  .addStringOption((o) => o.setName("services").setDescription("Services you offer").setRequired(true))
  .addStringOption((o) => o.setName("contact").setDescription("How to reach you (IGN / Discord)").setRequired(false))
  .addAttachmentOption((o) => o.setName("image").setDescription("A logo or showcase image").setRequired(false));

const panelCmd = new SlashCommandBuilder()
  .setName("panel")
  .setDescription("Open your realtor/manager control panel");

const helpCmd = new SlashCommandBuilder()
  .setName("help")
  .setDescription("How to use the Revolution Realty bot");

const SLASH_COMMANDS = [
  sellerCmd.toJSON(),
  purchaseCmd.toJSON(),
  leaseCmd.toJSON(),
  completeDealCmd.toJSON(),
  listCmd.toJSON(),
  contractorAdCmd.toJSON(),
  panelCmd.toJSON(),
  helpCmd.toJSON(),
];

async function registerCommands(guild) {
  await guild.commands.set(SLASH_COMMANDS).catch((e) =>
    console.warn(`slash register failed for ${guild.name}:`, e.message)
  );
}

client.once(Events.ClientReady, async (c) => {
  console.log(`🏠 ${config.brandName} online — logged in as ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) {
    await ensureGuildSetup(guild, c).catch((e) => console.error("setup:", e));
    await registerCommands(guild);
  }
  // Weekly recurring rent reminders (checked every 30 min).
  checkRecurringRent().catch(() => {});
  setInterval(() => checkRecurringRent().catch(() => {}), 30 * 60 * 1000);
});

client.on(Events.GuildCreate, async (guild) => {
  await ensureGuildSetup(guild, client).catch((e) => console.error("setup:", e));
  await registerCommands(guild);
});

// ===========================================================================
// Buttons
// ===========================================================================
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) {
      if (i.commandName === "seller-agreement") await issueContract(i, "seller");
      else if (i.commandName === "purchase-agreement") await issueContract(i, "purchase");
      else if (i.commandName === "lease-agreement") await issueContract(i, "lease");
      else if (i.commandName === "complete-deal") await completeDeal(i);
      else if (i.commandName === "list") await handleList(i);
      else if (i.commandName === "contractor-ad") await handleContractorAd(i);
      else if (i.commandName === "panel") await handlePanel(i);
      else if (i.commandName === "help") {
        await i.reply({
          embeds: [helpEmbed(isStaff(i.member, i.guild.id), verifyEnabled())],
          ephemeral: true,
        });
      }
      return;
    }
    if (i.isButton()) {
      if (i.customId === "ticket_buy") await openTicket(i, "buy");
      else if (i.customId === "ticket_sell") await openTicket(i, "sell");
      else if (i.customId === "ticket_rent") await openTicket(i, "rent");
      else if (i.customId === "ticket_contractor") await openTicket(i, "contractor");
      else if (i.customId === "find_contractors") await findContractors(i);
      else if (i.customId === "ticket_close") await closeTicketInteraction(i);
      else if (i.customId === "contractor_approve") await reviewContractor(i, true);
      else if (i.customId === "contractor_deny") await reviewContractor(i, false);
      else if (i.customId === "panel_contracts") await panelContracts(i);
      else if (i.customId === "panel_postdesk") await panelPostDesk(i);
      else if (i.customId.startsWith("contract_sign_")) await signContract(i);
      else if (i.customId.startsWith("contract_void_")) await voidContract(i);
      else if (i.customId.startsWith("pay_cmd_")) await handlePayCmd(i);
      else if (i.customId.startsWith("pay_check_")) await handlePayCheck(i);
      else if (i.customId === "verify_start") await startVerification(i);
      else if (i.customId === "verify_check") await checkVerification(i);
    }
  } catch (err) {
    console.error("interaction error:", err);
    // Never leave an interaction hanging on "thinking…" — surface the error.
    const note = `⚠️ Something went wrong: \`${err.message}\``;
    try {
      if (i.deferred || i.replied) await i.editReply(note);
      else if (i.isRepliable?.()) await i.reply({ content: note, ephemeral: true });
    } catch {}
  }
});

// ===========================================================================
// Contracts
// ===========================================================================
const displayName = (member, user) => member?.displayName ?? user.username;
// The IGN a user verified, or a clear fallback if they haven't linked one.
const linkedIgn = (discordId) =>
  store.getVerified(discordId)?.ign ?? "(unverified)";

async function issueContract(i, type) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({
      content: "Only realtors or managers can issue contracts.",
      ephemeral: true,
    });
  }

  const o = i.options;
  const c = config.contract;

  // Which client-side parties each contract type collects (realtor is added
  // automatically as the issuer).
  const partySpec =
    type === "seller"
      ? [{ key: "seller", label: "Seller", opt: "seller" }]
      : type === "lease"
      ? [
          { key: "landlord", label: "Landlord", opt: "landlord" },
          { key: "tenant", label: "Tenant", opt: "tenant" },
        ]
      : [
          { key: "buyer", label: "Buyer", opt: "buyer" },
          { key: "seller", label: "Seller", opt: "seller" },
        ];

  // Resolve + validate the chosen users.
  const chosen = partySpec.map((p) => ({ ...p, user: o.getUser(p.opt) }));
  const botParty = chosen.find((p) => p.user?.bot);
  if (botParty) {
    return i.reply({
      content: `You can't pick a bot (**${botParty.user.username}**) as the ${botParty.label.toLowerCase()} — choose the real player.`,
      ephemeral: true,
    });
  }
  const ids = chosen.map((p) => p.user.id);
  if (new Set(ids).size !== ids.length) {
    return i.reply({
      content: "The same person can't fill two of these roles.",
      ephemeral: true,
    });
  }

  // Acknowledge immediately so the interaction never times out.
  await i.deferReply();

  const realtorName = displayName(i.member, i.user);
  const date = todayISO();

  // Resolve display names for each chosen user.
  for (const p of chosen) {
    const m = await i.guild.members.fetch(p.user.id).catch(() => null);
    p.name = displayName(m, p.user);
  }
  const by = (key) => chosen.find((p) => p.key === key);

  let fields;
  if (type === "seller") {
    const termDays = o.getInteger("term_days") ?? c.termDaysDefault;
    fields = {
      date,
      term_days: termDays,
      expiry_date: plusDaysISO(termDays),
      seller: by("seller").name,
      seller_ign: linkedIgn(by("seller").user.id),
      realtor: realtorName,
      realtor_ign: linkedIgn(i.user.id),
      plot: o.getString("plot"),
      plot_desc: o.getString("description") ?? "—",
      price: o.getString("price"),
      commission: o.getString("commission") ?? c.commissionDefault,
    };
  } else if (type === "lease") {
    fields = {
      date,
      term: o.getString("term") ?? c.leaseTermDefault,
      landlord: by("landlord").name,
      landlord_ign: linkedIgn(by("landlord").user.id),
      tenant: by("tenant").name,
      tenant_ign: linkedIgn(by("tenant").user.id),
      realtor: realtorName,
      realtor_ign: linkedIgn(i.user.id),
      plot: o.getString("plot"),
      plot_desc: o.getString("description") ?? "—",
      rent: o.getNumber("rent"), // weekly rent as a number
      deposit: o.getString("deposit") ?? c.depositDefault,
      commission: o.getString("commission") ?? c.commissionDefault,
      special: o.getString("special") ?? c.specialDefault,
    };
  } else {
    fields = {
      date,
      buyer: by("buyer").name,
      buyer_ign: linkedIgn(by("buyer").user.id),
      seller: by("seller").name,
      seller_ign: linkedIgn(by("seller").user.id),
      realtor: realtorName,
      realtor_ign: linkedIgn(i.user.id),
      plot: o.getString("plot"),
      plot_desc: o.getString("description") ?? "—",
      price: o.getString("price"),
      payment_terms: o.getString("payment_terms") ?? c.paymentTermsDefault,
      special: o.getString("special") ?? c.specialDefault,
      commission: o.getString("commission") ?? c.commissionDefault,
    };
  }

  const parties = [
    ...chosen.map((p) => ({
      key: p.key,
      label: p.label,
      user_id: p.user.id,
      name: p.name,
      signed_at: null,
    })),
    { key: "realtor", label: "Realtor", user_id: i.user.id, name: realtorName, signed_at: null },
  ];

  const contract = store.createContract({
    guild_id: i.guild.id,
    channel_id: i.channel.id,
    type,
    status: "pending",
    created_by: i.user.id,
    created_at: Date.now(),
    fields,
    parties,
  });

  const uniqueIds = [...new Set(parties.map((p) => p.user_id))];
  const pings = uniqueIds.map((id) => `<@${id}>`).join(" ");
  const message = await i.editReply({
    content: `${pings} — please review and **Sign** the agreement below.`,
    embeds: [contractEmbed(contract)],
    components: [contractButtons(contract)],
    allowedMentions: { users: uniqueIds },
  });
  contract.message_id = message.id;
  store.saveContract();
}

async function signContract(i) {
  const id = Number(i.customId.split("_")[2]);
  const contract = store.getContract(id);
  if (!contract || contract.status !== "pending") {
    return i.reply({ content: "This contract isn't open for signing.", ephemeral: true });
  }
  const myParties = contract.parties.filter((p) => p.user_id === i.user.id);
  if (!myParties.length) {
    return i.reply({ content: "You're not a party to this contract.", ephemeral: true });
  }
  const unsigned = myParties.filter((p) => !p.signed_at);
  if (!unsigned.length) {
    return i.reply({ content: "You've already signed this one.", ephemeral: true });
  }

  const now = Date.now();
  unsigned.forEach((p) => (p.signed_at = now)); // sign all roles this person holds
  if (allSigned(contract)) contract.status = "signed";
  store.saveContract();

  await i.update({
    embeds: [contractEmbed(contract)],
    components: [contractButtons(contract)],
  });

  if (contract.status === "signed") {
    const att = await pdfAttachment(contract);
    await i.channel
      .send({ content: `✅ Contract #${contract.id} is fully signed.`, files: [att] })
      .catch(() => {});
    const archiveId = gcfg(i.guild.id, "contractArchiveChannelId");
    if (archiveId) {
      const ch = await client.channels.fetch(archiveId).catch(() => null);
      const att2 = await pdfAttachment(contract);
      ch?.send?.({
        content: `📑 **Contract #${contract.id}** (${contract.type}) — signed, from <#${contract.channel_id}>`,
        files: [att2],
      }).catch(() => {});
    }

    // Set up the buyer/tenant payment panel(s).
    await setupPostSignPayments(contract, i.channel);
  }
}

// ===========================================================================
// Payment panels + recurring rent
// ===========================================================================
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function parseTermMs(term) {
  const m = String(term).match(/(\d+)\s*(day|week|month)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit === "day" ? 86400000 : unit === "week" ? WEEK_MS : 30 * 86400000;
  return n * ms;
}

async function setupPostSignPayments(contract, channel) {
  if (!dealEnabled()) return;

  if (contract.type === "purchase") {
    contract.payment_code = newMemoCode();
    store.saveContract();
    const buyer = contract.parties.find((p) => p.key === "buyer");
    const amount = money(parseAmount(contract.fields.price));
    await channel
      .send({
        content: `<@${buyer.user_id}>`,
        embeds: [paymentPanelEmbed(contract, { amount })],
        components: [paymentPanelButtons(contract)],
        allowedMentions: { users: [buyer.user_id] },
      })
      .catch(() => {});
  } else if (contract.type === "lease") {
    contract.rent_active = true;
    contract.rent_week = 1;
    contract.current_rent_code = newMemoCode();
    contract.next_rent_at = Date.now() + WEEK_MS;
    const dur = parseTermMs(contract.fields.term);
    if (dur) contract.lease_until = Date.now() + dur;
    store.saveContract();
    await postWeeklyRent(contract, channel);
  }
}

async function postWeeklyRent(contract, channel) {
  const tenant = contract.parties.find((p) => p.key === "tenant");
  await channel
    .send({
      content: `<@${tenant.user_id}>`,
      embeds: [
        paymentPanelEmbed(contract, {
          amount: money(contract.fields.rent),
          weekly: true,
          week: contract.rent_week,
        }),
      ],
      components: [paymentPanelButtons(contract)],
      allowedMentions: { users: [tenant.user_id] },
    })
    .catch(() => {});
}

// Who pays + the active memo/amount for a contract.
function payerInfo(c) {
  const payer =
    c.type === "lease"
      ? c.parties.find((p) => p.key === "tenant")
      : c.parties.find((p) => p.key === "buyer");
  const memo = c.type === "lease" ? c.current_rent_code : c.payment_code;
  const amount = c.type === "lease" ? Number(c.fields.rent) : parseAmount(c.fields.price);
  return { payer, memo, amount };
}

async function handlePayCmd(i) {
  const id = Number(i.customId.split("_")[2]);
  const c = store.getContract(id);
  if (!c) return i.reply({ content: "Contract not found.", ephemeral: true });
  const { payer, memo, amount } = payerInfo(c);
  if (i.user.id !== payer?.user_id && !isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "This payment is for the buyer/tenant.", ephemeral: true });
  }
  if (!memo) return i.reply({ content: "No payment is set up for this contract.", ephemeral: true });
  const payCmd = config.deal.payCommandTemplate
    .replace("{firm}", config.verify.firmName)
    .replace("{amount}", String(amount))
    .replace("{memo}", memo);
  return i.reply({
    content:
      `Run this in-game to pay:\n\`\`\`\n${payCmd}\n\`\`\`\nThe memo must be exactly \`${memo}\`. ` +
      "Then come back and click **Check payment**.",
    ephemeral: true,
  });
}

async function handlePayCheck(i) {
  const id = Number(i.customId.split("_")[2]);
  const c = store.getContract(id);
  if (!c) return i.reply({ content: "Contract not found.", ephemeral: true });
  const { payer, memo, amount } = payerInfo(c);
  if (i.user.id !== payer?.user_id && !isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "This is for the buyer/tenant.", ephemeral: true });
  }
  if (!dealEnabled() || !memo) {
    return i.reply({ content: "Payments aren't configured for this contract.", ephemeral: true });
  }
  await i.deferReply({ ephemeral: true });

  const pay = await findVerificationPayment(memo, amount);
  if (!pay.ok) return i.editReply(`Couldn't reach the economy API (\`${pay.error}\`). Try again shortly.`);
  if (!pay.found) {
    return i.editReply(
      `I haven't seen a payment of **${money(amount)}** with memo \`${memo}\` yet. Pay, wait a few seconds, then click again.`
    );
  }

  if (c.type === "lease") {
    c.last_rent_paid_week = c.rent_week;
    store.saveContract();
    await i.editReply(`✅ Rent received for **Week ${c.rent_week}** — thank you!`);
    await i.channel
      .send(`✅ <@${payer.user_id}> paid Week ${c.rent_week} rent (${money(amount)}).`)
      .catch(() => {});

    // Escrow: split this week's rent — landlord gets (rent - commission),
    // realtor gets their commission share, company keeps the rest.
    if (config.deal.rentEscrow && (c.last_paid_out_week || 0) < c.rent_week) {
      await releaseRent(c, amount, i.channel);
    }
  } else {
    c.payment_received = true;
    store.saveContract();
    const realtor = c.parties.find((p) => p.key === "realtor");
    await i.editReply(`✅ Payment of **${money(amount)}** received! A realtor will transfer the plot and finalize.`);
    await i.channel
      .send(
        `✅ <@${payer.user_id}>'s payment for plot **${c.fields.plot}** is confirmed. ` +
          `<@${realtor.user_id}> — transfer the plot, then run \`/complete-deal contract:${c.id}\`.`
      )
      .catch(() => {});
  }
}

// Split a verified weekly rent payment: pay landlord + realtor, company keeps rest.
async function releaseRent(c, rent, channel) {
  const commission = commissionAmount(rent, c.fields.commission);
  const landlordProceeds = Math.max(0, rent - commission);
  const realtorCut = commission * config.deal.realtorCommissionShare;
  const companyCut = commission - realtorCut;
  const week = c.rent_week;

  const r1 = await payToPlayer(
    c.fields.landlord_ign,
    landlordProceeds,
    `Rent Week ${week} — lease #${c.id}`
  );
  let r2 = { ok: true, skipped: true };
  if (realtorCut > 0) {
    r2 = await payToPlayer(
      c.fields.realtor_ign,
      realtorCut,
      `Rent commission Week ${week} — lease #${c.id}`
    );
  }
  if (r1.ok) {
    c.last_paid_out_week = week;
    store.saveContract();
  }

  const lines = [`💸 **Week ${week} rent split:**`];
  lines.push(
    r1.ok
      ? `• Landlord (${c.fields.landlord_ign}): ${money(landlordProceeds)} ✅`
      : `• Landlord (${c.fields.landlord_ign}): ${money(landlordProceeds)} ❌ \`${r1.error}\``
  );
  if (!r2.skipped) {
    lines.push(
      r2.ok
        ? `• Realtor (${c.fields.realtor_ign}): ${money(realtorCut)} ✅`
        : `• Realtor (${c.fields.realtor_ign}): ${money(realtorCut)} ❌ \`${r2.error}\``
    );
  }
  lines.push(`• Company keeps: ${money(companyCut)} (stays in firm account)`);
  await channel.send(lines.join("\n")).catch(() => {});
}

// Weekly recurring rent reminders.
async function checkRecurringRent() {
  const now = Date.now();
  for (const c of store.listContracts({})) {
    if (c.type !== "lease" || !c.rent_active) continue;
    if (c.lease_until && now > c.lease_until) {
      c.rent_active = false;
      store.saveContract();
      const ch = await client.channels.fetch(c.channel_id).catch(() => null);
      ch?.send?.(`🏁 Lease #${c.id} term has ended — weekly rent reminders stopped.`).catch(() => {});
      continue;
    }
    if (c.next_rent_at && now >= c.next_rent_at) {
      c.rent_week = (c.rent_week || 1) + 1;
      c.current_rent_code = newMemoCode();
      c.next_rent_at = now + WEEK_MS;
      store.saveContract();
      const ch = await client.channels.fetch(c.channel_id).catch(() => null);
      if (ch) await postWeeklyRent(c, ch);
      else {
        c.rent_active = false; // channel gone
        store.saveContract();
      }
    }
  }
}

async function voidContract(i) {
  const id = Number(i.customId.split("_")[2]);
  const contract = store.getContract(id);
  if (!contract || contract.status !== "pending") {
    return i.reply({ content: "This contract can't be voided.", ephemeral: true });
  }
  const isIssuer = contract.created_by === i.user.id;
  if (!isIssuer && !isStaff(i.member, i.guild.id)) {
    return i.reply({
      content: "Only the issuing realtor or a manager can void this.",
      ephemeral: true,
    });
  }
  contract.status = "void";
  store.saveContract();
  await i.update({
    embeds: [contractEmbed(contract)],
    components: [contractButtons(contract)],
  });
}

// ===========================================================================
// Escrow / autopay
// ===========================================================================
const parseAmount = (s) => Number(String(s ?? "").replace(/[^0-9.]/g, "")) || 0;
const money = (n) => `$${Number(n).toFixed(2)}`;

function commissionAmount(price, commissionStr) {
  const s = String(commissionStr ?? "").trim();
  if (s.endsWith("%")) return price * (parseAmount(s) / 100);
  return parseAmount(s);
}

async function completeDeal(i) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "Only realtors or managers can complete deals.", ephemeral: true });
  }
  const id = i.options.getInteger("contract");
  const c = store.getContract(id);
  if (!c || c.guild_id !== i.guild.id) {
    return i.reply({ content: `No contract #${id} on file.`, ephemeral: true });
  }
  if (c.type !== "purchase") {
    return i.reply({ content: "Only purchase agreements can be completed.", ephemeral: true });
  }
  if (c.status !== "signed") {
    return i.reply({ content: "That contract isn't fully signed yet.", ephemeral: true });
  }
  if (c.completed) {
    return i.reply({ content: `Deal #${id} is already completed.`, ephemeral: true });
  }
  if (!dealEnabled()) {
    return i.reply({ content: "Autopay isn't configured (`DC_API_TOKEN` / `VERIFY_ACCOUNT_ID`).", ephemeral: true });
  }
  if (!c.payment_code) {
    return i.reply({ content: "No payment code on this contract — was it issued before autopay was enabled?", ephemeral: true });
  }

  await i.deferReply();

  const price = parseAmount(c.fields.price);
  const commission = commissionAmount(price, c.fields.commission);
  const sellerProceeds = Math.max(0, price - commission);
  const realtorCut = commission * config.deal.realtorCommissionShare;
  const companyCut = commission - realtorCut;
  const sellerIgn = c.fields.seller_ign;
  const realtorIgn = c.fields.realtor_ign;

  // 1) Confirm the buyer's escrow payment landed (unless the seller was already
  //    paid on a prior partial run).
  if (!c.sellerPaid) {
    const pay = await findVerificationPayment(c.payment_code, price);
    if (!pay.ok) {
      return i.editReply(`Couldn't reach the economy API (\`${pay.error}\`). Try again shortly.`);
    }
    if (!pay.found) {
      return i.editReply(
        `I haven't seen the buyer's payment of ${money(price)} with memo \`${c.payment_code}\` yet. ` +
          "Once they've paid the firm, run this again."
      );
    }
  }

  const results = [];

  // 2) Pay the seller their proceeds (skip if already done).
  if (!c.sellerPaid) {
    const r = await payToPlayer(sellerIgn, sellerProceeds, `Plot sale proceeds — contract #${id}`);
    if (r.ok) {
      c.sellerPaid = true;
      store.saveContract();
    }
    results.push(["Seller proceeds", sellerIgn, sellerProceeds, r]);
    if (!r.ok) {
      return i.editReply(payoutSummary(id, price, results) + "\n⚠️ Seller payout failed — nothing else was paid. Fix and re-run.");
    }
  }

  // 3) Pay the realtor their commission share (skip if already done / zero).
  if (!c.realtorPaid && realtorCut > 0) {
    const r = await payToPlayer(realtorIgn, realtorCut, `Commission — contract #${id}`);
    if (r.ok) {
      c.realtorPaid = true;
      store.saveContract();
    }
    results.push(["Realtor commission", realtorIgn, realtorCut, r]);
  }

  // 4) Finalize.
  c.completed = c.sellerPaid && (c.realtorPaid || realtorCut <= 0);
  c.payouts = { price, commission, sellerProceeds, realtorCut, companyCut, at: Date.now() };
  store.saveContract();

  const tail =
    `\n• Company keeps: ${money(companyCut)} (stays in firm account)` +
    (c.completed ? `\n✅ **Deal #${id} complete.**` : "\n⚠️ Some payouts pending — re-run to retry.");
  return i.editReply(payoutSummary(id, price, results) + tail);
}

// ===========================================================================
// Listings
// ===========================================================================
async function handleList(i) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "Only realtors or managers can post listings.", ephemeral: true });
  }
  const forums = gcfg(i.guild.id, "listingForums");
  const category = i.options.getString("category");
  const forum = forums?.[category];
  if (!forum) {
    return i.reply({
      content: `No listing channel for **${category}** — run \`!resetup\` to create the listing forums.`,
      ephemeral: true,
    });
  }

  await i.deferReply({ ephemeral: true });

  const type = i.options.getString("type"); // "Sale" | "Rent"
  const att = i.options.getAttachment("image");

  // Re-upload the image so it stays on the post permanently.
  const files = [];
  let imageName = null;
  if (att) {
    try {
      const res = await fetch(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      imageName = (att.name || "listing.png").replace(/[^\w.\-]/g, "_");
      files.push(new AttachmentBuilder(buf, { name: imageName }));
    } catch {
      imageName = null;
    }
  }

  const listing = store.createListing({
    guild_id: i.guild.id,
    category,
    type,
    plot: i.options.getString("plot"),
    price: i.options.getString("price"),
    title: i.options.getString("title"),
    description: i.options.getString("description") ?? "—",
    image_name: imageName,
    realtor: displayName(i.member, i.user),
    realtor_id: i.user.id,
    status: "active",
    created_at: Date.now(),
  });

  const embed = listingEmbed(listing);

  let link;
  try {
    const ch = await client.channels.fetch(forum.channelId);
    if (forum.kind === "forum") {
      const tagId = forum.tags?.[type];
      const thread = await ch.threads.create({
        name: `${listing.title} — ${listing.price}`.slice(0, 95),
        message: { embeds: [embed], files },
        appliedTags: tagId ? [tagId] : [],
      });
      listing.thread_id = thread.id;
      link = `<#${thread.id}>`;
    } else {
      const msg = await ch.send({ embeds: [embed], files });
      listing.message_id = msg.id;
      listing.channel_id = ch.id;
      link = `${ch} (listing posted)`;
    }
    store.saveListings();
  } catch (err) {
    console.error("listing post failed:", err);
    return i.editReply(`Couldn't post the listing: \`${err.message}\``);
  }

  return i.editReply(`✅ Listing **#${listing.id}** posted to ${link}.`);
}

function payoutSummary(id, price, results) {
  const lines = [`**Deal #${id} — plot transfer confirmed.** Buyer paid ${money(price)}.`];
  for (const [label, ign, amt, r] of results) {
    lines.push(
      r.ok
        ? `• ${label} (${ign}): ${money(amt)} ✅${r.txnId ? ` (txn #${r.txnId})` : ""}`
        : `• ${label} (${ign}): ${money(amt)} ❌ \`${r.error}\`${r.message ? ` — ${r.message}` : ""}`
    );
  }
  return lines.join("\n");
}

async function openTicket(i, type) {
  const existing = store.getOpenTicketByUser(i.user.id);
  if (existing) {
    const stillThere = await i.guild.channels
      .fetch(existing.channel_id)
      .catch(() => null);
    if (stillThere) {
      return i.reply({
        content: `You already have an open ticket: <#${existing.channel_id}>`,
        ephemeral: true,
      });
    }
    store.closeTicket(existing.channel_id);
  }

  const guild = i.guild;
  const prefix =
    type === "buy"
      ? config.buyTicketPrefix
      : type === "sell"
      ? config.sellTicketPrefix
      : type === "rent"
      ? config.rentTicketPrefix
      : "contractor-";
  const safeName =
    `${prefix}${i.user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "")
      .slice(0, 90) || `${prefix}ticket`;

  const realtorRoleId = gcfg(guild.id, "realtorRoleId");
  const managerRoleId = gcfg(guild.id, "managerRoleId");
  const categoryId = gcfg(guild.id, "ticketCategoryId");
  // Contractor applications are handled by managers only (realtors stay out).
  const staffRoleIds =
    type === "contractor"
      ? [managerRoleId].filter(Boolean)
      : [realtorRoleId, managerRoleId].filter(Boolean);

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: i.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    ...staffRoleIds.map((id) => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    })),
  ];

  let channel;
  try {
    channel = await guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: categoryId || null,
      permissionOverwrites: overwrites,
    });
  } catch (err) {
    console.error("ticket create failed:", err);
    return i.reply({
      content:
        "Couldn't open a ticket. I need **Manage Channels** and **Manage Roles** permissions" +
        (categoryId ? ", plus access to the Tickets category" : "") +
        `.\n> Discord said: \`${err.message}\``,
      ephemeral: true,
    });
  }

  store.createTicket(channel.id, i.user.id, type, Date.now());

  // Contractor applications ping a manager and show a review (approve/deny) panel.
  const pingRoleId = type === "contractor" ? managerRoleId : realtorRoleId;
  const ping = `<@${i.user.id}>` + (pingRoleId ? ` <@&${pingRoleId}>` : "");
  await channel.send({
    content: ping,
    embeds: [type === "contractor" ? contractorWelcomeEmbed() : ticketWelcomeEmbed(type)],
    components:
      type === "contractor"
        ? [contractorReviewButtons(), closeButton()]
        : [closeButton()],
    allowedMentions: {
      users: [i.user.id],
      roles: pingRoleId ? [pingRoleId] : [],
    },
  });

  return i.reply({
    content: `✅ Your ticket is open: <#${channel.id}>`,
    ephemeral: true,
  });
}

async function closeTicketInteraction(i) {
  if (!store.isTicketChannel(i.channel.id)) {
    return i.reply({ content: "This isn't an open ticket.", ephemeral: true });
  }
  const ticket = store.getTicket(i.channel.id);
  const owner = ticket && ticket.user_id === i.user.id;
  if (!owner && !isStaff(i.member, i.guild.id)) {
    return i.reply({
      content: "Only the client or a realtor/manager can close this ticket.",
      ephemeral: true,
    });
  }
  store.closeTicket(i.channel.id);
  await i.reply({ content: "🔒 Closing this ticket in 5 seconds…" });
  setTimeout(() => i.channel.delete().catch(() => {}), 5000);
}

// ===========================================================================
// Contractors
// ===========================================================================
async function findContractors(i) {
  const ch = gcfg(i.guild.id, "contractorsChannelId");
  return i.reply({
    content: ch
      ? `🔍 Browse our verified contractors here: <#${ch}>`
      : "No contractors channel is set up yet.",
    ephemeral: true,
  });
}

// ===========================================================================
// Staff control panel (/panel)
// ===========================================================================
async function handlePanel(i) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "This panel is for realtors and managers.", ephemeral: true });
  }
  const manager = isManager(i.member, i.guild.id);
  return i.reply({
    embeds: [staffPanelEmbed(manager)],
    components: [staffPanelButtons(manager)],
    ephemeral: true,
  });
}

async function panelContracts(i) {
  if (!isStaff(i.member, i.guild.id)) {
    return i.reply({ content: "Staff only.", ephemeral: true });
  }
  const all = store
    .listContracts({ guild_id: i.guild.id })
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 10);
  if (!all.length) return i.reply({ content: "No contracts on file yet.", ephemeral: true });
  const icon = (s) => (s === "signed" ? "✅" : s === "void" ? "🚫" : "🖊️");
  const lines = all.map(
    (c) => `${icon(c.status)} **#${c.id}** ${c.type} — ${c.parties.map((p) => p.name).join(", ")} — plot ${c.fields.plot}`
  );
  return i.reply({
    content: "**Recent contracts:**\n" + lines.join("\n").slice(0, 1800) + "\n\nUse `!contract <id>` to re-pull a PDF.",
    ephemeral: true,
  });
}

async function panelPostDesk(i) {
  if (!isManager(i.member, i.guild.id)) {
    return i.reply({ content: "Only a manager can post the client panel.", ephemeral: true });
  }
  await i.channel.send({ embeds: [panelEmbed()], components: [panelButtons()] }).catch(() => {});
  return i.reply({ content: "✅ Posted the client panel here.", ephemeral: true });
}

async function reviewContractor(i, approve) {
  if (!isManager(i.member, i.guild.id)) {
    return i.reply({ content: "Only a manager can review contractor applications.", ephemeral: true });
  }
  const ticket = store.getTicket(i.channel.id);
  if (!ticket || ticket.type !== "contractor") {
    return i.reply({ content: "This isn't a contractor application.", ephemeral: true });
  }
  const applicantId = ticket.user_id;

  if (approve) {
    const roleId = gcfg(i.guild.id, "contractorRoleId");
    const member = await i.guild.members.fetch(applicantId).catch(() => null);
    if (roleId && member) await member.roles.add(roleId).catch(() => {});
    await i.update({ components: [closeButton()] });
    const adChannel = gcfg(i.guild.id, "contractorsChannelId");
    await i.channel
      .send(
        `✅ <@${applicantId}> has been **approved** as a contractor! ` +
          `You can now advertise your company with \`/contractor-ad\`${adChannel ? ` in <#${adChannel}>` : ""}.`
      )
      .catch(() => {});
  } else {
    await i.update({ components: [closeButton()] });
    await i.channel
      .send(`❌ <@${applicantId}>'s contractor application was **denied**. Reach out if you'd like to reapply with more detail.`)
      .catch(() => {});
  }
}

async function handleContractorAd(i) {
  const roleId = gcfg(i.guild.id, "contractorRoleId");
  const isContractor = roleId && i.member.roles.cache.has(roleId);
  if (!isContractor && !isManager(i.member, i.guild.id)) {
    return i.reply({
      content: "Only approved contractors can post adverts. Use **Become a Contractor** on the Client Desk to apply.",
      ephemeral: true,
    });
  }
  const chId = gcfg(i.guild.id, "contractorsChannelId");
  const ch = chId ? await client.channels.fetch(chId).catch(() => null) : null;
  if (!ch) return i.reply({ content: "No contractors channel is set up.", ephemeral: true });

  await i.deferReply({ ephemeral: true });

  const att = i.options.getAttachment("image");
  const files = [];
  let imageName = null;
  if (att) {
    try {
      const res = await fetch(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      imageName = (att.name || "ad.png").replace(/[^\w.\-]/g, "_");
      files.push(new AttachmentBuilder(buf, { name: imageName }));
    } catch {
      imageName = null;
    }
  }

  const embed = contractorAdEmbed({
    company: i.options.getString("company"),
    services: i.options.getString("services"),
    contact: i.options.getString("contact"),
    image_name: imageName,
    by: displayName(i.member, i.user),
  });
  await ch.send({ embeds: [embed], files }).catch(() => {});
  return i.editReply(`✅ Your advert is posted in <#${ch.id}>.`);
}

// ===========================================================================
// IGN verification
// ===========================================================================
async function startVerification(i) {
  const already = store.getVerified(i.user.id);
  if (already) {
    return i.reply({
      content: `You're already verified as **${already.ign ?? "your account"}**. You can open a ticket in <#${gcfg(i.guild.id, "deskChannelId")}>.`,
      ephemeral: true,
    });
  }
  const code = newMemoCode();
  store.setPendingVerify(i.user.id, code, config.verify.amount);

  const payCmd = config.verify.payCommandTemplate
    .replace("{firm}", config.verify.firmName)
    .replace("{amount}", config.verify.amount)
    .replace("{memo}", code);

  return i.reply({
    content:
      `**Verify your account in 3 steps:**\n` +
      `1. In-game, send **${config.verify.amount}** with this exact memo:\n` +
      "```\n" + payCmd + "\n```" +
      `2. Make sure the memo is **exactly**: \`${code}\`\n` +
      `3. Come back and click **I've sent it** below.`,
    components: [verifyConfirmButton()],
    ephemeral: true,
  });
}

async function checkVerification(i) {
  const pending = store.getPendingVerify(i.user.id);
  if (!pending) {
    return i.reply({
      content: "Start verification first by clicking **Verify my IGN**.",
      ephemeral: true,
    });
  }
  await i.deferReply({ ephemeral: true });

  const result = await findVerificationPayment(
    pending.code,
    Number(config.verify.amount)
  );
  if (!result.ok) {
    return i.editReply(
      `Couldn't reach the economy API right now (\`${result.error}\`). Try again in a moment.`
    );
  }
  if (!result.found) {
    return i.editReply(
      "I haven't received your payment yet. Give it a few seconds after sending, then click **I've sent it** again. Double-check the memo matches exactly."
    );
  }

  const claimedBy = store.ignClaimedBy(result.uuid);
  if (claimedBy && claimedBy !== i.user.id) {
    return i.editReply(
      "That Minecraft account is already verified by another Discord user. Contact staff if this is a mistake."
    );
  }

  store.setVerified(i.user.id, {
    ign: result.ign,
    uuid: result.uuid,
    txn_id: result.txnId,
  });

  const roleId = gcfg(i.guild.id, "verifiedRoleId");
  if (roleId) await i.member.roles.add(roleId).catch(() => {});

  // Rename the member to their IGN (needs Manage Nicknames + the bot's role
  // above theirs; silently skipped for the owner / higher roles).
  if (config.verify.setNicknameToIgn && result.ign) {
    await i.member.setNickname(result.ign).catch(() => {});
  }

  const desk = gcfg(i.guild.id, "deskChannelId");
  return i.editReply(
    `✅ Verified as **${result.ign ?? "your account"}**! ` +
      (desk ? `You can now open a ticket in <#${desk}>.` : "You can now open a ticket.")
  );
}

// ===========================================================================
// Commands
// ===========================================================================
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot || !msg.guild) return;
    if (!msg.content.startsWith(config.prefix)) return;
    const [cmd, ...rest] = msg.content
      .slice(config.prefix.length)
      .trim()
      .split(/\s+/);
    const command = cmd.toLowerCase();

    if (command === "setup") return handleSetup(msg);
    if (command === "resetup") return handleResetup(msg);
    if (command === "close") return handleClose(msg);
    if (command === "help") return handleHelp(msg);
    if (command === "contracts") return handleContractList(msg, rest);
    if (command === "contract") return handleContractShow(msg, rest);
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

async function handleSetup(msg) {
  if (!msg.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return msg.reply("You need the **Manage Server** permission to run this.");
  }
  await msg.channel.send({ embeds: [panelEmbed()], components: [panelButtons()] });
  msg.delete().catch(() => {});
}

async function handleResetup(msg) {
  if (!msg.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return msg.reply("You need the **Manage Server** permission to run this.");
  }
  store.setGuildConfig(msg.guild.id, { configured: false });
  await msg.reply("🔧 Re-running setup…");
  await ensureGuildSetup(msg.guild, client);
  await msg.reply(
    "✅ Setup re-run. New roles/channels were created" +
      (verifyEnabled() ? " (including verification)." : ".") +
      " Old ones aren't deleted — remove any duplicates."
  );
}

async function handleClose(msg) {
  if (!store.isTicketChannel(msg.channel.id)) return;
  const ticket = store.getTicket(msg.channel.id);
  const owner = ticket && ticket.user_id === msg.author.id;
  if (!owner && !isStaff(msg.member, msg.guild.id)) {
    return msg.reply("Only the client or a realtor/manager can close this ticket.");
  }
  store.closeTicket(msg.channel.id);
  await msg.reply("🔒 Closing this ticket in 5 seconds…");
  setTimeout(() => msg.channel.delete().catch(() => {}), 5000);
}

// --- Contract archive / lookup (staff) -------------------------------------
const contractSearchText = (c) =>
  [c.type, c.status, c.fields.plot, c.fields.price, ...c.parties.map((p) => p.name)]
    .join(" ")
    .toLowerCase();

async function handleContractList(msg, rest) {
  if (!isStaff(msg.member, msg.guild.id)) {
    return msg.reply("Only realtors or managers can look up contracts.");
  }
  const all = store
    .listContracts({ guild_id: msg.guild.id })
    .sort((a, b) => b.created_at - a.created_at);
  if (!all.length) return msg.reply("No contracts on file yet.");

  const mention = msg.mentions.users.first();
  const arg = rest
    .filter((t) => !t.startsWith("<@"))
    .join(" ")
    .trim()
    .toLowerCase();

  let results = all;
  let label = "Recent contracts";
  if (mention) {
    results = all.filter((c) => c.parties.some((p) => p.user_id === mention.id));
    label = `Contracts involving ${mention.username}`;
  } else if (["pending", "signed", "void"].includes(arg)) {
    results = all.filter((c) => c.status === arg);
    label = `${arg[0].toUpperCase()}${arg.slice(1)} contracts`;
  } else if (arg) {
    results = all.filter((c) => contractSearchText(c).includes(arg));
    label = `Contracts matching "${arg}"`;
  }
  if (!results.length) return msg.reply("No matching contracts.");

  const icon = (s) => (s === "signed" ? "✅" : s === "void" ? "🚫" : "🖊️");
  const lines = results.slice(0, 15).map((c) => {
    const names = c.parties.map((p) => p.name).join(", ");
    return `${icon(c.status)} **#${c.id}** ${c.type} — ${names} — plot ${c.fields.plot} (${c.fields.price})`;
  });
  return msg.reply(
    `**${label}** (${results.length} found)\n` +
      lines.join("\n").slice(0, 1800) +
      `\n\nUse \`${config.prefix}contract <id>\` to re-pull a contract + PDF.`
  );
}

async function handleContractShow(msg, rest) {
  if (!isStaff(msg.member, msg.guild.id)) {
    return msg.reply("Only realtors or managers can look up contracts.");
  }
  const id = Number.parseInt(rest[0] ?? "", 10);
  if (Number.isNaN(id)) {
    return msg.reply(`Usage: \`${config.prefix}contract <id>\``);
  }
  const c = store.getContract(id);
  if (!c || c.guild_id !== msg.guild.id) {
    return msg.reply(`No contract #${id} on file.`);
  }
  const files = c.status === "signed" ? [await pdfAttachment(c)] : [];
  return msg.reply({ embeds: [contractEmbed(c)], files });
}

async function handleHelp(msg) {
  return msg.reply(
    [
      `**${config.brandName} — commands**`,
      `\`${config.prefix}setup\` — post the Buy/Sell panel (admin)`,
      `\`${config.prefix}close\` — close this ticket (client or staff)`,
      "",
      "**Realtors/managers — issue a contract (slash commands):**",
      "`/seller-agreement` — exclusive listing agreement (seller + realtor sign)",
      "`/purchase-agreement` — purchase agreement (buyer + seller + realtor sign)",
      "`/lease-agreement` — lease / rental agreement (landlord + tenant + realtor sign)",
      "Parties click **Sign**; once all have signed, a PDF record is posted and archived.",
      "`/complete-deal contract:<id>` — after the buyer pays the firm, confirm transfer and auto-release seller proceeds + commission",
      "`/list` — post a plot listing (category, sale/rent, plot, price, image) to the category forum",
      "",
      "**Look up past contracts:**",
      `\`${config.prefix}contracts\` — recent contracts (add \`@user\`, a status \`pending/signed/void\`, or a plot/name to filter)`,
      `\`${config.prefix}contract <id>\` — re-show a contract and re-pull its PDF`,
      "",
      "Clients open tickets with the buttons on the Client Desk panel.",
    ].join("\n")
  );
}

// Optional health endpoint for panel hosts.
const HEALTH_PORT = process.env.PORT || process.env.SERVER_PORT;
if (HEALTH_PORT) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    })
    .listen(HEALTH_PORT, () => console.log(`Health server on :${HEALTH_PORT}`));
}

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("❌ Discord login failed:", err);
  process.exit(1);
});
