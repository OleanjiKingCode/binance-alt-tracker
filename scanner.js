import 'dotenv/config';

const CG_BASE = 'https://pro-api.coingecko.com/api/v3';
const CG_KEY = process.env.COINGECKO_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const SCAN_INTERVAL = (parseInt(process.env.SCAN_INTERVAL) || 60) * 1000;
const COIN_REFRESH = (parseInt(process.env.COIN_REFRESH_INTERVAL) || 1800) * 1000;
const PUMP_THRESHOLD = parseFloat(process.env.PUMP_THRESHOLD) || 10;
const TICKER_PAGES = parseInt(process.env.TICKER_PAGES) || 10;

// Filters
const MIN_MCAP = parseFloat(process.env.MIN_MCAP) || 5e6;
const MAX_MCAP = parseFloat(process.env.MAX_MCAP) || 200e6;
const MIN_ATH_DROP = parseFloat(process.env.MIN_ATH_DROP) || 70;
const MIN_7D = parseFloat(process.env.MIN_7D) || -15;
const MAX_7D = parseFloat(process.env.MAX_7D) || 25;
const MAX_VOL = parseFloat(process.env.MAX_VOL) || 2e6;

// State
let binanceCoins = [];
let lastCoinRefresh = 0;
let isFirstRun = true;
const alerted = new Map(); // coinId -> { c7 }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ── CoinGecko fetch ──
async function cgFetch(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${CG_BASE}/${path}${qs ? '?' + qs : ''}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'x-cg-pro-api-key': CG_KEY }
      });
      if (res.status === 429) {
        log(`⏳ Rate limited, waiting ${attempt * 3}s...`);
        await sleep(attempt * 3000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

// ── Telegram (splits long messages) ──
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT || TG_TOKEN === 'your_bot_token_here') {
    log('⚠️  Telegram not configured, printing to console:\n' + text.replace(/<[^>]+>/g, ''));
    return;
  }

  // Telegram max is 4096 chars — split on blank lines to avoid breaking HTML tags
  const chunks = [];
  if (text.length <= 4096) {
    chunks.push(text);
  } else {
    const sections = text.split('\n\n');
    let chunk = '';
    for (const section of sections) {
      if ((chunk + '\n\n' + section).length > 3800) {
        if (chunk) chunks.push(chunk);
        chunk = section;
      } else {
        chunk += (chunk ? '\n\n' : '') + section;
      }
    }
    if (chunk) chunks.push(chunk);
  }

  for (const msg of chunks) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT,
          text: msg,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      if (!res.ok) {
        const body = await res.text();
        log(`❌ Telegram error: ${body}`);
      }
    } catch (e) {
      log(`❌ Telegram send failed: ${e.message}`);
    }
    if (chunks.length > 1) await sleep(500);
  }
}

// ── Score calculation ──
function calcScore(t) {
  let score = 0;
  const mc = t.market_cap || 0;
  if (mc >= 5e6 && mc <= 50e6) score += 25;
  else if (mc > 50e6 && mc <= 150e6) score += 15;

  const vol = t.total_volume || 0;
  if (vol < 200000) score += 22;
  else if (vol < 500000) score += 14;
  else if (vol < 1500000) score += 6;

  const athDrop = Math.abs(t.ath_change_percentage || 0);
  if (athDrop >= 90) score += 18;
  else if (athDrop >= 80) score += 13;
  else if (athDrop >= 70) score += 8;

  const c7 = t.price_change_percentage_7d_in_currency;
  if (c7 != null && c7 >= -5 && c7 <= 8) score += 12;

  const c30 = t.price_change_percentage_30d_in_currency;
  if (c30 != null && c30 >= -10 && c30 <= 5) score += 10;

  score += 13; // Binance confirmed
  return score;
}

function fmtPrice(n) {
  if (n == null) return '—';
  if (n < 0.0001) return n.toExponential(2);
  if (n < 0.01) return n.toFixed(6);
  if (n < 1) return n.toFixed(4);
  return '$' + n.toFixed(2);
}

function fmtMcap(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + (n / 1e3).toFixed(0) + 'K';
}

