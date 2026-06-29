// ---------------------------------------------------------------------------
// setup.js — first-run provisioning. Creates the roles, ticket category, a
// public client-desk channel with the Buy/Sell panel, and a private contract
// archive, then saves their IDs to the guild config. No manual ID copying.
// ---------------------------------------------------------------------------
import { ChannelType, PermissionFlagsBits } from "discord.js";
import * as store from "./db.js";
import { config } from "./config.js";
import {
  panelEmbed,
  panelButtons,
  verifyPanelEmbed,
  verifyPanelButton,
} from "./embeds.js";
import { verifyEnabled } from "./verify.js";

const V = PermissionFlagsBits.ViewChannel;
const S = PermissionFlagsBits.SendMessages;
const R = PermissionFlagsBits.ReadMessageHistory;

export async function ensureGuildSetup(guild, client) {
  const existing = store.getGuildConfig(guild.id);
  if (existing.configured) return existing;

  console.log(`First-time setup for "${guild.name}" (${guild.id})…`);
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    console.warn("setup: couldn't resolve bot member; will retry.");
    return existing;
  }
  const canRoles = me.permissions.has(PermissionFlagsBits.ManageRoles);
  const canChannels = me.permissions.has(PermissionFlagsBits.ManageChannels);

  const cfg = {};

  const gated = verifyEnabled();

  if (canRoles) {
    cfg.managerRoleId = await mk(() =>
      guild.roles.create({
        name: "Manager",
        color: 0x2b6cb0,
        hoist: true,
        reason: "Revolution Realty setup",
      })
    );
    cfg.realtorRoleId = await mk(() =>
      guild.roles.create({
        name: "Realtor",
        color: 0x38a169,
        hoist: true,
        reason: "Revolution Realty setup",
      })
    );
    if (gated) {
      cfg.verifiedRoleId = await mk(() =>
        guild.roles.create({
          name: "Verified",
          color: 0x3182ce,
          reason: "Revolution Realty setup",
        })
      );
    }
  }

  if (canChannels) {
    cfg.ticketCategoryId = await mk(() =>
      guild.channels.create({ name: "Tickets", type: ChannelType.GuildCategory })
    );

    const staffView = [
      { id: guild.roles.everyone.id, deny: [V] },
      { id: client.user.id, allow: [V, S, R] },
      ...(cfg.managerRoleId ? [{ id: cfg.managerRoleId, allow: [V, S, R] }] : []),
      ...(cfg.realtorRoleId ? [{ id: cfg.realtorRoleId, allow: [V, S, R] }] : []),
    ];

    // Private archive for completed contract records.
    cfg.contractArchiveChannelId = await mk(() =>
      guild.channels.create({
        name: "contract-archive",
        type: ChannelType.GuildText,
        permissionOverwrites: staffView,
      })
    );

    // Verification channel (only when verification is enabled). Visible to all
    // so unverified users can verify; they only need to click a button.
    if (gated) {
      const verifyId = await mk(() =>
        guild.channels.create({
          name: "verify-here",
          type: ChannelType.GuildText,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              allow: [V, R],
              deny: [S], // read + click only
            },
            { id: client.user.id, allow: [V, S, R] },
          ],
        })
      );
      if (verifyId) {
        const ch = await guild.channels.fetch(verifyId).catch(() => null);
        if (ch)
          await ch
            .send({ embeds: [verifyPanelEmbed()], components: [verifyPanelButton()] })
            .catch(() => {});
        cfg.verifyChannelId = verifyId;
      }
    }

    // Client desk with the Buy/Sell panel. Locked to Verified + staff when
    // verification is enabled; public otherwise.
    const deskOverwrites = gated
      ? [
          { id: guild.roles.everyone.id, deny: [V] },
          { id: client.user.id, allow: [V, S, R] },
          ...(cfg.verifiedRoleId ? [{ id: cfg.verifiedRoleId, allow: [V, S, R] }] : []),
          ...(cfg.managerRoleId ? [{ id: cfg.managerRoleId, allow: [V, S, R] }] : []),
          ...(cfg.realtorRoleId ? [{ id: cfg.realtorRoleId, allow: [V, S, R] }] : []),
        ]
      : undefined;
    const deskId = await mk(() =>
      guild.channels.create({
        name: "client-desk",
        type: ChannelType.GuildText,
        ...(deskOverwrites ? { permissionOverwrites: deskOverwrites } : {}),
      })
    );
    if (deskId) {
      const ch = await guild.channels.fetch(deskId).catch(() => null);
      if (ch)
        await ch
          .send({ embeds: [panelEmbed()], components: [panelButtons()] })
          .catch(() => {});
      cfg.deskChannelId = deskId;
    }

    // Listings: a category with a forum channel per listing category.
    const listCatId = await mk(() =>
      guild.channels.create({ name: "Listings", type: ChannelType.GuildCategory })
    );
    cfg.listingsCategoryId = listCatId;
    cfg.listingForums = {};
    for (const cat of config.listingCategories) {
      let channelId = null;
      let kind = "forum";
      const tags = {};
      try {
        const f = await guild.channels.create({
          name: cat.toLowerCase(),
          type: ChannelType.GuildForum,
          parent: listCatId || null,
          topic: `${cat} plot listings — posted by Revolution Realty`,
          availableTags: config.listingTags.map((t) => ({ name: t })),
        });
        channelId = f.id;
        for (const t of f.availableTags) tags[t.name] = t.id;
      } catch (err) {
        // Forum channels may be unavailable; fall back to a text channel.
        console.warn(`setup: forum for ${cat} failed (${err.message}); using text.`);
        channelId = await mk(() =>
          guild.channels.create({
            name: cat.toLowerCase(),
            type: ChannelType.GuildText,
            parent: listCatId || null,
            topic: `${cat} plot listings`,
          })
        );
        kind = "text";
      }
      if (channelId) cfg.listingForums[cat] = { channelId, kind, tags };
    }
  }

  cfg.configured = true;
  cfg.setupAt = Date.now();
  store.setGuildConfig(guild.id, cfg);

  await notifyOwner(guild, cfg).catch(() => {});
  console.log(`Setup complete for "${guild.name}".`);
  return store.getGuildConfig(guild.id);
}

