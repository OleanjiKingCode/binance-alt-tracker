const CG_BASE = 'https://pro-api.coingecko.com/api/v3';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function cgFetch(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${CG_BASE}/${path}${qs ? '?' + qs : ''}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      headers: { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY }
    });
    if (res.status === 429) { await sleep(2000 * attempt); continue; }
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    return res.json();
  }
  throw new Error('CoinGecko rate limited after retries');
}

function calcScore(t) {
  let score = 0;
  if (t.market_cap >= 5e6 && t.market_cap <= 50e6) score += 25;
  else if (t.market_cap > 50e6 && t.market_cap <= 150e6) score += 15;
  if (t.total_volume < 200000) score += 22;
  else if (t.total_volume < 500000) score += 14;
  else if (t.total_volume < 1500000) score += 6;
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

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Telegram env vars missing');

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

export default async function handler(req, res) {
  // Verify cron secret in production
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}` && process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Step 1: Fetch Binance USDT pairs
    const coinMap = new Map();
    for (let page = 1; page <= 6; page++) {
      const data = await cgFetch('exchanges/binance/tickers', { page });
      if (data?.tickers) {
        for (const t of data.tickers) {
          if (t.target === 'USDT' && t.coin_id) {
            coinMap.set(t.coin_id, { symbol: t.base, coinId: t.coin_id });
          }
        }
      }
      if (page < 6) await sleep(700);
    }

    // Step 2: Fetch market data
    const coinIds = Array.from(coinMap.keys());
    const batchSize = 50;
    let allMarket = [];

    for (let i = 0; i < coinIds.length; i += batchSize) {
      const ids = coinIds.slice(i, i + batchSize).join(',');
      try {
        const data = await cgFetch('coins/markets', {
          vs_currency: 'usd',
          ids,
          price_change_percentage: '7d,30d',
          per_page: batchSize,
          page: 1
        });
        if (Array.isArray(data)) allMarket = allMarket.concat(data);
      } catch (e) { /* skip failed batch */ }
      await sleep(700);
    }

    // Step 3: Filter and score
    const candidates = [];
    for (const coin of allMarket) {
      const mc = coin.market_cap;
      const vol = coin.total_volume;
      const athPct = coin.ath_change_percentage;
      const c7 = coin.price_change_percentage_7d_in_currency;
      const c30 = coin.price_change_percentage_30d_in_currency;

      if (!mc || mc < 5e6 || mc > 200e6) continue;
      if (!athPct || Math.abs(athPct) < 70) continue;
      if (c7 == null || c7 < -15 || c7 > 25) continue;
      if (c30 == null || c30 < -30 || c30 > 30) continue;
      if (!vol || vol > 2e6) continue;

      const score = calcScore(coin);
      if (score >= 45) {
        candidates.push({
          symbol: (coin.symbol || '').toUpperCase(),
          name: coin.name,
          id: coin.id,
          score,
          market_cap: mc,
          volume: vol,
          ath_drop: Math.abs(athPct).toFixed(1),
          c7: c7.toFixed(1),
          c30: c30.toFixed(1),
          price: coin.current_price
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    // Step 4: Send Telegram alert
    if (candidates.length === 0) {
      await sendTelegram('🔍 <b>Dormant Scanner</b>\n\nNo candidates found this scan.');
      return res.status(200).json({ sent: true, candidates: 0 });
    }

    const hot = candidates.filter(c => c.score >= 70);
    const watching = candidates.filter(c => c.score >= 45 && c.score < 70);

    let msg = '🚨 <b>Binance Dormant Token Scanner</b>\n';
    msg += `📊 Scanned ${allMarket.length} tokens | ${candidates.length} candidates\n\n`;

    if (hot.length > 0) {
      msg += `🔥 <b>HOT (${hot.length})</b>\n`;
      for (const t of hot.slice(0, 15)) {
        const mcStr = (t.market_cap / 1e6).toFixed(1);
        const volStr = t.volume < 1000 ? '$' + t.volume : '$' + (t.volume / 1e3).toFixed(0) + 'K';
        msg += `\n<b>${t.symbol}</b> — Score: ${t.score}\n`;
        msg += `  💰 $${formatPrice(t.price)} | MCap: $${mcStr}M | Vol: ${volStr}\n`;
        msg += `  📉 ATH: -${t.ath_drop}% | 7d: ${t.c7}% | 30d: ${t.c30}%\n`;
        msg += `  🔗 <a href="https://www.coingecko.com/en/coins/${t.id}">Chart</a> · <a href="https://www.binance.com/en/trade/${t.symbol}_USDT">Trade</a>\n`;
      }
    }

    if (watching.length > 0) {
      msg += `\n👀 <b>WATCHING (${watching.length})</b>\n`;
      for (const t of watching.slice(0, 10)) {
        msg += `• <b>${t.symbol}</b> — Score: ${t.score} | $${formatPrice(t.price)} | -${t.ath_drop}% ATH\n`;
      }
      if (watching.length > 10) {
        msg += `  <i>+${watching.length - 10} more...</i>\n`;
      }
    }

    msg += '\n⚠️ <i>Not financial advice. DYOR.</i>';

    await sendTelegram(msg);
    return res.status(200).json({ sent: true, hot: hot.length, watching: watching.length });

  } catch (e) {
    console.error('Scan failed:', e);
    try {
      await sendTelegram(`❌ <b>Scanner Error</b>\n${e.message}`);
    } catch (_) {}
    return res.status(500).json({ error: e.message });
  }
}

function formatPrice(n) {
  if (n == null) return '—';
  if (n < 0.0001) return n.toExponential(2);
  if (n < 0.01) return n.toFixed(6);
  if (n < 1) return n.toFixed(4);
  return n.toFixed(2);
}
