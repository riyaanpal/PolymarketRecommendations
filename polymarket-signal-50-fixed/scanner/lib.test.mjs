import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketCandidates,
  buildUsMarketSnapshot,
  createDecisionDetails,
  enrichCandidate,
  excludedSignalReason,
  extractDecisionChoice,
  extractDecisionOption,
  hasBothOutcomes,
  isCryptoMarket,
  isIranMarket,
  isTradeableMarket,
  isUsTradeableMarket,
  normalizeMatchText,
  scoreUsMarketMatch,
  selectRecommendations,
  traderVisibleAccountValue
} from "./lib.mjs";

function position(overrides = {}) {
  return {
    conditionId: "market-a",
    outcomeIndex: 0,
    outcome: "Yes",
    size: 10,
    currentValue: 6,
    avgPrice: 0.5,
    curPrice: 0.6,
    redeemable: false,
    title: "Will A happen?",
    slug: "will-a-happen",
    eventSlug: "a-event",
    ...overrides
  };
}

function trader(rank, positions) {
  return {
    rank,
    wallet: `0x${String(rank).padStart(40, "0")}`,
    userName: `Trader ${rank}`,
    positions
  };
}

test("detects a trader holding both outcomes in one market", () => {
  assert.equal(
    hasBothOutcomes([
      position({ outcomeIndex: 0, outcome: "Yes" }),
      position({ outcomeIndex: 1, outcome: "No" })
    ]),
    true
  );
  assert.equal(
    hasBothOutcomes([
      position({ outcomeIndex: 0, outcome: "Yes" }),
      position({ conditionId: "market-b", outcomeIndex: 1, outcome: "No" })
    ]),
    false
  );
});

test("selects a clear shared side and skips tied markets", () => {
  const eligible = [
    trader(1, [position()]),
    trader(2, [position()]),
    trader(3, [position({ outcomeIndex: 1, outcome: "No" })]),
    trader(4, [
      position({
        conditionId: "market-b",
        title: "Will B happen?",
        slug: "will-b-happen",
        outcomeIndex: 0,
        outcome: "Yes"
      })
    ]),
    trader(5, [
      position({
        conditionId: "market-b",
        title: "Will B happen?",
        slug: "will-b-happen",
        outcomeIndex: 1,
        outcome: "No"
      })
    ])
  ];

  const candidates = buildMarketCandidates(eligible, { minSharedSupporters: 2 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].conditionId, "market-a");
  assert.equal(candidates[0].outcome, "Yes");
  assert.equal(candidates[0].supporterCount, 2);
  assert.equal(candidates[0].opposingSupporters, 1);
});


test("does not count duplicate same-side rows as extra supporters", () => {
  const duplicate = position({ size: 4, currentValue: 2.4 });
  const candidates = buildMarketCandidates(
    [
      trader(1, [position(), duplicate]),
      trader(2, [position()])
    ],
    { minSharedSupporters: 2 }
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].supporterCount, 2);
  assert.equal(candidates[0].totalCurrentValue, 14.4);
});


test("calculates average same-side holder account allocation from visible open positions", () => {
  const eligible = [
    trader(1, [
      position({ currentValue: 25 }),
      position({
        conditionId: "other-1",
        title: "Other market 1",
        slug: "other-market-1",
        currentValue: 75
      })
    ]),
    trader(2, [
      position({ currentValue: 50 }),
      position({
        conditionId: "other-2",
        title: "Other market 2",
        slug: "other-market-2",
        currentValue: 50
      })
    ])
  ];

  assert.equal(traderVisibleAccountValue(eligible[0]), 100);

  const candidates = buildMarketCandidates(eligible, { minSharedSupporters: 2 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].avgAccountAllocation, 0.375);
  assert.equal(candidates[0].supporters[0].accountAllocation, 0.25);
  assert.equal(candidates[0].supporters[1].accountAllocation, 0.5);
});

