import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const GT = "https://api.geckoterminal.com/api/v2";
const DEX = "https://api.dexscreener.com";
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const cache = new Map();
const TTL = 60_000; // GeckoTerminal public API is cached at roughly one-minute intervals.
async function cached(key, loader, ttl = TTL) {
  const old = cache.get(key);
  if (old && Date.now() - old.time < ttl) return old.value;
  const value = await loader();
  cache.set(key, { time: Date.now(), value });
  return value;
}
async function getJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json;version=20230302",
        "user-agent": "VYRO-Solana-Terminal/1.0",
        ...headers
      }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Provider returned HTTP ${response.status}${body ? `: ${body.slice(0,160)}` : ""}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
function includedMap(included = []) {
  return new Map(included.map(item => [`${item.type}:${item.id}`, item.attributes || {}]));
}
function relationshipToken(pool, side, included) {
  const rel = pool.relationships?.[`${side}_token`]?.data;
  return rel ? included.get(`${rel.type}:${rel.id}`) || {} : {};
}
function mapPool(pool, included) {
  const a = pool.attributes || {};
  const base = relationshipToken(pool, "base", included);
  const quote = relationshipToken(pool, "quote", included);
  const dex = relationshipToken(pool, "dex", included);
  const id = pool.id || "";
  const address = a.address || id.split("_").slice(1).join("_");
  const created = a.pool_created_at ? Date.parse(a.pool_created_at) : null;
  const ageSeconds = created ? Math.max(0, Math.floor((Date.now() - created) / 1000)) : null;
  const volume = a.volume_usd || {};
  const tx = a.transactions || {};
  const changes = a.price_change_percentage || {};
  const reserve = Number(a.reserve_in_usd || 0);
  const h1 = Number(changes.h1 || 0);
  const h24 = Number(changes.h24 || 0);
  const buys = Number(tx.h24?.buys ?? tx.h1?.buys ?? 0);
  const sells = Number(tx.h24?.sells ?? tx.h1?.sells ?? 0);
  // Screening label is a transparent liquidity/age heuristic, not an audit.
  const risk = reserve >= 50_000 && ageSeconds !== null && ageSeconds >= 7200
    ? "Low" : reserve >= 10_000 && ageSeconds !== null && ageSeconds >= 900
      ? "Medium" : "High";
  const basePriceUsd = Number(a.base_token_price_usd || 0);
  const basePriceNative = Number(a.base_token_price_native_currency || 0);
  return {
    id: address || id,
    poolAddress: address,
    name: base.name || a.name || "Unknown token",
    symbol: base.symbol || (a.name || "???").split(" / ")[0],
    tokenAddress: base.address || (pool.relationships?.base_token?.data?.id || "").replace(/^solana_/, ""),
    quoteSymbol: quote.symbol || (a.name || "").split(" / ")[1] || "SOL",
    priceUsd: basePriceUsd,
    priceNative: basePriceNative,
    liquidityUsd: reserve,
    volume24h: Number(volume.h24 || 0),
    volume1h: Number(volume.h1 || 0),
    buys24h: buys,
    sells24h: sells,
    change1h: h1,
    change24h: h24,
    ageSeconds,
    createdAt: created,
    dex: dex.name || dex.identifier || "Solana DEX",
    risk,
    url: `https://www.geckoterminal.com/solana/pools/${address}`
  };
}
async function geckoPools(kind) {
  const endpoint = kind === "trending" ? "trending_pools" : "new_pools";
  const key = `gecko:${endpoint}:solana`;
  return cached(key, async () => {
    const url = `${GT}/networks/solana/${endpoint}?include=base_token,quote_token,dex&page=1`;
    const result = await getJson(url);
    const included = includedMap(result.included || []);
    const pools = (result.data || []).map(p => mapPool(p, included));
    return {
      source: "GeckoTerminal",
      network: "solana",
      fetchedAt: new Date().toISOString(),
      pools
    };
  });
}
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "VYRO", time: new Date().toISOString() });
});
app.get("/api/market/new-pools", async (_req, res) => {
  try {
    const data = await geckoPools("new");
    res.set("Cache-Control", "no-store").json(data);
  } catch (error) {
    res.status(502).json({
      error: "Could not retrieve new Solana pools from GeckoTerminal.",
      detail: error.message,
      hint: "Try again shortly. The public GeckoTerminal API is rate-limited and may be temporarily unavailable."
    });
  }
});
app.get("/api/market/trending", async (_req, res) => {
  try {
    const data = await geckoPools("trending");
    res.set("Cache-Control", "no-store").json(data);
  } catch (error) {
    res.status(502).json({ error: "Could not retrieve trending Solana pools.", detail: error.message });
  }
});
app.get("/api/market/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 80);
  if (!q) return res.status(400).json({ error: "Provide a token name, ticker or address in q." });
  try {
    const data = await cached(`dex-search:${q.toLowerCase()}`, async () => {
      const result = await getJson(`${DEX}/latest/dex/search?q=${encodeURIComponent(q)}`);
      const pools = (result.pairs || []).filter(p => p.chainId === "solana").map(p => ({
        id: p.pairAddress,
        poolAddress: p.pairAddress,
        name: p.baseToken?.name || "Unknown token",
        symbol: p.baseToken?.symbol || "???",
        tokenAddress: p.baseToken?.address || "",
        quoteSymbol: p.quoteToken?.symbol || "SOL",
        priceUsd: Number(p.priceUsd || 0),
        priceNative: Number(p.priceNative || 0),
        liquidityUsd: Number(p.liquidity?.usd || 0),
        volume24h: Number(p.volume?.h24 || 0),
        volume1h: Number(p.volume?.h1 || 0),
        buys24h: Number(p.txns?.h24?.buys || 0),
        sells24h: Number(p.txns?.h24?.sells || 0),
        change1h: Number(p.priceChange?.h1 || 0),
        change24h: Number(p.priceChange?.h24 || 0),
        ageSeconds: p.pairCreatedAt ? Math.floor((Date.now()-p.pairCreatedAt)/1000) : null,
        createdAt: p.pairCreatedAt || null,
        dex: p.dexId || "DEX",
        risk: Number(p.liquidity?.usd || 0) >= 50000 ? "Low" : Number(p.liquidity?.usd || 0) >= 10000 ? "Medium" : "High",
        url: p.url
      }));
      return { source: "DexScreener", fetchedAt: new Date().toISOString(), pools };
    }, 20_000);
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: "Token search failed.", detail: error.message });
  }
});
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`VYRO is running at http://localhost:${PORT}`));
