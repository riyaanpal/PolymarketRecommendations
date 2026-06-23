import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketCandidates,
  hasBothOutcomes,
  isTradeableMarket
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
