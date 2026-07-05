const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const POLYMARKET_US_API = "https://gateway.polymarket.us/v1";

export const DEFAULT_CONFIG = Object.freeze({
  targetEligibleTraders: 50,
  leaderboardBatchSize: 50,
  maxLeaderboardOffset: 1000,
  positionsPageSize: 500,
  positionSizeThreshold: 1,
  requestConcurrency: 6,
  minSharedSupporters: 2,
  recommendationCount: 5,
  maxMarketChecks: 150,
  requireUsAvailable: true,
  useCachedUsMarkets: true,
  usMarketsPageSize: 250,
  usMarketsMaxOffset: 20000
});

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJson(url, options = {}) {
  const {
    retries = 4,
    timeoutMs = 30_000,
    fetchImpl = globalThis.fetch
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Signal50/1.0 (+daily public-market research)"
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(
          `HTTP ${response.status} for ${url}${body ? `: ${body.slice(0, 180)}` : ""}`
        );
        error.status = response.status;
        throw error;
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      const retryable =
        error?.name === "AbortError" ||
        !error?.status ||
        error.status === 429 ||
        error.status >= 500;

      if (!retryable || attempt === retries) {
        throw error;
      }

      const backoff = Math.min(15_000, 700 * 2 ** attempt) + Math.floor(Math.random() * 350);
      await sleep(backoff);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error(`Request failed for ${url}`);
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positionIdentity(position) {
  if (position.outcomeIndex !== undefined && position.outcomeIndex !== null) {
    return String(position.outcomeIndex);
  }
  if (position.asset) return String(position.asset);
  return String(position.outcome ?? "unknown").toLowerCase();
}

export function isOpenPosition(position) {
  return (
    position &&
    number(position.size) > 0 &&
    number(position.currentValue, number(position.size) * number(position.curPrice)) > 0 &&
    position.redeemable !== true
  );
}

export function normalizePositions(positions) {
  return (Array.isArray(positions) ? positions : []).filter(isOpenPosition);
}

export function hasBothOutcomes(positions) {
  const outcomesByMarket = new Map();

  for (const position of normalizePositions(positions)) {
    const conditionId = String(position.conditionId ?? "");
    if (!conditionId) continue;
    if (!outcomesByMarket.has(conditionId)) {
      outcomesByMarket.set(conditionId, new Set());
    }
    outcomesByMarket.get(conditionId).add(positionIdentity(position));
  }

  return [...outcomesByMarket.values()].some((outcomes) => outcomes.size > 1);
}

export async function fetchLeaderboardBatch(offset, config = DEFAULT_CONFIG, fetchImpl = globalThis.fetch) {
  const params = new URLSearchParams({
    category: "OVERALL",
    timePeriod: "ALL",
    orderBy: "PNL",
    limit: String(config.leaderboardBatchSize),
    offset: String(offset)
  });

  const data = await fetchJson(`${DATA_API}/v1/leaderboard?${params}`, { fetchImpl });
  return Array.isArray(data) ? data : [];
}

export async function fetchAllCurrentPositions(wallet, config = DEFAULT_CONFIG, fetchImpl = globalThis.fetch) {
  const all = [];

  for (let offset = 0; offset <= 10_000; offset += config.positionsPageSize) {
    const params = new URLSearchParams({
      user: wallet,
      sizeThreshold: String(config.positionSizeThreshold),
      redeemable: "false",
      limit: String(config.positionsPageSize),
      offset: String(offset),
      sortBy: "CURRENT",
      sortDirection: "DESC"
    });

    const page = await fetchJson(`${DATA_API}/positions?${params}`, { fetchImpl });
    const rows = Array.isArray(page) ? page : [];
    all.push(...rows);
    if (rows.length < config.positionsPageSize) break;
  }

  return normalizePositions(all);
}

export async function collectEligibleTraders(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const onProgress = options.onProgress ?? (() => {});
  const eligible = [];
  const stats = {
    leaderboardUsersInspected: 0,
    skippedNoPositions: 0,
    excludedBothOutcomes: 0,
    positionFetchErrors: 0
  };

  for (
    let offset = 0;
    offset <= config.maxLeaderboardOffset && eligible.length < config.targetEligibleTraders;
    offset += config.leaderboardBatchSize
  ) {
    const batch = await fetchLeaderboardBatch(offset, config, fetchImpl);
    if (batch.length === 0) break;

    const results = await mapWithConcurrency(
      batch,
      config.requestConcurrency,
      async (trader) => {
        try {
          const positions = await fetchAllCurrentPositions(trader.proxyWallet, config, fetchImpl);
          return { trader, positions, error: null };
        } catch (error) {
          return { trader, positions: [], error };
        }
      }
    );

    for (const result of results) {
      if (eligible.length >= config.targetEligibleTraders) break;
      stats.leaderboardUsersInspected += 1;

      if (result.error) {
        stats.positionFetchErrors += 1;
        continue;
      }

      if (result.positions.length === 0) {
        stats.skippedNoPositions += 1;
        continue;
      }

      if (hasBothOutcomes(result.positions)) {
        stats.excludedBothOutcomes += 1;
        continue;
      }

      eligible.push({
        rank: number(result.trader.rank, stats.leaderboardUsersInspected),
        wallet: result.trader.proxyWallet,
        userName: result.trader.userName || "",
        pnl: number(result.trader.pnl),
        volume: number(result.trader.vol),
        profileImage: result.trader.profileImage || "",
        verifiedBadge: Boolean(result.trader.verifiedBadge),
        positions: result.positions
      });
    }

    onProgress({ eligible: eligible.length, stats: { ...stats }, offset });
  }

  return { eligible, stats };
}

function displayName(trader) {
  if (trader.userName) return trader.userName;
  const wallet = String(trader.wallet ?? "");
  return wallet.length > 10 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet || "Unknown";
}

function weightedAverage(values) {
  const totalWeight = values.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (totalWeight <= 0) return 0;
  return values.reduce((sum, item) => sum + item.value * Math.max(0, item.weight), 0) / totalWeight;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function buildMarketCandidates(eligible, config = DEFAULT_CONFIG) {
  const markets = new Map();

  for (const trader of eligible) {
    for (const position of trader.positions) {
      const conditionId = String(position.conditionId ?? "");
      if (!conditionId) continue;

      const outcomeKey = positionIdentity(position);
      if (!markets.has(conditionId)) {
        markets.set(conditionId, {
          conditionId,
          title: position.title || "Untitled market",
          slug: position.slug || "",
          eventSlug: position.eventSlug || "",
          icon: position.icon || "",
          endDate: position.endDate || "",
          sides: new Map()
        });
      }

      const market = markets.get(conditionId);
      if (!market.sides.has(outcomeKey)) {
        market.sides.set(outcomeKey, {
          outcomeKey,
          outcome: position.outcome || `Outcome ${outcomeKey}`,
          supporters: [],
          supporterWallets: new Set(),
          totalCurrentValue: 0,
          totalSize: 0,
          entryPrices: [],
          currentPrices: [],
          rankWeight: 0
        });
      }

      const side = market.sides.get(outcomeKey);
      const positionValue = number(
        position.currentValue,
        number(position.size) * number(position.curPrice)
      );
      const existingSupporter = side.supporters.find(
        (supporter) => supporter.wallet === trader.wallet
      );

      if (existingSupporter) {
        existingSupporter.currentValue += positionValue;
        existingSupporter.size += number(position.size);
        existingSupporter.pnl += number(position.cashPnl);
      } else {
        side.supporters.push({
          rank: trader.rank,
          name: displayName(trader),
          wallet: trader.wallet,
          currentValue: positionValue,
          size: number(position.size),
          avgPrice: number(position.avgPrice),
          pnl: number(position.cashPnl)
        });
        side.supporterWallets.add(trader.wallet);
        side.rankWeight += 1 / Math.sqrt(Math.max(1, number(trader.rank, 1)));
      }

      side.totalCurrentValue += positionValue;
      side.totalSize += number(position.size);
      side.entryPrices.push({ value: number(position.avgPrice), weight: number(position.size) });
      side.currentPrices.push(number(position.curPrice));
    }
  }

  const candidates = [];

  for (const market of markets.values()) {
    const sides = [...market.sides.values()].sort((a, b) => {
      if (b.supporters.length !== a.supporters.length) {
        return b.supporters.length - a.supporters.length;
      }
      if (b.rankWeight !== a.rankWeight) return b.rankWeight - a.rankWeight;
      return b.totalCurrentValue - a.totalCurrentValue;
    });

    const winner = sides[0];
    if (!winner || winner.supporters.length < config.minSharedSupporters) continue;

    const opposingSupporters = sides
      .slice(1)
      .reduce((sum, side) => sum + side.supporters.length, 0);

    if (winner.supporters.length <= opposingSupporters) continue;

    const involved = winner.supporters.length + opposingSupporters;
    candidates.push({
      conditionId: market.conditionId,
      title: market.title,
      slug: market.slug,
      eventSlug: market.eventSlug,
      icon: market.icon,
      endDate: market.endDate,
      outcome: winner.outcome,
      outcomeKey: winner.outcomeKey,
      supporterCount: winner.supporters.length,
      opposingSupporters,
      consensusRate: involved > 0 ? winner.supporters.length / involved : 1,
      totalCurrentValue: winner.totalCurrentValue,
      avgEntryPrice: weightedAverage(winner.entryPrices),
      currentPrice: median(winner.currentPrices),
      rankWeight: winner.rankWeight,
      supporters: winner.supporters.sort((a, b) => a.rank - b.rank)
    });
  }

  return candidates.sort((a, b) => {
    if (b.supporterCount !== a.supporterCount) return b.supporterCount - a.supporterCount;
    if (b.consensusRate !== a.consensusRate) return b.consensusRate - a.consensusRate;
    if (b.rankWeight !== a.rankWeight) return b.rankWeight - a.rankWeight;
    return b.totalCurrentValue - a.totalCurrentValue;
  });
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function fetchMarketMetadata(slug, fetchImpl = globalThis.fetch) {
  if (!slug) return null;
  return fetchJson(`${GAMMA_API}/markets/slug/${encodeURIComponent(slug)}`, { fetchImpl });
}

export async function fetchUsMarketMetadata(slug, fetchImpl = globalThis.fetch) {
  if (!slug) return null;
  const data = await fetchJson(`${POLYMARKET_US_API}/market/slug/${encodeURIComponent(slug)}`, {
    fetchImpl
  });
  return data?.market ?? data ?? null;
}

function normalizeSlug(slug) {
  return String(slug ?? "").trim().toLowerCase();
}

function extractMarketsPayload(data) {
  if (Array.isArray(data?.markets)) return data.markets;
  if (Array.isArray(data?.data)) return data.data;
  return Array.isArray(data) ? data : [];
}

export async function fetchUsMarketsPage(offset = 0, config = DEFAULT_CONFIG, fetchImpl = globalThis.fetch) {
  const params = new URLSearchParams({
    limit: String(config.usMarketsPageSize),
    offset: String(offset),
    active: "true",
    closed: "false",
    archived: "false",
    includeHidden: "false"
  });

  const data = await fetchJson(`${POLYMARKET_US_API}/markets?${params}`, { fetchImpl });
  return extractMarketsPayload(data);
}

export async function fetchAllUsMarkets(config = DEFAULT_CONFIG, fetchImpl = globalThis.fetch, onProgress = () => {}) {
  const markets = [];

  for (let offset = 0; offset <= config.usMarketsMaxOffset; offset += config.usMarketsPageSize) {
    const rows = await fetchUsMarketsPage(offset, config, fetchImpl);
    markets.push(...rows);
    onProgress({ offset, fetched: rows.length, total: markets.length });
    if (rows.length < config.usMarketsPageSize) break;
  }

  return markets;
}

function compactUsMarket(market) {
  return {
    id: market?.id ?? null,
    slug: market?.slug ?? "",
    question: market?.question || market?.title || "",
    title: market?.title || market?.question || "",
    category: market?.category || "Other",
    image: market?.image || market?.icon || "",
    icon: market?.icon || market?.image || "",
    endDate: market?.endDate || market?.endDateIso || "",
    endDateIso: market?.endDateIso || market?.endDate || "",
    active: market?.active,
    closed: market?.closed,
    archived: market?.archived,
    hidden: market?.hidden,
    marketSides: Array.isArray(market?.marketSides)
      ? market.marketSides.map((side) => ({
          id: side?.id ?? null,
          identifier: side?.identifier ?? "",
          description: side?.description ?? "",
          long: side?.long,
          price: side?.price,
          tradable: side?.tradable
        }))
      : [],
    liquidity: market?.liquidity,
    liquidityNum: market?.liquidityNum,
    volume: market?.volume,
    volume24hr: market?.volume24hr,
    minimumTradeQty: market?.minimumTradeQty,
    orderPriceMinTickSize: market?.orderPriceMinTickSize,
    updatedAt: market?.updatedAt || ""
  };
}

export async function buildUsMarketSnapshot(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const markets = await fetchAllUsMarkets(config, fetchImpl, options.onProgress);
  const tradableMarkets = markets
    .filter((market) => normalizeSlug(market?.slug) && isUsTradeableMarket(market))
    .map(compactUsMarket)
    .sort((a, b) => normalizeSlug(a.slug).localeCompare(normalizeSlug(b.slug)));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: "https://gateway.polymarket.us/v1/markets",
    marketCount: tradableMarkets.length,
    markets: tradableMarkets
  };
}

export function createUsMarketLookup(snapshot) {
  const lookup = new Map();
  const rows = Array.isArray(snapshot?.markets) ? snapshot.markets : [];

  for (const market of rows) {
    const slug = normalizeSlug(market?.slug);
    if (slug && isUsTradeableMarket(market)) {
      lookup.set(slug, market);
    }
  }

  return lookup;
}

export function findUsMarketBySlug(snapshotOrLookup, slug) {
  const key = normalizeSlug(slug);
  if (!key || !snapshotOrLookup) return null;
  const lookup = snapshotOrLookup instanceof Map ? snapshotOrLookup : createUsMarketLookup(snapshotOrLookup);
  return lookup.get(key) ?? null;
}

export function isTradeableMarket(metadata) {
  return Boolean(
    metadata &&
    metadata.active !== false &&
    metadata.closed !== true &&
    metadata.archived !== true &&
    metadata.acceptingOrders !== false
  );
}

export function isUsTradeableMarket(metadata) {
  const sides = Array.isArray(metadata?.marketSides) ? metadata.marketSides : [];
  const hasTradableSide = sides.length === 0 || sides.some((side) => side?.tradable !== false);

  return Boolean(
    metadata &&
    metadata.active !== false &&
    metadata.closed !== true &&
    metadata.archived !== true &&
    metadata.hidden !== true &&
    hasTradableSide
  );
}

export function distinctMarketKey(candidate, metadata = null) {
  const metadataEvents = Array.isArray(metadata?.events) ? metadata.events : [];
  const metadataEventSlug = metadataEvents.find((event) => event?.slug)?.slug || metadata?.eventSlug || "";
  const eventSlug = String(metadataEventSlug || candidate?.eventSlug || "").trim().toLowerCase();

  // A Polymarket event can contain several binary child markets, such as one
  // Yes/No market for each possible winner. Treat those child markets as one
  // recommendation family so the final five cards represent five different events.
  if (eventSlug) return `event:${eventSlug}`;

  const conditionId = String(candidate?.conditionId || "").trim().toLowerCase();
  if (conditionId) return `condition:${conditionId}`;

  return `slug:${String(candidate?.slug || candidate?.title || "unknown").trim().toLowerCase()}`;
}

export function enrichCandidate(candidate, metadata, usMetadata = null) {
  const outcomes = parseJsonArray(metadata?.outcomes);
  const outcomePrices = parseJsonArray(metadata?.outcomePrices).map((value) => number(value, NaN));
  const outcomeIndex = outcomes.findIndex(
    (outcome) => String(outcome).toLowerCase() === String(candidate.outcome).toLowerCase()
  );
  const metadataPrice = outcomeIndex >= 0 ? outcomePrices[outcomeIndex] : NaN;

  const displayMetadata = usMetadata || metadata || {};

  return {
    ...candidate,
    title: displayMetadata?.question || displayMetadata?.title || candidate.title,
    category: displayMetadata?.category || metadata?.category || "Other",
    icon: displayMetadata?.icon || displayMetadata?.image || candidate.icon,
    endDate: displayMetadata?.endDateIso || displayMetadata?.endDate || candidate.endDate,
    currentPrice: Number.isFinite(metadataPrice) ? metadataPrice : candidate.currentPrice,
    liquidity: number(displayMetadata?.liquidityNum, number(displayMetadata?.liquidity)),
    volume24hr: number(displayMetadata?.volume24hr),
    usAvailable: Boolean(usMetadata),
    marketUrl: usMetadata
      ? `https://polymarket.us/market/${candidate.slug}`
      : candidate.eventSlug
        ? `https://polymarket.com/event/${candidate.eventSlug}`
        : `https://polymarket.com/market/${candidate.slug}`
  };
}

export async function selectRecommendations(eligible, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const candidates = buildMarketCandidates(eligible, config);
  const recommendations = [];
  const selectedMarketKeys = new Set();
  const usMarketLookup =
    config.requireUsAvailable && config.useCachedUsMarkets && options.usMarketSnapshot
      ? createUsMarketLookup(options.usMarketSnapshot)
      : null;
  let marketsChecked = 0;

  for (let index = 0; index < candidates.length && marketsChecked < config.maxMarketChecks; ) {
    const chunk = candidates.slice(index, index + config.requestConcurrency);
    const metadataRows = await mapWithConcurrency(
      chunk,
      config.requestConcurrency,
      async (candidate) => {
        try {
          return await fetchMarketMetadata(candidate.slug, fetchImpl);
        } catch {
          return null;
        }
      }
    );

    const usMetadataRows = await mapWithConcurrency(
      chunk,
      config.requestConcurrency,
      async (candidate) => {
        if (!config.requireUsAvailable) return null;

        if (usMarketLookup) {
          return findUsMarketBySlug(usMarketLookup, candidate.slug);
        }

        try {
          return await fetchUsMarketMetadata(candidate.slug, fetchImpl);
        } catch {
          return null;
        }
      }
    );

    for (let i = 0; i < chunk.length; i += 1) {
      marketsChecked += 1;
      const internationalIsTradeable = isTradeableMarket(metadataRows[i]);
      const usIsTradeable = !config.requireUsAvailable || isUsTradeableMarket(usMetadataRows[i]);

      if (internationalIsTradeable && usIsTradeable) {
        const marketKey = distinctMarketKey(chunk[i], metadataRows[i]);

        // Keep only the strongest-ranked child market from each Polymarket event.
        // This prevents the five cards from being the same event expressed through
        // several outcome-specific binary markets.
        if (!selectedMarketKeys.has(marketKey)) {
          selectedMarketKeys.add(marketKey);
          recommendations.push(enrichCandidate(chunk[i], metadataRows[i], usMetadataRows[i]));
        }
      }
      if (recommendations.length >= config.recommendationCount) break;
    }

    if (recommendations.length >= config.recommendationCount) break;
    index += chunk.length;
  }

  return {
    recommendations,
    candidateMarketCount: candidates.length,
    marketsChecked
  };
}
