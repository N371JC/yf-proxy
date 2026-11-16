// v4 — resilient cookie acquisition, no fc.yahoo.com dependency
/**
 * Yahoo Finance proxy for Vercel — bypasses Railway IP blocks.
 *
 * Cookie strategy: scrape a consent/redirect cookie from multiple Yahoo
 * entry points so we are not dependent on a single rate-limited endpoint.
 *
 * Routes:
 *   GET /quote/:symbol
 *   GET /quotes?symbols=A,B,C
 *   GET /chart/:symbol?range=1m|1d|1w|1y|ytd|all
 *   GET /fx?currencies=CAD,EUR,GBP,JPY
 *   GET /fx-pair?from=X&to=Y
 *   GET /ticker-info/:symbol
 */

let session = null; // { cookieStr, crumb, fetchedAt }
const SESSION_TTL = 55 * 60 * 1000; // 55 min

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BASE_HEADERS = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" };

function parseCookieHeader(headers) {
  const raw = headers.getSetCookie ? headers.getSetCookie() : [];
  return raw.map(c => c.split(";")[0]).join("; ");
}

async function acquireSession() {
  // Try multiple Yahoo entry points to get a valid session cookie
  const entryPoints = [
    "https://finance.yahoo.com/",
    "https://www.yahoo.com/",
  ];

  let cookieStr = "";
  for (const url of entryPoints) {
    try {
      const r = await fetch(url, {
        headers: { ...BASE_HEADERS, Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
      const cookies = parseCookieHeader(r.headers);
      if (cookies.length > 10) { cookieStr = cookies; break; }
    } catch (_) {}
  }

  // Try to get crumb — best effort, not required
  let crumb = "";
  const crumbUrls = [
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
  ];
  for (const url of crumbUrls) {
    try {
      const r = await fetch(url, {
        headers: { ...BASE_HEADERS, Cookie: cookieStr },
        signal: AbortSignal.timeout(5000),
      });
      const text = await r.text();
      if (text && text.length < 60 && !text.includes("{") && !text.includes("Too Many") && !text.includes("<")) {
        crumb = text.trim();
        break;
      }
    } catch (_) {}
  }

  session = { cookieStr, crumb, fetchedAt: Date.now() };
  return session;
}

async function getSession(force = false) {
  if (!force && session && Date.now() - session.fetchedAt < SESSION_TTL) return session;
  return acquireSession();
}

async function yfGet(path) {
  const { cookieStr, crumb } = await getSession();
  const sep = path.includes("?") ? "&" : "?";
  const crumbSuffix = crumb ? `${sep}crumb=${encodeURIComponent(crumb)}` : "";
  const url = `https://query1.finance.yahoo.com${path}${crumbSuffix}`;

  const r = await fetch(url, {
    headers: { ...BASE_HEADERS, Cookie: cookieStr, Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });

  const text = await r.text();

  // Rate limited — force refresh session and retry once
  if (text.trimStart().startsWith("Too Many") || r.status === 429 || r.status === 401) {
    const fresh = await getSession(true);
    const crumbSuffix2 = fresh.crumb ? `${sep}crumb=${encodeURIComponent(fresh.crumb)}` : "";
    const url2 = `https://query1.finance.yahoo.com${path}${crumbSuffix2}`;
    const r2 = await fetch(url2, {
      headers: { ...BASE_HEADERS, Cookie: fresh.cookieStr, Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    const text2 = await r2.text();
    if (text2.trimStart().startsWith("Too Many")) {
      throw new Error("Yahoo Finance is temporarily rate-limiting this server. Please try again in a few minutes.");
    }
    return JSON.parse(text2);
  }

  return JSON.parse(text);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function quoteFromMeta(symbol, meta) {
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
  const price = meta.regularMarketPrice ?? 0;
  const change = (price && prevClose) ? price - prevClose : 0;
  const changePercent = prevClose ? (change / prevClose) * 100 : 0;
  return {
    symbol,
    price,
    currency: meta.currency ?? "USD",
    changePercent,
    change,
    previousClose: prevClose ?? 0,
    open: meta.regularMarketOpen ?? 0,
    dayHigh: meta.regularMarketDayHigh ?? 0,
    dayLow: meta.regularMarketDayLow ?? 0,
    volume: meta.regularMarketVolume ?? 0,
    marketCap: meta.marketCap ?? 0,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? 0,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? 0,
    longName: meta.longName ?? meta.shortName ?? symbol,
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? "",
  };
}

async function fetchQuote(symbol) {
  const data = await yfGet(`/v8/finance/chart/${symbol}?interval=1d&range=1d`);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`No data for ${symbol}`);
  return quoteFromMeta(symbol, meta);
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(204).end();

  const url = new URL(req.url, `https://${req.headers.host}`);
  const parts = url.pathname.replace(/^\/+/, "").split("/");

  try {
    // GET /quote/:symbol
    if (parts[0] === "quote" && parts[1]) {
      const symbol = decodeURIComponent(parts[1]).toUpperCase();
      return res.json(await fetchQuote(symbol));
    }

    // GET /quotes?symbols=A,B,C
    if (parts[0] === "quotes") {
      const symbols = (url.searchParams.get("symbols") ?? "")
        .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
      if (!symbols.length) return res.json([]);
      const results = await Promise.allSettled(symbols.map(fetchQuote));
      return res.json(results.filter(r => r.status === "fulfilled").map(r => r.value));
    }

    // GET /chart/:symbol?range=
    if (parts[0] === "chart" && parts[1]) {
      const symbol = decodeURIComponent(parts[1]).toUpperCase();
      const range = url.searchParams.get("range") ?? "1m";
      const now = new Date();
      let period1, interval;
      switch (range) {
        case "1d":  period1 = new Date(now - 86400000);        interval = "1m";  break;
        case "1w":  period1 = new Date(now - 7*86400000);      interval = "30m"; break;
        case "1y":  period1 = new Date(now - 365*86400000);    interval = "1d";  break;
        case "ytd": period1 = new Date(now.getFullYear(),0,1); interval = "1d";  break;
        case "all": period1 = new Date(now - 5*365*86400000);  interval = "1wk"; break;
        default:    period1 = new Date(now - 30*86400000);     interval = "1d";
      }
      const p1 = Math.floor(period1.getTime() / 1000);
      const p2 = Math.floor((now.getTime() + 86400000) / 1000);
      const data = await yfGet(`/v8/finance/chart/${symbol}?interval=${interval}&period1=${p1}&period2=${p2}`);
      const result = data?.chart?.result?.[0];
      if (!result) return res.status(404).json({ error: "No chart data" });
      const rawQ = result.indicators?.quote?.[0] ?? {};
      const timestamps = [], prices = [];
      (result.timestamp ?? []).forEach((ts, i) => {
        const close = rawQ.close?.[i];
        if (close == null) return;
        const d = new Date(ts * 1000);
        if (range === "1w" && d.getUTCHours() * 60 + d.getUTCMinutes() < 13 * 60 + 30) return;
        timestamps.push(d.getTime());
        prices.push(close);
      });
      return res.json({ timestamps, prices, currency: result.meta?.currency ?? "USD" });
    }

    // GET /fx?currencies=CAD,EUR
    if (parts[0] === "fx") {
      const currencies = (url.searchParams.get("currencies") ?? "")
        .split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
      const out = {};
      await Promise.allSettled(currencies.map(async cur => {
        if (cur === "USD") { out[cur] = 1; return; }
        const data = await yfGet(`/v8/finance/chart/${cur}USD=X?interval=1d&range=1d`);
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price != null) out[cur] = price;
      }));
      return res.json(out);
    }

    // GET /fx-pair?from=X&to=Y
    if (parts[0] === "fx-pair") {
      const from = (url.searchParams.get("from") ?? "USD").toUpperCase();
      const to   = (url.searchParams.get("to")   ?? "USD").toUpperCase();
      if (from === to) return res.json({ rate: 1, from, to });
      const data = await yfGet(`/v8/finance/chart/${from}${to}=X?interval=1d&range=1d`);
      const rate = data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
      return res.json({ rate, from, to });
    }

    // GET /ticker-info/:symbol
    if (parts[0] === "ticker-info" && parts[1]) {
      const symbol = decodeURIComponent(parts[1]).toUpperCase();
      const data = await yfGet(`/v8/finance/chart/${symbol}?interval=1d&range=1d`);
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return res.status(404).json({ error: "Symbol not found" });
      return res.json({
        longName: meta.longName ?? meta.shortName ?? symbol,
        currency: meta.currency ?? "USD",
        exchange: meta.fullExchangeName ?? meta.exchangeName ?? "",
      });
    }

    // GET /premarket?symbols=A,B,C
    if (parts[0] === "premarket") {
      const symbolsParam = url.searchParams.get("symbols") ?? "";
      const symbols = symbolsParam.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
      if (!symbols.length) return res.json([]);
      const results = await Promise.allSettled(
        symbols.map(async (symbol) => {
          const data = await yfGet(`/v10/finance/quoteSummary/${symbol}?modules=price`);
          const p = data?.quoteSummary?.result?.[0]?.price ?? {};
          return {
            symbol,
            preMarketPrice: p.preMarketPrice?.raw ?? null,
            preMarketChange: p.preMarketChange?.raw ?? null,
            preMarketChangePercent: p.preMarketChangePercent?.raw ?? null,
            postMarketPrice: p.postMarketPrice?.raw ?? null,
            postMarketChange: p.postMarketChange?.raw ?? null,
            postMarketChangePercent: p.postMarketChangePercent?.raw ?? null,
            regularMarketPrice: p.regularMarketPrice?.raw ?? null,
            marketState: p.marketState ?? null, // PRE, REGULAR, POST, CLOSED
          };
        })
      );
      return res.json(results.filter(r => r.status === "fulfilled").map(r => r.value));
    }

    // GET /pe/:symbol
    if (parts[0] === "pe" && parts[1]) {
      const symbol = decodeURIComponent(parts[1]).toUpperCase();
      const r = await yfGet(`/v10/finance/quoteSummary/${symbol}?modules=summaryDetail,defaultKeyStatistics`);
      const result = r?.quoteSummary?.result?.[0];
      const sd = result?.summaryDetail ?? {};
      const ks = result?.defaultKeyStatistics ?? {};
      return res.json({
        symbol,
        trailingPE: sd.trailingPE?.raw ?? ks.trailingPE?.raw ?? null,
        forwardPE:  sd.forwardPE?.raw  ?? ks.forwardPE?.raw  ?? null,
      });
    }

    // GET /news/:symbol - Yahoo Finance RSS
    if (parts[0] === "news" && parts[1]) {
      const symbol = decodeURIComponent(parts[1]);
      const r = await fetch(
        `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (!r.ok) return res.json([]);
      const xml = await r.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      const news = items.slice(0, 7).map(m => {
        const block = m[1];
        const get = (tag) => {
          const x = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\/${tag}>`, "i"));
          return x ? x[1].trim() : "";
        };
        const linkMatch = block.match(/<link[^>]*\/?>[\s\r\n]*([^\s<]+)/) || block.match(/<link>([^<]+)<\/link>/);
        const link = linkMatch?.[1]?.trim() || get("link") || "#";
        const rawDate = get("pubDate");
        const date = rawDate ? new Date(rawDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : "";
        return { title: get("title"), source: get("source") || "Yahoo Finance", time: date, url: link };
      }).filter(n => n.title);
      return res.json(news);
    }

    // GET /dividend/:symbol
    if (parts[0] === "dividend" && parts[1]) {
      const symbol = decodeURIComponent(parts[1]).toUpperCase();
      const r = await yfGet(`/v10/finance/quoteSummary/${symbol}?modules=summaryDetail,defaultKeyStatistics,calendarEvents`);
      const result = r?.quoteSummary?.result?.[0];
      const sd = result?.summaryDetail ?? {};
      const ks = result?.defaultKeyStatistics ?? {};
      const ce = result?.calendarEvents ?? {};
      // earningsDate is an array of timestamps; pick the first future one
      const earningsDates = ce.earnings?.earningsDate ?? [];
      const now = Math.floor(Date.now() / 1000);
      const nextEarningsTs = earningsDates.find(d => (d?.raw ?? d) >= now)?.raw
        ?? earningsDates.find(d => (d?.raw ?? d))?.raw
        ?? null;
      return res.json({
        symbol,
        dividendRate: sd.dividendRate?.raw ?? null,
        dividendYield: sd.dividendYield?.raw ?? null,
        trailingAnnualDividendRate: ks.trailingAnnualDividendRate?.raw ?? null,
        trailingAnnualDividendYield: ks.trailingAnnualDividendYield?.raw ?? null,
        exDividendDate: sd.exDividendDate?.raw ?? null,
        payoutRatio: sd.payoutRatio?.raw ?? null,
        nextEarningsDate: nextEarningsTs,
      });
    }

    return res.status(404).json({ error: "Unknown route" });

  } catch (err) {
    console.error("[yf-proxy]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
