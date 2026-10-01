/*
 * CardVault scoring engine.
 * Pure functions: card details + market / PSA / player data in,
 * seven ratings (each with its evidence) and a value estimate out.
 * Every number shown to the user is traceable to an evidence line here.
 */
(function (global) {
  'use strict';

  const DAY = 86400000;
  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
  const sortNum = (a) => [...a].sort((x, y) => x - y);
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  const median = (a) => quantile(sortNum(a), 0.5);

  const money = (v) => v == null ? '—' : '$' + (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
  const pct = (v) => `${Math.round(v * 100)}%`;
  const int = (v) => Math.round(v).toLocaleString('en-US');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function normalize(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  const SRC = {
    you: 'Card details you entered',
    manual: 'Sold prices you entered',
    ebay: 'eBay live listings',
    sold: 'eBay sold data',
    psa: 'PSA population report',
    wiki: 'Wikipedia',
    views: 'Wikipedia pageviews',
    wikidata: 'Wikidata awards',
    mlb: 'MLB Stats API',
    model: 'CardVault method',
  };

  // ------------------------------------------------------------ title parsing

  const JUNK = /\b(lots?|reprints?|rp|custom|digital|you pick|pick your|u pick|choose your|complete set|team set|facsimile|novelty|proxy|replica|aceo|random)\b/;
  const TEAM_COLORS = /\b(red sox|white sox|blue jays|green bay|red wings|red bulls|golden state|blackhawks|black hawks|blue jackets|red star|orange county)\b/g;
  const SEASON = /\b((?:19|20)\d{2})\s?[\/-]\s?(\d{2,4})\b/g;
  const PARALLEL = /(\/\s?\d{1,4}\b|\b1\s?of\s?1\b|fractor|prizm|\bwave\b|mojo|sapphire|\bgold\b|\borange\b|\bred\b|\bblack\b|\bgreen\b|\bpurple\b|\bblue\b|\bpink\b|\baqua\b|\bsepia\b|\bnegative\b|\bshimmer\b|\blava\b|\bspeckle\b|\braywave\b|\bparallel\b|\bvariation\b|\bssp\b|\bsp\b|\bfoil\b|\brainbow\b|\bvintage stock\b|\bclear\b|\bplatinum\b)/;
  const SERIAL_ANY = /\/\s?\d{1,4}\b/;
  const AUTO = /\b(auto|autos|autograph|autographed|signed|signature)\b/;
  const MEM = /\b(patch|relic|jersey|swatch|memorabilia|bat card|game[- ]used)\b/;
  const GRADED_WORD = /\b(graded|slab|slabbed)\b/;
  const GRADE_RE = /\b(psa|bgs|beckett|sgc|cgc|csg|tag|hga)\b[\s\-:#]*(?:(?:gem|mint|mt|nm-mt|nm|pristine|graded|black label)\s*)*(10|[1-9](?:\.5)?)(?:\.0)?(?![\d\/])/;

  function cleanTitle(t) {
    return normalize(t).replace(SEASON, '$1 $2').replace(TEAM_COLORS, ' ');
  }

  function parseGrade(t) {
    const m = t.match(GRADE_RE);
    if (!m) return null;
    let company = m[1].toUpperCase();
    if (company === 'BECKETT') company = 'BGS';
    if (company === 'CSG') company = 'CGC';
    return { company, grade: parseFloat(m[2]) };
  }

  function lastName(player) {
    const parts = normalize(player).replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean)
      .filter((p) => !/^(jr|sr|ii|iii|iv)$/.test(p));
    return parts[parts.length - 1] || '';
  }

  const PAR_STOP = new Set(['parallel', 'the', 'of', 'and', 'card', 'numbered', 'serial', 'to', 'edition']);
  function parseParallel(text) {
    let t = normalize(text);
    let serial = null;
    if (/\b1\s?(?:\/|of)\s?1\b|one of one|superfractor/.test(t)) serial = 1;
    const m = t.match(/(?:\d{1,4}\s?)?\/\s?(\d{1,4})\b/);
    if (serial == null && m) serial = parseInt(m[1], 10);
    t = t.replace(/\d{0,4}\s?\/\s?\d{1,4}/g, ' ').replace(/\b1\s?of\s?1\b/g, ' ');
    const words = t.split(/[^a-z0-9-]+/).filter((w) => w.length > 1 && !PAR_STOP.has(w) && !/^\d+$/.test(w));
    return { empty: !words.length && serial == null, words, serial };
  }

  function serialRe(n) {
    return n === 1 ? /(\b1\s?\/\s?1\b|\b1\s?of\s?1\b|one of one|superfractor)/ : new RegExp(`\\/\\s?${n}\\b`);
  }

  function makeClassifier(input, par) {
    const last = lastName(input.player);
    const year4 = (String(input.year || '').match(/\d{4}/) || [])[0];
    const num = normalize(input.number).replace(/^#/, '').trim();
    const numEsc = escapeRe(num);
    const strongNum = num ? new RegExp(`#\\s?${numEsc}(?![\\w])`) : null;
    const weakNum = num ? new RegExp(`(?:^|[\\s(])(?:no\\.?\\s?)?${numEsc}(?=[\\s),.]|$)`) : null;
    const allowWeak = num.length >= 3 || /[a-z]/.test(num);
    const wantsMem = MEM.test(normalize(input.parallel));
    const sRe = par.serial ? serialRe(par.serial) : null;

    return function classify(title) {
      const t = cleanTitle(title);
      const isAuto = AUTO.test(t);
      let parallelOk;
      if (par.empty) parallelOk = !PARALLEL.test(t);
      else parallelOk = par.words.every((w) => t.includes(w)) && (sRe ? sRe.test(t) : !SERIAL_ANY.test(t));
      const grade = parseGrade(t);
      return {
        junk: JUNK.test(t),
        nameOk: !last || t.includes(last),
        yearOk: !year4 || t.includes(year4),
        numberOk: !num || strongNum.test(t) || (allowWeak && weakNum.test(t)),
        autoOk: input.auto ? isAuto : !isAuto,
        memOk: wantsMem || !MEM.test(t),
        parallelOk,
        grade,
        graded: !!grade || GRADED_WORD.test(t),
        rookie: /\b(rc|rookie)\b/.test(t),
        firstBowman: /\b1st\b[^|]*bowman|bowman[^|]*\b1st\b/.test(t),
      };
    };
  }

  const MANUAL_CLS = { junk: false, nameOk: true, yearOk: true, numberOk: true, autoOk: true, memOk: true, parallelOk: true, grade: null, graded: false, rookie: false, firstBowman: false, manual: true };

  function tagItems(items, kind, classify) {
    return (items || []).map((it, i) => ({
      ...it,
      kind,
      id: it.manual ? `manual-${i}` : `${kind}-${i}`,
      cls: it.manual ? MANUAL_CLS : classify(it.title || ''),
    }));
  }

  function buildPool(items, input, excluded) {
    const base = items.filter((x) => {
      const c = x.cls;
      return !c.junk && c.nameOk && c.yearOk && c.autoOk && c.memOk && c.parallelOk;
    });
    let all = base, numberMatched = null;
    if (input.number) {
      const num = base.filter((x) => x.cls.numberOk);
      numberMatched = num.filter((x) => !x.cls.manual).length >= 3;
      if (numberMatched) all = num;
      else all = base;
    }
    return { all, active: all.filter((x) => !excluded.has(x.id)), numberMatched };
  }

  const isAuctionOnly = (x) => (x.buying || []).includes('AUCTION') && !(x.buying || []).includes('FIXED_PRICE');

  function removeOutliers(items) {
    if (items.length < 5) return { kept: items, outliers: new Set() };
    const logs = sortNum(items.map((x) => Math.log(x.price)));
    const q1 = quantile(logs, 0.25), q3 = quantile(logs, 0.75), iqr = q3 - q1;
    const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
    const outliers = new Set(items.filter((x) => Math.log(x.price) < lo || Math.log(x.price) > hi).map((x) => x.id));
    return { kept: items.filter((x) => !outliers.has(x.id)), outliers };
  }

  // ------------------------------------------------------------ PSA data

  function extractPop(raw) {
    if (!raw) return null;
    let found = null;
    (function walk(o) {
      if (!o || typeof o !== 'object' || found) return;
      const keys = Object.keys(o);
      if (keys.some((k) => /^grade\d/i.test(k))) { found = o; return; }
      keys.forEach((k) => walk(o[k]));
    })(raw);
    if (!found) return null;
    const grades = {};
    let sum = 0;
    for (const [k, v] of Object.entries(found)) {
      const m = k.match(/^grade(\d+)(?:_?(5))?$/i);
      if (!m || typeof v !== 'number') continue;
      let g = parseInt(m[1], 10) + (m[2] ? 0.5 : 0);
      if (g > 10) g = parseInt(m[1][0], 10) + 0.5;
      grades[g] = (grades[g] || 0) + v;
      sum += v;
    }
    const total = typeof found.Total === 'number' ? found.Total : sum;
    return total ? { total, grades } : null;
  }

  function extractPsa(psa) {
    if (!psa) return null;
    const cert = psa.cert ? (psa.cert.PSACert || psa.cert) : null;
    return { cert, pop: extractPop(psa.pop) };
  }

  // ------------------------------------------------------------ scoring helpers

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

  const ev = (text, source, url) => ({ text, source, url });
  // 50 views/day ≈ 32, 300 ≈ 52, 2,000 ≈ 73, 13,000 ≈ 93
  const viewScore = (avg) => clamp(25 * Math.log10(avg + 1) - 10);
  const avgViews = (wiki) => (wiki && wiki.views && wiki.views.length ? wiki.views.reduce((a, b) => a + b, 0) / wiki.views.length : null);

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

  // ------------------------------------------------------------ the seven ratings

  function scoreRarity(c) {
    const parts = [], e = [];
    if (c.par.serial) {
      parts.push({ score: clamp(100 - 16 * Math.log10(c.par.serial)), weight: 0.45 });
      e.push(ev(c.par.serial === 1 ? 'One-of-one: only a single copy of this parallel exists.'
        : `Serial-numbered /${c.par.serial}: only ${int(c.par.serial)} copies of this parallel were produced.`, SRC.you));
    }
    if (c.psa && c.psa.pop) {
      const { total, grades } = c.psa.pop;
      parts.push({ score: clamp(100 - 18 * Math.log10(total + 1)), weight: 0.35 });
      e.push(ev(`PSA has graded ${int(total)} copies of this card in total${grades[10] != null ? `; ${int(grades[10])} are PSA 10` : ''}.`, SRC.psa));
    }
    if (c.market.ebay && c.market.total != null) {
      parts.push({ score: clamp(95 - 20 * Math.log10(c.market.total + 1)), weight: 0.2 });
      e.push(ev(`${int(c.market.total)} live eBay listings match "${c.market.queries[0]}". More copies for sale means easier to find.`, SRC.ebay));
    }
    if (!c.par.serial && c.input.parallel) e.push(ev('This parallel is not serial-numbered, so its print run is not public.', SRC.you));
    if (!c.par.serial && !c.input.parallel) e.push(ev('Base card (no parallel). Topps does not publish base-card print runs.', SRC.you));
    const s = weighted(parts);
    const summary = c.par.serial ? `Limited to ${c.par.serial === 1 ? 'a single copy' : `${int(c.par.serial)} copies`}.`
      : s >= 65 ? 'Few copies surface on the market.' : s >= 45 ? 'Moderately available.' : 'Widely available.';
    return result('rarity', 'Rarity', parts, e,
      'Serial number (45%), PSA population (35%) and live market supply (20%), each on a log scale. Missing sources are skipped and the rest re-weighted.', summary);
  }

  function scoreCollector(c) {
    const e = [];
    let pts = 30;
    const add = (n, text, source) => { pts += n; e.push(ev(`+${n}: ${text}`, source)); };
    if (c.input.rookie) add(25, 'Rookie card (you marked it as RC).', SRC.you);
    else if (c.rookieShare >= 0.3) add(25, `Rookie card: ${pct(c.rookieShare)} of matching listings are titled RC/Rookie.`, SRC.ebay);
    if (c.firstBowmanShare >= 0.3) add(20, `1st Bowman: ${pct(c.firstBowmanShare)} of matching listings say "1st Bowman".`, SRC.ebay);
    if (c.input.auto) add(20, 'Autographed card.', SRC.you);
    if (c.par.serial) c.par.serial <= 99 ? add(15, `Low serial number (/${c.par.serial}).`, SRC.you) : add(8, `Serial-numbered (/${c.par.serial}).`, SRC.you);
    const year = parseInt((String(c.input.year).match(/\d{4}/) || [])[0], 10);
    if (year && year <= 1985) add(15, `Vintage issue (${year}).`, SRC.you);
    const g = c.input.condition;
    if ((g.company === 'PSA' && g.grade === 10) || (g.company === 'BGS' && g.grade >= 9.5) || (g.company === 'SGC' && g.grade === 10)) add(10, `Gem-mint grade (${g.company} ${g.grade}).`, SRC.you);
    const auctions = c.L.active.filter((x) => (x.buying || []).includes('AUCTION'));
    if (auctions.length >= 3) {
      const share = auctions.filter((x) => x.bids > 0).length / auctions.length;
      const n = Math.round(share * 15);
      if (n > 0) add(n, `${auctions.filter((x) => x.bids > 0).length} of ${auctions.length} live auctions already have bids.`, SRC.ebay);
    }
    if (e.length === 0) e.push(ev('No premium attributes (rookie, auto, numbered, vintage, gem grade) detected.', SRC.model));
    const score = clamp(pts);
    return result('collector', 'Collector Appeal', [{ score, weight: 1 }], e,
      'Starts at 30 points; adds points for the attributes collectors pay up for (rookie +25, 1st Bowman +20, auto +20, low serial +15, vintage +15, gem grade +10, active bidding up to +15).',
      score >= 65 ? 'Has the traits collectors chase.' : score >= 45 ? 'Some collector hooks.' : 'Mostly a player/base collector card.');
  }

  function scoreDemand(c) {
    const parts = [], e = [];
    if (c.soldQty90 != null && c.soldQty90 > 0) {
      parts.push({ score: clamp(30 * Math.log10(c.soldQty90 + 1)), weight: 0.5 });
      e.push(ev(`${int(c.soldQty90)} copies sold in the last 90 days.`, SRC.sold));
    }
    const auctions = c.L.active.filter((x) => (x.buying || []).includes('AUCTION'));
    if (auctions.length >= 3) {
      const withBids = auctions.filter((x) => x.bids > 0);
      const share = withBids.length / auctions.length;
      const avgBids = auctions.reduce((s, x) => s + (x.bids || 0), 0) / auctions.length;
      parts.push({ score: clamp(share * 70 + Math.min(avgBids, 15) * 2), weight: 0.4 });
      e.push(ev(`${withBids.length} of ${auctions.length} live auctions have bids (average ${avgBids.toFixed(1)} bids each).`, SRC.ebay));
    }
    const avg = avgViews(c.player && c.player.wiki);
    if (avg != null) {
      parts.push({ score: viewScore(avg), weight: 0.3 });
      e.push(ev(`${c.player.wiki.title}'s Wikipedia page averages ${int(avg)} views/day (last 60 days): a proxy for fan interest.`, SRC.views, c.player.wiki.url));
    }
    return result('demand', 'Demand', parts, e,
      'Sales volume (50%), live auction bidding (40%) and player attention on Wikipedia (30%), log-scaled and re-weighted for whatever data is available.',
      'Based on how actively this card trades and how much attention the player gets.');
  }

  const MLB_AWARD_POINTS = [
    [/^(AL|NL) MVP$/, 10, 'MVP'],
    [/Cy Young/, 10, 'Cy Young'],
    [/^(Jackie Robinson )?(AL|NL) Rookie of the Year$/, 6, 'Rookie of the Year'],
    [/^World Series MVP/, 5, 'World Series MVP'],
    [/World Series Champion/, 4, 'World Series title'],
    [/^(AL|NL) All-Star$/, 3, 'All-Star'],
    [/^(AL|NL) Silver Slugger/, 2, 'Silver Slugger'],
    [/Gold Glove/, 2, 'Gold Glove'],
    [/^All-MLB First Team/, 2, 'All-MLB First Team'],
    [/Hank Aaron Award/, 2, 'Hank Aaron Award'],
  ];

  function scorePlayer(c) {
    const parts = [], e = [];
    const p = c.player || {};
    const avg = avgViews(p.wiki);
    if (avg != null) {
      parts.push({ score: viewScore(avg), weight: 0.35 });
      e.push(ev(`${int(avg)} Wikipedia views/day on average over the last 60 days.`, SRC.views, p.wiki.url));
    }
    if (p.awards && p.awards.length) {
      // Wikidata usually lists each distinct award once (not every repeat win), so even a few is significant.
      const distinct = [...new Set(p.awards.map((a) => a.name))];
      const n = distinct.length;
      parts.push({ score: clamp(100 * (1 - Math.exp(-n / 5))), weight: 0.35 });
      e.push(ev(`${n} distinct award${n > 1 ? 's' : ''}/honours recorded on Wikidata, including ${distinct.slice(0, 5).join(', ')}.`, SRC.wikidata, p.wiki && p.wiki.wikidata ? `https://www.wikidata.org/wiki/${p.wiki.wikidata}` : undefined));
    } else if (p.wiki) {
      parts.push({ score: 0, weight: 0.2 });
      e.push(ev('No major awards recorded on Wikidata yet.', SRC.wikidata));
    }
    if (p.mlb && p.mlb.awards) {
      let pts = 0;
      const tally = {};
      const seen = new Set();
      for (const a of p.mlb.awards) {
        const key = `${a.name}|${a.season}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rule = MLB_AWARD_POINTS.find(([re]) => re.test(a.name || ''));
        if (rule) { pts += rule[1]; tally[rule[2]] = (tally[rule[2]] || 0) + 1; }
      }
      parts.push({ score: clamp(100 * (1 - Math.exp(-pts / 25))), weight: 0.3 });
      const list = Object.entries(tally).map(([k, v]) => `${v}× ${k}`).join(', ');
      e.push(ev(list ? `Major MLB honours: ${list}.` : 'No major MLB honours (MVP, All-Star, etc.) yet.', SRC.mlb));
      const hr = p.mlb.career && p.mlb.career.hitting && p.mlb.career.hitting.homeRuns;
      if (p.mlb.debut) e.push(ev(`MLB debut ${p.mlb.debut}${hr != null ? `; ${int(hr)} career home runs` : ''}${p.mlb.active === false ? '; retired' : ''}.`, SRC.mlb));
    }
    if (p.wiki && /hall of fame/i.test(p.wiki.extract || '')) {
      parts.push({ score: 100, weight: 0.15 });
      e.push(ev('Wikipedia notes a Hall of Fame connection in the player\'s summary.', SRC.wiki, p.wiki.url));
    }
    const s = weighted(parts);
    return result('player', 'Player Importance', parts, e,
      'Public attention (Wikipedia views, 35%), recorded career honours (Wikidata, 35%), MLB major awards for baseball (30%) and Hall of Fame status.',
      s >= 80 ? 'A marquee name in the sport.' : s >= 60 ? 'A well-established star.' : s >= 40 ? 'A recognised player.' : 'Limited track record so far.');
  }

  function scoreGrading(c) {
    const parts = [], e = [];
    const cond = c.input.condition;
    const pool = [...c.L.active, ...c.S.active].filter((x) => x.price > 0 && !x.cls.manual && !(x.kind === 'ask' && isAuctionOnly(x)));
    const psaGraded = pool.filter((x) => x.cls.grade && x.cls.grade.company === 'PSA');
    const priceOf = (f) => pool.filter(f).map((x) => x.price);

    if (cond.company === 'RAW') {
      const raw = priceOf((x) => !x.cls.graded);
      const psa10 = priceOf((x) => x.cls.grade && x.cls.grade.company === 'PSA' && x.cls.grade.grade === 10);
      const psa9 = priceOf((x) => x.cls.grade && x.cls.grade.company === 'PSA' && x.cls.grade.grade === 9);
      if (raw.length >= 2 && psa10.length >= 2) {
        const mRaw = median(raw), m10 = median(psa10);
        const premium = m10 / mRaw;
        parts.push({ score: clamp(25 * Math.log2(Math.max(premium, 1))), weight: 0.55 });
        e.push(ev(`Raw copies: median ${money(mRaw)} (${raw.length}). PSA 10: median ${money(m10)} (${psa10.length}). A PSA 10 is worth ${premium.toFixed(1)}× raw.`, c.market.salesAvailable ? SRC.sold : SRC.ebay));
        if (psa9.length >= 2) e.push(ev(`PSA 9 copies: median ${money(median(psa9))} (${psa9.length}).`, c.market.salesAvailable ? SRC.sold : SRC.ebay));
        if (mRaw < 25) e.push(ev('Raw value is low. Grading fees can exceed the gain unless the card reaches a 10.', SRC.model));
      }
      let gemRate = null;
      if (c.psa && c.psa.pop && c.psa.pop.grades[10] != null) {
        gemRate = c.psa.pop.grades[10] / c.psa.pop.total;
        e.push(ev(`PSA gem rate: ${pct(gemRate)} of all graded copies earned a 10.`, SRC.psa));
      } else if (psaGraded.length >= 5) {
        gemRate = psaGraded.filter((x) => x.cls.grade.grade === 10).length / psaGraded.length;
        e.push(ev(`${pct(gemRate)} of the ${psaGraded.length} PSA-graded copies on the market are 10s (sellers list 10s more often, so the true rate is likely lower).`, SRC.ebay));
      }
      if (gemRate != null) parts.push({ score: clamp(gemRate * 150), weight: 0.45 });
      const s = weighted(parts);
      return result('grading', 'Grading Potential', parts, e,
        'Price premium of a PSA 10 over a raw copy (55%, 2× = 25 pts, 4× = 50, 8× = 75, 16× = 100) and the chance of getting a 10 (45%).',
        s >= 65 ? 'Strong case for grading if your copy is clean.' : s >= 45 ? 'Grading can pay off for sharp copies.' : 'Grading is unlikely to add much value.');
    }

    // Already graded: where does this grade sit relative to all others?
    const label = `${cond.company} ${cond.grade}`;
    if (c.psa && c.psa.cert && c.psa.cert.TotalPopulation != null && cond.company === 'PSA') {
      const total = Number(c.psa.cert.TotalPopulation) || 0;
      const higher = Number(c.psa.cert.PopulationHigher) || 0;
      if (total > 0) {
        parts.push({ score: clamp(100 - (higher / (total + higher)) * 100), weight: 1 });
        e.push(ev(`PSA population at this grade: ${int(total)}; graded higher: ${int(higher)}.`, SRC.psa));
      }
    } else if (c.psa && c.psa.pop && cond.company === 'PSA') {
      const { total, grades } = c.psa.pop;
      const higher = Object.entries(grades).filter(([g]) => parseFloat(g) > cond.grade).reduce((s, [, n]) => s + n, 0);
      parts.push({ score: clamp(100 - (higher / total) * 100), weight: 1 });
      e.push(ev(`${int(higher)} of ${int(total)} PSA-graded copies (${pct(higher / total)}) grade higher than yours.`, SRC.psa));
    } else {
      const same = pool.filter((x) => x.cls.grade && x.cls.grade.company === cond.company);
      if (same.length >= 4) {
        const atOrBelow = same.filter((x) => x.cls.grade.grade <= cond.grade).length;
        parts.push({ score: clamp((atOrBelow / same.length) * 100), weight: 1 });
        e.push(ev(`Your ${label} is at or above ${atOrBelow} of the ${same.length} ${cond.company}-graded copies on the market.`, SRC.ebay));
      }
    }
    const topGrade = cond.grade === 10 && cond.company !== 'BGS';
    if (topGrade && !parts.length) {
      parts.push({ score: 100, weight: 1 });
      e.push(ev(`${label} is ${cond.company}'s highest grade; no copy can grade higher.`, SRC.you));
    } else if (topGrade || (cond.company === 'BGS' && cond.grade >= 9.5)) {
      e.push(ev(`${label} is a top-tier grade.`, SRC.you));
    }
    return result('grading', 'Grade Standing', parts, e,
      'For graded cards: the share of graded copies at or below your grade (from PSA population when available, otherwise graded copies on the market).',
      `Already graded ${label}.`);
  }

  function scoreLiquidity(c) {
    const parts = [], e = [];
    if (c.soldQty90 != null && c.soldQty90 > 0) {
      parts.push({ score: clamp(35 * Math.log10(c.soldQty90 + 1)), weight: 0.5 });
      e.push(ev(`${int(c.soldQty90)} sales in the last 90 days.`, SRC.sold));
    }
    if (c.market.ebay && c.market.total != null) {
      parts.push({ score: clamp(22 * Math.log10(c.market.total + 1)), weight: 0.3 });
      e.push(ev(`${int(c.market.total)} live eBay listings for this player/set: an active marketplace.`, SRC.ebay));
      const sellers = new Set(c.L.active.map((x) => x.seller).filter(Boolean));
      if (sellers.size) {
        parts.push({ score: clamp(sellers.size * 4), weight: 0.25 });
        e.push(ev(`${sellers.size} different sellers currently list this card.`, SRC.ebay));
      }
    }
    const comps = c.valuation.comps;
    if (comps.length >= 5) {
      const p = sortNum(comps.map((x) => x.price));
      const spread = (quantile(p, 0.75) - quantile(p, 0.25)) / quantile(p, 0.5);
      parts.push({ score: clamp(100 - spread * 100), weight: 0.2 });
      const src = comps.every((x) => x.manual) ? SRC.manual : c.valuation.method === 'sold' ? SRC.sold : SRC.ebay;
      e.push(ev(`Middle 50% of comparable prices spans ${money(quantile(p, 0.25))}–${money(quantile(p, 0.75))}. ${spread < 0.35 ? 'A tight range means clear price discovery.' : 'A wide range means buyers and sellers disagree on price.'}`, src));
    }
    const s = weighted(parts);
    return result('liquidity', 'Market Liquidity', parts, e,
      'Recent sales volume (50%), number of live listings (30%), number of distinct sellers (25%) and how tightly prices cluster (20%).',
      s >= 65 ? 'Easy to buy or sell quickly at a fair price.' : s >= 45 ? 'Sells, but may take some patience.' : 'Thin market: selling may take time.');
  }

  function scoreMomentum(c) {
    const parts = [], e = [];
    const now = Date.now();
    const dated = c.valuation.method === 'sold' ? c.valuation.comps.filter((x) => x.date) : [];
    const recent = dated.filter((x) => now - Date.parse(x.date) <= 30 * DAY).map((x) => x.price);
    const prior = dated.filter((x) => { const a = now - Date.parse(x.date); return a > 30 * DAY && a <= 90 * DAY; }).map((x) => x.price);
    if (recent.length >= 3 && prior.length >= 3) {
      const change = median(recent) / median(prior) - 1;
      parts.push({ score: clamp(50 + change * 100), weight: 0.6 });
      e.push(ev(`Median sale price last 30 days: ${money(median(recent))} vs ${money(median(prior))} in the 30–90 days before (${change >= 0 ? '+' : ''}${pct(change)}).`, c.manualOnly ? SRC.manual : SRC.sold));
    }
    const asks = c.valuation.askComps.filter((x) => x.created);
    const newAsks = asks.filter((x) => now - Date.parse(x.created) <= 14 * DAY).map((x) => x.price);
    const oldAsks = asks.filter((x) => now - Date.parse(x.created) > 14 * DAY).map((x) => x.price);
    if (newAsks.length >= 3 && oldAsks.length >= 3) {
      const change = median(newAsks) / median(oldAsks) - 1;
      parts.push({ score: clamp(50 + change * 80), weight: 0.2 });
      e.push(ev(`Listings from the last 14 days ask a median ${money(median(newAsks))} vs ${money(median(oldAsks))} for older listings (${change >= 0 ? '+' : ''}${pct(change)}). Older listings that have not sold are often overpriced, so this is a weaker signal.`, SRC.ebay));
    }
    const views = c.player && c.player.wiki && c.player.wiki.views;
    if (views && views.length >= 40) {
      const last30 = views.slice(-30).reduce((a, b) => a + b, 0);
      const prev = views.slice(0, -30);
      const prior30 = prev.reduce((a, b) => a + b, 0) * (30 / prev.length);
      if (prior30 > 0) {
        const ratio = last30 / prior30;
        parts.push({ score: clamp(50 + 50 * Math.log2(ratio)), weight: 0.25 });
        e.push(ev(`Player interest: ${int(last30)} Wikipedia views in the last 30 days vs ${int(prior30)} the 30 days before (${ratio >= 1 ? '+' : ''}${pct(ratio - 1)}).`, SRC.views, c.player.wiki.url));
      }
    }
    const trend = (s) => s == null ? 'Not enough data' : s >= 60 ? 'Rising' : s <= 40 ? 'Cooling' : 'Stable';
    const s = weighted(parts);
    return result('momentum', 'Recent Momentum', parts, e,
      'Change in median sale price (60%), new vs older asking prices (20%) and change in player attention (25%). 50 = flat; above 60 rising; below 40 cooling.',
      s >= 60 ? 'Prices and/or interest are trending up.' : s <= 40 ? 'Prices and/or interest are cooling off.' : 'Holding steady.', trend);
  }

  // ------------------------------------------------------------ valuation

  function valuate(c) {
    const out = { method: null, point: null, low: null, high: null, n: 0, confidence: null, notes: [], comps: [], askComps: c.askComps };
    const down = { High: 'Medium', Medium: 'Low', Low: 'Very low', 'Very low': 'Very low' };
    if (c.soldComps.length >= 3) {
      const p = sortNum(c.soldComps.map((x) => x.price));
      Object.assign(out, { method: 'sold', point: quantile(p, 0.5), low: quantile(p, 0.25), high: quantile(p, 0.75), n: p.length, comps: c.soldComps });
      out.confidence = p.length >= 10 ? 'High' : p.length >= 5 ? 'Medium' : 'Low';
      out.notes.push(`Median of ${p.length} recent sales; range is the middle 50% of those sales.`);
    } else if (c.askComps.length >= 3) {
      const p = sortNum(c.askComps.map((x) => x.price));
      Object.assign(out, { method: 'asking', point: quantile(p, 0.35), low: quantile(p, 0.2), high: quantile(p, 0.5), n: p.length, comps: c.askComps });
      out.confidence = p.length >= 15 ? 'Medium' : p.length >= 5 ? 'Low' : 'Very low';
      out.notes.push('Asking prices are what sellers want, not what buyers paid. Cards that sell are usually priced competitively, so the estimate uses the 20th–50th percentile of current asks.');
    } else if (c.soldComps.length || c.askComps.length) {
      const src = c.soldComps.length ? c.soldComps : c.askComps;
      const p = sortNum(src.map((x) => x.price));
      Object.assign(out, { method: c.soldComps.length ? 'sold' : 'asking', point: median(p), low: p[0], high: p[p.length - 1], n: p.length, comps: src, confidence: 'Very low' });
      out.notes.push(`Only ${p.length} comparable ${c.soldComps.length ? 'sale' : 'listing'}${p.length > 1 ? 's' : ''} found. Treat this as a rough indication.`);
    }
    if (out.confidence && c.numberMatched === false) {
      out.confidence = down[out.confidence];
      out.notes.push(`Not enough listings mention card #${c.input.number}, so comps may include other cards of this player from the same set.`);
    }
    return out;
  }

  // ------------------------------------------------------------ description

  function conditionLabel(cond) {
    return cond.company === 'RAW' ? 'raw (ungraded)' : `${cond.company} ${cond.grade}`;
  }

  function cardTitle(input) {
    return [input.year, input.set, input.player, input.number ? `#${String(input.number).replace(/^#/, '')}` : '', input.parallel, input.auto ? 'Auto' : '']
      .filter(Boolean).join(' ');
  }

  function describe(c, scores, val) {
    const s = [];
    const traits = [];
    if (c.input.rookie || c.rookieShare >= 0.3) traits.push('a rookie card');
    if (c.par.serial) traits.push(c.par.serial === 1 ? 'a one-of-one' : `serial-numbered to /${c.par.serial}`);
    if (c.input.auto) traits.push('autographed');
    s.push(`${cardTitle(c.input)}${traits.length ? ` is ${traits.join(', ')}` : ''}.`);
    const wiki = c.player && c.player.wiki;
    if (wiki && wiki.extract) {
      const first = wiki.extract.split(/(?<=[.!?])\s+/)[0];
      s.push(first.length > 260 ? first.slice(0, 257) + '…' : first);
    }
    if (val.point != null) {
      s.push(`In ${conditionLabel(c.input.condition)} condition, ${val.n} comparable ${val.method === 'sold' ? 'sales' : 'listings'} put it at about ${money(val.point)} (likely ${money(val.low)}–${money(val.high)}), with ${val.confidence.toLowerCase()} confidence.`);
    } else {
      s.push('There is not yet enough comparable market data to put a dollar figure on it.');
    }
    const rated = scores.filter((x) => x.score != null && x.key !== 'momentum').sort((a, b) => b.score - a.score);
    if (rated.length >= 3) {
      const weakest = rated[rated.length - 1];
      s.push(`Its strongest areas are ${rated[0].name.toLowerCase()} (${rated[0].score}) and ${rated[1].name.toLowerCase()} (${rated[1].score}); ${weakest.name.toLowerCase()} (${weakest.score}) is its weakest.`);
    }
    const mom = scores.find((x) => x.key === 'momentum');
    if (mom && mom.score != null) s.push(`Recent momentum: ${mom.label.toLowerCase()}.`);
    return s.join(' ');
  }

  // ------------------------------------------------------------ entry point

  function evaluate({ input, market, player, psa, excluded = new Set() }) {
    const par = parseParallel(input.parallel);
    const classify = makeClassifier(input, par);
    const listings = tagItems(market.listings, 'ask', classify);
    const sales = tagItems(market.sales, 'sold', classify);
    const L = buildPool(listings, input, excluded);
    const S = buildPool(sales, input, excluded);
    const numberMatched = input.number && (market.ebay ? (L.numberMatched || S.numberMatched) : null);

    const cond = input.condition;
    const condMatch = (x) => x.cls.manual || (cond.company === 'RAW' ? !x.cls.graded
      : !!(x.cls.grade && x.cls.grade.company === cond.company && x.cls.grade.grade === cond.grade));
    const notExcluded = (x) => !excluded.has(x.id);

    const askAll = L.all.filter((x) => condMatch(x) && x.price > 0 && !isAuctionOnly(x));
    const soldAll = S.all.filter((x) => condMatch(x) && x.price > 0);
    const askOut = removeOutliers(askAll.filter(notExcluded));
    const soldOut = removeOutliers(soldAll.filter(notExcluded));

    const everyone = [...L.active, ...S.active].filter((x) => !x.cls.manual);
    const share = (f) => (everyone.length ? everyone.filter(f).length / everyone.length : 0);
    const now = Date.now();
    const sold90 = S.active.filter((x) => condMatch(x) && (!x.date || now - Date.parse(x.date) <= 90 * DAY));

    const c = {
      input, par, market, player, psa: extractPsa(psa), L, S, numberMatched,
      askComps: askOut.kept, soldComps: soldOut.kept,
      rookieShare: share((x) => x.cls.rookie),
      firstBowmanShare: share((x) => x.cls.firstBowman),
      // Hand-entered prices are a sample, not a full sales count, so they never feed volume-based ratings.
      soldQty90: market.salesAvailable ? sold90.filter((x) => !x.manual).reduce((s, x) => s + (x.qty || 1), 0) : null,
      manualOnly: !market.salesAvailable,
    };
    c.valuation = valuate(c);

    const scores = [scoreRarity(c), scoreCollector(c), scoreDemand(c), scorePlayer(c), scoreGrading(c), scoreLiquidity(c), scoreMomentum(c)];
    const rated = scores.filter((x) => x.score != null);
    const overall = rated.length ? Math.round(rated.reduce((s, x) => s + x.score, 0) / rated.length) : null;

    const useSold = c.valuation.method === 'sold';
    const comps = (useSold ? soldAll : askAll).map((x) => ({
      ...x,
      status: excluded.has(x.id) ? 'excluded' : (useSold ? soldOut : askOut).outliers.has(x.id) ? 'outlier' : 'used',
    }));
    const imageFrom = [...c.valuation.comps, ...L.active, ...S.active].find((x) => x.image);

    return {
      title: cardTitle(input),
      image: imageFrom ? imageFrom.image : null,
      valuation: c.valuation,
      scores,
      overall,
      overallLabel: bandLabel(overall),
      description: describe(c, scores, c.valuation),
      comps,
      matched: { listings: L.all.length, sales: S.all.length, rawListings: market.listings.length, rawSales: market.sales.length },
      numberMatched,
      condition: conditionLabel(cond),
    };
  }

  function parseManualSales(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      let line = raw.trim();
      if (!line) continue;
      let date = null;
      const dm = line.match(/(\d{4}-\d{1,2}-\d{1,2})|(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (dm) {
        if (dm[1]) date = dm[1];
        else {
          const y = dm[4].length === 2 ? `20${dm[4]}` : dm[4];
          date = `${y}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
        }
        if (isNaN(Date.parse(date))) date = null;
        line = line.replace(dm[0], ' ');
      }
      const pm = line.match(/\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
      if (!pm) continue;
      const price = parseFloat(pm[1].replace(/,/g, ''));
      if (!(price > 0)) continue;
      const note = line.replace(pm[0], ' ').replace(/\s+/g, ' ').trim();
      out.push({ title: note ? `Your entry: ${note}` : 'Your entry', price, date, qty: 1, manual: true, currency: 'USD' });
    }
    return out;
  }

  global.Scoring = { evaluate, parseManualSales, money, parseGrade, parseParallel, cleanTitle };
})(window);
