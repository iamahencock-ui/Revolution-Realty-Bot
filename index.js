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

const SLASH_COMMANDS = [sellerCmd.toJSON(), purchaseCmd.toJSON()];

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
      if (i.commandName === "seller-agreement") return issueContract(i, "seller");
      if (i.commandName === "purchase-agreement") return issueContract(i, "purchase");
      return;
    }
    if (i.isButton()) {
      if (i.customId === "ticket_buy") return openTicket(i, "buy");
      if (i.customId === "ticket_sell") return openTicket(i, "sell");
      if (i.customId === "ticket_close") return closeTicketInteraction(i);
      if (i.customId.startsWith("contract_sign_")) return signContract(i);
      if (i.customId.startsWith("contract_void_")) return voidContract(i);
      if (i.customId === "verify_start") return startVerification(i);
      if (i.customId === "verify_check") return checkVerification(i);
    }
  } catch (err) {
    console.error("interaction error:", err);
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
  const realtorName = displayName(i.member, i.user);
  const date = todayISO();

  let fields, parties;

  if (type === "seller") {
    const sellerUser = o.getUser("seller");
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
    const buyerUser = o.getUser("buyer");
    const sellerUser = o.getUser("seller");
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
  const message = await i.reply({
    content: `${pings} — please review and **Sign** the agreement below.`,
    embeds: [contractEmbed(contract)],
    components: [contractButtons(contract)],
    allowedMentions: { users: parties.map((p) => p.user_id) },
    fetchReply: true,
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
