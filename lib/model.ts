// Token Launch Radar — the valuation model (radar-2, "peer multiple").
//
// One sealed DefiLlama snapshot in, one ranked board out. The board ranks every protocol in the
// snapshot that records no token and is not a wrapped, staked, bridged or versioned product of one
// that trades: the snapshot's watchlist is the floor, and the board also carries every rankable
// pre-token protocol below that floor, because the early ones are the radar's whole point.
//
// The implied value is priced the way the market already prices launched peers, never from a flat
// constant and never from a list of names:
//
//   multiple   the median market-cap / TVL ratio of the token-bearing protocols in the same
//              DefiLlama category (a category with too few launched peers borrows its family's
//              median, and a family with too few borrows the whole market's median)
//   base       = tvl_usd x multiple
//   momentum   = 1 + clamp(change_7d, -40, 60) / 100 x 0.5      (a week of TVL flow, damped)
//   longevity  = 0.85 + 0.30 x min(age_days, 1460) / 1460       (years run with no token)
//   breadth    = 1 + 0.02 x min(chains - 1, 5)                   (distribution across chains)
//   implied    = max(1, round(base x momentum x longevity x breadth))
//
// Every figure comes from the snapshot's own ten fields, the same function scores every row, and
// the run is deterministic: no clock, no network, no randomness — the as_of date is the snapshot's.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it and the board's rows carry it. */
export const MODEL_VERSION = 'radar-2 peer-multiple';

/** The model's constants, stated in the dashboard so a reader can re-derive any row by hand. */
export const MODEL = {
  min_peers: 4,
  min_peer_tvl_usd: 5_000_000,
  momentum_weight: 0.5,
  momentum_floor_pct: -40,
  momentum_cap_pct: 60,
  longevity_floor: 0.85,
  longevity_range: 0.3,
  longevity_days: 1460,
  unknown_age_days: 365,
  breadth_per_chain: 0.02,
  breadth_max_extra_chains: 5,
};

/** Categories whose products are claims on another protocol's token, never a launch of their own. */
const WRAPPER_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A name ending in a release marker is a later version of a protocol, not a separate launch. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product of a token that already trades. */
const WRAPPER_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names that open with an exchange's name are that exchange's product, not a protocol launch. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol records no token at all in the snapshot. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token and not a wrapper, version or exchange product. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && WRAPPER_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || WRAPPER_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

const DAY_MS = 86_400_000;

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Category families: categories that price alike borrow each other's launched peers. */
const FAMILIES: { name: string; words: string[] }[] = [
  { name: 'credit', words: ['lend', 'cdp', 'collateral', 'credit', 'interest rate'] },
  { name: 'trading', words: ['dex', 'derivative', 'perpetual', 'options', 'prediction', 'otc'] },
  { name: 'yield', words: ['yield', 'farm', 'curator', 'allocator', 'liquidity manager', 'basis'] },
  { name: 'staking', words: ['staking', 'restaking', 'staking pool'] },
  { name: 'money', words: ['stable', 'payments', 'card', 'rwa', 'indexes', 'insurance'] },
];

/** The family a category belongs to, by the words in its name; null when it stands alone. */
function familyOf(category: string | null): string | null {
  if (category === null) return null;
  const c = category.toLowerCase();
  for (const f of FAMILIES) if (f.words.some((w) => c.includes(w))) return f.name;
  return null;
}

