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
  recommendationCount: 4,
  maxMarketChecks: 300,
  minEligibleBeforeRecommendations: 50,
  maxEligibleTraders: 300,
  usMatchMinScore: 0.68,
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
  const shouldStop = options.shouldStop ?? null;
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

    if (typeof shouldStop === "function") {
      const stop = await shouldStop({
        eligible,
        stats: { ...stats },
        offset
      });
      if (stop) break;
    }
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
          groupItemTitle: position.groupItemTitle || position.groupItem || position.option || position.selection || "",
          groupItemThreshold: position.groupItemThreshold || position.threshold || "",
          rawPositionTitle: position.title || "",
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
      groupItemTitle: market.groupItemTitle,
      groupItemThreshold: market.groupItemThreshold,
      rawPositionTitle: market.rawPositionTitle,
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

const MATCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "will",
  "with",
  "yes",
  "no",
  "market",
  "polymarket"
]);

export function normalizeMatchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchTokens(value) {
  return normalizeMatchText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !MATCH_STOP_WORDS.has(token));
}

function numberTokens(value) {
  return new Set(matchTokens(value).filter((token) => /^\d+$/.test(token)));
}

function yearTokens(value) {
  return new Set([...numberTokens(value)].filter((token) => /^20\d{2}$/.test(token)));
}

