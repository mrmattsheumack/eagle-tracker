// Netlify serverless function — proxies Ecowitt real-time API to avoid CORS
// Deploy this to: netlify/functions/ecowitt.js

exports.handler = async (event) => {
  const APP_KEY = '7C78EE38078394C154BD80B2D874DBD3';
  const API_KEY = 'd4d54185-e9d9-4639-8fca-2c8593603558';
  const MAC     = '8C:4F:00:4F:FC:E2';

  const url = `https://api.ecowitt.net/api/v3/device/real_time` +
    `?application_key=${APP_KEY}` +
    `&api_key=${API_KEY}` +
    `&mac=${MAC}` +
    `&call_back=all` +
    `&temp_unitid=1` +      // Celsius
    `&wind_speed_unitid=7` + // km/h
    `&pressure_unitid=3` +  // hPa
    `&rainfall_unitid=12`;  // mm

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Ecowitt API returned ${res.status}`);
    const data = await res.json();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
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