test("requires an active, open, order-accepting market", () => {
  assert.equal(isTradeableMarket({ active: true, closed: false, acceptingOrders: true }), true);
  assert.equal(isTradeableMarket({ active: false, closed: false, acceptingOrders: true }), false);
  assert.equal(isTradeableMarket({ active: true, closed: true, acceptingOrders: true }), false);
  assert.equal(isTradeableMarket({ active: true, closed: false, acceptingOrders: false }), false);
});

test("requires a Polymarket US market that is visible and tradable", () => {
  assert.equal(
    isUsTradeableMarket({
      active: true,
      closed: false,
      archived: false,
      hidden: false,
      marketSides: [{ tradable: true }]
    }),
    true
  );
  assert.equal(
    isUsTradeableMarket({
      active: true,
      closed: false,
      archived: false,
      hidden: true,
      marketSides: [{ tradable: true }]
    }),
    false
  );
  assert.equal(
    isUsTradeableMarket({
      active: true,
      closed: false,
      archived: false,
      hidden: false,
      marketSides: [{ tradable: false }]
    }),
    false
  );
});


test("returns at most one recommendation from each Polymarket event", async () => {
  const sharedEventOne = position({
    conditionId: "event-a-market-1",
    title: "Will Candidate One win?",
    slug: "candidate-one-win",
    eventSlug: "shared-election-event",
    currentValue: 12
  });
  const sharedEventTwo = position({
    conditionId: "event-a-market-2",
    title: "Will Candidate Two win?",
    slug: "candidate-two-win",
    eventSlug: "shared-election-event",
    currentValue: 10
  });
  const differentEventOne = position({
    conditionId: "event-b-market-1",
    title: "Will Team B win?",
    slug: "team-b-win",
    eventSlug: "different-event-b",
    currentValue: 8
  });
  const differentEventTwo = position({
    conditionId: "event-c-market-1",
    title: "Will Measure C pass?",
    slug: "measure-c-pass",
    eventSlug: "different-event-c",
    currentValue: 7
  });

  const eligible = [
    trader(1, [sharedEventOne, sharedEventTwo, differentEventOne, differentEventTwo]),
    trader(2, [sharedEventOne, sharedEventTwo, differentEventOne, differentEventTwo])
  ];

  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => {
      if (String(url).includes("gateway.polymarket.us")) {
        return {
          market: {
            active: true,
            closed: false,
            archived: false,
            hidden: false,
            marketSides: [{ tradable: true }]
          }
        };
      }

      return {
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.60", "0.40"]'
      };
    }
  });

  const result = await selectRecommendations(eligible, {
    fetchImpl,
    config: {
      minSharedSupporters: 2,
      recommendationCount: 5,
      requestConcurrency: 2,
      maxMarketChecks: 20
    }
  });

  assert.equal(result.recommendations.length, 3);
  assert.equal(
    result.recommendations.filter((item) => item.eventSlug === "shared-election-event").length,
    1
  );
  assert.equal(new Set(result.recommendations.map((item) => item.eventSlug)).size, 3);
});


test("skips markets that are not listed as tradable on Polymarket US", async () => {
  const usListed = position({
    conditionId: "us-listed-market",
    slug: "us-listed-market",
    eventSlug: "us-listed-event"
  });
  const notUsListed = position({
    conditionId: "not-us-listed-market",
    slug: "not-us-listed-market",
    eventSlug: "not-us-listed-event"
  });

  const eligible = [trader(1, [notUsListed, usListed]), trader(2, [notUsListed, usListed])];

  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes("gateway.polymarket.us") && text.includes("not-us-listed-market")) {
      return { ok: false, status: 404, text: async () => "not found" };
    }

    return {
      ok: true,
      json: async () => {
        if (text.includes("gateway.polymarket.us")) {
          return {
            market: {
              question: "US listed market",
              active: true,
              closed: false,
              archived: false,
              hidden: false,
              marketSides: [{ tradable: true }]
            }
          };
        }

        return {
          active: true,
          closed: false,
          archived: false,
          acceptingOrders: true,
          outcomes: '["Yes", "No"]',
          outcomePrices: '["0.60", "0.40"]'
        };
      },
      text: async () => ""
    };
  };

  const result = await selectRecommendations(eligible, {
    fetchImpl,
    config: {
      minSharedSupporters: 2,
      recommendationCount: 5,
      requestConcurrency: 2,
      maxMarketChecks: 20,
      requireUsAvailable: true
    }
  });

  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].slug, "us-listed-market");
  assert.equal(result.recommendations[0].usAvailable, true);
});