function setsIntersect(a, b) {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function numbersAreCompatible(a, b) {
  const yearsA = yearTokens(a);
  const yearsB = yearTokens(b);
  return yearsA.size === 0 || yearsB.size === 0 || setsIntersect(yearsA, yearsB);
}

function textSimilarity(a, b) {
  const normalizedA = normalizeMatchText(a);
  const normalizedB = normalizeMatchText(b);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;

  const tokensA = new Set(matchTokens(normalizedA));
  const tokensB = new Set(matchTokens(normalizedB));
  if (!tokensA.size || !tokensB.size) return 0;

  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union ? intersection / union : 0;
  const containment = intersection / Math.min(tokensA.size, tokensB.size);

  // Containment helps catch equivalent titles with one extra date/descriptor
  // while Jaccard keeps unrelated markets with a few shared words from matching.
  return Math.max(jaccard, containment * 0.92);
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function datesAreCompatible(candidate, metadata, usMarket) {
  const candidateDate =
    parseDate(candidate?.endDate) ||
    parseDate(metadata?.endDate) ||
    parseDate(metadata?.endDateIso) ||
    parseDate(metadata?.end_date);
  const usDate = parseDate(usMarket?.endDateIso) || parseDate(usMarket?.endDate);

  if (!candidateDate || !usDate) return true;
  const diffDays = Math.abs(candidateDate.getTime() - usDate.getTime()) / 86_400_000;
  return diffDays <= 45;
}

function uniqueTexts(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = normalizeMatchText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(String(value));
  }
  return output;
}

export function scoreUsMarketMatch(candidate, metadata, usMarket) {
  if (!candidate || !usMarket || !isUsTradeableMarket(usMarket)) return 0;
  if (!datesAreCompatible(candidate, metadata, usMarket)) return 0;

  const candidateTexts = uniqueTexts([
    candidate.slug,
    candidate.eventSlug,
    candidate.title,
    candidate.groupItemTitle,
    candidate.groupItemThreshold,
    metadata?.slug,
    metadata?.question,
    metadata?.title,
    metadata?.groupItemTitle,
    metadata?.groupItemThreshold
  ]);
  const usTexts = uniqueTexts([
    usMarket.slug,
    usMarket.question,
    usMarket.title,
    usMarket.groupItemTitle,
    usMarket.groupItemThreshold
  ]);

  let best = 0;
  for (const left of candidateTexts) {
    for (const right of usTexts) {
      if (!numbersAreCompatible(left, right)) continue;
      best = Math.max(best, textSimilarity(left, right));
    }
  }

  return best;
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
    groupItemTitle: market?.groupItemTitle || "",
    groupItemThreshold: market?.groupItemThreshold || "",
    groupItemRange: market?.groupItemRange || "",
    marketGroup: market?.marketGroup ?? null,
    line: market?.line ?? null,
    sportsMarketType: market?.sportsMarketType || "",
    shortOutcomes: market?.shortOutcomes || "",
    outcomes: market?.outcomes || "",
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
  const bySlug = new Map();
  const markets = [];
  const rows = Array.isArray(snapshot?.markets) ? snapshot.markets : [];

  for (const market of rows) {
    if (!isUsTradeableMarket(market)) continue;
    const slug = normalizeSlug(market?.slug);
    if (slug) bySlug.set(slug, market);
    markets.push(market);
  }

  return { bySlug, markets };
}

function asUsMarketLookup(snapshotOrLookup) {
  if (!snapshotOrLookup) return null;
  if (snapshotOrLookup instanceof Map) {
    return { bySlug: snapshotOrLookup, markets: [...snapshotOrLookup.values()] };
  }
  if (snapshotOrLookup.bySlug instanceof Map && Array.isArray(snapshotOrLookup.markets)) {
    return snapshotOrLookup;
  }
  return createUsMarketLookup(snapshotOrLookup);
}

function withUsMatch(market, matchMethod, matchScore) {
  return market ? { ...market, matchMethod, matchScore } : null;
}

export function findUsMarketBySlug(snapshotOrLookup, slug) {
  const key = normalizeSlug(slug);
  const lookup = asUsMarketLookup(snapshotOrLookup);
  if (!key || !lookup) return null;
  const market = lookup.bySlug.get(key) ?? null;
  return market ? withUsMatch(market, "exact_slug", 1) : null;
}

export function findUsMarketMatch(snapshotOrLookup, candidate, metadata = null, config = DEFAULT_CONFIG) {
  const lookup = asUsMarketLookup(snapshotOrLookup);
  if (!lookup || !candidate) return null;

  const exact = findUsMarketBySlug(lookup, candidate.slug);
  if (exact) return exact;

  let best = null;
  let bestScore = 0;
  for (const market of lookup.markets) {
    const score = scoreUsMarketMatch(candidate, metadata, market);
    if (score > bestScore) {
      best = market;
      bestScore = score;
    }
  }

  if (best && bestScore >= config.usMatchMinScore) {
    return withUsMatch(best, "title_slug_similarity", Number(bestScore.toFixed(3)));
  }

  return null;
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

function normalizeDecisionSide(outcome) {
  const side = String(outcome ?? "Unknown").trim();
  if (!side) return "Unknown";
  const lower = side.toLowerCase();
  if (lower === "yes") return "YES";
  if (lower === "no") return "NO";
  return side;
}

const MONTH_NAMES = {
  jan: "January",
  january: "January",
  feb: "February",
  february: "February",
  mar: "March",
  march: "March",
  apr: "April",
  april: "April",
  may: "May",
  jun: "June",
  june: "June",
  jul: "July",
  july: "July",
  aug: "August",
  august: "August",
  sep: "September",
  sept: "September",
  september: "September",
  oct: "October",
  october: "October",
  nov: "November",
  november: "November",
  dec: "December",
  december: "December"
};

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeDecisionQuestion({ title, metadata = null, usMetadata = null } = {}) {
  // Prefer the exact child market question from Gamma/Data API. The US match can
  // be an event-level title, so using it first can hide the actual option such
  // as Round of 16 vs. Quarterfinals or July 31 vs. August 31.
  return firstNonEmpty(
    metadata?.question,
    metadata?.title,
    title,
    usMetadata?.question,
    usMetadata?.title,
    "this market"
  );
}

function formatMonthDecision(month, day, year = "") {
  const monthName = MONTH_NAMES[String(month ?? "").toLowerCase().replace(/\.$/, "")];
  if (!monthName || !day) return "";
  const cleanYear = String(year ?? "").trim();
  return `${monthName} ${Number(day)}${cleanYear ? `, ${cleanYear}` : ""}`;
}

function titleCaseOption(value) {
  const keepLower = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "vs", "v"]);
  return String(value ?? "")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word, index) => {
      if (!word) return "";
      if (/^\d+(st|nd|rd|th)?$/i.test(word)) return word.replace(/(st|nd|rd|th)$/i, "");
      if (/^20\d{2}$/.test(word)) return word;
      const lower = word.toLowerCase();
      if (index > 0 && keepLower.has(lower)) return lower;
      if (/^[A-Z]{2,}$/.test(word)) return word;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ")
    .trim();
}

