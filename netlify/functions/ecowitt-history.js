// Netlify serverless function — fetches historical Ecowitt data for a specific datetime
// Called with: /.netlify/functions/ecowitt-history?date=2026-03-27&hour=11
// Returns the closest 5-minute reading to that hour from Ecowitt history API

exports.handler = async (event) => {
  const APP_KEY = '7C78EE38078394C154BD80B2D874DBD3';
  const API_KEY = 'd4d54185-e9d9-4639-8fca-2c8593603558';
  const MAC     = '8C:4F:00:4F:FC:E2';

  const { date, hour } = event.queryStringParameters || {};
  if (!date || hour === undefined) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing date or hour' }) };
  }

  // Build a 2-hour window around the requested hour to ensure we capture a reading
  // Ecowitt history uses local time (Melbourne) in YYYY-MM-DD HH:mm:ss format
  const h = parseInt(hour);
  const startH = Math.max(0, h - 1);
  const endH   = Math.min(23, h + 1);
  const pad = n => String(n).padStart(2, '0');
  const start_date = `${date} ${pad(startH)}:00:00`;
  const end_date   = `${date} ${pad(endH)}:59:59`;

  const url = `https://api.ecowitt.net/api/v3/device/history` +
    `?application_key=${APP_KEY}` +
    `&api_key=${API_KEY}` +
    `&mac=${MAC}` +
    `&start_date=${encodeURIComponent(start_date)}` +
    `&end_date=${encodeURIComponent(end_date)}` +
    `&cycle_type=5min` +      // 5-minute intervals
    `&call_back=all` +
    `&temp_unitid=1` +        // Celsius
    `&wind_speed_unitid=7` +  // km/h
    `&pressure_unitid=3` +    // hPa
    `&rainfall_unitid=12`;    // mm

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Ecowitt history API returned ${res.status}`);
    const data = await res.json();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=300', // cache 5 min — historical data doesn't change
      },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
