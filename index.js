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

const helpCmd = new SlashCommandBuilder()
  .setName("help")
  .setDescription("How to use the Revolution Realty bot");

const SLASH_COMMANDS = [
  sellerCmd.toJSON(),
  purchaseCmd.toJSON(),
  completeDealCmd.toJSON(),
  listCmd.toJSON(),
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
      else if (i.commandName === "complete-deal") await completeDeal(i);
      else if (i.commandName === "list") await handleList(i);
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
      else if (i.customId === "ticket_close") await closeTicketInteraction(i);
      else if (i.customId.startsWith("contract_sign_")) await signContract(i);
      else if (i.customId.startsWith("contract_void_")) await voidContract(i);
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

  // Validate the chosen parties before anything else.
  const sellerUser = o.getUser("seller");
  const buyerUser = type === "purchase" ? o.getUser("buyer") : null;
  const botParty = [sellerUser, buyerUser].find((u) => u && u.bot);
  if (botParty) {
    return i.reply({
      content: `You can't pick a bot (**${botParty.username}**) as a party — choose the real player.`,
      ephemeral: true,
    });
  }
  if (buyerUser && buyerUser.id === sellerUser.id) {
    return i.reply({
      content: "Buyer and seller can't be the same person.",
      ephemeral: true,
    });
  }

  // Acknowledge immediately so the interaction never times out.
  await i.deferReply();

  const c = config.contract;
  const realtorName = displayName(i.member, i.user);
  const date = todayISO();

  let fields, parties;

  if (type === "seller") {
    const sellerMember = await i.guild.members.fetch(sellerUser.id).catch(() => null);
    const sellerName = displayName(sellerMember, sellerUser);
    const termDays = o.getInteger("term_days") ?? c.termDaysDefault;
    fields = {
      date,
      term_days: termDays,
      expiry_date: plusDaysISO(termDays),
      seller: sellerName,
      seller_ign: linkedIgn(sellerUser.id),
      realtor: realtorName,
      realtor_ign: linkedIgn(i.user.id),
      plot: o.getString("plot"),
      plot_desc: o.getString("description") ?? "—",
      price: o.getString("price"),
      commission: o.getString("commission") ?? c.commissionDefault,
    };
    parties = [
      { key: "seller", label: "Seller", user_id: sellerUser.id, name: sellerName, signed_at: null },
      { key: "realtor", label: "Realtor", user_id: i.user.id, name: realtorName, signed_at: null },
    ];
  } else {
    const buyerMember = await i.guild.members.fetch(buyerUser.id).catch(() => null);
    const sellerMember = await i.guild.members.fetch(sellerUser.id).catch(() => null);
    const buyerName = displayName(buyerMember, buyerUser);
    const sellerName = displayName(sellerMember, sellerUser);
    fields = {
      date,
      buyer: buyerName,
      buyer_ign: linkedIgn(buyerUser.id),
      seller: sellerName,
      seller_ign: linkedIgn(sellerUser.id),
      realtor: realtorName,
      realtor_ign: linkedIgn(i.user.id),
      plot: o.getString("plot"),
      plot_desc: o.getString("description") ?? "—",
      price: o.getString("price"),
      payment_terms: o.getString("payment_terms") ?? c.paymentTermsDefault,
      special: o.getString("special") ?? c.specialDefault,
      commission: o.getString("commission") ?? c.commissionDefault,
    };
    parties = [
      { key: "buyer", label: "Buyer", user_id: buyerUser.id, name: buyerName, signed_at: null },
      { key: "seller", label: "Seller", user_id: sellerUser.id, name: sellerName, signed_at: null },
      { key: "realtor", label: "Realtor", user_id: i.user.id, name: realtorName, signed_at: null },
    ];
  }

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

  const pings = parties.map((p) => `<@${p.user_id}>`).join(" ");
  const message = await i.editReply({
    content: `${pings} — please review and **Sign** the agreement below.`,
    embeds: [contractEmbed(contract)],
    components: [contractButtons(contract)],
    allowedMentions: { users: parties.map((p) => p.user_id) },
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
  const party = contract.parties.find((p) => p.user_id === i.user.id);
  if (!party) {
    return i.reply({ content: "You're not a party to this contract.", ephemeral: true });
  }
  if (party.signed_at) {
    return i.reply({ content: "You've already signed this one.", ephemeral: true });
  }

  party.signed_at = Date.now();
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

    // Purchase agreement + escrow on → tell the buyer how to pay the firm.
    if (contract.type === "purchase" && dealEnabled()) {
      const code = newMemoCode();
      contract.payment_code = code;
      store.saveContract();
      const buyer = contract.parties.find((p) => p.key === "buyer");
      const priceNum = parseAmount(contract.fields.price);
      const payCmd = config.deal.payCommandTemplate
        .replace("{firm}", config.verify.firmName)
        .replace("{amount}", String(priceNum))
        .replace("{memo}", code);
      await i.channel
        .send({
          content:
            `<@${buyer.user_id}> 💳 To complete the purchase, pay the firm the full price in-game:\n` +
            "```\n" + payCmd + "\n```" +
            `Memo must be exactly: \`${code}\`\n` +
            `Once paid, a realtor will run \`/complete-deal contract:${contract.id}\` to release funds.`,
          allowedMentions: { users: [buyer.user_id] },
        })
        .catch(() => {});
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
  const prefix = type === "buy" ? config.buyTicketPrefix : config.sellTicketPrefix;
  const safeName =
    `${prefix}${i.user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "")
      .slice(0, 90) || `${prefix}ticket`;

  const realtorRoleId = gcfg(guild.id, "realtorRoleId");
  const managerRoleId = gcfg(guild.id, "managerRoleId");
  const categoryId = gcfg(guild.id, "ticketCategoryId");

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
    ...[realtorRoleId, managerRoleId]
      .filter(Boolean)
      .map((id) => ({
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

  const ping = [i.user.id]
    .map((id) => `<@${id}>`)
    .concat(realtorRoleId ? [`<@&${realtorRoleId}>`] : [])
    .join(" ");
  await channel.send({
    content: ping,
    embeds: [ticketWelcomeEmbed(type)],
    components: [closeButton()],
    allowedMentions: {
      users: [i.user.id],
      roles: realtorRoleId ? [realtorRoleId] : [],
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