function cleanOptionLabel(value) {
  const text = String(value ?? "")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-:|\s]+|[-:|\s]+$/g, "");

  if (!text) return "";
  const normalized = normalizeMatchText(text);
  if (!normalized || normalized === "yes" || normalized === "no") return "";
  if (normalized === "other" || normalized === "this market") return "";
  return text;
}

function dateDecisionFromText(value) {
  const monthDatePattern =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s\-\.]+(\d{1,2})(?:st|nd|rd|th)?(?:[,\s\-]+(20\d{2}|\d{2}))?\b/i;

  const spaced = String(value ?? "").replace(/[-_/]+/g, " ");
  const match = spaced.match(monthDatePattern);
  return match ? formatMonthDecision(match[1], match[2], match[3]) : "";
}

export function extractDecisionChoice({ title, slug, metadata = null, usMetadata = null } = {}) {
  const question = normalizeDecisionQuestion({ title, metadata, usMetadata });
  const rawTexts = uniqueTexts([
    question,
    title,
    metadata?.question,
    metadata?.title,
    metadata?.groupItemTitle,
    metadata?.groupItemThreshold,
    metadata?.slug,
    slug,
    usMetadata?.question,
    usMetadata?.title,
    usMetadata?.groupItemTitle,
    usMetadata?.groupItemThreshold,
    usMetadata?.slug
  ]);

  for (const text of rawTexts) {
    const date = dateDecisionFromText(text);
    if (date) return date;
  }

  return "";
}

function optionFromSlug({ slug, eventSlug } = {}) {
  const marketSlug = normalizeSlug(slug);
  const parentSlug = normalizeSlug(eventSlug);
  if (!marketSlug) return "";

  let suffix = "";
  if (parentSlug && marketSlug.startsWith(`${parentSlug}-`)) {
    suffix = marketSlug.slice(parentSlug.length + 1);
  }

  if (!suffix) return "";
  suffix = suffix.replace(/^(by|before|after|on|in|to)-/i, "");
  const date = dateDecisionFromText(suffix);
  if (date) return date;
  return cleanOptionLabel(titleCaseOption(suffix));
}

function optionFromQuestionPattern(question) {
  const text = String(question ?? "").trim();
  if (!text) return "";

  const date = dateDecisionFromText(text);
  if (date) return date;

  const patterns = [
    /\b(?:in|during|at)\s+(?:the\s+)?(round\s+of\s+\d+|quarterfinals?|semi[-\s]?finals?|final|championship|champion)\b/i,
    /\b(eliminated\s+in\s+(?:the\s+)?(?:round\s+of\s+\d+|quarterfinals?|semi[-\s]?finals?|final))\b/i,
    /:\s*([^?]+)\??$/,
    /[-–—]\s*([^?]+)\??$/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanOptionLabel(titleCaseOption(match[1]));
  }

  return "";
}

export 
function textContainsOption(text, option) {
  const textTokens = new Set(matchTokens(text));
  const optionTokens = matchTokens(option);
  return optionTokens.length > 0 && optionTokens.every((token) => textTokens.has(token));
}

export function extractDecisionOption({ title, slug, eventSlug, groupItemTitle = "", groupItemThreshold = "", metadata = null, usMetadata = null } = {}) {
  // groupItemTitle is the cleanest source for grouped/multi-option events. The
  // Gamma market schema documents it next to marketGroup/groupItemThreshold, and
  // it corresponds to the row/card label users select in the Polymarket UI.
  const directOption = cleanOptionLabel(
    firstNonEmpty(
      metadata?.groupItemTitle,
      metadata?.groupItemThreshold,
      groupItemTitle,
      groupItemThreshold,
      usMetadata?.groupItemTitle,
      usMetadata?.groupItemThreshold
    )
  );
  if (directOption) return directOption;

  const dateChoice = extractDecisionChoice({ title, slug, metadata, usMetadata });
  if (dateChoice) return dateChoice;

  const slugOption = optionFromSlug({ slug: metadata?.slug || slug, eventSlug });
  if (slugOption) return slugOption;

  const questionOption = optionFromQuestionPattern(
    firstNonEmpty(metadata?.question, metadata?.title, title, usMetadata?.question, usMetadata?.title)
  );
  if (questionOption) return questionOption;

  return "";
}

