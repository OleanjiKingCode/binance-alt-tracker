import 'dotenv/config';

const CG_BASE = 'https://pro-api.coingecko.com/api/v3';
const CG_KEY = process.env.COINGECKO_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const SCAN_INTERVAL = (parseInt(process.env.SCAN_INTERVAL) || 60) * 1000;
const COIN_REFRESH = (parseInt(process.env.COIN_REFRESH_INTERVAL) || 1800) * 1000;
const PUMP_THRESHOLD = parseFloat(process.env.PUMP_THRESHOLD) || 10;

// State
let binanceCoins = [];         // All Binance USDT coin IDs
let lastCoinRefresh = 0;
const alerted = new Map();     // coinId -> { c7 } — last alerted 7d change

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

// ── Telegram ──
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT || TG_TOKEN === 'your_bot_token_here') {
    log('⚠️  Telegram not configured, printing alert to console:\n' + text.replace(/<[^>]+>/g, ''));
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text,
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
  log('🔄 Refreshing Binance USDT pairs...');
  const coinMap = new Map();

  for (let page = 1; page <= 6; page++) {
    try {
      const data = await cgFetch('exchanges/binance/tickers', { page });
      if (data?.tickers) {
        for (const t of data.tickers) {
          if (t.target === 'USDT' && t.coin_id) {
            coinMap.set(t.coin_id, t.base);
          }
        }
      }
    } catch (e) {
      log(`⚠️  Failed to fetch tickers page ${page}: ${e.message}`);
    }
    await sleep(700);
  }

  binanceCoins = Array.from(coinMap.keys());
  lastCoinRefresh = Date.now();
  log(`✅ Found ${binanceCoins.length} Binance USDT pairs`);
}

// ── Main scan cycle ──
async function scanOnce() {
  // Refresh coin list if stale
  if (Date.now() - lastCoinRefresh > COIN_REFRESH || binanceCoins.length === 0) {
    await refreshBinanceCoins();
  }

  log(`📡 Scanning ${binanceCoins.length} coins...`);

  const batchSize = 50;
  const alerts = [];

  for (let i = 0; i < binanceCoins.length; i += batchSize) {
    const ids = binanceCoins.slice(i, i + batchSize).join(',');

    try {
      const data = await cgFetch('coins/markets', {
        vs_currency: 'usd',
        ids,
        price_change_percentage: '7d,30d',
        per_page: batchSize,
        page: 1
      });

      if (!Array.isArray(data)) continue;

      for (const coin of data) {
        const mc = coin.market_cap;
        const vol = coin.total_volume;
        const athPct = coin.ath_change_percentage;
        const c7 = coin.price_change_percentage_7d_in_currency;
        const c30 = coin.price_change_percentage_30d_in_currency;

        // Base dormant filters
        if (!mc || mc < 5e6 || mc > 200e6) continue;
        if (!athPct || Math.abs(athPct) < 70) continue;
        if (c30 == null || c30 < -30 || c30 > 30) continue;
        if (!vol || vol > 2e6) continue;

        // Pump detection: 7d change crossed the threshold
        if (c7 == null || c7 < PUMP_THRESHOLD) continue;

        const score = calcScore(coin);

        // Only alert if going higher than last alert, skip if dropping
        const prev = alerted.get(coin.id);
        if (prev && c7 <= prev.c7) continue;

        const prevC7 = prev ? prev.c7 : null;
        alerted.set(coin.id, { c7 });
        alerts.push({
          symbol: (coin.symbol || '').toUpperCase(),
          name: coin.name,
          id: coin.id,
          score,
          price: coin.current_price,
          market_cap: mc,
          volume: vol,
          ath_drop: Math.abs(athPct).toFixed(1),
          c7: c7.toFixed(1),
          c30: (c30 || 0).toFixed(1),
          prevC7: prevC7 ? prevC7.toFixed(1) : null,
        });
      }
    } catch (e) {
      log(`⚠️  Batch failed: ${e.message}`);
    }

    await sleep(700);
  }

  if (alerts.length === 0) {
    log(`✅ Scan complete. No new pumps detected.`);
    return;
  }

  // Sort by 7d change descending
  alerts.sort((a, b) => parseFloat(b.c7) - parseFloat(a.c7));

  log(`🚨 ${alerts.length} new pump alert(s)!`);

  // Build Telegram message
  let msg = `🚨 <b>PUMP ALERT — ${alerts.length} token${alerts.length > 1 ? 's' : ''} moving!</b>\n`;
  msg += `<i>7d change crossed +${PUMP_THRESHOLD}% on dormant Binance tokens</i>\n`;

  for (const t of alerts.slice(0, 20)) {
    const status = t.score >= 70 ? '🔥' : t.score >= 45 ? '👀' : '📊';
    const trend = t.prevC7 ? ` (was +${t.prevC7}% ↗️ now +${t.c7}%)` : '';
    const label = t.prevC7 ? '📈 STILL CLIMBING' : '🆕 NEW';
    msg += `\n${status} <b>${t.symbol}</b> (${t.name}) — ${label}\n`;
    msg += `   💰 ${fmtPrice(t.price)} | MCap: ${fmtMcap(t.market_cap)} | Vol: ${fmtVol(t.volume)}\n`;
    msg += `   📈 <b>7d: +${t.c7}%</b>${trend} | 30d: ${t.c30}% | ATH: -${t.ath_drop}%\n`;
    msg += `   Score: ${t.score}/100\n`;
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
  log(`Config:`);
  log(`  Scan interval: ${SCAN_INTERVAL / 1000}s`);
  log(`  Coin refresh: ${COIN_REFRESH / 1000}s`);
  log(`  Pump threshold: +${PUMP_THRESHOLD}% (7d)`);
  log(`  Re-alert: only when 7d% goes higher than last alert`);
  log(`  Telegram: ${TG_TOKEN && TG_TOKEN !== 'your_bot_token_here' ? '✅ configured' : '❌ not configured (console only)'}`);
  console.log('');

  // Initial scan
  await scanOnce();

  // Loop
  setInterval(async () => {
    try {
      await scanOnce();
    } catch (e) {
      log(`❌ Scan error: ${e.message}`);
    }
  }, SCAN_INTERVAL);
}

run().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