test("builds a daily US market snapshot from the public markets endpoint", async () => {
  const pages = [
    [
      {
        slug: "active-us-market",
        question: "Active US market?",
        active: true,
        closed: false,
        archived: false,
        hidden: false,
        marketSides: [{ tradable: true }]
      },
      {
        slug: "hidden-us-market",
        question: "Hidden US market?",
        active: true,
        closed: false,
        archived: false,
        hidden: true,
        marketSides: [{ tradable: true }]
      }
    ],
    []
  ];
  let callCount = 0;
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ markets: pages[callCount++] ?? [] })
  });

  const snapshot = await buildUsMarketSnapshot({
    fetchImpl,
    config: { usMarketsPageSize: 2, usMarketsMaxOffset: 4 }
  });

  assert.equal(snapshot.marketCount, 1);
  assert.equal(snapshot.markets[0].slug, "active-us-market");
});



test("matches Polymarket US markets by title or slug similarity when exact slugs differ", async () => {
  const international = position({
    conditionId: "fed-september-market",
    slug: "will-the-fed-cut-rates-in-september-2026",
    title: "Will the Fed cut rates in September 2026?",
    eventSlug: "fed-rates-september-2026"
  });

  const eligible = [trader(1, [international]), trader(2, [international])];

  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      active: true,
      closed: false,
      archived: false,
      acceptingOrders: true,
      question: "Will the Fed cut rates in September 2026?",
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.60", "0.40"]'
    }),
    text: async () => ""
  });

  const result = await selectRecommendations(eligible, {
    fetchImpl,
    usMarketSnapshot: {
      schemaVersion: 1,
      generatedAt: "2026-07-05T00:00:00.000Z",
      marketCount: 1,
      markets: [
        {
          slug: "fed-rate-cut-september-2026",
          question: "Fed rate cut in September 2026?",
          active: true,
          closed: false,
          archived: false,
          hidden: false,
          marketSides: [{ tradable: true }]
        }
      ]
    },
    config: {
      minSharedSupporters: 2,
      recommendationCount: 4,
      requestConcurrency: 2,
      maxMarketChecks: 20,
      requireUsAvailable: true,
      useCachedUsMarkets: true,
      usMatchMinScore: 0.68
    }
  });

  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].usMarketSlug, "fed-rate-cut-september-2026");
  assert.equal(result.recommendations[0].usMatchMethod, "title_slug_similarity");
  assert.equal(
    result.recommendations[0].marketUrl,
    "https://polymarket.us/market/fed-rate-cut-september-2026"
  );
});

test("rejects weak US title matches even when one generic word overlaps", () => {
  assert.equal(normalizeMatchText("Will Trump win the 2028 election?"), "will trump win the 2028 election");

  const candidate = {
    slug: "will-trump-win-2028-election",
    title: "Will Trump win the 2028 election?",
    endDate: "2028-11-08T00:00:00Z"
  };
  const usMarket = {
    slug: "trump-republican-nomination-2028",
    question: "Will Trump win the Republican nomination in 2028?",
    endDateIso: "2028-07-01T00:00:00Z",
    active: true,
    closed: false,
    archived: false,
    hidden: false,
    marketSides: [{ tradable: true }]
  };

  assert.ok(scoreUsMarketMatch(candidate, null, usMarket) < 0.68);
});