function fmtVol(n) {
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

// ── Fetch all Binance USDT pairs ──
async function refreshBinanceCoins() {
  log(`🔄 Fetching Binance USDT pairs (${TICKER_PAGES} pages)...`);
  const coinMap = new Map();

  for (let page = 1; page <= TICKER_PAGES; page++) {
    try {
      const data = await cgFetch('exchanges/binance/tickers', { page });
      if (data?.tickers) {
        for (const t of data.tickers) {
          if (t.target === 'USDT' && t.coin_id) {
            coinMap.set(t.coin_id, t.base);
          }
        }
        // If we got less than 100 tickers, no more pages
        if (data.tickers.length < 100) {
          log(`   Page ${page} returned ${data.tickers.length} tickers — no more pages.`);
          break;
        }
      } else {
        break;
      }
    } catch (e) {
      log(`⚠️  Failed page ${page}: ${e.message}`);
    }
    if (page < TICKER_PAGES) await sleep(700);
  }

  binanceCoins = Array.from(coinMap.keys());
  lastCoinRefresh = Date.now();
  log(`✅ Found ${binanceCoins.length} unique Binance USDT pairs`);
}

// ── Fetch market data for all coins ──
async function fetchAllMarketData() {
  const batchSize = 50;
  let allMarket = [];

  for (let i = 0; i < binanceCoins.length; i += batchSize) {
    const ids = binanceCoins.slice(i, i + batchSize).join(',');
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(binanceCoins.length / batchSize);

    if (batchNum % 10 === 0 || batchNum === 1) {
      log(`   Batch ${batchNum}/${totalBatches}...`);
    }

    try {
      const data = await cgFetch('coins/markets', {
        vs_currency: 'usd',
        ids,
        price_change_percentage: '24h,7d,30d',
        per_page: batchSize,
        page: 1
      });
      if (Array.isArray(data)) allMarket = allMarket.concat(data);
    } catch (e) {
      log(`⚠️  Batch ${batchNum} failed: ${e.message}`);
    }

    await sleep(700);
  }

  return allMarket;
}

// ── Apply dormant filters ──
function filterDormant(coin) {
  const mc = coin.market_cap;
  const vol = coin.total_volume;
  const athPct = coin.ath_change_percentage;
  const c7 = coin.price_change_percentage_7d_in_currency;
  const c30 = coin.price_change_percentage_30d_in_currency;

  if (!mc || mc < MIN_MCAP || mc > MAX_MCAP) return null;
  if (!athPct || Math.abs(athPct) < MIN_ATH_DROP) return null;
  if (c7 == null || c7 < MIN_7D || c7 > MAX_7D) return null;
  if (c30 == null || c30 < -30 || c30 > 30) return null;
  if (!vol || vol > MAX_VOL) return null;

  const c24 = coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h ?? 0;

  return {
    symbol: (coin.symbol || '').toUpperCase(),
    name: coin.name,
    id: coin.id,
    score: calcScore(coin),
    price: coin.current_price,
    market_cap: mc,
    volume: vol,
    ath_drop: Math.abs(athPct).toFixed(1),
    c24: c24.toFixed(1),
    c24_raw: c24,
    c7: c7.toFixed(1),
    c30: (c30 || 0).toFixed(1),
    c7_raw: c7,
  };
}

// ── INITIAL SCAN: show all tokens up 10%+ in 24h ──
async function initialScan() {
  log('📋 INITIAL SCAN — finding all Binance tokens up 10%+ in 24h...');

  await refreshBinanceCoins();
  const allMarket = await fetchAllMarketData();

  log(`📊 Got market data for ${allMarket.length} coins. Filtering...`);

  const now = Date.now();
  const SIX_MONTHS = 180 * 24 * 60 * 60 * 1000;
  const FIVE_YEARS = 5 * 365 * 24 * 60 * 60 * 1000;

  // Seed ALL coins into alerted map with their current 24h values
  // so we only alert when something NEWLY crosses 10%, not already above
  let seeded = 0;
  for (const coin of allMarket) {
    const athDate = coin.ath_date ? new Date(coin.ath_date).getTime() : 0;
    const atlDate = coin.atl_date ? new Date(coin.atl_date).getTime() : 0;
    const oldestDate = Math.min(athDate || now, atlDate || now);
    const age = now - oldestDate;
    if (age < SIX_MONTHS || age > FIVE_YEARS) continue;

    const c24 = coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h ?? 0;
    const r24 = Math.round(c24 * 10) / 10;
    alerted.set(coin.id, { c24: r24 });
    seeded++;
  }

  log(`✅ Seeded ${seeded} coins. Will alert when any newly cross +${PUMP_THRESHOLD}% in 24h.`);

  let msg = `📋 <b>Scanner Started</b>\n\n`;
  msg += `📊 Tracking ${seeded} Binance tokens (age 6mo–5yr)\n`;
  msg += `⏰ Checking every ${SCAN_INTERVAL/1000}s for tokens crossing +${PUMP_THRESHOLD}% in 24h\n`;
  msg += `🔔 You'll be alerted when a token hits or crosses the threshold\n\n`;
  msg += `⚠️ <i>Not financial advice. DYOR.</i>`;

  await sendTelegram(msg);
}

// ── RECURRING SCAN: pump detection only ──
async function pumpScan() {
  if (Date.now() - lastCoinRefresh > COIN_REFRESH) {
    await refreshBinanceCoins();
  }

  log(`📡 Pump check — ${binanceCoins.length} coins...`);

  const allMarket = await fetchAllMarketData();
  const newCrossings = [];
  const stillClimbing = [];

  const now = Date.now();
  const SIX_MONTHS = 180 * 24 * 60 * 60 * 1000;
  const FIVE_YEARS = 5 * 365 * 24 * 60 * 60 * 1000;

  for (const coin of allMarket) {
    // Check coin age: 6 months to 5 years old (use ath_date as proxy)
    const athDate = coin.ath_date ? new Date(coin.ath_date).getTime() : 0;
    const atlDate = coin.atl_date ? new Date(coin.atl_date).getTime() : 0;
    const oldestDate = Math.min(athDate || now, atlDate || now);
    const age = now - oldestDate;
    if (age < SIX_MONTHS || age > FIVE_YEARS) continue;

    const c24 = coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h ?? 0;

    // 24h up 10%+
    if (c24 < PUMP_THRESHOLD) continue;

    // Only alert if 24h going meaningfully higher than last alert
    const prev = alerted.get(coin.id);
    const r24 = Math.round(c24 * 10) / 10;
    if (prev && r24 <= prev.c24 + 0.5) continue;

    const prevC24 = prev ? prev.c24 : null;
    alerted.set(coin.id, { c24: r24 });

    const c7 = coin.price_change_percentage_7d_in_currency ?? 0;
    const c30 = coin.price_change_percentage_30d_in_currency ?? 0;
    const ageYears = (age / (365 * 24 * 60 * 60 * 1000)).toFixed(1);
    const sym = (coin.symbol || '').toUpperCase();

    // Was below threshold last check → just crossed = NEW
    // Was already above threshold → still climbing = one-liner
    const justCrossed = prevC24 == null || prevC24 < PUMP_THRESHOLD;

    if (justCrossed) {
      newCrossings.push({
        symbol: sym, name: coin.name, id: coin.id,
        price: coin.current_price, market_cap: coin.market_cap,
        c24: c24.toFixed(1), c7: c7.toFixed(1), c30: c30.toFixed(1),
        ath_drop: Math.abs(coin.ath_change_percentage || 0).toFixed(1),
        ageYears,
        prevC24: prevC24 != null ? prevC24.toFixed(1) : null,
      });
    } else {
      stillClimbing.push({
        symbol: sym,
        prevC24: prevC24.toFixed(1),
        c24: c24.toFixed(1),
      });
    }
  }

  if (newCrossings.length === 0 && stillClimbing.length === 0) {
    log(`✅ No new pumps.`);
    return;
  }

  log(`🚨 ${newCrossings.length} new crossing(s), ${stillClimbing.length} still climbing`);

  // Build message
  let msg = '';

  if (newCrossings.length > 0) {
    newCrossings.sort((a, b) => parseFloat(b.c24) - parseFloat(a.c24));
    msg += `🚨 <b>NEW +${PUMP_THRESHOLD}% CROSSINGS</b>\n`;

    for (const t of newCrossings.slice(0, 15)) {
      msg += `\n🚀 <b>${t.symbol}</b> (${t.name}) — JUST CROSSED +${PUMP_THRESHOLD}%\n`;
      msg += `   💰 ${fmtPrice(t.price)} | MCap: ${fmtMcap(t.market_cap)} | Age: ${t.ageYears}y\n`;
      msg += `   📈 24h: was +${t.prevC24 || '0.0'}% → <b>now +${t.c24}%</b>\n`;
      msg += `   7d: ${t.c7}% | 30d: ${t.c30}% | ATH: -${t.ath_drop}%\n`;
      msg += `   <a href="https://www.coingecko.com/en/coins/${t.id}">Chart</a> · <a href="https://www.binance.com/en/trade/${t.symbol}_USDT">Trade</a>\n`;
    }
  }

  if (stillClimbing.length > 0) {
    stillClimbing.sort((a, b) => parseFloat(b.c24) - parseFloat(a.c24));
    msg += `\n———————————\n`;
    msg += `📊 <b>Still climbing:</b>\n`;
    for (const t of stillClimbing.slice(0, 20)) {
      msg += `• <b>${t.symbol}</b>: +${t.prevC24}% → +${t.c24}%\n`;
    }
    if (stillClimbing.length > 20) {
      msg += `<i>+${stillClimbing.length - 20} more...</i>\n`;
    }
  }

  msg += `\n⚠️ <i>Not financial advice. DYOR.</i>`;

  await sendTelegram(msg);
}

// ── Runner ──
async function run() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Binance Dormant Token Pump Scanner     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  log('Config:');
  log(`  Ticker pages: ${TICKER_PAGES}`);
  log(`  Pump threshold: +${PUMP_THRESHOLD}% (24h)`);
  log(`  Scan interval: ${SCAN_INTERVAL / 1000}s`);
  log(`  Coin refresh: ${COIN_REFRESH / 1000}s`);
  log(`  Telegram: ${TG_TOKEN && TG_TOKEN !== 'your_bot_token_here' ? '✅' : '❌ (console only)'}`);
  console.log('');

  // Step 1: Full initial scan — send all dormant tokens
  await initialScan();
  isFirstRun = false;

  log('');
  log(`🔁 Starting pump monitoring every ${SCAN_INTERVAL / 1000}s...`);
  log('');

  // Step 2: Loop — pump detection only
  setInterval(async () => {
    try {
      await pumpScan();
    } catch (e) {
      log(`❌ Scan error: ${e.message}`);
    }
  }, SCAN_INTERVAL);
}

run().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
