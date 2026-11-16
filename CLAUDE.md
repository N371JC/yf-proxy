# yf-proxy

Small Yahoo Finance proxy deployed on Vercel. It exists because Yahoo blocks cloud IPs (Railway in particular), so the backend of `portfoliopulse` calls this instead of Yahoo directly. It handles Yahoo's cookie + crumb session and returns trimmed JSON.

## Stack and layout

- One file: `api/proxy.js`, a Vercel **Node.js serverless function** (`handler(req, res)`), not the Edge runtime.
- `vercel.json` rewrites every path to `/api/proxy`; the handler routes on `url.pathname` itself.
- `package.json` has no dependencies, no scripts, no `"type"`. Uses global `fetch` only.
- No tests, no CI, no lint config, no README.

## Routes

| Route | Returns | Yahoo source |
|---|---|---|
| `GET /quote/:symbol` | price, change, day range, 52w range, name, exchange | `/v8/finance/chart` meta |
| `GET /quotes?symbols=A,B` | array of the above (failed symbols silently dropped) | same |
| `GET /chart/:symbol?range=1d\|1w\|1m\|1y\|ytd\|all` | `{timestamps, prices, currency}` | `/v8/finance/chart` |
| `GET /fx?currencies=CAD,EUR` | map of currency -> USD rate | chart meta for `XXXUSD=X` |
| `GET /fx-pair?from=X&to=Y` | `{rate, from, to}` | chart meta for `XY=X` |
| `GET /ticker-info/:symbol` | longName, currency, exchange | chart meta |
| `GET /premarket?symbols=A,B` | pre/post-market price and change, `marketState` | `/v10/finance/quoteSummary` `price` |
| `GET /pe/:symbol` | `trailingPE`, `forwardPE` | quoteSummary |
| `GET /dividend/:symbol` | dividend rate/yield, ex-date, payout ratio, `nextEarningsDate` | quoteSummary |
| `GET /news/:symbol` | up to 7 `{title, source, time, url}` | Yahoo RSS feed, regex-parsed |

The header comment in `proxy.js` lists only the first six.

## Deployment

- Production: `https://lonsdale-yf-proxy.vercel.app` (Vercel project `lonsdale-yf-proxy`, not the repo name).
- History: production was deployed outside git and ran ahead of the repo until 2026-11-17, when the live source ("v4") was copied from the Vercel dashboard's Source tab into this repo and checked route by route against production. If the project is not yet connected to GitHub (Vercel → Settings → Git), deployments are still manual; once connected, every push to `main` deploys to production, so treat `main` as live.
- No environment variables or secrets are needed.

## Dependents

- `portfoliopulse` (`server/market.ts`, `server/routes.ts`, and the built copies under `api/`) hardcodes the production URL and uses every route above. Treat response shapes as a contract with that project.

## Running and testing locally

- `vercel dev` (needs the Vercel CLI and project link; not set up in this clone).
- Without Vercel: import the handler from an `.mjs` script and call it with a mock `req` (`method`, `url`, `headers.host`) and `res` (`setHeader`, `status`, `json`, `end`). Node detects the ESM syntax despite the missing `"type": "module"` (with a warning).
- Local calls hit real Yahoo, which rate-limits. The cheapest regression check is to compare each route's status and JSON keys against the live URL.

## Gotchas

- Session (cookie + crumb) is module-level, so it lasts only for the life of a warm function instance (55 min TTL). The crumb is best-effort: requests go out without one if Yahoo refuses to issue it.
- `yfGet` retries once on 401/429/"Too Many Requests", then throws; errors surface as a 500 with `{error}`. Non-JSON bodies from Yahoo also become a 500.
- `/pe` and `/dividend` return 200 with nulls for unknown symbols rather than 404.
- `Access-Control-Allow-Origin: *`, no auth, no rate limiting, `Cache-Control: no-store`. The URL and repo are public, so anyone can use the proxy.
- `/quotes`, `/fx` and `/premarket` fan out one Yahoo request per symbol with no concurrency limit.
- In `/chart`, `range=1w` drops points before 13:30 UTC (US market open in summer), which is wrong for non-US symbols and an hour early during US winter time.
- `/fx` silently omits currencies that fail; `/fx-pair` returns `rate: null`.
- `/news` titles keep HTML entities (e.g. `&amp;`) as-is.
- Commits in history use a personal email as author; nothing else sensitive is in the files or history.
