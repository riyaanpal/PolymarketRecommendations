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


function recommendationIdentity(item) {
  return {
    conditionId: String(item?.conditionId ?? ""),
    slug: String(item?.slug ?? ""),
    eventSlug: String(item?.eventSlug ?? ""),
    side: String(item?.decisionSide ?? item?.outcome ?? "").toUpperCase(),
    outcomeKey: String(item?.outcomeKey ?? ""),
    option: String(item?.decisionOption ?? item?.decisionChoice ?? item?.groupItemTitle ?? item?.groupItemThreshold ?? ""),
    target: String(item?.decisionTarget ?? item?.title ?? ""),
    usMarketSlug: String(item?.usMarketSlug ?? "")
  };
}

function recommendationSignature(recommendations = []) {
  return JSON.stringify(
    (Array.isArray(recommendations) ? recommendations : [])
      .map(recommendationIdentity)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
}

function recommendationCount(data) {
  return Array.isArray(data?.recommendations) ? data.recommendations.length : 0;
}

function buildPublishPayload({ freshPayload, previousPayload, finishedAt }) {
  const lastCheckedAt = finishedAt.toISOString();
  const freshCount = recommendationCount(freshPayload);
  const previousCount = recommendationCount(previousPayload);
  const previousHasRecommendations = previousCount > 0;
  const freshHasRecommendations = freshCount > 0;
  const signaturesMatch =
    previousHasRecommendations &&
    freshHasRecommendations &&
    recommendationSignature(previousPayload.recommendations) ===
      recommendationSignature(freshPayload.recommendations);

  if (!previousHasRecommendations) {
    return {
      ...freshPayload,
      generatedAt: freshPayload.generatedAt ?? lastCheckedAt,
      recommendationsUpdatedAt: freshHasRecommendations ? lastCheckedAt : null,
      lastCheckedAt,
      lastCheckStatus: freshPayload.status,
      lastCheckRecommendationCount: freshCount,
      refreshMode: freshHasRecommendations ? "recommendations_updated" : "checked_no_recommendations_yet"
    };
  }

  if (freshHasRecommendations && !signaturesMatch) {
    return {
      ...freshPayload,
      generatedAt: lastCheckedAt,
      recommendationsUpdatedAt: lastCheckedAt,
      lastCheckedAt,
      lastCheckStatus: freshPayload.status,
      lastCheckRecommendationCount: freshCount,
      previousRecommendationsReplacedAt: previousPayload.generatedAt ?? previousPayload.recommendationsUpdatedAt ?? null,
      refreshMode: "recommendations_updated"
    };
  }

  const preservedNotes = Array.isArray(previousPayload.notes) ? previousPayload.notes : [];
  const checkNote = freshHasRecommendations
    ? `Checked at ${lastCheckedAt}. The scanner found the same recommendation set, so the published cards were left unchanged.`
    : `Checked at ${lastCheckedAt}. The scanner did not find a replacement recommendation set, so the previously published cards were kept.`;

  return {
    ...freshPayload,
    status: previousPayload.status ?? freshPayload.status,
    generatedAt: previousPayload.generatedAt ?? previousPayload.recommendationsUpdatedAt ?? lastCheckedAt,
    recommendationsUpdatedAt:
      previousPayload.recommendationsUpdatedAt ?? previousPayload.generatedAt ?? null,
    lastCheckedAt,
    lastCheckStatus: freshPayload.status,
    lastCheckRecommendationCount: freshCount,
    refreshMode: freshHasRecommendations
      ? "checked_recommendations_unchanged"
      : "checked_no_replacement_found",
    recommendations: previousPayload.recommendations,
    notes: [...preservedNotes.filter((note) => !String(note).startsWith("Checked at ")), checkNote]
  };
}

async function main() {
  const previousPayload = await readJsonIfExists(outputPath);
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
  const freshPayload = {
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

  const payload = buildPublishPayload({
    freshPayload,
    previousPayload,
    finishedAt
  });

  await writeAtomically(outputPath, payload);
  if (payload.refreshMode === "recommendations_updated") {
    log(`Published ${payload.recommendations.length} new recommendations to ${outputPath}.`);
  } else {
    log(`Checked markets and kept the existing ${payload.recommendations.length} recommendations. Updated lastCheckedAt only.`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
