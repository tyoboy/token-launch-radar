'use strict';
/* Token Launch Radar — the page. Everything renders from window.RADAR (../data.js), written by
   main.ts from the same board the gate reads: no fetch, no network, no framework. */
const R = window.RADAR;
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function fmtUsd(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n}`;
}
function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n.toFixed(2))}%`;
}
function fmtAge(days) {
  if (days === null || days === undefined) return 'unknown';
  if (days >= 730) return `${(days / 365).toFixed(1)} yrs`;
  if (days >= 60) return `${Math.round(days / 30.4)} mo`;
  return `${days} d`;
}
function fmtMult(n) {
  return `${Number(n.toFixed(3))}×`;
}

const state = { view: 'board', sortKey: 'rank', sortDir: 1, q: '', category: '', chain: '', minTvl: 0, watch: false, slug: null };

/* ---------- header stats ---------- */
function renderStats() {
  const items = [
    ['Protocols ranked', R.board_size],
    ['Watchlist covered', `${R.watchlist_size} / ${R.watchlist_size}`],
    ['Categories priced', R.categories.length],
    ['Snapshot', R.as_of],
  ];
  $('stats').innerHTML = items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  $('foot').textContent = `Data: ${R.source}. The board records what DefiLlama records: a protocol here records no token — that is the snapshot's record, not a promise that none exists. Implied values are this model's claim, priced from the snapshot's figures alone. Model: ${R.model_version}.`;
}

/* ---------- board ---------- */
function filteredRows() {
  const q = state.q.trim().toLowerCase();
  let rows = R.rows.filter((r) => {
    if (state.watch && !r.on_watchlist) return false;
    if (state.category && (r.category ?? '') !== state.category) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.minTvl && r.tvl_usd < state.minTvl) return false;
    if (q && !r.name.toLowerCase().includes(q) && !r.slug.includes(q)) return false;
    return true;
  });
  const k = state.sortKey;
  const dir = state.sortDir;
  rows = [...rows].sort((a, b) => {
    const av = a[k];
    const bv = b[k];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });
  return rows;
}

function rowHtml(r) {
  const chg = r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down';
  return `<tr data-slug="${esc(r.slug)}">
    <td class="num">${r.rank}</td>
    <td><span class="name">${esc(r.name)}</span>${r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : ''}<span class="slug">${esc(r.slug)}</span></td>
    <td>${esc(r.category ?? '—')}</td>
    <td class="num">${fmtUsd(r.tvl_usd)}</td>
    <td class="num ${chg}">${fmtPct(r.change_7d)}</td>
    <td class="num">${fmtAge(r.age_days)}</td>
    <td class="num implied">${fmtUsd(r.implied_value_usd)}</td>
    <td class="num"><span class="score">${r.radar_score}</span><span class="score-bar"><i style="width:${r.radar_score}%"></i></span></td>
  </tr>`;
}

function renderBoard() {
  const rows = filteredRows();
  $('board-body').innerHTML = rows.map(rowHtml).join('');
  $('count').textContent = `${rows.length} of ${R.board_size} protocols shown`;
  document.querySelectorAll('#board-table th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
  });
}

function fillFilters() {
  const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
  $('f-category').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  $('f-chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');
  if (state.category) $('f-category').value = state.category;
  if (state.chain) $('f-chain').value = state.chain;
  if (state.watch) $('f-watch').checked = true;
  if (state.minTvl) $('f-tvl').value = String(state.minTvl);
  if (state.q) $('q').value = state.q;
}

/* ---------- detail ---------- */
function factorRow(label, note, mult, scale) {
  const pct = Math.max(2, Math.min(100, (mult / scale) * 100));
  return `<div class="factor"><span>${esc(label)}<br><small style="color:var(--faint)">${esc(note)}</small></span><span class="bar"><i style="width:${pct}%"></i></span><span class="val">${fmtMult(mult)}</span></div>`;
}

function renderDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  const box = $('view-detail');
  if (!r) {
    box.innerHTML = '<button type="button" class="back" data-nav="board">← Back to the board</button><p>No such protocol on the board.</p>';
    return;
  }
  const m = r.model;
  const peers = R.peers[r.category ?? '(uncategorised)'] ?? [];
  const basisText = { category: `the median of its ${esc(r.category ?? '')} peers`, family: 'the median of its category family', market: 'the median of the whole market' }[m.multiple_basis];
  box.innerHTML = `
    <button type="button" class="back" data-nav="board">← Back to the board</button>
    <div class="detail-head">
      <div>
        <h2>${esc(r.name)}${r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : ''}</h2>
        <p class="detail-sub">${esc(r.slug)} · ${esc(r.category ?? 'Uncategorised')} · rank ${r.rank} of ${R.board_size} · records no token in the snapshot</p>
      </div>
    </div>
    <dl class="detail-grid">
      <div class="fact"><dt>Implied value</dt><dd>${fmtUsd(r.implied_value_usd)}</dd></div>
      <div class="fact"><dt>TVL</dt><dd>${fmtUsd(r.tvl_usd)}</dd></div>
      <div class="fact"><dt>7-day TVL change</dt><dd>${fmtPct(r.change_7d)}</dd></div>
      <div class="fact"><dt>Tokenless for</dt><dd>${fmtAge(r.age_days)}${r.listed_at ? ` <small>since ${esc(r.listed_at)}</small>` : ''}</dd></div>
      <div class="fact"><dt>Radar score</dt><dd>${r.radar_score} <small>/ 100</small></dd></div>
      <div class="fact"><dt>Chains</dt><dd style="font-size:14px;font-weight:500">${esc(r.chains.join(', ') || '—')}</dd></div>
    </dl>
    <div class="panel">
      <h3>How the model prices ${esc(r.name)}</h3>
      <p>Implied value = TVL × peer multiple × momentum × longevity × breadth. The peer multiple is ${basisText}: no flat constant, and no protocol is priced by name.</p>
      ${factorRow('Peer multiple', `cap / TVL, ${m.multiple_basis}`, m.peer_multiple, 1.2)}
      ${factorRow('Momentum', `7d TVL ${fmtPct(r.change_7d)}`, m.momentum_multiplier, 1.3)}
      ${factorRow('Longevity', `${fmtAge(r.age_days)} with no token`, m.longevity_multiplier, 1.15)}
      ${factorRow('Breadth', `${r.chains.length} chain${r.chains.length === 1 ? '' : 's'}`, m.breadth_multiplier, 1.1)}
      ${peers.length ? `<table class="peers"><thead><tr><th>Launched peer</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Cap / TVL</th></tr></thead><tbody>
        ${peers.map((p) => `<tr><td>${esc(p.name)} <span style="color:var(--faint)">${esc(p.symbol ?? '')}</span></td><td class="num">${fmtUsd(p.tvl_usd)}</td><td class="num">${fmtUsd(p.mcap_usd)}</td><td class="num">${fmtMult(p.ratio)}</td></tr>`).join('')}
      </tbody></table>` : ''}
    </div>
    <div class="panel">
      <h3>The farm plan</h3>
      <p>Six steps, sized from this protocol's own TVL, age and main chain. Costs are the plan's estimates at ordinary congestion, in the wallet's own funds.</p>
      <ol class="steps">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    </div>`;
}

/* ---------- live ---------- */
function renderLive() {
  $('live-body').innerHTML = R.live.map((p) => {
    const chg = p.change_7d === null ? '' : p.change_7d >= 0 ? 'up' : 'down';
    return `<tr><td><span class="name">${esc(p.name)}</span> <span style="color:var(--faint)">${esc(p.symbol ?? '')}</span><span class="slug">${esc(p.slug)}</span></td>
      <td>${esc(p.category ?? '—')}</td><td class="num">${fmtUsd(p.tvl_usd)}</td><td class="num">${fmtUsd(p.mcap_usd)}</td>
      <td class="num ${chg}">${fmtPct(p.change_7d)}</td><td class="num">${p.ratio === null ? '—' : fmtMult(p.ratio)}</td></tr>`;
  }).join('');
}

