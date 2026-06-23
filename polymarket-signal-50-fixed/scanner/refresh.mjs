import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  collectEligibleTraders,
  DEFAULT_CONFIG,
  selectRecommendations
} from "./lib.mjs";

const outputPath = resolve(process.cwd(), "data/recommendations.json");
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

async function main() {
  log("Loading the all-time P&L leaderboard and scanning for 50 eligible traders...");

  const { eligible, stats } = await collectEligibleTraders({
    onProgress: ({ eligible: count, stats: currentStats, offset }) => {
      log(
        `Leaderboard offset ${offset}: ${count}/${DEFAULT_CONFIG.targetEligibleTraders} eligible; ` +
          `${currentStats.skippedNoPositions} without positions; ` +
          `${currentStats.excludedBothOutcomes} dual-sided exclusions.`
      );
    }
  });

  if (eligible.length < DEFAULT_CONFIG.targetEligibleTraders) {
    throw new Error(
      `Only found ${eligible.length} eligible traders after inspecting ${stats.leaderboardUsersInspected}. ` +
        "The previous recommendation file was left unchanged."
    );
  }

  log("Aggregating shared positions and validating that candidate markets are still tradeable...");
  const selection = await selectRecommendations(eligible);

  const finishedAt = new Date();
  const payload = {
    schemaVersion: 1,
    status: selection.recommendations.length > 0 ? "ok" : "no_shared_markets",
    generatedAt: finishedAt.toISOString(),
    durationSeconds: Math.round((finishedAt - startedAt) / 1000),
    methodology: {
      leaderboard: "OVERALL / ALL time / ordered by PNL",
      eligibleTraderTarget: DEFAULT_CONFIG.targetEligibleTraders,
      positionSizeThreshold: DEFAULT_CONFIG.positionSizeThreshold,
      minSharedSupporters: DEFAULT_CONFIG.minSharedSupporters,
      dualOutcomeRule:
        "A trader is excluded if they currently hold more than one outcome in the same conditionId.",
      ranking:
        "Supporter count first, then same-side consensus rate, rank-weighted support, and combined current position value.",
      activeMarketRule:
        "Only Gamma markets that are active, not closed or archived, and accepting orders are shown."
    },
    stats: {
      ...stats,
      eligibleTraders: eligible.length,
      candidateMarkets: selection.candidateMarketCount,
      marketsChecked: selection.marketsChecked,
      recommendationsReturned: selection.recommendations.length
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
