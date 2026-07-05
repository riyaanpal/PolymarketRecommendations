import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildUsMarketSnapshot, DEFAULT_CONFIG } from "./lib.mjs";

const outputPath = resolve(process.cwd(), "data/us-markets.json");
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
  log("Refreshing the Polymarket US tradable market catalog...");

  const snapshot = await buildUsMarketSnapshot({
    onProgress: ({ offset, fetched, total }) => {
      log(`US markets offset ${offset}: fetched ${fetched}; ${total} total scanned.`);
    }
  });

  const finishedAt = new Date();
  const payload = {
    ...snapshot,
    durationSeconds: Math.round((finishedAt - startedAt) / 1000),
    filters: {
      active: true,
      closed: false,
      archived: false,
      includeHidden: false,
      tradeableSideRequired: true
    },
    config: {
      pageSize: DEFAULT_CONFIG.usMarketsPageSize,
      maxOffset: DEFAULT_CONFIG.usMarketsMaxOffset
    }
  };

  await writeAtomically(outputPath, payload);
  log(`Wrote ${payload.marketCount} US-available markets to ${outputPath}.`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
