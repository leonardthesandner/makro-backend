const express = require("express");
const router  = express.Router();
const Stripe  = require("stripe");

// lazy-init so missing key doesn't crash the whole server on import
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY nicht gesetzt");
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

const FLAVOR_NAMES = {
  blue:   "⚡ makro. blue — Coffein + Elektrolyte",
  orange: "+ makro. orange — 60g Carbs",
  purple: "~ makro. purple — 40g Carbs, koffeinfrei",
};

// Pack prices in euro-cents
const PACK_PRICES = { 10: 1500, 20: 2800, 50: 6500 };

// POST /api/shop/checkout
router.post("/checkout", async (req, res) => {
  try {
    const { flavor, pack } = req.body;

    if (!FLAVOR_NAMES[flavor]) {
      return res.status(400).json({ error: "Ungültige Sorte" });
    }
    const packInt = parseInt(pack, 10);
    if (!PACK_PRICES[packInt]) {
      return res.status(400).json({ error: "Ungültige Packgröße (10, 20 oder 50)" });
    }

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `${FLAVOR_NAMES[flavor]} — ${packInt}er Pack`,
              description: `${packInt} Energiegele à ${(PACK_PRICES[packInt] / packInt / 100).toFixed(2).replace(".", ",")} €`,
            },
            unit_amount: PACK_PRICES[packInt],
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "https://makro-tracking.com/success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:  "https://makro-tracking.com/",
      locale: "de",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Shop checkout error:", err);
    res.status(500).json({ error: err.message || "Checkout fehlgeschlagen" });
  }
});

module.exports = router;