/** One launched peer the multiple was priced from: a token-bearing protocol and its market-cap / TVL ratio. */
export interface Peer {
  slug: string;
  name: string;
  symbol: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

/** The peer set behind one category's multiple: where the number came from, shown in the detail view. */
export interface PeerSet {
  basis: 'category' | 'family' | 'market';
  label: string;
  multiple: number;
  peers: Peer[];
}

/**
 * The multiple for a category: the median market-cap / TVL of its launched peers, falling back to
 * the family's median, then the whole market's, when a set holds fewer than MODEL.min_peers peers.
 */
export function peerMultiple(snapshot: Snapshot, category: string | null): PeerSet {
  const launched = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd >= MODEL.min_peer_tvl_usd,
  );
  const toPeers = (list: SnapshotProtocol[]): Peer[] =>
    list
      .map((p) => ({ slug: p.slug, name: p.name, symbol: p.symbol, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd!, ratio: p.mcap_usd! / p.tvl_usd }))
      .sort((a, b) => b.ratio - a.ratio);
  const byCategory = category === null ? [] : toPeers(launched.filter((p) => p.category === category));
  if (byCategory.length >= MODEL.min_peers) {
    return { basis: 'category', label: category!, multiple: median(byCategory.map((p) => p.ratio)), peers: byCategory };
  }
  const fam = familyOf(category);
  if (fam !== null) {
    const byFamily = toPeers(launched.filter((p) => familyOf(p.category) === fam));
    if (byFamily.length >= MODEL.min_peers) {
      return { basis: 'family', label: `${fam} family`, multiple: median(byFamily.map((p) => p.ratio)), peers: byFamily };
    }
  }
  const all = toPeers(launched);
  return { basis: 'market', label: 'whole market', multiple: median(all.map((p) => p.ratio)), peers: all };
}

/** The four factors and the implied value one protocol gets under the model. */
export interface Scored {
  implied: number;
  multiple: number;
  basis: PeerSet['basis'];
  momentum: number;
  longevity: number;
  breadth: number;
  age: number | null;
  growthPct: number;
}

/** Score one protocol: the same function for every row, from the snapshot's figures alone. */
export function score(p: SnapshotProtocol, asOf: string, peers: PeerSet): Scored {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = Math.min(MODEL.momentum_cap_pct, Math.max(MODEL.momentum_floor_pct, p.change_7d ?? 0));
  const momentum = 1 + (growthPct / 100) * MODEL.momentum_weight;
  const ageForModel = age ?? MODEL.unknown_age_days;
  const longevity = MODEL.longevity_floor + (Math.min(Math.max(ageForModel, 0), MODEL.longevity_days) / MODEL.longevity_days) * MODEL.longevity_range;
  const breadth = 1 + MODEL.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_max_extra_chains);
  const base = p.tvl_usd * peers.multiple;
  const implied = Math.max(1, Math.round(base * momentum * longevity * breadth));
  return { implied, multiple: peers.multiple, basis: peers.basis, momentum, longevity, breadth, age, growthPct };
}

/** How expensive a chain is to farm on, from its name: the plan's gas figures follow from it. */
type ChainClass = 'solana' | 'ethereum' | 'l2' | 'other';

function chainClass(chain: string): ChainClass {
  const c = chain.toLowerCase();
  if (c === 'solana') return 'solana';
  if (c === 'ethereum') return 'ethereum';
  if (['arbitrum', 'base', 'optimism', 'polygon', 'zksync era', 'linea', 'scroll', 'mantle', 'blast', 'mode', 'taiko', 'starknet'].includes(c)) return 'l2';
  return 'other';
}

const GAS_TEXT: Record<ChainClass, string> = {
  solana: 'about $0.01 of SOL in fees',
  ethereum: 'about $4 to $9 of ETH in gas at ordinary congestion',
  l2: 'under $0.50 of ETH in gas',
  other: 'about $1 to $3 of the chain gas token in fees',
};

const WEEKLY_GAS_TEXT: Record<ChainClass, string> = {
  solana: 'about $0.01 of SOL in fees',
  ethereum: 'about $4 of ETH in gas',
  l2: 'under $0.50 of ETH in gas',
  other: 'about $1 of the chain gas token in fees',
};

