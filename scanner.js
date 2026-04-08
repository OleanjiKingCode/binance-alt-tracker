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

// ── INITIAL SCAN: show all dormant tokens ──
async function initialScan() {
  log('📋 INITIAL SCAN — finding all dormant tokens...');

  await refreshBinanceCoins();
  const allMarket = await fetchAllMarketData();

  log(`📊 Got market data for ${allMarket.length} coins. Filtering...`);

  const dormant = [];
  for (const coin of allMarket) {
    const result = filterDormant(coin);
    if (result) dormant.push(result);
  }

  dormant.sort((a, b) => b.score - a.score);

  log(`✅ Found ${dormant.length} dormant tokens`);

  // Seed the alerted map with current values
  for (const t of dormant) {
    alerted.set(t.id, { c7: t.c7_raw, c24: t.c24_raw });
  }

  // Send full list to Telegram
  if (dormant.length === 0) {
    await sendTelegram('📋 <b>Dormant Scanner Started</b>\n\nNo dormant tokens found matching filters.');
    return;
  }

  const hot = dormant.filter(t => t.score >= 70);
  const watching = dormant.filter(t => t.score >= 45 && t.score < 70);
  const cold = dormant.filter(t => t.score < 45);

  let msg = '📋 <b>DORMANT TOKEN SCAN — Full Report</b>\n';
  msg += `📊 Scanned: ${allMarket.length} | Dormant: ${dormant.length}\n`;
  msg += `🔥 Hot: ${hot.length} | 👀 Watch: ${watching.length} | ❄️ Cold: ${cold.length}\n`;
  msg += `\nFilters: MCap $${(MIN_MCAP/1e6).toFixed(0)}M–$${(MAX_MCAP/1e6).toFixed(0)}M | ATH -${MIN_ATH_DROP}%+ | Vol under $${(MAX_VOL/1e6).toFixed(0)}M\n`;

  if (hot.length > 0) {
    msg += `\n🔥 <b>HOT (Score 70+)</b>\n`;
    for (const t of hot) {
      msg += `\n<b>${t.symbol}</b> — Score: ${t.score}/100\n`;
      msg += `   💰 ${fmtPrice(t.price)} | MCap: ${fmtMcap(t.market_cap)} | Vol: ${fmtVol(t.volume)}\n`;
      msg += `   📉 ATH: -${t.ath_drop}% | 24h: ${t.c24}% | 7d: ${t.c7}% | 30d: ${t.c30}%\n`;
      msg += `   <a href="https://www.coingecko.com/en/coins/${t.id}">Chart</a> · <a href="https://www.binance.com/en/trade/${t.symbol}_USDT">Trade</a>\n`;
    }
  }

  if (watching.length > 0) {
    msg += `\n👀 <b>WATCHING (Score 45-69)</b>\n`;
    for (const t of watching) {
      msg += `• <b>${t.symbol}</b> — ${t.score}pts | ${fmtPrice(t.price)} | 24h: ${t.c24}% | 7d: ${t.c7}% | ATH: -${t.ath_drop}%\n`;
    }
  }

  if (cold.length > 0) {
    msg += `\n❄️ <b>COLD (Score under 45)</b>\n`;
    for (const t of cold) {
      msg += `• ${t.symbol} — ${t.score}pts | ${fmtPrice(t.price)} | 24h: ${t.c24}% | 7d: ${t.c7}%\n`;
    }
  }

  msg += `\n⏰ Now monitoring every ${SCAN_INTERVAL/1000}s for 24h pumps above +${PUMP_THRESHOLD}%\n`;
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
  const alerts = [];

  for (const coin of allMarket) {
    const c24 = coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h ?? 0;

    // Any Binance token up 10%+ in 24h
    if (c24 < PUMP_THRESHOLD) continue;

    // Only alert if 24h going meaningfully higher than last alert
    const prev = alerted.get(coin.id);
    const r24 = Math.round(c24 * 10) / 10;
    if (prev && r24 <= prev.c24 + 0.5) continue;

    const prevC24 = prev ? prev.c24 : null;
    alerted.set(coin.id, { c24: r24 });

    const c7 = coin.price_change_percentage_7d_in_currency ?? 0;
    const c30 = coin.price_change_percentage_30d_in_currency ?? 0;

    alerts.push({
      symbol: (coin.symbol || '').toUpperCase(),
      name: coin.name,
      id: coin.id,
      price: coin.current_price,
      market_cap: coin.market_cap,
      volume: coin.total_volume,
      c24: c24.toFixed(1),
      c24_raw: c24,
      c7: c7.toFixed(1),
      c30: c30.toFixed(1),
      ath_drop: Math.abs(coin.ath_change_percentage || 0).toFixed(1),
      prevC24: prevC24 != null ? prevC24.toFixed(1) : null,
    });
  }

  if (alerts.length === 0) {
    log(`✅ No new pumps.`);
    return;
  }

  alerts.sort((a, b) => b.c24_raw - a.c24_raw);

  log(`🚨 ${alerts.length} pump alert(s)!`);

  let msg = `🚨 <b>PUMP ALERT — ${alerts.length} token${alerts.length > 1 ? 's' : ''} moving!</b>\n`;
  msg += `<i>24h change crossed +${PUMP_THRESHOLD}%</i>\n`;

  for (const t of alerts.slice(0, 20)) {
    const label = t.prevC24 ? '📈 STILL CLIMBING' : '🆕 NEW';
    msg += `\n🚀 <b>${t.symbol}</b> (${t.name}) — ${label}\n`;
    msg += `   💰 ${fmtPrice(t.price)} | MCap: ${fmtMcap(t.market_cap)} | Vol: ${fmtVol(t.volume)}\n`;
    msg += `   📈 <b>24h: +${t.c24}%</b> | 7d: ${t.c7}% | 30d: ${t.c30}% | ATH: -${t.ath_drop}%\n`;
    if (t.prevC24) {
      msg += `   ↗️ 24h was +${t.prevC24}% → now +${t.c24}%\n`;
    }
    msg += `   <a href="https://www.coingecko.com/en/coins/${t.id}">Chart</a> · <a href="https://www.binance.com/en/trade/${t.symbol}_USDT">Trade</a>\n`;
  }

  if (alerts.length > 20) {
    msg += `\n<i>+${alerts.length - 20} more...</i>\n`;
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
  log(`  MCap: $${(MIN_MCAP/1e6).toFixed(0)}M – $${(MAX_MCAP/1e6).toFixed(0)}M`);
  log(`  ATH drop: ${MIN_ATH_DROP}%+`);
  log(`  7d range: ${MIN_7D}% to ${MAX_7D}%`);
  log(`  Max volume: $${(MAX_VOL/1e6).toFixed(0)}M`);
  log(`  Pump threshold: +${PUMP_THRESHOLD}% (7d)`);
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
