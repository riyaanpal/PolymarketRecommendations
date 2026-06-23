# Signal 50

A zero-dependency static website that publishes five daily Polymarket consensus signals from a clean set of 50 traders drawn from the overall all-time P&L leaderboard.

## Exact rules implemented

1. Read the `OVERALL`, `ALL`, `PNL` leaderboard in batches of 50.
2. Fetch each trader's current positions.
3. Skip traders with no current positions.
4. Exclude a trader entirely if they hold more than one outcome for the same `conditionId`.
5. Keep scanning down the leaderboard until 50 eligible traders are collected or the API's documented offset limit is reached.
6. Group positions by market and side.
7. Require at least two traders on the same side and reject markets where that side does not outnumber all opposing holders.
8. Validate candidates with Gamma and show only active, non-closed, non-archived markets accepting orders.
9. Rank by same-side supporter count, consensus rate, rank-weighted support, and combined current position value.
10. Publish up to five markets. It shows fewer rather than inventing a weak signal.

## First live refresh

After uploading this folder to a GitHub repository:

1. Open **Settings → Actions → General**.
2. Under **Workflow permissions**, select **Read and write permissions**, then save.
3. Open **Actions → Daily Polymarket refresh → Run workflow**.
4. The action updates `data/recommendations.json` and commits it.

The scheduled workflow runs every day at `11:17 UTC`. GitHub schedules can start a few minutes late.

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
- Public positions can change immediately after the daily snapshot.
- A trader's visible position size is not the same as their full risk exposure or conviction.
- The app never connects a wallet or places trades.
- Users must independently verify market resolution rules, current price, platform eligibility, and applicable law.
