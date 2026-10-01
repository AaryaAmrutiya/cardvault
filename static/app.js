(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const { money } = Scoring;

  const SETS = {
    baseball: ['Topps Series 1', 'Topps Series 2', 'Topps Update', 'Topps Chrome', 'Topps Chrome Update', 'Topps Heritage', 'Topps Stadium Club', 'Topps Finest', 'Topps Allen & Ginter', 'Topps Gypsy Queen', 'Topps Archives', 'Topps Tribute', 'Topps Dynasty', 'Topps Sterling', 'Topps Triple Threads', 'Topps Inception', 'Topps Now', 'Topps Traded', 'Topps Tiffany', 'Bowman', 'Bowman Chrome', 'Bowman Draft', 'Bowman Sterling', "Bowman's Best"],
    basketball: ['Topps Chrome', 'Topps Finest', 'Topps Cosmic Chrome', 'Topps Motif', 'Topps Now', 'Topps Stadium Club', 'Topps', 'Topps Chrome Sapphire', 'Bowman Chrome', 'Bowman University Chrome'],
    football: ['Topps', 'Topps Chrome', 'Topps Finest', 'Topps Heritage', 'Topps Stadium Club', 'Topps Now', 'Topps Traded', 'Bowman', 'Bowman Chrome', 'Bowman University Chrome'],
    soccer: ['Topps Chrome UEFA Club Competitions', 'Topps Finest UEFA Club Competitions', 'Topps Stadium Club Chrome UEFA', 'Topps Merlin Chrome UEFA', 'Topps UEFA Club Competitions', 'Topps Chrome Sapphire UEFA', 'Topps Inception UEFA', 'Topps Chrome MLS', 'Topps MLS', 'Topps Now', 'Topps Match Attax'],
  };
  const EXAMPLES = {
    baseball: { player: 'Mike Trout', year: '2011', set: 'Topps Update', number: 'US175' },
    basketball: { player: 'Kobe Bryant', year: '1996-97', set: 'Topps Chrome', number: '138' },
    football: { player: 'Tom Brady', year: '2000', set: 'Bowman Chrome', number: '236' },
    soccer: { player: 'Erling Haaland', year: '2020-21', set: 'Topps Chrome UEFA Champions League', number: '' },
  };
  const GRADES = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1];
  const PSA_GRADES = [10, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1];

  const state = { sport: 'baseball', status: null, ctx: null, excluded: new Set(), showAll: false };
  const form = $('#searchForm');

  // ------------------------------------------------------------ api

  async function api(path, params = {}) {
    const res = await fetch(`${path}?${new URLSearchParams(params)}`);
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ------------------------------------------------------------ status

  async function loadStatus() {
    try {
      state.status = await api('/api/status');
    } catch {
      state.status = { ebay: false, psa: false, players: false, offline: true };
    }
    renderStatus();
  }

  function pills() {
    const s = state.status || {};
    const psaState = !s.psa ? 'off' : s.psaApproved === false ? 'warn' : 'on';
    const ebayState = !s.ebay ? 'off' : s.insights === false ? 'warn' : 'on';
    return [
      [ebayState, 'eBay', !s.ebay ? 'eBay: not connected' : s.insights === false ? 'eBay: live listings (no sold data)' : 'eBay: connected'],
      [psaState, 'PSA', !s.psa ? 'PSA: no token' : s.psaApproved === false ? 'PSA: awaiting API approval' : 'PSA: connected'],
      [s.players ? 'on' : 'off', 'Player data', s.players ? 'Player data: connected' : 'Server offline'],
    ];
  }

  function renderStatus() {
    const html = pills().map(([cls, short, long]) => `<span class="pill ${cls}" title="${esc(long)}"><i></i>${esc(short)}</span>`).join('');
    $('#status').innerHTML = html;
    $('#setupStatus').innerHTML = pills().map(([cls, , long]) => `<span class="pill ${cls}"><i></i>${esc(long)}</span>`).join('');
    const s = state.status || {};
    $('#formHint').textContent = s.offline ? 'Server not running. Start it with start.bat.'
      : !s.ebay ? 'eBay not connected yet: add sold prices under "More evidence" to get a value estimate.' : '';
  }

  // ------------------------------------------------------------ form

  function setSport(sport) {
    state.sport = sport;
    $$('.sports button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.sport === sport)));
    $('#setList').innerHTML = SETS[sport].map((s) => `<option value="${esc(s)}">`).join('');
    const ex = EXAMPLES[sport];
    form.player.placeholder = ex.player;
    form.year.placeholder = ex.year;
    form.set.placeholder = ex.set;
    form.number.placeholder = ex.number || 'e.g. 12';
  }

  function updateGrades() {
    const company = form.company.value;
    $('#gradeField').hidden = company === 'RAW';
    const list = company === 'PSA' ? PSA_GRADES : GRADES;
    const prev = parseFloat(form.grade.value);
    form.grade.innerHTML = list.map((g) => `<option value="${g}">${g}</option>`).join('');
    if (list.includes(prev)) form.grade.value = String(prev);
  }

  function readInput() {
    const company = form.company.value;
    return {
      sport: state.sport,
      player: form.player.value.trim(),
      year: form.year.value.trim(),
      set: form.set.value.trim(),
      number: form.number.value.trim().replace(/^#/, ''),
      parallel: form.parallel.value.trim(),
      rookie: form.rookie.checked,
      auto: form.auto.checked,
      condition: { company, grade: company === 'RAW' ? null : parseFloat(form.grade.value) },
      cert: form.cert.value.replace(/\D/g, ''),
      manual: form.manual.value,
    };
  }

  function buildQueries(input) {
    let set = input.set;
    if (set && !/topps|bowman/i.test(set)) set = `Topps ${set}`;
    if (!set) set = 'Topps';
    const core = [input.year, set, input.player, input.parallel, input.auto ? 'auto' : ''].filter(Boolean).join(' ');
    const qs = [core];
    if (input.number) qs.push(`${core} ${input.number}`);
    if (input.condition.company !== 'RAW') qs.push([core, input.number, input.condition.company, input.condition.grade].filter(Boolean).join(' '));
    return [...new Set(qs)];
  }

  const titleCase = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

  function applyCert(cert, input) {
    const c = cert && (cert.PSACert || cert);
    if (!c) return;
    const fill = (field, value) => { if (!input[field] && value) { input[field] = String(value).trim(); form[field].value = input[field]; } };
    fill('player', titleCase(c.Subject));
    fill('year', c.Year);
    fill('set', titleCase(c.Brand));
    fill('number', c.CardNumber);
    fill('parallel', c.Variety ? titleCase(c.Variety) : '');
    const g = String(c.CardGrade || '').match(/(\d+(?:\.\d)?)\s*$/);
    if (g) {
      input.condition = { company: 'PSA', grade: parseFloat(g[1]) };
      form.company.value = 'PSA';
      updateGrades();
      form.grade.value = String(parseFloat(g[1]));
    }
  }

  // ------------------------------------------------------------ loading steps

  function startSteps(steps) {
    $('#loading').hidden = false;
    $('#loadingSteps').innerHTML = steps.map((s) => `<li data-step="${s.key}">${esc(s.label)}</li>`).join('');
  }
  function step(key, cls, label) {
    const li = $(`#loadingSteps [data-step="${key}"]`);
    if (!li) return;
    li.className = cls;
    if (label) li.textContent = label;
  }

  function alertBox(html, kind = '') {
    $('#alerts').insertAdjacentHTML('beforeend', `<div class="alert ${kind}">${html}</div>`);
  }

  // ------------------------------------------------------------ evaluation flow

  async function evaluateCard(e) {
    e.preventDefault();
    const input = readInput();
    if (!input.player && !input.cert) { form.player.focus(); return; }
    const s = state.status || {};
    const btn = $('#submitBtn');
    btn.disabled = true;
    $('#alerts').innerHTML = '';
    $('#results').hidden = true;

    const steps = [];
    if (input.cert) steps.push({ key: 'psa', label: 'Looking up PSA cert & population…' });
    steps.push({ key: 'ebay', label: s.ebay ? 'Searching live eBay listings…' : 'eBay not connected: skipping live listings' });
    steps.push({ key: 'sold', label: s.ebay ? 'Checking recent sold prices…' : 'Reading the sold prices you entered…' });
    steps.push({ key: 'player', label: 'Pulling player records, awards & attention…' });
    steps.push({ key: 'score', label: 'Scoring and estimating value…' });
    startSteps(steps);

    try {
      let psa = null;
      if (input.cert) {
        try {
          const cert = await api('/api/psa/cert', { cert: input.cert });
          applyCert(cert, input);
          const spec = (cert.PSACert || cert).SpecID;
          let pop = null;
          if (spec) pop = await api('/api/psa/pop', { spec }).catch(() => null);
          psa = { cert, pop };
          step('psa', 'done', `PSA cert found${pop ? ' with population report' : ''}`);
        } catch (err) {
          step('psa', 'fail', 'PSA lookup failed');
          alertBox(`<b>PSA:</b> ${esc(err.message)}`, 'error');
          loadStatus();
        }
      }
      if (!input.player) throw new Error('Enter a player name (the PSA cert could not fill it in).');

      const queries = buildQueries(input);
      const listingsP = s.ebay
        ? Promise.allSettled(queries.map((q) => api('/api/ebay/search', { q })))
        : Promise.resolve(null);
      const soldP = s.ebay
        ? Promise.allSettled(queries.map((q) => api('/api/ebay/sold', { q })))
        : Promise.resolve(null);
      const playerP = api('/api/player', { name: input.player, sport: input.sport }).catch((err) => ({ errors: [err.message] }));

      const listingRes = await listingsP;
      const market = { ebay: false, listings: [], sales: [], total: null, queries, salesAvailable: false };
      if (listingRes) {
        const ok = listingRes.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        const failed = listingRes.find((r) => r.status === 'rejected');
        if (ok.length) {
          market.ebay = true;
          market.total = ok[0].total;
          const seen = new Set();
          for (const r of ok) for (const it of r.items) {
            const key = it.url || `${it.title}|${it.price}`;
            if (!seen.has(key)) { seen.add(key); market.listings.push(it); }
          }
          step('ebay', 'done', `Found ${market.listings.length} live eBay listings`);
        } else {
          step('ebay', 'fail', 'eBay search failed');
        }
        if (failed && !ok.length) alertBox(`<b>eBay:</b> ${esc(failed.reason.message)}`, 'error');
      } else {
        step('ebay', 'skip');
      }

      const soldRes = await soldP;
      if (soldRes) {
        const ok = soldRes.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        const avail = ok.filter((r) => r.available);
        if (avail.length) {
          market.salesAvailable = true;
          const seen = new Set();
          for (const r of avail) for (const it of r.items) {
            const key = `${it.url}|${it.date}|${it.price}`;
            if (!seen.has(key)) { seen.add(key); market.sales.push(it); }
          }
        } else if (ok[0] && ok[0].reason) {
          market.salesNote = ok[0].reason;
        }
      }
      const manual = Scoring.parseManualSales(input.manual);
      market.sales.push(...manual);
      step('sold', market.sales.length ? 'done' : 'skip',
        market.salesAvailable ? `Found ${market.sales.length - manual.length} eBay sales${manual.length ? ` + ${manual.length} of yours` : ''}`
          : manual.length ? `Using ${manual.length} sold price${manual.length > 1 ? 's' : ''} you entered` : 'No sold-price data available');

      const player = await playerP;
      const found = player && (player.wiki || player.mlb);
      step('player', found ? 'done' : 'fail', found ? `Player data for ${player.wiki ? player.wiki.title : player.mlb.name}` : 'Player not found');

      state.ctx = { input, market, player, psa };
      state.excluded = new Set();
      state.showAll = false;
      step('score', 'done', 'Done');

      if (!market.ebay && !manual.length) {
        alertBox('<b>No price data yet.</b> eBay isn\'t connected, so add a few recent sold prices under <b>More evidence</b> to get a value estimate. Player and card ratings are shown below.');
      }
      if (market.salesNote && market.ebay && !manual.length) alertBox(esc(market.salesNote));

      render();
      setTimeout(() => { $('#loading').hidden = true; }, 350);
      $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      $('#loading').hidden = true;
      alertBox(`<b>Something went wrong:</b> ${esc(err.message)}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ rendering

  const scoreColor = (s) => s == null ? 'var(--faint)' : s >= 65 ? 'var(--good)' : s >= 45 ? 'var(--mid)' : 'var(--bad)';

  function ring(score, size = 120) {
    const r = size / 2 - 9, C = 2 * Math.PI * r;
    const off = score == null ? C : C * (1 - score / 100);
    return `<svg class="ring" viewBox="0 0 ${size} ${size}" role="img" aria-label="${score == null ? 'No score' : `Score ${score} out of 100`}">
      <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}"/>
      <circle class="fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${scoreColor(score)}" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-offset="${off}"/>
      <text x="50%" y="50%" class="${score == null ? 'na' : ''}">${score == null ? '–' : score}</text>
    </svg>`;
  }

  function confBars(level) {
    const n = { High: 4, Medium: 3, Low: 2, 'Very low': 1 }[level] || 0;
    return `<span class="conf-bars">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
  }

  function render() {
    const { input, market, player } = state.ctx;
    const r = Scoring.evaluate({ ...state.ctx, excluded: state.excluded });
    const v = r.valuation;
    const manualOnly = v.comps.length && v.comps.every((x) => x.manual);

    const tags = [
      `<span class="tag">${esc(input.sport)}</span>`,
      (input.rookie || /a rookie card/.test(r.description)) ? '<span class="tag gold">Rookie</span>' : '',
      input.auto ? '<span class="tag gold">Auto</span>' : '',
      input.parallel ? `<span class="tag gold">${esc(input.parallel)}</span>` : '',
      `<span class="tag">${esc(r.condition)}</span>`,
    ].join('');

    const valueBlock = v.point != null
      ? `<div class="value-big">${money(v.point)}</div>
         <div class="value-range">Likely range <b>${money(v.low)} – ${money(v.high)}</b></div>`
      : '<div class="value-big none">Not enough price data</div>';

    const methodText = v.method === 'sold'
      ? `${manualOnly ? 'Based on' : 'Based on'} ${v.n} ${manualOnly ? 'sold prices you entered' : 'recent sales'}`
      : v.method === 'asking' ? `Based on ${v.n} current asking prices` : 'No comparable prices yet';

    const art = r.image
      ? `<img src="${esc(r.image)}" alt="Photo of a listed copy of this card" referrerpolicy="no-referrer">`
      : `<div class="card-placeholder"><div>${esc(input.player.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase())}<small>No photo available</small></div></div>`;

    const html = `
      <article class="panel showcase">
        <div class="card-frame">
          <div class="card-art" id="cardArt">${art}<div class="holo"></div></div>
          ${r.image ? '<p class="card-caption">Photo from a live listing</p>' : ''}
        </div>
        <div class="showcase-info">
          <div class="tags">${tags}</div>
          <h1 class="card-title">${esc(r.title)}</h1>
          <div class="value-row">
            <div>
              <div class="value-label">Estimated value</div>
              ${valueBlock}
            </div>
            <div class="overall">
              ${ring(r.overall)}
              <div class="overall-text"><b>${esc(r.overallLabel)}</b><span>CardVault score<br>(average of ratings)</span></div>
            </div>
          </div>
          <div class="confidence">${confBars(v.confidence)}<span>${v.confidence ? `${esc(v.confidence)} confidence · ` : ''}${esc(methodText)}</span></div>
          <p class="description">${esc(r.description)}</p>
          ${v.notes.length ? `<ul class="notes">${v.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        </div>
      </article>

      <div class="section-head"><h2>Ratings</h2><p>Every score is 0–100. Open "Evidence" to see the data behind it.</p></div>
      <div class="scores">${r.scores.map(scoreCard).join('')}</div>

      <div class="two-col">
        ${playerBlock(player, input)}
        ${marketBlock(r, market)}
      </div>

      ${compsBlock(r)}
      ${sourcesBlock(r, market, player)}
    `;
    const out = $('#results');
    out.innerHTML = html;
    out.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $$('.ring .fill', out).forEach((c) => { c.style.strokeDashoffset = c.dataset.offset; });
    }));
    bindResults();
  }

  function scoreCard(s) {
    const color = scoreColor(s.score);
    return `<article class="panel score">
      <div class="score-top">
        ${ring(s.score)}
        <div>
          <h3>${esc(s.name)}</h3>
          <div class="label" style="color:${color}">${esc(s.label)}</div>
        </div>
      </div>
      <p>${esc(s.summary)}</p>
      <details>
        <summary>Evidence (${s.evidence.length})</summary>
        <ul class="evidence">
          ${s.evidence.map((e) => `<li>${esc(e.text)}<small>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.source)}</a>` : esc(e.source)}</small></li>`).join('') || '<li>No data available for this rating.</li>'}
        </ul>
        <div class="method"><b>How it's calculated:</b> ${esc(s.method)}</div>
      </details>
    </article>`;
  }

  function playerBlock(p, input) {
    if (!p || (!p.wiki && !p.mlb)) {
      return `<section class="panel block"><h2>Player</h2><p class="empty">No public records found for "${esc(input.player)}". Check the spelling or sport.</p></section>`;
    }
    const w = p.wiki || {};
    const views = w.views || [];
    let spark = '';
    if (views.length > 5) {
      const max = Math.max(...views, 1);
      const pts = views.map((n, i) => `${(i / (views.length - 1)) * 300},${66 - (n / max) * 60}`).join(' ');
      spark = `<div class="spark">
        <svg viewBox="0 0 300 70" preserveAspectRatio="none" aria-label="Wikipedia daily views, last 60 days">
          <defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#46d3c0" stop-opacity=".35"/><stop offset="1" stop-color="#46d3c0" stop-opacity="0"/></linearGradient></defs>
          <polygon points="0,70 ${pts} 300,70" fill="url(#sg)"/>
          <polyline points="${pts}" fill="none" stroke="#46d3c0" stroke-width="2" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="spark-meta"><span>${esc(w.viewsStart)}</span><span>Wikipedia views/day · peak ${max.toLocaleString()}</span><span>${esc(w.viewsEnd)}</span></div>
      </div>`;
    }
    const counts = {};
    (p.awards || []).forEach((a) => { counts[a.name] = (counts[a.name] || 0) + 1; });
    const awards = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14);
    const mlb = p.mlb;
    const sub = [w.description, mlb && mlb.team, mlb && mlb.position].filter(Boolean).join(' · ');
    return `<section class="panel block">
      <h2>Player</h2>
      <div class="player-head">
        ${w.thumbnail ? `<img src="${esc(w.thumbnail)}" alt="">` : ''}
        <div><b>${esc(w.title || (mlb && mlb.name) || input.player)}</b><span>${esc(sub)}</span></div>
      </div>
      ${w.extract ? `<p class="player-extract">${esc(w.extract.length > 420 ? w.extract.slice(0, 417) + '…' : w.extract)}</p>` : ''}
      ${spark}
      ${awards.length ? `<div class="award-list">${awards.map(([n, c]) => `<span>${c > 1 ? `${c}× ` : ''}${esc(n)}</span>`).join('')}</div>` : ''}
    </section>`;
  }

  function marketBlock(r, market) {
    const v = r.valuation;
    const pts = r.comps.filter((x) => x.status !== 'excluded');
    let dist = '<p class="empty">No comparable prices to chart yet.</p>';
    if (pts.length) {
      const prices = pts.map((x) => x.price);
      const lo = Math.log(Math.min(...prices) * 0.9), hi = Math.log(Math.max(...prices) * 1.1);
      const x = (p) => (hi === lo ? 50 : ((Math.log(p) - lo) / (hi - lo)) * 100);
      const band = v.point != null ? `<div class="band" style="left:${x(v.low)}%;width:${Math.max(x(v.high) - x(v.low), 1)}%"></div>` : '';
      const pin = v.point != null ? `<div class="pin" style="left:${x(v.point)}%"><span>${money(v.point)}</span></div>` : '';
      const dots = pts.map((p) => `<div class="dot ${p.status === 'outlier' ? 'out' : ''}" style="left:${x(p.price)}%" title="${esc(money(p.price))}: ${esc(p.title)}"></div>`).join('');
      dist = `<div class="dist" role="img" aria-label="Distribution of comparable prices">
        <div class="axis"></div>${band}${dots}${pin}
        <span class="tick" style="left:3%">${money(Math.exp(lo) / 0.9)}</span>
        <span class="tick" style="left:97%">${money(Math.exp(hi) / 1.1)}</span>
      </div>`;
    }
    const stats = [
      [market.ebay ? (market.total ?? 0).toLocaleString() : '—', 'Live listings (search)'],
      [market.ebay ? r.matched.listings : '—', 'Listings matching this card'],
      [r.matched.sales || (market.salesAvailable ? 0 : '—'), 'Sales matching this card'],
    ];
    return `<section class="panel block">
      <h2>Market snapshot</h2>
      ${dist}
      <div class="stat-grid">${stats.map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('')}</div>
      ${r.numberMatched === false ? '<p class="notes">Few listings mention this card number, so the comps may include other cards of this player in the set.</p>' : ''}
    </section>`;
  }

  function compsBlock(r) {
    if (!r.comps.length) return '';
    const rows = [...r.comps].sort((a, b) => (a.status === 'used' ? 0 : 1) - (b.status === 'used' ? 0 : 1) || a.price - b.price);
    const visible = state.showAll ? rows : rows.slice(0, 12);
    const kindLabel = (x) => x.manual ? 'Your entry' : x.kind === 'sold' ? 'Sold' : 'Asking';
    const when = (x) => x.date ? new Date(x.date).toLocaleDateString() : x.created ? `Listed ${new Date(x.created).toLocaleDateString()}` : '';
    return `<section class="panel comps">
      <div class="comps-head">
        <h2>Comparable ${r.valuation.method === 'sold' ? 'sales' : 'listings'} (${rows.length})</h2>
        <p>Untick anything that isn't really your card. The estimate recalculates instantly.</p>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Use</th><th></th><th>Title</th><th>Type</th><th>Date</th><th>Price</th></tr></thead>
        <tbody>
        ${visible.map((x) => `<tr class="${x.status}">
          <td><input type="checkbox" data-id="${esc(x.id)}" ${x.status === 'excluded' ? '' : 'checked'} aria-label="Use this comparable"></td>
          <td class="thumb">${x.image ? `<img src="${esc(x.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</td>
          <td class="title">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}</td>
          <td><span class="badge">${kindLabel(x)}</span>${x.status === 'outlier' ? ' <span class="badge out" title="Far outside the typical price; ignored">Outlier</span>' : ''}</td>
          <td>${esc(when(x))}</td>
          <td class="price">${money(x.price)}</td>
        </tr>`).join('')}
        </tbody>
      </table></div>
      ${rows.length > 12 ? `<button class="show-more" type="button" id="showMore">${state.showAll ? 'Show fewer' : `Show all ${rows.length}`}</button>` : ''}
    </section>`;
  }

  function sourcesBlock(r, market, player) {
    const items = [];
    if (market.ebay) items.push(`eBay Browse API: live listings for "${esc(market.queries.join('", "'))}" (${r.matched.rawListings} retrieved, ${r.matched.listings} matched this card after filtering out lots, reprints, other parallels and other players).`);
    if (market.salesAvailable) items.push('eBay Marketplace Insights: sold listings from the last 90 days.');
    if (r.valuation.comps.some((x) => x.manual)) items.push('Sold prices you entered manually.');
    if (state.ctx.psa) items.push('PSA Public API: cert and population report.');
    if (player && player.wiki) items.push(`Wikipedia: <a href="${esc(player.wiki.url)}" target="_blank" rel="noopener">${esc(player.wiki.title)}</a>, with daily pageviews from the Wikimedia REST API.`);
    if (player && player.awards) items.push('Wikidata: awards received (property P166).');
    if (player && player.mlb) items.push('MLB Stats API: career stats and awards.');
    return `<section class="panel sources">
      <h2>Sources & method</h2>
      <ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>
      <p class="muted" style="margin-top:10px">Ratings use fixed, published formulas (open "Evidence" on any rating). Estimates reflect market data at the time of the search. Card condition, centering and eye appeal can move real prices well above or below the estimate.</p>
    </section>`;
  }

  function bindResults() {
    $$('#results tbody input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) state.excluded.delete(cb.dataset.id);
      else state.excluded.add(cb.dataset.id);
      render();
    }));
    const more = $('#showMore');
    if (more) more.addEventListener('click', () => { state.showAll = !state.showAll; render(); });
    const art = $('#cardArt');
    if (art && window.matchMedia('(hover: hover)').matches) {
      const holo = $('.holo', art);
      art.addEventListener('mousemove', (e) => {
        const b = art.getBoundingClientRect();
        const px = (e.clientX - b.left) / b.width, py = (e.clientY - b.top) / b.height;
        art.style.transform = `rotateY(${(px - 0.5) * 16}deg) rotateX(${(0.5 - py) * 16}deg)`;
        holo.style.backgroundPosition = `${px * 100}% ${py * 100}%`;
      });
      art.addEventListener('mouseleave', () => { art.style.transform = ''; });
    }
  }

  // ------------------------------------------------------------ init

  $$('.sports button').forEach((b) => b.addEventListener('click', () => setSport(b.dataset.sport)));
  form.company.addEventListener('change', updateGrades);
  form.addEventListener('submit', evaluateCard);
  $('#openSetup').addEventListener('click', () => { loadStatus(); $('#setup').showModal(); });
  setSport('baseball');
  updateGrades();
  loadStatus();
})();