/** How much capital one farm position needs, from the protocol's own TVL: deeper books take more to register. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action and its weekly qualifying action, in words a farmer can follow. */
function playbook(p: SnapshotProtocol, capital: number, chain: string): { core: string; weekly: string } {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return {
      core: `Supply $${capital} of USDC to ${n} on ${chain}; if it offers a points program, borrow no more than 30% against it once so the position counts as both supply and borrow.`,
      weekly: `Rebalance the position once: repay and re-borrow a small slice, or add and withdraw $10 of collateral, so the wallet shows a fresh action each week.`,
    };
  }
  if (c.includes('dex') || c.includes('derivative') || c.includes('perpetual')) {
    return {
      core: `Provide $${capital} split evenly across ${n}'s highest-volume pool on ${chain} and make two small swaps through the same wallet so it records both liquidity and trading.`,
      weekly: `Make one swap of about $25 through ${n} and re-centre the liquidity position if its range has drifted, keeping the same wallet active every week.`,
    };
  }
  if (c.includes('bridge')) {
    return {
      core: `Bridge $${capital} of USDC from Ethereum to ${chain} through ${n}, then put the bridged funds to work in one app on the far side instead of bridging straight back.`,
      weekly: `Bridge one small transfer of about $25 through ${n} in alternating directions, and keep a balance on the far chain so the wallet reads as a user, not a passer-by.`,
    };
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield') || c.includes('farm') || c.includes('liquidity manager')) {
    return {
      core: `Deposit $${capital} into the largest ${n} vault on ${chain} and keep the vault shares in the same wallet; shares, not the deposit receipt, are what a distribution would count.`,
      weekly: `Add about $10 to the vault or move the position between two ${n} vaults once a week, and claim any rewards into the same wallet rather than a fresh one.`,
    };
  }
  if (c.includes('staking') || c.includes('restaking')) {
    return {
      core: `Stake $${capital} of the chain's staking asset through ${n} on ${chain} and hold the liquid receipt token in the staking wallet for the whole window.`,
      weekly: `Claim the week's staking rewards and restake them through ${n} once, so the wallet compounds instead of sitting idle between snapshots.`,
    };
  }
  if (c.includes('stable')) {
    return {
      core: `Mint or deposit $${capital} of the stable asset through ${n} on ${chain} and hold it in the wallet; a balance held across snapshots is the signal that counts.`,
      weekly: `Move about $25 of the stable asset between two wallets you control through ${n}'s own transfer or mint route, never through an unrelated bridge.`,
    };
  }
  if (c.includes('prediction')) {
    return {
      core: `Fund the wallet with $${capital} on ${chain} and take one position in ${n}'s most liquid market, sized small enough to hold to settlement.`,
      weekly: `Place one small position a week on ${n} and settle or roll the finished ones, building a record of real markets rather than one lucky ticket.`,
    };
  }
  if (c.includes('rwa') || c.includes('insurance') || c.includes('indexes')) {
    return {
      core: `Mint $${capital} of ${n}'s yield or cover asset on ${chain} after its own onboarding, and hold the asset in the minting wallet for the full window.`,
      weekly: `Check the position's reported yield or cover price once a week and add about $10 once a month, keeping the holding continuous across snapshots.`,
    };
  }
  if (c.includes('chain')) {
    return {
      core: `Bridge $${capital} to ${n} and use two of its native apps from the same wallet, so the address builds a real history on the chain itself.`,
      weekly: `Make one transaction a week on ${n} through its own apps — a swap, a mint or a vote — and keep a small native balance for gas at all times.`,
    };
  }
  return {
    core: `Deposit $${capital} of USDC into ${n} on ${chain} through its own app and keep the position open in that wallet for the whole window.`,
    weekly: `Repeat one small qualifying action on ${n} each week — a deposit, a claim or a vote — always from the same wallet and chain.`,
  };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page weekly.`;
  return s;
}

/**
 * A protocol's farm plan: six steps derived from its own record (category, first chain, TVL, age),
 * each with a concrete cost and duration. Nothing is written per protocol by hand.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const cls = chainClass(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const { core, weekly } = playbook(p, capital, chain);
  return [
    stepText(
      `Open a fresh wallet for ${p.name} alone and fund it from an exchange withdrawal, keeping its seed phrase offline and never reusing the address for other farms.`,
      'under $3 to fund and set up',
      '10 minutes',
    ),
    stepText(core, `$${capital} of capital plus ${GAS_TEXT[cls]}`, '15 minutes to set up'),
    stepText(weekly, `${WEEKLY_GAS_TEXT[cls]} a week`, '10 minutes a week'),
    stepText(
      `Hold the position for at least ${hold} days without emptying the wallet, so the activity stands in several weekly snapshots instead of one.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    stepText(
      `Watch ${p.name}'s own announcements for a points or rewards page, and claim only from a link the protocol itself publishes; never pay a fee to claim and never sign a claim on a look-alike site.`,
      'nothing to check; a real claim costs gas only',
      '10 minutes a week',
    ),
    stepText(
      `Log the wallet, the dates and every transaction hash in a farm log, and unwind the position if ${p.name}'s TVL falls by a third in a week or a token is announced on terms that close the farm.`,
      'nothing but the log',
      '5 minutes a week',
    ),
  ];
}