test("uses the cached daily US market snapshot instead of per-market gateway calls", async () => {
  const usListed = position({
    conditionId: "cached-us-market",
    slug: "cached-us-market",
    eventSlug: "cached-us-event"
  });
  const notUsListed = position({
    conditionId: "not-cached-market",
    slug: "not-cached-market",
    eventSlug: "not-cached-event"
  });

  const eligible = [trader(1, [notUsListed, usListed]), trader(2, [notUsListed, usListed])];

  const fetchImpl = async (url) => {
    const text = String(url);
    assert.equal(text.includes("gateway.polymarket.us"), false);
    return {
      ok: true,
      json: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.60", "0.40"]'
      }),
      text: async () => ""
    };
  };

  const result = await selectRecommendations(eligible, {
    fetchImpl,
    usMarketSnapshot: {
      schemaVersion: 1,
      generatedAt: "2026-07-05T00:00:00.000Z",
      marketCount: 1,
      markets: [
        {
          slug: "cached-us-market",
          question: "Cached US market",
          active: true,
          closed: false,
          archived: false,
          hidden: false,
          marketSides: [{ tradable: true }]
        }
      ]
    },
    config: {
      minSharedSupporters: 2,
      recommendationCount: 5,
      requestConcurrency: 2,
      maxMarketChecks: 20,
      requireUsAvailable: true,
      useCachedUsMarkets: true
    }
  });

  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].slug, "cached-us-market");
  assert.equal(result.recommendations[0].usAvailable, true);
});

test("adds exact decision copy so NO recommendations identify the market question", async () => {
  const noPosition = position({
    outcomeIndex: 1,
    outcome: "No",
    title: "Will Team A win the championship?",
    slug: "will-team-a-win-the-championship",
    curPrice: 0.42
  });

  const eligible = [trader(1, [noPosition]), trader(2, [noPosition])];

  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      active: true,
      closed: false,
      archived: false,
      acceptingOrders: true,
      question: "Will Team A win the championship?",
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.58", "0.42"]'
    }),
    text: async () => ""
  });

  const result = await selectRecommendations(eligible, {
    fetchImpl,
    config: {
      minSharedSupporters: 2,
      recommendationCount: 4,
      requestConcurrency: 2,
      maxMarketChecks: 20,
      requireUsAvailable: false
    }
  });

  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].decisionSide, "NO");
  assert.equal(result.recommendations[0].decisionTarget, "Will Team A win the championship?");
  assert.equal(
    result.recommendations[0].decisionText,
    "Buy NO on: Will Team A win the championship?"
  );
  assert.match(result.recommendations[0].decisionMeaning, /exact market question resolves No/);
});

test("creates standalone decision details for a NO side", () => {
  const details = createDecisionDetails({
    outcome: "No",
    title: "Will the bill pass?"
  });

  assert.equal(details.decisionSide, "NO");
  assert.equal(details.decisionTarget, "Will the bill pass?");
  assert.equal(details.decisionText, "Buy NO on: Will the bill pass?");
  assert.equal(
    details.decisionMeaning,
    "NO is specifically on “Will the bill pass?”. It pays only if that exact market question resolves No."
  );
});



test("shows which date decision a NO signal applies to", async () => {
  const julyNo = position({
    conditionId: "alito-july-31",
    outcomeIndex: 1,
    outcome: "No",
    title: "Samuel Alito Announced Out as SCOTUS Justice by July 31?",
    slug: "samuel-alito-announced-out-as-scotus-justice-by-july-31",
    eventSlug: "samuel-alito-announced-out-as-scotus-justice"
  });

  const eligible = [trader(1, [julyNo]), trader(2, [julyNo])];

  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      active: true,
      closed: false,
      archived: false,
      acceptingOrders: true,
      question: "Samuel Alito Announced Out as SCOTUS Justice by July 31?",
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.60", "0.40"]'
    }),
    text: async () => ""
  });

  const result = await selectRecommendations(eligible, {
    fetchImpl,
    usMarketSnapshot: {
      schemaVersion: 1,
      generatedAt: "2026-07-05T00:00:00.000Z",
      marketCount: 1,
      markets: [
        {
          slug: "samuel-alito-announced-out-as-scotus-justice",
          question: "Samuel Alito Announced Out as SCOTUS Justice?",
          active: true,
          closed: false,
          archived: false,
          hidden: false,
          marketSides: [{ tradable: true }]
        }
      ]
    },
    config: {
      minSharedSupporters: 2,
      recommendationCount: 4,
      requestConcurrency: 2,
      maxMarketChecks: 20,
      requireUsAvailable: true,
      useCachedUsMarkets: true,
      usMatchMinScore: 0.35
    }
  });

  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].decisionSide, "NO");
  assert.equal(result.recommendations[0].decisionChoice, "July 31");
  assert.equal(
    result.recommendations[0].decisionTarget,
    "Samuel Alito Announced Out as SCOTUS Justice by July 31?"
  );
  assert.equal(result.recommendations[0].decisionOption, "July 31");
  assert.equal(result.recommendations[0].decisionText, "Select “July 31” → Buy NO");
  assert.match(result.recommendations[0].decisionMeaning, /option\/row\/card/);
});

