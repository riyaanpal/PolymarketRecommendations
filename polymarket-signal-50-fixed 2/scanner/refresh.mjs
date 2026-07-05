import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  collectEligibleTraders,
  DEFAULT_CONFIG,
  selectRecommendations
} from "./lib.mjs";

const outputPath = resolve(process.cwd(), "data/recommendations.json");
const usMarketsPath = resolve(process.cwd(), "data/us-markets.json");
const startedAt = new Date();

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function writeAtomically(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  const usMarketSnapshot = await readJsonIfExists(usMarketsPath);
  if (usMarketSnapshot?.marketCount) {
    log(
      `Using cached Polymarket US market list from ${usMarketSnapshot.generatedAt} with ${usMarketSnapshot.marketCount} tradable markets.`
    );
  } else {
    log("No cached Polymarket US market list found; falling back to live per-market US checks.");
  }

  const scanConfig = {
    ...DEFAULT_CONFIG,
    targetEligibleTraders: DEFAULT_CONFIG.maxEligibleTraders
  };

  let latestSelection = null;

  log(
    `Loading the all-time P&L leaderboard. The scan will continue past 50 eligible traders until ${DEFAULT_CONFIG.recommendationCount} distinct US-available markets are found, or until the leaderboard scan limit is reached...`
  );

  const { eligible, stats } = await collectEligibleTraders({
    config: scanConfig,
    onProgress: ({ eligible: count, stats: currentStats, offset }) => {
      log(
        `Leaderboard offset ${offset}: ${count}/${scanConfig.targetEligibleTraders} eligible maximum; ` +
          `${currentStats.skippedNoPositions} without positions; ` +
          `${currentStats.excludedBothOutcomes} dual-sided exclusions.`
      );
    },
    shouldStop: async ({ eligible: currentEligible }) => {
      if (currentEligible.length < DEFAULT_CONFIG.minEligibleBeforeRecommendations) return false;

      const selection = await selectRecommendations(currentEligible, {
        usMarketSnapshot,
        config: DEFAULT_CONFIG
      });
      latestSelection = selection;
      log(
        `Current recommendation coverage: ${selection.recommendations.length}/${DEFAULT_CONFIG.recommendationCount} distinct markets after ${currentEligible.length} eligible traders.`
      );

      return selection.recommendations.length >= DEFAULT_CONFIG.recommendationCount;
    }
  });

  log("Aggregating shared positions and validating that candidate markets are still tradeable...");
  const selection =
    latestSelection ??
    (await selectRecommendations(eligible, {
      usMarketSnapshot,
      config: DEFAULT_CONFIG
    }));

  const finishedAt = new Date();
  const payload = {
    schemaVersion: 2,
    status:
      selection.recommendations.length >= DEFAULT_CONFIG.recommendationCount
        ? "ok"
        : selection.recommendations.length > 0
          ? "partial"
          : "no_shared_markets",
    generatedAt: finishedAt.toISOString(),
    durationSeconds: Math.round((finishedAt - startedAt) / 1000),
    methodology: {
      leaderboard: "OVERALL / ALL time / ordered by PNL",
      eligibleTraderMinimumBeforeSelecting: DEFAULT_CONFIG.minEligibleBeforeRecommendations,
      eligibleTraderMaxScan: DEFAULT_CONFIG.maxEligibleTraders,
      positionSizeThreshold: DEFAULT_CONFIG.positionSizeThreshold,
      minSharedSupporters: DEFAULT_CONFIG.minSharedSupporters,
      recommendationTarget: DEFAULT_CONFIG.recommendationCount,
      dualOutcomeRule:
        "A trader is excluded if they currently hold more than one outcome in the same conditionId.",
      ranking:
        "Supporter count first, then same-side consensus rate, rank-weighted support, and combined current position value.",
      activeMarketRule:
        "Only Gamma markets that are active, not closed or archived, and accepting orders are shown.",
      usAvailabilityRule:
        "Only markets that match the daily Polymarket US catalog by exact slug or high-confidence title/slug similarity, and are active, not closed, not archived, not hidden, and with a tradable side, are shown.",
      usMarketCatalogGeneratedAt: usMarketSnapshot?.generatedAt ?? null,
      distinctMarketRule:
        "Only one recommendation is shown per Polymarket event; the highest-ranked qualifying child market is kept.",
      scanUntilRule:
        `After at least ${DEFAULT_CONFIG.minEligibleBeforeRecommendations} clean traders are collected, the scanner continues down the leaderboard until ${DEFAULT_CONFIG.recommendationCount} distinct markets are produced or ${DEFAULT_CONFIG.maxEligibleTraders} eligible traders have been inspected.`
    },
    stats: {
      ...stats,
      eligibleTraders: eligible.length,
      candidateMarkets: selection.candidateMarketCount,
      marketsChecked: selection.marketsChecked,
      recommendationsReturned: selection.recommendations.length,
      recommendationTarget: DEFAULT_CONFIG.recommendationCount,
      fullRecommendationSetFound: selection.recommendations.length >= DEFAULT_CONFIG.recommendationCount,
      usMarketCatalogUsed: Boolean(usMarketSnapshot?.marketCount),
      usMarketCatalogGeneratedAt: usMarketSnapshot?.generatedAt ?? null,
      usMarketCatalogCount: usMarketSnapshot?.marketCount ?? null
    },
    eligibleTraders: eligible.map((trader) => ({
      rank: trader.rank,
      name: trader.userName || `${trader.wallet.slice(0, 6)}…${trader.wallet.slice(-4)}`,
      wallet: trader.wallet,
      pnl: trader.pnl,
      activePositionCount: trader.positions.length
    })),
    recommendations: selection.recommendations
  };

  await writeAtomically(outputPath, payload);
  log(`Wrote ${selection.recommendations.length} recommendations to ${outputPath}.`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
