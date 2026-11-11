/*
 * CardVault TCG section: game bar, per-game set and card browsing, card search,
 * and the TCG card evaluation page (rated by tcg-scoring.js, not the sports engine).
 * Data comes from TCG API through the local server's /api/tcg/* routes.
 */
(function (global) {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const { money } = TcgScoring;
  const int = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
  const fmtDate = (d) => (d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

  let ui; // shared helpers from app.js: api, esc, ring, scoreCard, confBars
  const state = {
    gamesP: null,
    games: [],
    sets: new Map(), // game slug -> { items, page, hasMore }
    setInfo: new Map(), // set id -> set
    cards: new Map(), // card id -> card row (so opening a card needs no extra lookup)
    list: null, // the card list on screen: { key, cards, page, hasMore, sort }
    detail: null, // the card page on screen: { id, card, data, printing }
    view: 0, // bumped on every navigation so late responses for old pages are dropped
  };

  // ------------------------------------------------------------ helpers

  const gameBySlug = (slug) => state.games.find((g) => g.slug === slug);

  function setQuota(q) {
    if (!q || q.daily_remaining == null) return;
    $('#tcgQuota').textContent = `TCG API: ${int(q.daily_remaining)} of ${int(q.daily_limit)} lookups left today. Resets at midnight UTC. Pages you've already opened don't count again.`;
  }

  function alertBox(html, kind = '') {
    $('#tcgAlerts').insertAdjacentHTML('beforeend', `<div class="alert ${kind}">${html}</div>`);
  }

  const loading = (text) => `<div class="tcg-loading"><span class="spinner" aria-hidden="true"></span>${ui.esc(text)}</div>`;

  function crumbs(items) {
    return `<nav class="crumbs" aria-label="Breadcrumb">${items.map(([label, href]) =>
      href ? `<a href="${href}">${ui.esc(label)}</a>` : `<span aria-current="page">${ui.esc(label)}</span>`).join('<span class="sep">/</span>')}</nav>`;
  }

  function head(title, lede, slug) {
    $('#tcgTitle').textContent = title;
    $('#tcgLede').textContent = lede || '';
    $('#tcgLede').hidden = !lede;
    const form = $('#tcgSearch');
    form.hidden = !slug;
    if (slug) {
      const g = gameBySlug(slug);
      form.dataset.game = slug;
      form.q.placeholder = `Search ${g ? g.name : ''} cards`;
    }
  }

  function loadGames() {
    if (!state.gamesP) {
      state.gamesP = ui.api('/api/tcg/games').then((r) => { state.games = r.games; return r.games; })
        .catch((err) => { state.gamesP = null; throw err; });
    }
    return state.gamesP;
  }

  // ------------------------------------------------------------ game bar

  function renderBar(active) {
    const bar = $('#gameBar');
    bar.innerHTML = state.games.map((g) =>
      `<a href="#/tcg/${encodeURIComponent(g.slug)}" ${g.slug === active ? 'aria-current="true"' : ''}>${ui.esc(g.name)}</a>`).join('');
    const cur = $('[aria-current]', bar);
    if (cur) bar.scrollLeft = cur.offsetLeft - bar.clientWidth / 2 + cur.offsetWidth / 2;
    updateArrows();
  }

  function updateArrows() {
    const bar = $('#gameBar');
    const [prev, next] = $$('.bar-arrow');
    prev.hidden = bar.scrollLeft <= 2;
    next.hidden = bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 2;
  }

  // ------------------------------------------------------------ pages

  async function show(parts) {
    const view = ++state.view;
    const [slug, kind, arg] = parts;
    $('#tcgAlerts').innerHTML = '';
    $('#tcgBody').innerHTML = loading('Loading card games…');
    try {
      await loadGames();
    } catch (err) {
      $('#tcgBody').innerHTML = '';
      alertBox(`<b>Couldn't load the card games:</b> ${ui.esc(err.message)}`, 'error');
      return;
    }
    if (view !== state.view) return;
    renderBar(slug);
    if (!slug) return showLanding();
    const game = gameBySlug(slug);
    if (!game) {
      head('TCG', '');
      $('#tcgBody').innerHTML = '<p class="empty">That card game isn\'t available. Pick one from the bar above.</p>';
      return;
    }
    if (kind === 'set' && arg) return showSet(game, arg, view);
    if (kind === 'search' && arg) return showSearch(game, arg, view);
    if (kind === 'card' && arg) return showCard(game, arg, view);
    return showGame(game, view);
  }

  function showLanding() {
    head('TCG', `Prices for ${state.games.length} trading card games from TCGplayer. Pick a game to browse its sets or search its cards.`);
    $('#tcgBody').innerHTML = `<div class="game-grid">${state.games.map((g) => `
      <a class="game-tile" href="#/tcg/${encodeURIComponent(g.slug)}">
        <div class="game-logo">${g.logo ? `<img src="${ui.esc(g.logo)}" alt="" loading="lazy">` : `<span>${ui.esc(g.name)}</span>`}</div>
        <b>${ui.esc(g.name)}</b>
        <small>${int(g.sets)} sets · ${int(g.cards)} cards</small>
      </a>`).join('')}</div>`;
  }

  async function showGame(game, view) {
    head(game.name, `${int(game.sets)} sets · ${int(game.cards)} cards. Open a set to see its cards for sale, or search every ${game.name} card.`, game.slug);
    let entry = state.sets.get(game.slug);
    if (!entry) {
      $('#tcgBody').innerHTML = loading('Loading sets…');
      try {
        const r = await ui.api('/api/tcg/sets', { game: game.slug, page: 1 });
        entry = { items: r.sets, page: 1, hasMore: r.hasMore };
        state.sets.set(game.slug, entry);
      } catch (err) {
        if (view !== state.view) return;
        $('#tcgBody').innerHTML = '';
        alertBox(`<b>Couldn't load sets:</b> ${ui.esc(err.message)}`, 'error');
        return;
      }
    }
    if (view !== state.view) return;
    entry.items.forEach((s) => state.setInfo.set(String(s.id), s));
    renderSets(game, entry);
  }

  function renderSets(game, entry) {
    $('#tcgBody').innerHTML = `
      <div class="section-head"><h2>Sets</h2><p>Newest first</p></div>
      <div class="set-grid">${entry.items.map((s) => `
        <a class="set-tile" href="#/tcg/${encodeURIComponent(game.slug)}/set/${s.id}">
          <div class="set-art">${s.image ? `<img src="${ui.esc(s.image)}" alt="" loading="lazy">` : ''}</div>
          <div class="set-meta">
            <b>${ui.esc(s.name)}</b>
            <small>${[fmtDate(s.released), s.cards ? `${int(s.cards)} cards` : ''].filter(Boolean).join(' · ')}</small>
          </div>
        </a>`).join('')}</div>
      ${entry.hasMore ? '<button type="button" class="load-more" id="moreSets">Load more sets</button>' : ''}`;
    const more = $('#moreSets');
    if (more) more.addEventListener('click', async () => {
      more.disabled = true;
      more.textContent = 'Loading…';
      try {
        const r = await ui.api('/api/tcg/sets', { game: game.slug, page: entry.page + 1 });
        entry.items.push(...r.sets);
        entry.page += 1;
        entry.hasMore = r.hasMore;
        r.sets.forEach((s) => state.setInfo.set(String(s.id), s));
        renderSets(game, entry);
      } catch (err) {
        alertBox(`<b>Couldn't load more sets:</b> ${ui.esc(err.message)}`, 'error');
        more.disabled = false;
        more.textContent = 'Load more sets';
      }
    });
  }

  async function showSet(game, setId, view) {
    const set = state.setInfo.get(String(setId));
    const name = set ? set.name : 'Set';
    head(game.name, set ? `${name}${set.released ? ` · released ${fmtDate(set.released)}` : ''}` : '', game.slug);
    await showList(view, {
      key: `set:${setId}`,
      crumbs: [['TCG', '#/tcg'], [game.name, `#/tcg/${encodeURIComponent(game.slug)}`], [name]],
      fetch: (page) => ui.api('/api/tcg/set-cards', { set: setId, page, setName: set ? set.name : '' }),
      game,
      empty: 'No singles are listed for this set yet.',
      sorts: true,
    });
  }

  async function showSearch(game, q, view) {
    head(game.name, `Results for "${q}"`, game.slug);
    $('#tcgSearch').q.value = q;
    await showList(view, {
      key: `search:${game.slug}:${q}`,
      crumbs: [['TCG', '#/tcg'], [game.name, `#/tcg/${encodeURIComponent(game.slug)}`], [`Search: ${q}`]],
      fetch: (page) => ui.api('/api/tcg/search', { game: game.slug, q, page }),
      game,
      empty: `No ${game.name} cards match "${q}". Try fewer words or check the spelling.`,
      showSet: true,
    });
  }

  // ------------------------------------------------------------ card lists

  async function showList(view, opts) {
    if (!state.list || state.list.key !== opts.key) {
      $('#tcgBody').innerHTML = crumbs(opts.crumbs) + loading('Loading cards…');
      try {
        const r = await opts.fetch(1);
        if (view !== state.view) return;
        setQuota(r.quota);
        state.list = { key: opts.key, cards: r.cards, page: 1, hasMore: r.hasMore, total: r.total, sort: 'number' };
      } catch (err) {
        if (view !== state.view) return;
        $('#tcgBody').innerHTML = crumbs(opts.crumbs);
        alertBox(`<b>Couldn't load cards:</b> ${ui.esc(err.message)}`, 'error');
        return;
      }
    }
    if (view !== state.view) return;
    state.list.cards.forEach((c) => state.cards.set(String(c.id), c));
    renderList(opts);
  }

  function sortedCards(list) {
    const cards = [...list.cards];
    if (list.sort === 'price') cards.sort((a, b) => (b.market ?? -1) - (a.market ?? -1));
    if (list.sort === 'number') cards.sort((a, b) => String(a.number || '').localeCompare(String(b.number || ''), undefined, { numeric: true }));
    return cards;
  }

  function renderList(opts) {
    const list = state.list;
    const cards = opts.sorts ? sortedCards(list) : list.cards;
    const count = list.total != null ? `${int(list.total)} card${list.total === 1 ? '' : 's'}` : `${cards.length} cards`;
    $('#tcgBody').innerHTML = `
      ${crumbs(opts.crumbs)}
      <div class="list-head">
        <p>${count}${list.hasMore ? ` · showing ${int(cards.length)}` : ''}</p>
        ${opts.sorts ? `<div class="seg" role="group" aria-label="Sort cards">
          <button type="button" data-sort="number" aria-pressed="${list.sort === 'number'}">Card number</button>
          <button type="button" data-sort="price" aria-pressed="${list.sort === 'price'}">Highest price</button>
        </div>` : ''}
      </div>
      ${cards.length ? `<div class="card-grid">${cards.map((c) => cardTile(c, opts)).join('')}</div>` : `<p class="empty">${ui.esc(opts.empty)}</p>`}
      ${list.hasMore ? '<button type="button" class="load-more" id="moreCards">Load more cards</button>' : ''}`;
    $$('.seg button').forEach((b) => b.addEventListener('click', () => { list.sort = b.dataset.sort; renderList(opts); }));
    const more = $('#moreCards');
    if (more) more.addEventListener('click', async () => {
      more.disabled = true;
      more.textContent = 'Loading…';
      try {
        const r = await opts.fetch(list.page + 1);
        setQuota(r.quota);
        list.cards.push(...r.cards);
        list.page += 1;
        list.hasMore = r.hasMore;
        r.cards.forEach((c) => state.cards.set(String(c.id), c));
        renderList(opts);
      } catch (err) {
        alertBox(`<b>Couldn't load more cards:</b> ${ui.esc(err.message)}`, 'error');
        more.disabled = false;
        more.textContent = 'Load more cards';
      }
    });
  }

  function cardTile(c, opts) {
    const meta = [c.number ? `#${c.number}` : '', c.rarity].filter(Boolean).join(' · ');
    return `<a class="tcg-card" href="#/tcg/${encodeURIComponent(opts.game.slug)}/card/${c.id}">
      <div class="tcg-card-art">${c.image ? `<img src="${ui.esc(c.image)}" alt="" loading="lazy">` : ''}</div>
      <div class="tcg-card-body">
        <b>${ui.esc(c.name)}</b>
        ${opts.showSet && c.set ? `<small>${ui.esc(c.set)}</small>` : ''}
        ${meta ? `<small>${ui.esc(meta)}</small>` : ''}
        <div class="tcg-card-price">
          <span>${money(c.market ?? c.median ?? c.low)}</span>
          ${c.listings != null ? `<small>${int(c.listings)} for sale</small>` : ''}
        </div>
        ${c.printing && c.printing !== 'Normal' ? `<small class="printing">${ui.esc(c.printing)}</small>` : ''}
      </div>
    </a>`;
  }

  // ------------------------------------------------------------ card evaluation

  async function showCard(game, id, view) {
    const known = state.cards.get(String(id));
    head(game.name, '', game.slug);
    const trail = [['TCG', '#/tcg'], [game.name, `#/tcg/${encodeURIComponent(game.slug)}`]];
    $('#tcgBody').innerHTML = crumbs([...trail, [known ? known.name : 'Card']]) + loading('Pricing this card…');
    let data;
    try {
      data = await ui.api('/api/tcg/card', { id, info: known ? '0' : '1' });
    } catch (err) {
      if (view !== state.view) return;
      $('#tcgBody').innerHTML = crumbs([...trail, [known ? known.name : 'Card']]);
      alertBox(`<b>Couldn't price this card:</b> ${ui.esc(err.message)}`, 'error');
      return;
    }
    if (view !== state.view) return;
    setQuota(data.quota);
    const card = { ...(known || {}), ...(data.card || {}), game: game.name };
    if (!data.prices.length) {
      $('#tcgBody').innerHTML = crumbs([...trail, [card.name || 'Card']]);
      alertBox('TCGplayer has no price data for this card yet.');
      return;
    }
    const preferred = data.prices.find((p) => p.printing === card.printing && p.market != null)
      || data.prices.find((p) => p.market != null) || data.prices[0];
    state.detail = { id: String(id), card, data, printing: preferred.printing, trail };
    renderCard();
  }

  function renderCard() {
    const { card, data, trail } = state.detail;
    const r = TcgScoring.evaluate({ card, prices: data.prices, history: data.history, printing: state.detail.printing });
    const v = r.valuation;
    const tags = [
      `<span class="tag">${ui.esc(card.game)}</span>`,
      card.rarity ? `<span class="tag gold">${ui.esc(card.rarity)}</span>` : '',
      `<span class="tag">${ui.esc(r.printing)}</span>`,
      '<span class="tag">Near Mint · ungraded</span>',
    ].join('');
    const valueBlock = v.point != null
      ? `<div class="value-big">${money(v.point)}</div>
         <div class="value-range">${v.low != null ? `Recent range <b>${money(v.low)} – ${money(v.high)}</b>` : 'TCGplayer market price'}</div>`
      : '<div class="value-big none">Not enough price data</div>';
    const methodText = v.method === 'market' ? `TCGplayer market price${r.sales != null ? ` · ${int(r.sales)} sold in ${r.days} days` : ''}`
      : v.method === 'listing' ? 'Based on current listings (no market price yet)' : 'No price data yet';
    const printings = r.printings.length > 1 ? `<div class="seg printings" role="group" aria-label="Printing">
      ${r.printings.map((p) => `<button type="button" data-printing="${ui.esc(p)}" aria-pressed="${p === r.printing}">${ui.esc(p)}</button>`).join('')}
    </div>` : '';

    const html = `<div class="tcg-detail">
      ${crumbs([...trail, [card.name || 'Card']])}
      <article class="panel showcase">
        <div class="card-frame">
          <div class="card-art tcg-art">${card.image ? `<img src="${ui.esc(card.image)}" alt="${ui.esc(card.name)}">` : '<div class="card-placeholder"><div>?<small>No image available</small></div></div>'}</div>
          ${r.url ? `<p class="card-caption"><a href="${ui.esc(r.url)}" target="_blank" rel="noopener">View on TCGplayer</a></p>` : ''}
        </div>
        <div class="showcase-info">
          <div class="tags">${tags}</div>
          <h1 class="card-title">${ui.esc(r.title)}</h1>
          ${card.set ? `<p class="card-sub">${ui.esc(card.set)}</p>` : ''}
          ${printings}
          <div class="value-row">
            <div>
              <div class="value-label">Market value</div>
              ${valueBlock}
            </div>
            <div class="overall">
              ${ui.ring(r.overall)}
              <div class="overall-text"><b>${ui.esc(r.overallLabel)}</b><span>CardVault TCG score<br>(average of ratings)</span></div>
            </div>
          </div>
          <div class="confidence">${ui.confBars(v.confidence)}<span>${v.confidence ? `${ui.esc(v.confidence)} confidence · ` : ''}${ui.esc(methodText)}</span></div>
          <p class="description">${ui.esc(r.description)}</p>
          ${v.notes.length ? `<ul class="notes">${v.notes.map((n) => `<li>${ui.esc(n)}</li>`).join('')}</ul>` : ''}
        </div>
      </article>

      <div class="section-head"><h2>Ratings</h2><p>Every score is 0–100. Open "Evidence" to see the data behind it.</p></div>
      <div class="scores">${r.scores.map(ui.scoreCard).join('')}</div>

      <div class="two-col">
        ${historyBlock(r)}
        ${snapshotBlock(r, card)}
      </div>

      <section class="panel sources">
        <h2>Sources & method</h2>
        <ul>
          <li>TCG API (tcgapi.dev): TCGplayer market, low and median prices for each printing, and daily price history with sales volume.</li>
          <li>TCGplayer: card details, rarity and listings${r.url ? ` (<a href="${ui.esc(r.url)}" target="_blank" rel="noopener">product page</a>)` : ''}.</li>
        </ul>
        <p class="muted" style="margin-top:10px">TCG cards use their own ratings, separate from the sports calculator. TCGplayer's market price is based on recent completed sales of Near Mint copies. Condition, language and grading can move real prices well above or below it.</p>
      </section>
    </div>`;
    const out = $('#tcgBody');
    out.innerHTML = html;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $$('.ring .fill', out).forEach((c) => { c.style.strokeDashoffset = c.dataset.offset; });
    }));
    $$('.printings button', out).forEach((b) => b.addEventListener('click', () => {
      state.detail.printing = b.dataset.printing;
      renderCard();
    }));
  }

  function historyBlock(r) {
    const pts = r.history.filter((h) => h.market != null);
    if (pts.length < 2) {
      return '<section class="panel block"><h2>Price history</h2><p class="empty">Not enough daily prices recorded for this printing yet.</p></section>';
    }
    const W = 600, H = 170, pad = 8;
    const values = pts.map((h) => h.market).concat(pts.map((h) => h.avgSale).filter((v) => v > 0));
    let lo = Math.min(...values), hi = Math.max(...values);
    if (hi - lo < hi * 0.02) { lo -= hi * 0.05; hi += hi * 0.05; }
    const x = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
    const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2);
    const line = pts.map((h, i) => `${x(i).toFixed(1)},${y(h.market).toFixed(1)}`).join(' ');
    const dots = pts.map((h, i) => (h.avgSale > 0
      // A zero-length path with a round cap stays circular when the chart stretches.
      ? `<path d="M${x(i).toFixed(1)},${y(h.avgSale).toFixed(1)}h0"><title>${ui.esc(fmtDate(h.date))}: ${h.volume || 0} sold, avg ${money(h.avgSale)}</title></path>` : '')).join('');
    return `<section class="panel block">
      <h2>Price history</h2>
      <div class="chart">
        <div class="chart-y"><span>${money(hi)}</span><span>${money(lo)}</span></div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Daily market price, ${ui.esc(r.printing)}">
          <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
          <g class="chart-dots">${dots}</g>
        </svg>
      </div>
      <div class="spark-meta"><span>${ui.esc(fmtDate(pts[0].date))}</span><span>${ui.esc(fmtDate(pts[pts.length - 1].date))}</span></div>
      <div class="legend"><span><i class="line"></i>Market price</span><span><i class="dot"></i>Average sale that day</span></div>
    </section>`;
  }

  function snapshotBlock(r, card) {
    const p = r.price;
    const pct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
    const stats = [
      [money(p.market), 'Market price'],
      [money(p.lowestShipped ?? p.low), 'Cheapest listing'],
      [money(p.median), 'Median listing'],
      [r.sales != null ? int(r.sales) : '—', `Sold in ${r.days || 0} days`],
      [card.listings != null ? int(card.listings) : '—', 'Listed for sale'],
      [pct(p.change30d), '30-day change'],
    ];
    return `<section class="panel block">
      <h2>Market snapshot</h2>
      <div class="stat-grid">${stats.map(([b, s]) => `<div class="stat"><b>${ui.esc(b)}</b><span>${ui.esc(s)}</span></div>`).join('')}</div>
      ${p.marketAsOf ? `<p class="notes">Market price as of ${ui.esc(fmtDate(p.marketAsOf))}.</p>` : ''}
    </section>`;
  }

  // ------------------------------------------------------------ init

  function init(helpers) {
    ui = helpers;
    const bar = $('#gameBar');
    bar.addEventListener('scroll', updateArrows, { passive: true });
    window.addEventListener('resize', updateArrows);
    // A mouse wheel scrolls the bar sideways, since it has no vertical scroll of its own.
    bar.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || bar.scrollWidth <= bar.clientWidth) return;
      e.preventDefault();
      bar.scrollLeft += e.deltaY;
    }, { passive: false });
    $$('.bar-arrow').forEach((b) => b.addEventListener('click', () => {
      bar.scrollBy({ left: Number(b.dataset.dir) * bar.clientWidth * 0.8, behavior: 'smooth' });
    }));
    $('#tcgSearch').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = e.target.q.value.trim();
      if (q.length < 2) return;
      location.hash = `#/tcg/${encodeURIComponent(e.target.dataset.game)}/search/${encodeURIComponent(q)}`;
    });
  }

  global.TcgView = { init, show };
})(window);