async function mk(fn) {
  try {
    const obj = await fn();
    return obj.id;
  } catch (err) {
    console.warn("setup: skipped a resource —", err.message);
    return null;
  }
}

async function notifyOwner(guild, cfg) {
  const owner = await guild.fetchOwner().catch(() => null);
  if (!owner) return;
  const line = (label, id, type) =>
    id
      ? `• ${label}: ${type === "ch" ? `<#${id}>` : `<@&${id}>`}`
      : `• ${label}: ⚠️ not created (missing permission)`;
  const { EmbedBuilder } = await import("discord.js");
  const embed = new EmbedBuilder()
    .setColor(config.brandColor)
    .setTitle(`✅ ${config.brandName} is set up in ${guild.name}`)
    .setDescription(
      [
        "Created the essentials:",
        line("Manager role", cfg.managerRoleId),
        line("Realtor role", cfg.realtorRoleId),
        ...(cfg.verifiedRoleId ? [line("Verified role", cfg.verifiedRoleId)] : []),
        line("Client desk (panel)", cfg.deskChannelId, "ch"),
        ...(cfg.verifyChannelId ? [line("Verify channel", cfg.verifyChannelId, "ch")] : []),
        line("Contract archive", cfg.contractArchiveChannelId, "ch"),
        `• Listing forums: ${
          Object.keys(cfg.listingForums || {}).length
            ? Object.values(cfg.listingForums)
                .map((f) => `<#${f.channelId}>`)
                .join(" ")
            : "⚠️ not created"
        }`,
        "",
        cfg.verifyChannelId
          ? "**Verification is ON** — clients must verify their IGN before the Client Desk unlocks."
          : "Verification is off (set `DC_API_TOKEN` + `VERIFY_ACCOUNT_ID`, then `!resetup`, to require IGN verification).",
        "**Next:** assign the Realtor/Manager roles to your staff. Run `!help` in a ticket for commands.",
      ].join("\n")
    );
  await owner.send({ embeds: [embed] });
}
