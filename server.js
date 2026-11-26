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

async function cached(key, loader, ttl = 60_000) {
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
        accept: "application/json",
        "user-agent": "VYRO-Solana-Terminal/1.1",
        ...headers
      }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Provider returned HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
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

function riskLabel(liquidity, ageSeconds) {
  // Informational liquidity/age heuristic only; this is not a security audit.
  return liquidity >= 50_000 && ageSeconds !== null && ageSeconds >= 7200
    ? "Low"
    : liquidity >= 10_000 && ageSeconds !== null && ageSeconds >= 900
      ? "Medium"
      : "High";
}

function mapGeckoPool(pool, included) {
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
  const liquidity = Number(a.reserve_in_usd || 0);

  return {
    id: address || id,
    poolAddress: address,
    name: base.name || a.name || "Unknown token",
    symbol: base.symbol || (a.name || "???").split(" / ")[0],
    tokenAddress: base.address || (pool.relationships?.base_token?.data?.id || "").replace(/^solana_/, ""),
    quoteSymbol: quote.symbol || (a.name || "").split(" / ")[1] || "SOL",
    priceUsd: Number(a.base_token_price_usd || 0),
    priceNative: Number(a.base_token_price_native_currency || 0),
    liquidityUsd: liquidity,
    volume24h: Number(volume.h24 || 0),
    volume1h: Number(volume.h1 || 0),
    buys24h: Number(tx.h24?.buys ?? tx.h1?.buys ?? 0),
    sells24h: Number(tx.h24?.sells ?? tx.h1?.sells ?? 0),
    change1h: Number(changes.h1 || 0),
    change24h: Number(changes.h24 || 0),
    ageSeconds,
    createdAt: created,
    dex: dex.name || dex.identifier || "Solana DEX",
    risk: riskLabel(liquidity, ageSeconds),
    url: address ? `https://www.geckoterminal.com/solana/pools/${address}` : ""
  };
}

function mapDexPair(p) {
  const liquidity = Number(p.liquidity?.usd || 0);
  const created = Number(p.pairCreatedAt || 0) || null;
  const ageSeconds = created ? Math.max(0, Math.floor((Date.now() - created) / 1000)) : null;
  return {
    id: p.pairAddress || p.baseToken?.address || "",
    poolAddress: p.pairAddress || "",
    name: p.baseToken?.name || "Unknown token",
    symbol: p.baseToken?.symbol || "???",
    tokenAddress: p.baseToken?.address || "",
    quoteSymbol: p.quoteToken?.symbol || "SOL",
    priceUsd: Number(p.priceUsd || 0),
    priceNative: Number(p.priceNative || 0),
    liquidityUsd: liquidity,
    volume24h: Number(p.volume?.h24 || 0),
    volume1h: Number(p.volume?.h1 || 0),
    buys24h: Number(p.txns?.h24?.buys || 0),
    sells24h: Number(p.txns?.h24?.sells || 0),
    change1h: Number(p.priceChange?.h1 || 0),
    change24h: Number(p.priceChange?.h24 || 0),
    ageSeconds,
    createdAt: created,
    dex: p.dexId || "Solana DEX",
    risk: riskLabel(liquidity, ageSeconds),
    url: p.url || ""
  };
}

async function geckoPools(kind) {
  const endpoint = kind === "trending" ? "trending_pools" : "new_pools";
  return cached(`gecko:${endpoint}:solana`, async () => {
    const url = `${GT}/networks/solana/${endpoint}?include=base_token,quote_token,dex&page=1`;
    const result = await getJson(url, { accept: "application/json;version=20230302" });
    const included = includedMap(result.included || []);
    return {
      source: "GeckoTerminal",
      network: "solana",
      fetchedAt: new Date().toISOString(),
      pools: (result.data || []).map(p => mapGeckoPool(p, included))
    };
  }, 60_000);
}

