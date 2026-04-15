const express = require('express');
const https   = require('https');
const http    = require('http');
const Parser  = require('rss-parser');
const path    = require('path');

const app    = express();
const PORT   = process.env.PORT || 3001;
const parser = new Parser({ timeout: 8000 });

// ── Cache ────────────────────────────────────────────────────────
let cache = { market: null, news: null };
let lastFetch = { market: 0, news: 0 };
const MARKET_TTL = 60 * 1000;       // 1 min
const NEWS_TTL   = 5 * 60 * 1000;   // 5 min

// ── HTTP fetch helper ─────────────────────────────────────────────
function fetch(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json, text/html, */*'
            }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetch(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ── Finnhub Market Data ───────────────────────────────────────────
const MARKET_SYMBOLS = [
    { symbol: 'QQQ',  name: 'NASDAQ 100', type: 'index'  },
    { symbol: 'SPY',  name: 'S&P 500',    type: 'index'  },
    { symbol: 'DIA',  name: 'Dow Jones',  type: 'index'  },
    { symbol: 'NVDA', name: 'Nvidia',     type: 'stock'  },
    { symbol: 'AAPL', name: 'Apple',      type: 'stock'  },
    { symbol: 'TSLA', name: 'Tesla',      type: 'stock'  },
    { symbol: 'META', name: 'Meta',       type: 'stock'  },
    { symbol: 'MSFT', name: 'Microsoft',  type: 'stock'  },
    { symbol: 'AMZN', name: 'Amazon',     type: 'stock'  },
    { symbol: 'GOOGL', name: 'Alphabet',  type: 'stock'  },
    { symbol: 'ASML', name: 'ASML',       type: 'stock'  },
    { symbol: 'TSM',  name: 'TSMC',       type: 'stock'  },
    { symbol: 'PLTR', name: 'Palantir',   type: 'stock'  },
    { symbol: 'AMD',  name: 'AMD',        type: 'stock'  },
    // Sector ETFs
    { symbol: 'XLK',  name: 'Technology',    type: 'sector' },
    { symbol: 'XLF',  name: 'Financials',    type: 'sector' },
    { symbol: 'XLE',  name: 'Energy',        type: 'sector' },
    { symbol: 'XLV',  name: 'Healthcare',    type: 'sector' },
    { symbol: 'XLY',  name: 'Cons. Disc.',   type: 'sector' },
    { symbol: 'XLI',  name: 'Industrials',   type: 'sector' },
    { symbol: 'XLC',  name: 'Comm. Svcs',    type: 'sector' },
    { symbol: 'XLB',  name: 'Materials',     type: 'sector' },
];

async function fetchFinnhubQuote(symbol, apiKey) {
    const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${apiKey}`;
    const raw  = await fetch(url);
    const data = JSON.parse(raw);
    return { c: data.c, d: data.d, dp: data.dp }; // current, change, change%
}

async function fetchMarket() {
    if (cache.market && Date.now() - lastFetch.market < MARKET_TTL) return cache.market;
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) { console.warn('FINNHUB_API_KEY not set'); return cache.market || []; }
    try {
        const results = await Promise.allSettled(
            MARKET_SYMBOLS.map(async s => {
                const q = await fetchFinnhubQuote(s.symbol, apiKey);
                return {
                    symbol:                      s.symbol,
                    shortName:                   s.name,
                    type:                        s.type,
                    regularMarketPrice:          q.c,
                    regularMarketChange:         q.d,
                    regularMarketChangePercent:  q.dp,
                };
            })
        );
        const quotes = results
            .filter(r => r.status === 'fulfilled' && r.value.regularMarketPrice > 0)
            .map(r => r.value);
        if (quotes.length) {
            cache.market     = quotes;
            lastFetch.market = Date.now();
        }
        return cache.market || [];
    } catch (e) {
        console.error('Market fetch error:', e.message);
        return cache.market || [];
    }
}

// ── RSS News Feeds ────────────────────────────────────────────────
const FEEDS = [
    { name: 'CNBC Markets',   url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'CNBC Tech',      url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html' },
    { name: 'Reuters Business', url: 'https://feeds.reuters.com/reuters/businessNews' },
    { name: 'MarketWatch',    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
    { name: 'Seeking Alpha',  url: 'https://seekingalpha.com/market_currents.xml' },
    { name: 'iProperty MY',  url: 'https://www.iproperty.com.my/news/feed/' },
    { name: 'The Edge MY',   url: 'https://www.theedgemarkets.com/rss.xml' },
];

// Impact tagging — keyword → affected stocks/sectors
const IMPACT_MAP = [
    { keys: ['fed', 'federal reserve', 'interest rate', 'fomc', 'powell', 'inflation', 'cpi'],  tags: ['ALL MARKETS', 'BONDS', 'RATES'],       color: '#c9a55a' },
    { keys: ['iran', 'oil', 'opec', 'energy', 'crude', 'hormuz'],                               tags: ['OIL', 'ENERGY', 'XOM', 'CVX'],          color: '#e07070' },
    { keys: ['ai', 'artificial intelligence', 'llm', 'openai', 'chatgpt', 'nvidia', 'nvda'],    tags: ['NVDA', 'AI SECTOR', 'AMD', 'MSFT'],     color: '#5588cc' },
    { keys: ['chip', 'semiconductor', 'tsmc', 'asml', 'amd', 'intel'],                         tags: ['SEMICONDUCTORS', 'NVDA', 'AMD', 'TSM'], color: '#7b6cc9' },
    { keys: ['apple', 'aapl', 'iphone', 'mac', 'ios'],                                         tags: ['AAPL'],                                  color: '#aaaaaa' },
    { keys: ['tesla', 'tsla', 'musk', 'ev', 'electric vehicle'],                               tags: ['TSLA', 'EV SECTOR'],                    color: '#e07070' },
    { keys: ['meta', 'facebook', 'instagram', 'zuckerberg'],                                   tags: ['META', 'SOCIAL MEDIA'],                 color: '#5588cc' },
    { keys: ['amazon', 'amzn', 'aws', 'cloud'],                                                tags: ['AMZN', 'CLOUD'],                        color: '#e8a020' },
    { keys: ['microsoft', 'msft', 'azure', 'copilot'],                                        tags: ['MSFT', 'CLOUD', 'AI'],                  color: '#5588cc' },
    { keys: ['google', 'alphabet', 'googl', 'gemini', 'youtube'],                             tags: ['GOOGL', 'AD MARKET'],                   color: '#4caf7d' },
    { keys: ['nasdaq', 'tech stock', 'technology'],                                            tags: ['NASDAQ', 'TECH'],                       color: '#5588cc' },
    { keys: ['recession', 'gdp', 'unemployment', 'jobs', 'economy'],                          tags: ['ALL MARKETS', 'MACRO'],                 color: '#c9a55a' },
    { keys: ['tariff', 'trade war', 'china', 'import'],                                       tags: ['TRADE', 'SUPPLY CHAIN'],               color: '#e8a020' },
    { keys: ['earnings', 'revenue', 'profit', 'quarterly results'],                           tags: ['EARNINGS SEASON'],                      color: '#5cba8a' },
    { keys: ['ipo', 'listing', 'public offering'],                                             tags: ['IPO', 'NEW LISTINGS'],                  color: '#c9a55a' },
];

// ── Geo-tagging — keyword → country ──────────────────────────────
const GEO_MAP = [
    { keys: ['united states', 'wall street', 'fed ', 'federal reserve', 'nasdaq', 'nyse', 's&p', 'dow jones', 'silicon valley', 'u.s.', ' us ', 'american', 'america', 'washington', 'treasury', 'sec ', 'irs'], code: 'US', name: 'USA' },
    { keys: ['china', 'beijing', 'chinese', 'prc', 'hong kong', 'yuan', 'renminbi', 'alibaba', 'tencent', 'baidu', 'shenzhen', 'shanghai'], code: 'CN', name: 'China' },
    { keys: ['taiwan', 'tsmc', 'taipei', 'taiwanese'], code: 'TW', name: 'Taiwan' },
    { keys: ['japan', 'tokyo', 'japanese', 'yen', 'nikkei', 'boj ', 'softbank', 'toyota'], code: 'JP', name: 'Japan' },
    { keys: ['south korea', 'korea', 'seoul', 'samsung', 'kospi', 'hyundai', 'korean'], code: 'KR', name: 'S. Korea' },
    { keys: ['india', 'mumbai', 'delhi', 'rupee', 'sensex', 'nse ', 'bse ', 'reliance', 'tata', 'infosys'], code: 'IN', name: 'India' },
    { keys: ['uk', 'britain', 'british', 'london', 'ftse', 'pound sterling', 'bank of england', 'england', 'boe '], code: 'GB', name: 'UK' },
    { keys: ['germany', 'german', 'berlin', 'frankfurt', 'dax', 'deutsche', 'bundesbank', 'volkswagen', 'siemens'], code: 'DE', name: 'Germany' },
    { keys: ['france', 'french', 'paris', 'cac 40', 'macron', 'lvmh', 'total'], code: 'FR', name: 'France' },
    { keys: ['europe', 'european', 'eu ', 'ecb', 'eurozone', 'euro zone', 'brussels'], code: 'EU-', name: 'Europe' },
    { keys: ['russia', 'russian', 'moscow', 'putin', 'ruble', 'gazprom', 'rosneft'], code: 'RU', name: 'Russia' },
    { keys: ['iran', 'tehran', 'iranian', 'persian', 'hormuz', 'khamenei'], code: 'IR', name: 'Iran' },
    { keys: ['saudi', 'riyadh', 'aramco', 'mbs', 'neom'], code: 'SA', name: 'Saudi Arabia' },
    { keys: ['opec', 'oil cartel', 'crude oil production cut'], code: 'SA', name: 'OPEC' },
    { keys: ['canada', 'toronto', 'ottawa', 'tsx', 'canadian dollar', 'shopify'], code: 'CA', name: 'Canada' },
    { keys: ['australia', 'sydney', 'melbourne', 'asx', 'australian dollar', 'rba '], code: 'AU', name: 'Australia' },
    { keys: ['brazil', 'são paulo', 'bovespa', 'real ', 'petrobras'], code: 'BR', name: 'Brazil' },
    { keys: ['mexico', 'mexican', 'peso', 'pemex', 'banxico'], code: 'MX', name: 'Mexico' },
    { keys: ['asml', 'netherlands', 'dutch', 'amsterdam'], code: 'NL', name: 'Netherlands' },
    { keys: ['switzerland', 'swiss', 'zurich', 'ubs', 'credit suisse', 'nestlé'], code: 'CH', name: 'Switzerland' },
    { keys: ['singapore', 'sgx', 'mas '], code: 'SG', name: 'Singapore' },
    { keys: ['israel', 'tel aviv', 'shekel'], code: 'IL', name: 'Israel' },
    { keys: ['ukraine', 'kyiv', 'zelensky', 'ukrainian'], code: 'UA', name: 'Ukraine' },
];

function geoTag(title, summary) {
    const text = (title + ' ' + (summary || '')).toLowerCase();
    const found = [];
    for (const g of GEO_MAP) {
        if (g.keys.some(k => text.includes(k))) {
            // Avoid duplicates (EU can match multiple)
            if (!found.find(f => f.code === g.code)) {
                found.push({ code: g.code, name: g.name });
            }
            if (found.length >= 3) break;
        }
    }
    // Most finance news defaults to US if nothing else matched
    if (!found.length) found.push({ code: 'US', name: 'USA' });
    return found;
}

function tagNews(title, summary) {
    const text   = (title + ' ' + summary).toLowerCase();
    const impacts = [];
    for (const { keys, tags, color } of IMPACT_MAP) {
        if (keys.some(k => text.includes(k))) {
            impacts.push({ tags, color });
            if (impacts.length >= 2) break;
        }
    }
    return impacts;
}

function sentiment(title) {
    const text = title.toLowerCase();
    const pos  = ['rise', 'rises', 'gain', 'gains', 'surge', 'surges', 'rally', 'high', 'record', 'beat', 'beats', 'jump', 'jumps', 'soar', 'recovery', 'rebound', 'strong', 'optimism', 'deal', 'positive'];
    const neg  = ['fall', 'falls', 'drop', 'drops', 'plunge', 'plunges', 'crash', 'low', 'miss', 'misses', 'decline', 'fear', 'risk', 'warn', 'warning', 'recession', 'sell', 'loss', 'concern', 'weak', 'cut'];
    const posScore = pos.filter(w => text.includes(w)).length;
    const negScore = neg.filter(w => text.includes(w)).length;
    if (posScore > negScore) return 'bullish';
    if (negScore > posScore) return 'bearish';
    return 'neutral';
}

async function fetchNews() {
    if (cache.news && Date.now() - lastFetch.news < NEWS_TTL) return cache.news;
    const allItems = [];
    await Promise.allSettled(FEEDS.map(async feed => {
        try {
            const parsed = await parser.parseURL(feed.url);
            for (const item of (parsed.items || []).slice(0, 8)) {
                allItems.push({
                    title:    item.title || '',
                    summary:  item.contentSnippet || item.summary || '',
                    link:     item.link || '#',
                    date:     item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    source:    feed.name,
                    impacts:   tagNews(item.title || '', item.contentSnippet || ''),
                    sentiment: sentiment(item.title || ''),
                    countries: geoTag(item.title || '', item.contentSnippet || '')
                });
            }
        } catch (e) {
            console.error(`Feed error (${feed.name}):`, e.message);
        }
    }));
    // Sort by date, deduplicate by title similarity
    allItems.sort((a, b) => new Date(b.date) - new Date(a.date));
    const seen = new Set();
    const deduped = allItems.filter(item => {
        const key = item.title.slice(0, 40).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    cache.news     = deduped.slice(0, 40);
    lastFetch.news = Date.now();
    return cache.news;
}

// ── Asian Markets (Yahoo Finance) ────────────────────────────────
const ASIAN_SYMBOLS = [
    // Malaysia — indices
    { symbol: '^KLSE',    name: 'KLCI',          type: 'index', market: 'MY' },
    // Malaysia — stocks
    { symbol: '1155.KL',  name: 'Maybank',        type: 'stock', market: 'MY' },
    { symbol: '1295.KL',  name: 'Public Bank',    type: 'stock', market: 'MY' },
    { symbol: '1023.KL',  name: 'CIMB',           type: 'stock', market: 'MY' },
    { symbol: '5347.KL',  name: 'Tenaga',         type: 'stock', market: 'MY' },
    { symbol: '5225.KL',  name: 'IHH Healthcare', type: 'stock', market: 'MY' },
    // Malaysia — REITs (property proxy)
    { symbol: '5227.KL',  name: 'IGB REIT',       type: 'reit',  market: 'MY' },
    { symbol: '5212.KL',  name: 'Pavilion REIT',  type: 'reit',  market: 'MY' },
    { symbol: '5106.KL',  name: 'Axis REIT',      type: 'reit',  market: 'MY' },
    { symbol: '2163.KL',  name: 'YTL Hospitality', type: 'reit', market: 'MY' },
    // Singapore — index
    { symbol: '^STI',     name: 'Straits Times Index', type: 'index', market: 'SG' },
    // Singapore — stocks
    { symbol: 'D05.SI',   name: 'DBS Bank',       type: 'stock', market: 'SG' },
    { symbol: 'O39.SI',   name: 'OCBC Bank',      type: 'stock', market: 'SG' },
    { symbol: 'U11.SI',   name: 'UOB',            type: 'stock', market: 'SG' },
    { symbol: 'Z74.SI',   name: 'Singtel',        type: 'stock', market: 'SG' },
    { symbol: 'C38U.SI',  name: 'CapitaLand REIT', type: 'stock', market: 'SG' },
];

async function fetchYahooQuote(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
    const raw = await fetch(url);
    const data = JSON.parse(raw);
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No result');
    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const prev  = meta.chartPreviousClose || meta.previousClose || price;
    return {
        regularMarketPrice:         price,
        regularMarketChange:        +(price - prev).toFixed(4),
        regularMarketChangePercent: +((price - prev) / prev * 100).toFixed(4),
        currency:                   meta.currency || '',
    };
}

let asianCache = null, asianLastFetch = 0;
const ASIAN_TTL = 5 * 60 * 1000;

async function fetchAsianMarkets() {
    if (asianCache && Date.now() - asianLastFetch < ASIAN_TTL) return asianCache;
    const results = await Promise.allSettled(
        ASIAN_SYMBOLS.map(async s => {
            const q = await fetchYahooQuote(s.symbol);
            return { symbol: s.symbol, shortName: s.name, type: s.type, market: s.market, ...q };
        })
    );
    const data = results
        .filter(r => r.status === 'fulfilled' && r.value.regularMarketPrice > 0)
        .map(r => r.value);
    if (data.length) { asianCache = data; asianLastFetch = Date.now(); }
    return asianCache || [];
}

// ── Yield Curve ──────────────────────────────────────────────────
let yieldCache = null, yieldLastFetch = 0;
const YIELD_TTL = 60 * 60 * 1000; // 1 hour

async function fetchYields() {
    if (yieldCache && Date.now() - yieldLastFetch < YIELD_TTL) return yieldCache;
    try {
        const now = new Date();
        const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
        const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${ym}`;
        const xml = await fetch(url);
        const entries = xml.split('<entry>');
        const last = entries[entries.length - 1];
        const fields = [
            { key: 'BC_1MONTH',  label: '1M' },
            { key: 'BC_3MONTH',  label: '3M' },
            { key: 'BC_6MONTH',  label: '6M' },
            { key: 'BC_1YEAR',   label: '1Y' },
            { key: 'BC_2YEAR',   label: '2Y' },
            { key: 'BC_3YEAR',   label: '3Y' },
            { key: 'BC_5YEAR',   label: '5Y' },
            { key: 'BC_7YEAR',   label: '7Y' },
            { key: 'BC_10YEAR',  label: '10Y' },
            { key: 'BC_20YEAR',  label: '20Y' },
            { key: 'BC_30YEAR',  label: '30Y' },
        ];
        const result = [];
        for (const f of fields) {
            const m = last.match(new RegExp(`<d:${f.key}[^>]*>([0-9.]+)<`));
            if (m) result.push({ label: f.label, yield: parseFloat(m[1]) });
        }
        if (result.length) { yieldCache = result; yieldLastFetch = Date.now(); }
        return yieldCache || [];
    } catch (e) {
        console.error('Yield fetch error:', e.message);
        return yieldCache || [];
    }
}

// ── Routes ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

app.get('/api/market', async (req, res) => {
    const data = await fetchMarket();
    res.json(data);
});

app.get('/api/news', async (req, res) => {
    const data = await fetchNews();
    res.json(data);
});

app.get('/api/yields', async (req, res) => {
    res.json(await fetchYields());
});

app.get('/api/asian', async (req, res) => {
    res.json(await fetchAsianMarkets());
});

app.get('/api/all', async (req, res) => {
    const [market, news] = await Promise.all([fetchMarket(), fetchNews()]);
    res.json({ market, news, updated: new Date().toISOString() });
});

app.get('/api/candles/:symbol', async (req, res) => {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return res.json({ c: [] });
    const { symbol } = req.params;
    const to   = Math.floor(Date.now() / 1000);
    const from = to - 30 * 24 * 3600;
    try {
        const raw  = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${apiKey}`);
        const data = JSON.parse(raw);
        res.json({ c: data.c || [] });
    } catch(e) {
        res.json({ c: [] });
    }
});

app.listen(PORT, () => {
    console.log(`\n  Market News Dashboard → http://localhost:${PORT}\n`);
    // Pre-warm cache
    fetchMarket().catch(() => {});
    fetchNews().catch(() => {});
});
