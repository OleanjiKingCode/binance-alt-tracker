export default async function handler(req, res) {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'COINGECKO_API_KEY not configured' });
  }

  const { path, ...params } = req.query;
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  // Only allow known CoinGecko paths
  const allowed = ['exchanges/binance/tickers', 'coins/markets'];
  if (!allowed.some(a => path.startsWith(a))) {
    return res.status(403).json({ error: 'Path not allowed' });
  }

  const qs = new URLSearchParams(params).toString();
  const url = `https://pro-api.coingecko.com/api/v3/${path}${qs ? '?' + qs : ''}`;

  try {
    const response = await fetch(url, {
      headers: { 'x-cg-pro-api-key': apiKey }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Failed to fetch from CoinGecko' });
  }
}