// DexScreener's discovery feeds identify token addresses. Batch-enrich those
// addresses through its higher-limit token endpoint to obtain price/pool data.
async function dexDiscovery(kind) {
  return cached(`dex-discovery:${kind}`, async () => {
    const paths = kind === "trending"
      ? ["/token-boosts/top/v1", "/token-boosts/latest/v1"]
      : ["/token-profiles/latest/v1", "/token-boosts/latest/v1"];

    const lists = await Promise.all(paths.map(p => getJson(`${DEX}${p}`)));
    const candidates = lists.flatMap(x => Array.isArray(x) ? x : [x])
      .filter(x => x && x.chainId === "solana" && x.tokenAddress)
      .filter((x, i, arr) => arr.findIndex(y => y.tokenAddress === x.tokenAddress) === i);

    const addresses = candidates.slice(0, 60).map(x => x.tokenAddress);
    const batches = [];
    for (let i = 0; i < addresses.length; i += 30) {
      batches.push(addresses.slice(i, i + 30));
    }

    const pairLists = await Promise.all(batches.map(batch =>
      getJson(`${DEX}/tokens/v1/solana/${batch.map(encodeURIComponent).join(",")}`)
    ));

    const allPairs = pairLists.flatMap(x => Array.isArray(x) ? x : (x.pairs || []))
      .filter(p => p.chainId === "solana");

    // Keep the most liquid pair for each discovered token.
    const bestByToken = new Map();
    for (const pair of allPairs) {
      const address = pair.baseToken?.address || pair.quoteToken?.address;
      if (!address) continue;
      const current = bestByToken.get(address);
      if (!current || Number(pair.liquidity?.usd || 0) > Number(current.liquidity?.usd || 0)) {
        bestByToken.set(address, pair);
      }
    }

    const pools = [...bestByToken.values()]
      .map(mapDexPair)
      .sort((a, b) => kind === "trending"
        ? (b.volume24h - a.volume24h)
        : ((a.ageSeconds ?? Number.MAX_SAFE_INTEGER) - (b.ageSeconds ?? Number.MAX_SAFE_INTEGER)));

    return {
      source: "DexScreener discovery",
      network: "solana",
      fetchedAt: new Date().toISOString(),
      pools
    };
  }, 60_000);
}

async function marketPools(kind) {
  try {
    const primary = await geckoPools(kind);
    if (primary.pools.length) return primary;
    throw new Error("GeckoTerminal returned an empty pool list.");
  } catch (geckoError) {
    try {
      const fallback = await dexDiscovery(kind);
      if (fallback.pools.length) {
        return {
          ...fallback,
          fallback: true,
          providerNote: "GeckoTerminal was unavailable; showing DexScreener discovery data."
        };
      }
      throw new Error("DexScreener returned no matching Solana pairs.");
    } catch (dexError) {
      throw new Error(`GeckoTerminal: ${geckoError.message}. DexScreener fallback: ${dexError.message}`);
    }
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "VYRO", time: new Date().toISOString() });
});

app.get("/api/market/new-pools", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store").json(await marketPools("new"));
  } catch (error) {
    res.status(502).json({
      error: "Could not retrieve Solana pools from available providers.",
      detail: error.message,
      hint: "Both market providers may be temporarily rate-limited. Wait a minute and retry."
    });
  }
});

app.get("/api/market/trending", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store").json(await marketPools("trending"));
  } catch (error) {
    res.status(502).json({
      error: "Could not retrieve trending Solana pools from available providers.",
      detail: error.message
    });
  }
});

app.get("/api/market/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 80);
  if (!q) return res.status(400).json({ error: "Provide a token name, ticker or address in q." });

  try {
    const data = await cached(`dex-search:${q.toLowerCase()}`, async () => {
      const result = await getJson(`${DEX}/latest/dex/search?q=${encodeURIComponent(q)}`);
      const pools = (result.pairs || [])
        .filter(p => p.chainId === "solana")
        .map(mapDexPair);
      return { source: "DexScreener", fetchedAt: new Date().toISOString(), pools };
    }, 20_000);
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: "Token search failed.", detail: error.message });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`VYRO is running on port ${PORT}`));