test("extracts a date decision from a slug when the title is generic", () => {
  assert.equal(
    extractDecisionChoice({
      title: "Samuel Alito Announced Out as SCOTUS Justice?",
      slug: "samuel-alito-announced-out-as-scotus-justice-by-august-31"
    }),
    "August 31"
  );
});


test("uses Gamma groupItemTitle as the option the user should select", () => {
  const details = createDecisionDetails({
    outcome: "No",
    title: "Brazil Stage of Elimination",
    slug: "world-cup-brazil-stage-of-elimination-round-of-16",
    eventSlug: "world-cup-brazil-stage-of-elimination",
    metadata: {
      question: "Brazil Stage of Elimination",
      groupItemTitle: "Round of 16"
    }
  });

  assert.equal(details.decisionSide, "NO");
  assert.equal(details.decisionOption, "Round of 16");
  assert.equal(details.decisionText, "Select “Round of 16” → Buy NO");
  assert.match(details.decisionMeaning, /choose the “Round of 16” option\/row\/card/);
});

test("falls back to the child market slug when the title is only the event title", () => {
  assert.equal(
    extractDecisionOption({
      title: "Brazil Stage of Elimination",
      slug: "world-cup-brazil-stage-of-elimination-quarterfinals",
      eventSlug: "world-cup-brazil-stage-of-elimination"
    }),
    "Quarterfinals"
  );
});


test("does not match a US market just because the option label overlaps", () => {
  const candidate = {
    slug: "will-argentina-win-the-2026-fifa-world-cup",
    title: "Will Argentina win the 2026 FIFA World Cup?",
    groupItemTitle: "Argentina",
    endDate: "2026-07-19T00:00:00Z"
  };
  const metadata = {
    slug: "will-argentina-win-the-2026-fifa-world-cup",
    question: "Will Argentina win the 2026 FIFA World Cup?",
    groupItemTitle: "Argentina",
    endDate: "2026-07-19T00:00:00Z"
  };
  const usMarket = {
    slug: "will-argentina-advance-against-egypt-on-2026-07-07-1200pm-et",
    question: "Will Argentina advance against Egypt on 2026-07-07 12:00PM ET?",
    active: true,
    closed: false,
    archived: false,
    hidden: false,
    marketSides: [{ tradable: true }]
  };

  assert.ok(scoreUsMarketMatch(candidate, metadata, usMarket) < 0.68);
});

test("keeps the displayed title and exact question from the same market candidate", () => {
  const candidate = {
    conditionId: "bitcoin-250k",
    title: "Will Bitcoin reach $250,000 by December 31, 2026?",
    slug: "will-bitcoin-reach-250000-by-december-31-2026",
    outcome: "No",
    outcomeKey: "1",
    supporterCount: 2,
    opposingSupporters: 0,
    consensusRate: 1,
    totalCurrentValue: 100,
    avgEntryPrice: 0.9,
    currentPrice: 0.88,
    rankWeight: 1,
    supporters: []
  };
  const metadata = {
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    question: "Will Bitcoin reach $250,000 by December 31, 2026?",
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.12", "0.88"]'
  };
  const staleOrWrongUsMetadata = {
    slug: "samuel-alito-announced-out-as-scotus-justice",
    question: "Samuel Alito Announced Out as SCOTUS Justice?",
    active: true,
    closed: false,
    archived: false,
    hidden: false,
    marketSides: [{ tradable: true }]
  };

  const enriched = enrichCandidate(candidate, metadata, staleOrWrongUsMetadata);
  assert.equal(enriched.title, "Will Bitcoin reach $250,000 by December 31, 2026?");
  assert.equal(enriched.decisionTarget, "Will Bitcoin reach $250,000 by December 31, 2026?");
});


