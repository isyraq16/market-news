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
// Using ETFs as index proxies (Finnhub free tier doesn't support ^IXIC etc)
const MARKET_SYMBOLS = [
    { symbol: 'QQQ',  name: 'NASDAQ 100', isIndex: true  },
    { symbol: 'SPY',  name: 'S&P 500',    isIndex: true  },
    { symbol: 'DIA',  name: 'Dow Jones',  isIndex: true  },
    { symbol: 'NVDA', name: 'Nvidia',     isIndex: false },
    { symbol: 'AAPL', name: 'Apple',      isIndex: false },
    { symbol: 'TSLA', name: 'Tesla',      isIndex: false },
    { symbol: 'META', name: 'Meta',       isIndex: false },
    { symbol: 'MSFT', name: 'Microsoft',  isIndex: false },
    { symbol: 'AMZN', name: 'Amazon',     isIndex: false },
    { symbol: 'GOOGL', name: 'Alphabet',  isIndex: false },
    { symbol: 'ASML', name: 'ASML',       isIndex: false },
    { symbol: 'TSM',  name: 'TSMC',       isIndex: false },
    { symbol: 'PLTR', name: 'Palantir',   isIndex: false },
    { symbol: 'AMD',  name: 'AMD',        isIndex: false },
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
                    isIndex:                     s.isIndex,
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
                    source:   feed.name,
                    impacts:  tagNews(item.title || '', item.contentSnippet || ''),
                    sentiment: sentiment(item.title || '')
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

app.get('/api/all', async (req, res) => {
    const [market, news] = await Promise.all([fetchMarket(), fetchNews()]);
    res.json({ market, news, updated: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`\n  Market News Dashboard → http://localhost:${PORT}\n`);
    // Pre-warm cache
    fetchMarket().catch(() => {});
    fetchNews().catch(() => {});
});
