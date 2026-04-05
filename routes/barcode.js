const express = require("express");
const router  = express.Router();
const { pool } = require("../db");

// POST /api/barcode  body: { barcode: "4001234567890" }
router.post("/", async (req, res) => {
  const { barcode } = req.body;
  if (!barcode) return res.status(400).json({ error: "Barcode erforderlich" });

  try {
    // 1. Check own DB first
    const cached = await pool.query(
      "SELECT * FROM foods WHERE barcode = $1",
      [barcode]
    );
    if (cached.rows.length > 0) {
      const f = cached.rows[0];
      console.log(`📦 Barcode ${barcode} aus DB: ${f.name_de}`);
      return res.json({
        found: true, source: "cache",
        name_de: f.name_de, name_en: f.name_en,
        kcal_100: f.kcal_100, protein_100: f.protein_100,
        carbs_100: f.carbs_100, fat_100: f.fat_100,
      });
    }

    // 2. Check Open Food Facts
    const offRes = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=product_name,product_name_de,product_name_en,nutriments`);
    const offData = await offRes.json();

    if (offData.status === 1 && offData.product) {
      const p = offData.product;
      const n = p.nutriments || {};

      const kcal_100    = parseFloat(n["energy-kcal_100g"] ?? n["energy-kcal"] ?? 0);
      const protein_100 = parseFloat(n["proteins_100g"]    ?? 0);
      const carbs_100   = parseFloat(n["carbohydrates_100g"] ?? 0);
      const fat_100     = parseFloat(n["fat_100g"]          ?? 0);

      if (kcal_100 > 0) {
        const name_de = (p.product_name_de || p.product_name || p.product_name_en || "Unbekannt").trim();
        const name_en = (p.product_name_en || p.product_name || name_de).trim();

        const r_kcal    = Math.round(kcal_100    * 10) / 10;
        const r_protein = Math.round(protein_100 * 10) / 10;
        const r_carbs   = Math.round(carbs_100   * 10) / 10;
        const r_fat     = Math.round(fat_100     * 10) / 10;

        // Cache in own DB
        await pool.query(
          `INSERT INTO foods (name_de, name_en, kcal_100, protein_100, carbs_100, fat_100, aliases, source, barcode)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'off', $8)
           ON CONFLICT DO NOTHING`,
          [name_de.toLowerCase(), name_en, r_kcal, r_protein, r_carbs, r_fat, [], barcode]
        );

        console.log(`📦 Barcode ${barcode} von Open Food Facts: ${name_de}`);
        return res.json({
          found: true, source: "off",
          name_de, name_en,
          kcal_100: r_kcal, protein_100: r_protein,
          carbs_100: r_carbs, fat_100: r_fat,
        });
      }
    }

    console.log(`📦 Barcode ${barcode} nicht gefunden`);
    res.json({ found: false });

  } catch (err) {
    console.error("Barcode error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
