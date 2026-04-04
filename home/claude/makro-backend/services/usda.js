// USDA FoodData Central API
// Kostenlos, kein Ratenlimit für normale Nutzung
// API Key: https://fdc.nal.usda.gov/api-key-signup.html

const USDA_BASE = "https://api.nal.usda.gov/fdc/v1";
const API_KEY = process.env.USDA_API_KEY;

// USDA nutrient IDs
const NUTRIENTS = {
  kcal:    [1008, 2047, 2048], // 2047/2048 = Atwater-Varianten bei Branded Foods
  protein: [1003],
  carbs:   [1005],
  fat:     [1004],
};

function extractNutrient(foodNutrients, nutrientIds) {
  const ids = Array.isArray(nutrientIds) ? nutrientIds : [nutrientIds];
  for (const nutrientId of ids) {
    const n = foodNutrients.find(
      (fn) => fn.nutrientId === nutrientId || fn.nutrient?.id === nutrientId
    );
    if (n) return parseFloat(n.value || n.amount || 0);
  }
  return 0;
}

function formatFood(item) {
  const nutrients = item.foodNutrients || [];
  return {
    fdc_id:      item.fdcId,
    name:        item.description,
    kcal_100:    extractNutrient(nutrients, NUTRIENTS.kcal),
    protein_100: extractNutrient(nutrients, NUTRIENTS.protein),
    carbs_100:   extractNutrient(nutrients, NUTRIENTS.carbs),
    fat_100:     extractNutrient(nutrients, NUTRIENTS.fat),
    source:      "usda",
  };
}

async function searchUSDA(query, limit = 5) {
  const url = `${USDA_BASE}/foods/search?api_key=${API_KEY}&query=${encodeURIComponent(query)}&pageSize=${limit}&dataType=SR%20Legacy,Foundation,Branded`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USDA API error: ${res.status}`);
  const data = await res.json();
  return (data.foods || []).map(formatFood);
}

async function getFoodByFdcId(fdcId) {
  const url = `${USDA_BASE}/food/${fdcId}?api_key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USDA API error: ${res.status}`);
  const data = await res.json();
  return formatFood(data);
}

module.exports = { searchUSDA, getFoodByFdcId };
