/*
 * CardVault TCG scoring engine.
 * Separate from the sports engine: trading card games have no players or grading data
 * here, so a TCG card is rated on TCGplayer prices, sales volume, rarity and trend.
 * Pure functions: card + prices + daily history in, ratings (each with evidence) and a value out.
 */
(function (global) {
  'use strict';

  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
  const money = (v) => v == null ? '—' : '$' + (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
  const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const int = (v) => Math.round(v).toLocaleString('en-US');
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  const SRC = {
    market: 'TCGplayer market price',
    listings: 'TCGplayer listings',
    history: 'TCGplayer daily price history',
    card: 'TCGplayer card details',
    model: 'CardVault method',
  };
  const ev = (text, source, url) => ({ text, source, url });

  function weighted(parts) {
    const valid = parts.filter((p) => p.score != null && isFinite(p.score));
    if (!valid.length) return null;
    const w = valid.reduce((s, p) => s + p.weight, 0);
    return Math.round(clamp(valid.reduce((s, p) => s + p.score * p.weight, 0) / w));
  }

  function bandLabel(score) {
    if (score == null) return 'Not enough data';
    if (score >= 80) return 'Exceptional';
    if (score >= 65) return 'Strong';
    if (score >= 45) return 'Moderate';
    if (score >= 30) return 'Low';
    return 'Very low';
  }

  function result(key, name, parts, evidence, method, summary, labelOverride) {
    const score = weighted(parts);
    return {
      key, name, score,
      label: labelOverride ? labelOverride(score) : bandLabel(score),
      summary: score == null ? 'Not enough evidence available to rate this yet.' : summary,
      evidence,
      method,
    };
  }

  // Rarity names differ by game, so match on the words they share. First match wins.
  const RARITY_TIERS = [
    [/special illustration|hyper|secret|starlight|ghost|quarter century|prismatic|collector'?s|enchanted|iconic|serialized|manga|treasure|\bgold\b|1 of 1|alt(ernate)? art/, 92],
    [/illustration rare|ultra|mythic|super rare|legendary|radiant|amazing|ace spec|\bspecial\b/, 75],
    [/double rare|holo|shiny|leader|\bepic\b/, 58],
    [/\brare\b|promo/, 42],
    [/uncommon/, 22],
    [/common|token|\bland\b|basic/, 8],
  ];
  // Magic: The Gathering reports rarity as a single letter.
  const RARITY_LETTERS = { M: 75, S: 70, R: 42, P: 42, U: 22, C: 8, T: 5, L: 5 };

  function rarityScore(rarity) {
    if (!rarity) return null;
    const r = String(rarity).trim();
    if (RARITY_LETTERS[r.toUpperCase()] != null && r.length === 1) return RARITY_LETTERS[r.toUpperCase()];
    const low = r.toLowerCase();
    for (const [re, score] of RARITY_TIERS) if (re.test(low)) return score;
    return null;
  }

  // ------------------------------------------------------------ the five ratings

  function scoreValue(c) {
    const parts = [], e = [];
    if (c.point != null && c.point > 0) {
      // $1 ≈ 25, $10 ≈ 50, $100 ≈ 75, $1,000 ≈ 100
      parts.push({ score: clamp(25 + 25 * Math.log10(c.point)), weight: 1 });
      e.push(ev(`${c.printing} copies are valued at ${money(c.point)}.`, SRC.market, c.url));
    }
    const s = weighted(parts);
    return result('value', 'Value Tier', parts, e,
      'Logarithmic scale of the card\'s value: $1 ≈ 25, $10 ≈ 50, $100 ≈ 75, $1,000 and up ≈ 100.',
      s >= 75 ? 'A high-end card.' : s >= 50 ? 'A card with real value.' : s >= 30 ? 'A low-value card.' : 'Priced near bulk.');
  }

  function scoreRarity(c) {
    const parts = [], e = [];
    const r = rarityScore(c.card.rarity);
    if (r != null) {
      parts.push({ score: r, weight: 1 });
      e.push(ev(`Listed rarity: ${c.card.rarity}.`, SRC.card));
    } else if (c.card.rarity) {
      e.push(ev(`Listed rarity "${c.card.rarity}" isn't one CardVault can rank yet.`, SRC.card));
    }
    const s = weighted(parts);
    return result('rarity', 'Rarity', parts, e,
      'Rarity tiers shared across games: common 8, uncommon 22, rare 42, holo / double rare 58, ultra / mythic / illustration rare 75, secret / hyper / special illustration 92.',
      s >= 75 ? 'One of the hardest pulls in its set.' : s >= 50 ? 'Harder to pull than most cards.' : s >= 30 ? 'A standard rare.' : 'A common pull.');
  }

  function scoreLiquidity(c) {
    const parts = [], e = [];
    if (c.days > 0 && c.sales != null) {
      const weekly = (c.sales / c.days) * 7;
      parts.push({ score: clamp(40 * Math.log10(weekly + 1)), weight: 0.55 });
      e.push(ev(`${int(c.sales)} sold in the last ${c.days} day${c.days > 1 ? 's' : ''} (about ${int(weekly)} a week).`, SRC.history));
    }
    if (c.card.listings != null) {
      parts.push({ score: clamp(22 * Math.log10(c.card.listings + 1)), weight: 0.3 });
      e.push(ev(`${int(c.card.listings)} listings for sale right now (all printings).`, SRC.listings, c.url));
    }
    const p = c.price;
    if (num(p.low) && num(p.median)) {
      const ratio = p.low / p.median;
      parts.push({ score: clamp(ratio * 100), weight: 0.15 });
      e.push(ev(`Cheapest listing ${money(p.low)} vs median listing ${money(p.median)}. ${ratio > 0.7 ? 'Sellers agree on price.' : 'A wide gap: condition or seller pricing varies a lot.'}`, SRC.listings));
    }
    const s = weighted(parts);
    return result('liquidity', 'Market Liquidity', parts, e,
      'Sales per week (55%), number of listings for sale (30%) and how close the cheapest listing is to the median (15%).',
      s >= 65 ? 'Easy to buy or sell quickly at a fair price.' : s >= 45 ? 'Sells, but may take some patience.' : 'Thin market: selling may take time.');
  }

  function scoreMomentum(c) {
    const parts = [], e = [];
    const p = c.price;
    if (num(p.change30d) != null) {
      parts.push({ score: clamp(50 + p.change30d * 1.5), weight: 0.6 });
      e.push(ev(`Market price changed ${signed(p.change30d)} over 30 days.`, SRC.market));
    }
    if (num(p.change7d) != null) {
      parts.push({ score: clamp(50 + p.change7d * 3), weight: 0.4 });
      e.push(ev(`Market price changed ${signed(p.change7d)} over 7 days.`, SRC.market));
    }
    const trend = (s) => s == null ? 'Not enough data' : s >= 60 ? 'Rising' : s <= 40 ? 'Cooling' : 'Stable';
    const s = weighted(parts);
    return result('momentum', 'Price Momentum', parts, e,
      '50 means flat. 30-day price change (60%, each 1% moves the score 1.5 points) and 7-day change (40%, each 1% moves it 3 points).',
      s >= 60 ? 'Prices are climbing.' : s <= 40 ? 'Prices are cooling off.' : 'Prices are holding steady.', trend);
  }

  function scoreStability(c) {
    const parts = [], e = [];
    const daily = c.hist.map((h) => h.market).filter((v) => num(v) && v > 0);
    if (daily.length >= 3) {
      const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
      const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / daily.length);
      const cv = sd / mean;
      parts.push({ score: clamp(100 - cv * 400), weight: 0.5 });
      e.push(ev(`Daily market price ranged ${money(Math.min(...daily))}–${money(Math.max(...daily))} over ${daily.length} days (${(cv * 100).toFixed(1)}% variation).`, SRC.history));
    }
    const p = c.price;
    if (num(p.market) && num(p.median)) {
      const gap = Math.abs(p.median / p.market - 1);
      parts.push({ score: clamp(100 - gap * 150), weight: 0.5 });
      e.push(ev(`Median listing ${money(p.median)} vs market price ${money(p.market)} (${(gap * 100).toFixed(0)}% apart).`, SRC.listings));
    }
    const s = weighted(parts);
    return result('stability', 'Price Stability', parts, e,
      'Day-to-day variation of the market price (50%) and how far asking prices sit from the market price (50%).',
      s >= 65 ? 'The price is settled and predictable.' : s >= 45 ? 'Some price swings.' : 'The price swings a lot.');
  }

  // ------------------------------------------------------------ value

  function valuation(c) {
    const p = c.price;
    const point = num(p.market) || num(p.median) || num(p.low) || num(c.card.market);
    const method = num(p.market) ? 'market' : point != null ? 'listing' : null;
    const refs = [num(p.market), num(p.median), ...c.hist.map((h) => num(h.avgSale))].filter((v) => v && v > 0);
    const low = refs.length >= 2 ? Math.min(...refs) : null;
    const high = refs.length >= 2 ? Math.max(...refs) : null;
    const confidence = point == null ? null
      : c.sales >= 10 ? 'High' : c.sales >= 4 ? 'Medium' : c.sales >= 1 || method === 'market' ? 'Low' : 'Very low';
    const notes = ['Prices are for Near Mint, ungraded copies on TCGplayer. Graded copies sell for more.'];
    if (c.days && c.days < 14) notes.push(`Price history covers the last ${c.days} days (the TCG API free plan's limit).`);
    return { point, low: low != null && high > low ? low : null, high: low != null && high > low ? high : null, method, confidence, notes };
  }

  function evaluate({ card, prices, history, printing }) {
    const price = prices.find((p) => p.printing === printing) || prices[0] || {};
    const chosen = price.printing || printing || card.printing || 'Normal';
    const hist = history.filter((h) => h.printing === chosen).sort((a, b) => a.date.localeCompare(b.date));
    const volumes = hist.map((h) => h.volume).filter((v) => num(v) != null);
    const url = card.url || (card.tcgplayerId ? `https://www.tcgplayer.com/product/${card.tcgplayerId}` : null);
    const c = {
      card, price, hist, url,
      printing: chosen,
      days: hist.length,
      sales: volumes.length ? volumes.reduce((a, b) => a + b, 0) : null,
    };
    const v = valuation(c);
    c.point = v.point;

    const scores = [scoreValue(c), scoreRarity(c), scoreLiquidity(c), scoreMomentum(c), scoreStability(c)];
    const rated = scores.filter((s) => s.score != null);
    const overall = rated.length ? Math.round(rated.reduce((a, s) => a + s.score, 0) / rated.length) : null;

    const title = [card.name, card.number ? `#${card.number}` : ''].filter(Boolean).join(' ');
    const bits = [`${title}${card.set ? ` from ${card.set}` : ''}${card.rarity ? ` is a ${card.rarity} card` : ''}.`];
    if (v.point != null) bits.push(`${chosen} copies are worth about ${money(v.point)}${v.low != null ? ` (recent sales and listings ${money(v.low)}–${money(v.high)})` : ''}.`);
    if (c.sales != null && c.days) bits.push(`${int(c.sales)} sold in the last ${c.days} days.`);
    const strong = rated.filter((s) => s.score >= 65).map((s) => s.name.toLowerCase());
    if (strong.length) bits.push(`Strongest areas: ${strong.join(' and ')}.`);

    return {
      title, printing: chosen, url,
      printings: prices.map((p) => p.printing).filter(Boolean),
      valuation: v, scores, overall, overallLabel: bandLabel(overall),
      history: hist, sales: c.sales, days: c.days, price,
      description: bits.join(' '),
    };
  }

  global.TcgScoring = { evaluate, money };
})(window);
