# Signal 50

A zero-dependency static website that publishes up to four Polymarket consensus signals. It starts with a clean set of 50 traders drawn from the overall all-time P&L leaderboard, keeps scanning farther down the leaderboard until four distinct markets are produced, and only shows markets that are also listed as tradable on Polymarket US.

## Exact rules implemented

1. Read the `OVERALL`, `ALL`, `PNL` leaderboard in batches of 50.
2. Fetch each trader's current positions.
3. Skip traders with no current positions.
4. Exclude a trader entirely if they hold more than one outcome for the same `conditionId`.
5. Start selecting after 50 eligible traders are collected, then keep scanning down the leaderboard until four distinct qualifying markets are produced or the configured scan cap is reached.
6. Group positions by market and side.
7. Require at least two traders on the same side and reject markets where that side does not outnumber all opposing holders.
8. Validate candidates with Gamma and show only active, non-closed, non-archived markets accepting orders.
9. Refresh a cached Polymarket US tradable-market catalog once per day and match candidates against it using exact slug first, then high-confidence title/slug similarity.
10. If the catalog has not been created yet, fall back to a live Polymarket US slug check.
11. Collapse outcome-specific child markets that belong to the same Polymarket event, keeping only the strongest-ranked one.
12. Rank by same-side supporter count, consensus rate, rank-weighted support, and combined current position value.
13. Publish up to four distinct events. It shows fewer rather than repeating one event or inventing a weak signal.

## First live refresh

After uploading this folder to a GitHub repository:

1. Open **Settings → Actions → General**.
2. Under **Workflow permissions**, select **Read and write permissions**, then save.
3. Open **Actions → Daily Polymarket US markets refresh → Run workflow** once. This creates/updates `data/us-markets.json`.
4. Open **Actions → 30-Minute Polymarket refresh → Run workflow** once. This updates `data/recommendations.json` using the latest US market catalog.

The US market catalog refreshes once per day from `https://gateway.polymarket.us/v1/markets`. The recommendations workflow can still run every 30 minutes; it reads `data/us-markets.json` and falls back to live per-market US checks if the catalog has not been created yet. GitHub schedules can start a few minutes late.

## Deploy on Vercel

1. Import the GitHub repository into Vercel.
2. Choose **Other** as the framework preset.
3. Leave the build command empty and use `.` as the output directory if Vercel asks.
4. Deploy.

Each daily data commit triggers a new deployment automatically.

## Run locally

Because the browser fetches a JSON file, use a local web server rather than opening `index.html` directly:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

Refresh only the Polymarket US market catalog:

```bash
npm run refresh:us-markets
```

Run tests and syntax checks:

```bash
npm test
npm run check
```

Run a live refresh:

```bash
npm run refresh
```

## Configuration

Edit `DEFAULT_CONFIG` in `scanner/lib.mjs` to change:

- eligible trader target
- minimum position size
- same-side supporter minimum
- recommendation count
- request concurrency

## Important limitations

- This is a crowd-position signal, not proof that a side is correctly priced.
- The top-trader leaderboard and position data still come from the public Polymarket International data APIs. The US filter verifies that the recommended market appears in the latest cached Polymarket US tradable-market catalog.
- Exact slug matches are preferred. When Polymarket US uses a different slug, the app can match by normalized title/slug similarity, but it rejects low-confidence matches rather than guessing.
- Public positions can change immediately after the snapshot.
- A trader's visible position size is not the same as their full risk exposure or conviction.
- The app never connects a wallet or places trades.
- Users must independently verify market resolution rules, current price, platform eligibility, and applicable law.