/** One row of board.json: the ranked board's row, with the model's working shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  radar_score: number;
  model: {
    peer_multiple: number;
    multiple_basis: PeerSet['basis'];
    momentum_multiplier: number;
    longevity_multiplier: number;
    breadth_multiplier: number;
    growth_pct: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The board: every rankable pre-token protocol, watchlist first-class, ranked by implied value. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const peerCache = new Map<string, PeerSet>();
  const peersFor = (category: string | null): PeerSet => {
    const key = category ?? '(none)';
    if (!peerCache.has(key)) peerCache.set(key, peerMultiple(snapshot, category));
    return peerCache.get(key)!;
  };
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => ({ p, s: score(p, snapshot.as_of, peersFor(p.category)) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const logs = scored.map((x) => Math.log(x.s.implied));
  const lo = Math.min(...logs);
  const hi = Math.max(...logs);
  return scored.map(({ p, s }, i) => {
    const logShare = hi > lo ? (Math.log(s.implied) - lo) / (hi - lo) : 1;
    const momentumNorm = (s.momentum - 0.8) / 0.5;
    const longevityNorm = (s.longevity - MODEL.longevity_floor) / MODEL.longevity_range;
    const radar = Math.max(1, Math.min(100, Math.round(100 * (0.6 * logShare + 0.2 * momentumNorm + 0.2 * longevityNorm))));
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token' as const,
      on_watchlist: watch.has(p.slug),
      age_days: s.age,
      implied_value_usd: s.implied,
      radar_score: radar,
      model: {
        peer_multiple: round4(s.multiple),
        multiple_basis: s.basis,
        momentum_multiplier: round4(s.momentum),
        longevity_multiplier: round4(s.longevity),
        breadth_multiplier: round4(s.breadth),
        growth_pct: round4(s.growthPct),
        age_days: s.age,
      },
      farm_steps: farmSteps(p, s.age),
    };
  });
}

/** A live-token protocol: it already trades, so the dashboard shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  ratio: number | null;
}

/** The dashboard's dataset: the board, the live set, the category multiples and the model itself. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: typeof MODEL;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  categories: { category: string; multiple: number; basis: PeerSet['basis']; peers: number }[];
  peers: Record<string, Peer[]>;
  rows: BoardRow[];
  live: LiveRow[];
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
  const categories = new Map<string, PeerSet>();
  for (const row of board) {
    const key = row.category ?? '(uncategorised)';
    if (!categories.has(key)) categories.set(key, peerMultiple(snapshot, row.category));
  }
  const peers: Record<string, Peer[]> = {};
  for (const [key, set] of categories) {
    // The detail view shows the five largest launched peers by TVL, not the five most extreme
    // ratios: the median already speaks for the set, and the giants are the honest yardstick.
    peers[key] = [...set.peers]
      .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
      .slice(0, 5)
      .map((x) => ({ ...x, ratio: round4(x.ratio) }));
  }
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: MODEL,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    categories: [...categories.entries()]
      .map(([category, set]) => ({ category, multiple: round4(set.multiple), basis: set.basis, peers: set.peers.length }))
      .sort((a, b) => (a.category < b.category ? -1 : 1)),
    peers,
    rows: board,
    live,
  };
  return { board, radar };
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100 the gate asks for`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
