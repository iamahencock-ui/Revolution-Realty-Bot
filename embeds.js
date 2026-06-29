// ---------------------------------------------------------------------------
// embeds.js — Revolution Realty embeds and the ticket-panel buttons.
// ---------------------------------------------------------------------------
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { config } from "./config.js";

// The public panel with Buy / Sell buttons.
export function panelEmbed() {
  return new EmbedBuilder()
    .setColor(config.brandColor)
    .setTitle(config.panelTitle)
    .setDescription(config.panelDescription);
}

export function panelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_buy")
      .setLabel("Buy a plot")
      .setEmoji("🏠")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ticket_sell")
      .setLabel("Sell a plot")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success)
  );
}

// The welcome message inside a freshly opened ticket.
export function ticketWelcomeEmbed(type) {
  const isBuy = type === "buy";
  return new EmbedBuilder()
    .setColor(config.brandColor)
    .setTitle(isBuy ? "🏠 Buying a plot" : "💰 Selling a plot")
    .setDescription(isBuy ? config.buyWelcome : config.sellWelcome)
    .setFooter({ text: `${config.brandName} • a realtor will assist you here` });
}

export function closeButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Close ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger)
  );
}

// --- Help -------------------------------------------------------------------
export function helpEmbed(isStaff, verifyOn) {
  const e = new EmbedBuilder()
    .setColor(config.brandColor)
    .setTitle(`${config.brandName} — Help`)
    .setDescription("Your one-stop shop for buying, selling, and renting plots.");

  const client = [
    "• Open a ticket from the **Client Desk** — **Buy a plot** or **Sell a plot** — and a realtor will assist you.",
    "• Browse current listings in the **Residential / Commercial / Skyscraper / Industrial** forums.",
  ];
  if (verifyOn) {
    client.push("• Verify your Minecraft account in the **verify** channel to unlock the Client Desk.");
  }
  e.addFields({ name: "🏠 For clients", value: client.join("\n") });

  if (isStaff) {
    e.addFields({
      name: "💼 For realtors & managers",
      value: [
        "`/seller-agreement` — issue an exclusive listing agreement",
        "`/purchase-agreement` — issue a purchase agreement",
        "`/complete-deal contract:<id>` — confirm transfer → release escrow + commission",
        "`/list` — post a plot listing to a category forum",
        "`!contracts` / `!contract <id>` — look up past contracts",
        "`!close` — close a ticket",
        "`!setup` / `!resetup` — (admin) post the panel / re-provision",
      ].join("\n"),
    });
  }
  return e;
}

// --- Listings ---------------------------------------------------------------
export function listingEmbed(listing) {
  const e = new EmbedBuilder()
    .setColor(listing.type === "Rent" ? 0x38a169 : config.brandColor)
    .setTitle(`${listing.type === "Rent" ? "🔑" : "🏷️"} ${listing.title}`)
    .addFields(
      { name: "Category", value: listing.category, inline: true },
      { name: "Type", value: `For ${listing.type}`, inline: true },
      { name: "Plot", value: listing.plot, inline: true },
      { name: "Price", value: listing.price, inline: true }
    )
    .setFooter({ text: `${config.brandName} • Listing #${listing.id} • posted by ${listing.realtor}` });
  if (listing.description && listing.description !== "—") {
    e.setDescription(listing.description);
  }
  if (listing.image_name) e.setImage(`attachment://${listing.image_name}`);
  return e;
}

// --- IGN verification panel -------------------------------------------------
export function verifyPanelEmbed() {
  return new EmbedBuilder()
    .setColor(config.brandColor)
    .setTitle(config.verify.panelTitle)
    .setDescription(config.verify.panelDescription);
}

export function verifyPanelButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verify_start")
      .setLabel("Verify my IGN")
      .setEmoji("🔐")
      .setStyle(ButtonStyle.Primary)
  );
}

// The "I've sent it" confirm button shown after instructions.
export function verifyConfirmButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verify_check")
      .setLabel("I've sent it")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
  );
}