/* ---------- model ---------- */
function renderModel() {
  const m = R.model;
  $('model-text').innerHTML = `
    <h2>How the model prices a launch</h2>
    <p>The radar asks one question of every protocol that records no token: if it launched today, what would the market plausibly pay? It answers from the snapshot's own figures — never from a hardcoded list of names, and the same function scores every row.</p>
    <div class="formula">
      multiple&nbsp;&nbsp;= median market-cap / TVL of the category's launched peers<br>
      base&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;= TVL × multiple<br>
      momentum&nbsp;&nbsp;= 1 + clamp(7d change, ${m.momentum_floor_pct}%, ${m.momentum_cap_pct}%) × ${m.momentum_weight}<br>
      longevity&nbsp;= ${m.longevity_floor} + ${m.longevity_range} × min(tokenless days, ${m.longevity_days}) / ${m.longevity_days}<br>
      breadth&nbsp;&nbsp;&nbsp;= 1 + ${m.breadth_per_chain} × extra chains (max ${m.breadth_max_extra_chains})<br>
      implied&nbsp;&nbsp;&nbsp;= base × momentum × longevity × breadth
    </div>
    <p><strong>Why peers?</strong> A flat multiple prices a lending market like a DEX. Launched protocols in the same category show what the market actually pays per dollar of TVL, so the board borrows that price. A category with fewer than ${m.min_peers} launched peers borrows its family's median; a family with too few borrows the whole market's.</p>
    <p><strong>Who is on the board?</strong> Every protocol whose snapshot record shows no token — no market cap, no CoinGecko id, no symbol — minus the wrapped, staked, bridged and exchange products of tokens that already trade, and minus later versions of a protocol. The snapshot's watchlist (TVL at or above ${fmtUsd(R.floor_usd)}) is the floor: all ${R.watchlist_size} are ranked, and so is every rankable protocol below the floor, ${R.board_size} rows in all. Protocols that already trade are never ranked; the largest are shown under “Already trading” as the yardstick.</p>
    <p><strong>The radar score</strong> blends the implied value's log position on the board (60%), the momentum factor (20%) and the longevity factor (20%) into 0–100, so a reader can spot a fast-rising young protocol beside the giants the value ranking puts first.</p>
    <h3>Category multiples in this snapshot</h3>
    <table class="mult"><thead><tr><th>Category</th><th>Basis</th><th class="num">Launched peers</th><th class="num">Median cap / TVL</th></tr></thead>
    <tbody>${R.categories.map((c) => `<tr><td>${esc(c.category)}</td><td>${esc(c.basis)}</td><td class="num">${c.peers}</td><td class="num">${fmtMult(c.multiple)}</td></tr>`).join('')}</tbody></table>`;
}

/* ---------- routing ---------- */
function show(view) {
  state.view = view;
  for (const v of ['board', 'live', 'model', 'detail']) $('view-' + v).hidden = v !== view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view || (view === 'detail' && t.dataset.view === 'board')));
  window.scrollTo(0, 0);
}
function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, query] = hash.split('?');
  const params = new URLSearchParams(query ?? '');
  if (path.startsWith('protocol/')) {
    state.slug = decodeURIComponent(path.slice('protocol/'.length));
    renderDetail(state.slug);
    show('detail');
  } else if (path === 'live') {
    renderLive();
    show('live');
  } else if (path === 'model') {
    renderModel();
    show('model');
  } else {
    if (params.has('category')) state.category = params.get('category');
    if (params.has('chain')) state.chain = params.get('chain');
    if (params.has('watch')) state.watch = params.get('watch') === '1';
    if (params.has('q')) state.q = params.get('q');
    fillFilters();
    renderBoard();
    show('board');
  }
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { location.hash = t.dataset.view === 'board' ? '#/' : `#/${t.dataset.view}`; }));
document.querySelectorAll('#board-table th').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.sort;
  if (state.sortKey === k) state.sortDir *= -1;
  else { state.sortKey = k; state.sortDir = k === 'name' || k === 'category' || k === 'rank' ? 1 : -1; }
  renderBoard();
}));
$('board-body').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-slug]');
  if (tr) location.hash = `#/protocol/${encodeURIComponent(tr.dataset.slug)}`;
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-nav="board"]');
  if (b) location.hash = '#/';
});
$('q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
$('f-category').addEventListener('change', (e) => { state.category = e.target.value; renderBoard(); });
$('f-chain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
$('f-tvl').addEventListener('change', (e) => { state.minTvl = Number(e.target.value); renderBoard(); });
$('f-watch').addEventListener('change', (e) => { state.watch = e.target.checked; renderBoard(); });
window.addEventListener('hashchange', route);

renderStats();
fillFilters();
route();