test("detects crypto markets from category, title, question, or slug", () => {
  assert.equal(isCryptoMarket({ title: "Will Bitcoin hit $150k?" }), true);
  assert.equal(isCryptoMarket({ slug: "will-eth-reach-5000" }), true);
  assert.equal(isCryptoMarket({}, { category: "Crypto" }), true);
  assert.equal(isCryptoMarket({}, { question: "Will Dogecoin reach $1?" }), true);
  assert.equal(isCryptoMarket({ title: "Will Arsenal win the Premier League?" }), false);
});

test("skips crypto markets and keeps scanning for non-crypto recommendations", async () => {
  const bitcoin = position({
    conditionId: "bitcoin-market",
    title: "Will Bitcoin reach $250,000 by December 31, 2026?",
    slug: "will-bitcoin-reach-250000-by-december-31-2026",
    eventSlug: "bitcoin-price-2026",
    currentValue: 100
  });
  const sports = position({
    conditionId: "sports-market",
    title: "Will Arsenal win the Premier League?",
    slug: "will-arsenal-win-the-premier-league",
    eventSlug: "arsenal-premier-league",
    currentValue: 50
  });

  const eligible = [trader(1, [bitcoin, sports]), trader(2, [bitcoin, sports])];

  const fetchImpl = async (url) => {
    const text = String(url);
    const isBitcoin = text.includes("bitcoin");
    return {
      ok: true,
      json: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        question: isBitcoin
          ? "Will Bitcoin reach $250,000 by December 31, 2026?"
          : "Will Arsenal win the Premier League?",
        category: isBitcoin ? "Crypto" : "Sports",
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.60", "0.40"]'
      }),
      text: async () => ""
    };
  };

  const result = await selectRecommendations(eligible, {
    fetchImpl,
    config: {
      minSharedSupporters: 2,
      recommendationCount: 2,
      requestConcurrency: 2,
      maxMarketChecks: 20,
      requireUsAvailable: false,
      excludeCryptoMarkets: true
    }
  });

  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].slug, "will-arsenal-win-the-premier-league");
});

test("flags zero displayed allocation and extreme displayed market prices", () => {
  assert.equal(
    excludedSignalReason({ avgAccountAllocation: 0.004, currentPrice: 0.55 }),
    "zero_avg_account_allocation"
  );
  assert.equal(
    excludedSignalReason({ avgAccountAllocation: 0.05, currentPrice: 0.004 }),
    "extreme_market_price_0"
  );
  assert.equal(
    excludedSignalReason({ avgAccountAllocation: 0.05, currentPrice: 0.99 }),
    "extreme_market_price_99"
  );
  assert.equal(
    excludedSignalReason({ avgAccountAllocation: 0.05, currentPrice: 1 }),
    "extreme_market_price_100"
  );
  assert.equal(
    excludedSignalReason({ avgAccountAllocation: 0.05, currentPrice: 0.55 }),
    ""
  );
});