export function createDecisionDetails({ outcome, title, slug, eventSlug, groupItemTitle = "", groupItemThreshold = "", metadata = null, usMetadata = null } = {}) {
  const decisionSide = normalizeDecisionSide(outcome);
  const baseDecisionTarget = normalizeDecisionQuestion({ title, metadata, usMetadata });
  const decisionOption = extractDecisionOption({ title, slug, eventSlug, groupItemTitle, groupItemThreshold, metadata, usMetadata });
  const decisionChoice = decisionOption;
  const decisionTarget =
    decisionOption && !textContainsOption(baseDecisionTarget, decisionOption)
      ? `${baseDecisionTarget} — ${decisionOption}`
      : baseDecisionTarget;

  const quotedTarget = `“${decisionTarget}”`;
  const quotedOption = decisionOption ? `“${decisionOption}”` : quotedTarget;
  const decisionText = decisionOption
    ? `Select ${quotedOption} → Buy ${decisionSide}`
    : `Buy ${decisionSide} on: ${decisionTarget}`;
  let decisionMeaning;

  if (decisionOption) {
    decisionMeaning = `On Polymarket, choose the ${quotedOption} option/row/card, then click Buy ${decisionSide}. This applies only to the exact market question: ${quotedTarget}.`;
  } else if (decisionSide === "NO") {
    decisionMeaning = `NO is specifically on ${quotedTarget}. It pays only if that exact market question resolves No.`;
  } else if (decisionSide === "YES") {
    decisionMeaning = `YES is specifically on ${quotedTarget}. It pays only if that exact market question resolves Yes.`;
  } else {
    decisionMeaning = `${decisionSide} is specifically on ${quotedTarget}. Verify the market rules before acting.`;
  }

  return {
    decisionSide,
    decisionChoice,
    decisionOption,
    decisionTarget,
    decisionText,
    decisionMeaning
  };
}

export function enrichCandidate(candidate, metadata, usMetadata = null) {
  const outcomes = parseJsonArray(metadata?.outcomes);
  const outcomePrices = parseJsonArray(metadata?.outcomePrices).map((value) => number(value, NaN));
  const outcomeIndex = outcomes.findIndex(
    (outcome) => String(outcome).toLowerCase() === String(candidate.outcome).toLowerCase()
  );
  const metadataPrice = outcomeIndex >= 0 ? outcomePrices[outcomeIndex] : NaN;

  const displayMetadata = usMetadata || metadata || {};
  const displayTitle = displayMetadata?.question || displayMetadata?.title || candidate.title;
  const decisionDetails = createDecisionDetails({
    outcome: candidate.outcome,
    title: candidate.title,
    slug: candidate.slug,
    eventSlug: candidate.eventSlug,
    groupItemTitle: candidate.groupItemTitle,
    groupItemThreshold: candidate.groupItemThreshold,
    metadata,
    usMetadata
  });

  return {
    ...candidate,
    title: displayTitle,
    ...decisionDetails,
    category: displayMetadata?.category || metadata?.category || "Other",
    icon: displayMetadata?.icon || displayMetadata?.image || candidate.icon,
    endDate: displayMetadata?.endDateIso || displayMetadata?.endDate || candidate.endDate,
    currentPrice: Number.isFinite(metadataPrice) ? metadataPrice : candidate.currentPrice,
    liquidity: number(displayMetadata?.liquidityNum, number(displayMetadata?.liquidity)),
    volume24hr: number(displayMetadata?.volume24hr),
    usAvailable: Boolean(usMetadata),
    usMarketSlug: usMetadata?.slug || null,
    usMatchMethod: usMetadata?.matchMethod || null,
    usMatchScore: usMetadata?.matchScore ?? null,
    marketUrl: usMetadata
      ? `https://polymarket.us/market/${usMetadata.slug || candidate.slug}`
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
      async (candidate, candidateIndex) => {
        if (!config.requireUsAvailable) return null;

        if (usMarketLookup) {
          return findUsMarketMatch(usMarketLookup, candidate, metadataRows[candidateIndex], config);
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
