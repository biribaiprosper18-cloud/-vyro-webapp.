# VYRO — Solana market radar + paper trading

VYRO is a Node.js web app. It is not a single-file HTML preview: run the server so the browser can call same-origin `/api/*` endpoints. The server proxies market data providers, avoiding browser-side CORS issues and keeping provider requests centralized.

## Run locally

Requirements: Node.js 20+

```bash
npm install
npm start
```

Open http://localhost:3000

## Deploy

The included `render.yaml` is a Render Blueprint. Push this folder to a GitHub repository, then in Render choose **New → Blueprint** and select the repository. Render will read `render.yaml` and deploy the Node web service. You can also deploy to another Node hosting provider with:

- Build command: `npm install`
- Start command: `npm start`
- Node version: 20+

## Live market sources

- New Solana pools: GeckoTerminal `/api/v2/networks/solana/new_pools`
- Trending Solana pools: GeckoTerminal `/api/v2/networks/solana/trending_pools`
- Token search: DexScreener `/latest/dex/search`

The app refreshes GeckoTerminal market feeds every 60 seconds because its public API is rate-limited and caches data around one minute. Provider availability, coverage and latency can vary. This is not a tick-by-tick trade stream.

## Paper-trading safety

- Start/Stop controls only start or stop the paper strategy.
- Paper buys/sells use a virtual 10 SOL balance.
- No wallet connection, private key, signing or on-chain transaction exists in this app.
- Take-profit and stop-loss are checked when fresh market data is fetched.
- Risk badges are simple liquidity/age heuristics, not audits, guarantees or investment advice.
- Some new pools may have missing token metadata or no usable price yet; they are shown as incomplete and cannot be paper-bought until a SOL-denominated price is available.

## Notes

The public GeckoTerminal API is beta and subject to change. For higher-volume production use, consider a commercial market-data plan and add request monitoring, persistence, user authentication and server-side rate limiting.
