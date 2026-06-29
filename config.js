// ---------------------------------------------------------------------------
// config.js — tunable settings for the Revolution Realty bot.
// ---------------------------------------------------------------------------

export const config = {
  prefix: "!",
  brandName: "Revolution Realty",
  brandColor: 0x2b6cb0, // professional blue, used on embeds

  // --- Tickets --------------------------------------------------------------
  // Naming for the private deal channels (prefix + the customer's name).
  buyTicketPrefix: "buy-",
  sellTicketPrefix: "sell-",
  renameTicketOnName: true,

  // The panel posted by !setup (and auto-setup).
  panelTitle: "🏠 Revolution Realty — Client Desk",
  panelDescription:
    "Welcome to Revolution Realty. Open a private ticket below and one of our " +
    "realtors will assist you.\n\n" +
    "🏠 **Buy a plot** — find and purchase a property.\n" +
    "💰 **Sell a plot** — list your property with us.",

  // --- IGN verification -----------------------------------------------------
  // Users prove they own a Minecraft account by sending a tiny payment with a
  // unique memo to the firm's receiving account (VERIFY_ACCOUNT_ID), then
  // clicking confirm. Active only when DC_API_TOKEN + VERIFY_ACCOUNT_ID are set.
  verify: {
    amount: "0.01", // the micro-charge (decimal string)
    firmName: "RevolutionRealty", // firm that receives the payment
    // Shown to the user. {firm}/{amount}/{memo} are filled in. Adjust to match
    // however payments are sent to your account on DemocracyCraft.
    payCommandTemplate: "/pay-account business {firm} {amount} {memo}",
    panelTitle: "🔐 Verify your account",
    panelDescription:
      "Before you can open a ticket, please verify the Minecraft account you'll " +
      "be dealing under. Click **Verify my IGN** below to get started — it takes " +
      "a single one-cent payment.",
  },

  // --- Contracts ------------------------------------------------------------
  contract: {
    commissionDefault: "10%",
    termDaysDefault: 30,
    paymentTermsDefault: "Full payment on transfer of the plot.",
    specialDefault: "None.",
  },

  // Shown at the top of each new ticket.
  buyWelcome:
    "Thanks for reaching out! A realtor will be with you shortly. To help us " +
    "get started, let us know **what you're looking for** — area, budget, plot " +
    "size, and any must-haves.",
  sellWelcome:
    "Thanks for choosing Revolution Realty to sell your plot! A realtor will be " +
    "with you shortly. To get started, share the **plot number (/gps)**, your " +
    "asking price, and anything we should know about the property.",
};