test("skips recommendations with 0% allocation or 0%, 99%, or 100% displayed price", async () => {
  const tinyAllocation = position({
    conditionId: "tiny-allocation-market",
    title: "Will tiny allocation happen?",
    slug: "will-tiny-allocation-happen",
    eventSlug: "tiny-allocation-event",
    currentValue: 1,
    curPrice: 0.55
  });
  const extremePrice = position({
    conditionId: "extreme-price-market",
    title: "Will extreme price happen?",
    slug: "will-extreme-price-happen",
    eventSlug: "extreme-price-event",
    currentValue: 99,
    curPrice: 0.99
  });
  const valid = position({
    conditionId: "valid-market",
    title: "Will valid market happen?",
    slug: "will-valid-market-happen",
    eventSlug: "valid-event",
    currentValue: 40,
    curPrice: 0.55
  });

  const eligible = [
    trader(1, [
      tinyAllocation,
      extremePrice,
      valid,
      position({ conditionId: "large-private-denominator-1", slug: "other-1", title: "Other 1", currentValue: 999 })
    ]),
    trader(2, [
      tinyAllocation,
      extremePrice,
      valid,
      position({ conditionId: "large-private-denominator-2", slug: "other-2", title: "Other 2", currentValue: 999 })
    ])
  ];

  const fetchImpl = async (url) => {
    const text = String(url);
    let price = "0.55";
    if (text.includes("extreme-price")) price = "0.99";
    return {
      ok: true,
      json: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        question: text.includes("tiny-allocation")
          ? "Will tiny allocation happen?"
          : text.includes("extreme-price")
            ? "Will extreme price happen?"
            : "Will valid market happen?",
        outcomes: '["Yes", "No"]',
        outcomePrices: `["${price}", "${(1 - Number(price)).toFixed(2)}"]`
      }),
      text: async () => ""
    };
  };

  const result = await selectRecommendations(eligible, {
    fetchImpl,
    config: {
      minSharedSupporters: 2,
      recommendationCount: 3,
      requestConcurrency: 3,
      maxMarketChecks: 20,
      requireUsAvailable: false,
      excludeCryptoMarkets: true,
      excludeZeroAvgAccountAllocation: true,
      excludeExtremeMarketPrices: true
    }
  });

  assert.deepEqual(result.recommendations.map((item) => item.slug), ["will-valid-market-happen"]);
  assert.equal(Math.round(result.recommendations[0].avgAccountAllocation * 100) > 0, true);
  assert.equal(Math.round(result.recommendations[0].currentPrice * 100), 55);
});



test("detects Iran markets from title, question, slug, or category", () => {
  assert.equal(isIranMarket({ title: "Will Iran and Israel reach a ceasefire?" }), true);
  assert.equal(isIranMarket({ slug: "will-iran-nuclear-talks-resume" }), true);
  assert.equal(isIranMarket({}, { category: "Iran" }), true);
  assert.equal(isIranMarket({}, { question: "Will Tehran announce a new agreement?" }), true);
  assert.equal(isIranMarket({ title: "Will Arsenal win the Premier League?" }), false);
});

test("skips Iran-related markets and keeps scanning for non-Iran recommendations", async () => {
  const iran = position({
    conditionId: "iran-market",
    title: "Will Iran and Israel reach a ceasefire?",
    slug: "will-iran-and-israel-reach-a-ceasefire",
    eventSlug: "iran-israel-ceasefire",
    currentValue: 100
  });
  const sports = position({
    conditionId: "sports-market",
    title: "Will Arsenal win the Premier League?",
    slug: "will-arsenal-win-the-premier-league",
    eventSlug: "arsenal-premier-league",
    currentValue: 50
  });

  const eligible = [trader(1, [iran, sports]), trader(2, [iran, sports])];

  const fetchImpl = async (url) => {
    const text = String(url);
    const isIran = text.includes("iran");
    return {
      ok: true,
      json: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        question: isIran
          ? "Will Iran and Israel reach a ceasefire?"
          : "Will Arsenal win the Premier League?",
        category: isIran ? "Politics" : "Sports",
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.60", "0.40"]'
      }),
      text: async () => ""
    };
  };

  const result = await selectRecommendations(eligible, {
    fetchImpl,
    config: {
      minSharedSupporters: 2,
      recommendationCount: 2,
      requestConcurrency: 2,
      maxMarketChecks: 20,
      requireUsAvailable: false,
      excludeCryptoMarkets: true,
      excludeIranMarkets: true
    }
  });

  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].slug, "will-arsenal-win-the-premier-league");
});
