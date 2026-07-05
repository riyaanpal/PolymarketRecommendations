import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketCandidates,
  buildUsMarketSnapshot,
  hasBothOutcomes,
  isTradeableMarket,
  isUsTradeableMarket,
  normalizeMatchText,
  scoreUsMarketMatch,
  selectRecommendations
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
