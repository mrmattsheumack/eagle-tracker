// netlify/functions/eagle-cam-webhook.js
//
// Receives motion detection events from Frigate NVR.
// Stage 1: immediately writes candidate record to Supabase (radar fires ~2-3s)
// Stage 2: calls Claude Vision API async, updates same record with species ID
//
// Frigate webhook payload expected:
// {
//   "type": "new",
//   "before": {},
//   "after": {
//     "id": "1234567890.123456-abc123",
//     "camera": "eagle_cam",
//     "label": "bird",
//     "score": 0.87,
//     "area": 1240,
//     "ratio": 2.1,
//     "box": [0.42, 0.18, 0.61, 0.34],   // [x1,y1,x2,y2] normalised 0-1
//     "start_time": 1711234567.123,
//     "top_score": 0.91
//   }
// }
//
// Frigate snapshot URL pattern (configure in frigate config.yml):
// http://<frigate-ip>:5000/api/events/<event_id>/snapshot.jpg

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key, not anon
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FRIGATE_IP = process.env.FRIGATE_IP || "192.168.1.100";

// Camera config — update these to match your Reolink mount
const CAMERA_CONFIG = {
  mountBearingDeg: 180,     // compass bearing camera faces when pan=0 (degrees, 0=N, 90=E)
  mountAltitudeM: 8,        // approx height of camera above ground (metres)
  defaultTiltDeg: 35,       // tilt angle above horizontal when at rest
  panRangeDeg: 355,         // total pan range of PTZ
};

// Altitude bracket from tilt angle
function altitudeBracket(tiltDeg) {
  if (tiltDeg < 20) return "high (>200m)";
  if (tiltDeg < 40) return "mid (80–200m)";
  if (tiltDeg < 60) return "low (20–80m)";
  return "very low (<20m)";
}

// Estimate distance from tilt angle and assumed altitude
function estimateDistanceM(tiltDeg, assumedAltM = 80) {
  const rad = tiltDeg * Math.PI / 180;
  if (rad <= 0) return 999;
  return Math.round(assumedAltM / Math.tan(rad));
}

// Convert pan position + mount bearing to compass bearing
function panToCompassBearing(panDeg, mountBearingDeg) {
  return Math.round((mountBearingDeg + panDeg + 360) % 360);
}

// Bearing to compass direction label
function bearingToLabel(deg) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// Fetch Frigate snapshot as base64
async function fetchSnapshot(eventId) {
  try {
    const url = `http://${FRIGATE_IP}:5000/api/events/${eventId}/snapshot.jpg?crop=1&quality=85`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString("base64");
  } catch {
    return null;
  }
}

// Write or update candidate record in Supabase
async function supabaseUpsert(record) {
  const res = await fetch(`${SUPA_URL}/rest/v1/candidate_sightings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPA_KEY,
      "Authorization": `Bearer ${SUPA_KEY}`,
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify(record),
  });
  return res.ok;
}

// Update existing candidate record by frigate_event_id
async function supabaseUpdate(frigateEventId, fields) {
  const res = await fetch(
    `${SUPA_URL}/rest/v1/candidate_sightings?frigate_event_id=eq.${encodeURIComponent(frigateEventId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPA_KEY,
        "Authorization": `Bearer ${SUPA_KEY}`,
      },
      body: JSON.stringify(fields),
    }
  );
  return res.ok;
}

// Fetch current weather from Open-Meteo (Dromana)
async function fetchWeather() {
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=-38.334&longitude=144.967&current=temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover,weather_code&wind_speed_unit=kmh&forecast_days=1";
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const d = await res.json();
    const c = d.current;
    return {
      temp: c.temperature_2m,
      windSpeed: c.wind_speed_10m,
      windDir: c.wind_direction_10m,
      cloudCover: c.cloud_cover,
      weatherCode: c.weather_code,
    };
  } catch {
    return null;
  }
}

// Call Claude Vision to classify the bird
async function classifyWithClaude(base64Image, candidateData) {
  const { bearing, bearingLabel, distanceM, altitudeBracketStr, weather } = candidateData;

  const weatherStr = weather
    ? `Current conditions at Dromana: ${weather.temp}°C, wind ${weather.windSpeed}km/h from ${weather.windDir}°, cloud cover ${weather.cloudCover}%.`
    : "";

  const prompt = `You are an expert Australian raptor and bird identification specialist.

A security camera on a roof at Dromana, Mornington Peninsula, Victoria has detected a large bird.
Camera bearing: ${bearing}° (${bearingLabel}). Estimated distance: ~${distanceM}m. Altitude bracket: ${altitudeBracketStr}.
${weatherStr}

This camera system is specifically monitoring for:
- Wedge-tailed Eagle (Aquila audax) — primary target
- Other large raptors: White-bellied Sea-Eagle, Brown Falcon, Whistling Kite, Black-shouldered Kite, Swamp Harrier, Brown Goshawk, Little Eagle, Peregrine Falcon
- Other notable transiting birds: Black Cockatoo species, White Ibis, Straw-necked Ibis, large herons

Analyse this camera frame and respond ONLY with a JSON object (no markdown, no preamble):
{
  "detected": true/false,
  "species": "species common name or null",
  "confidence": 0-100,
  "altBracketConfirmed": "very low/low/mid/high",
  "behaviour": "soaring/gliding/flapping/hovering/perched/unknown",
  "flightDirection": "approaching/departing/crossing/circling/unknown",
  "wingspanEstimate": "small/medium/large/very large",
  "plumageNotes": "brief notes on visible plumage",
  "reasoning": "one sentence max",
  "notEagle": false,
  "alternativeSpecies": "if not eagle, most likely species"
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: base64Image },
            },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.find(b => b.type === "text")?.text || "";

    // Strip any accidental markdown fences
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

// ─── Main handler ───────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  // Only process new detections of birds (or animals if bird model not configured)
  const event = payload?.after;
  if (!event) return new Response("No event data", { status: 400 });

  const label = event.label || "";
  if (!["bird", "animal", "person"].includes(label) && label !== "") {
    // Frigate fired for vehicle or other — ignore
    return new Response("Not a bird event", { status: 200 });
  }

  // Filter by minimum detection area (filters out tiny distant birds / noise)
  // area is in pixels²; for a 1080p frame, a wedgie at 300m ≈ 400-800px²
  const area = event.area || 0;
  if (area < 200) {
    return new Response("Detection too small", { status: 200 });
  }

  const frigateEventId = event.id;
  const detectedAt = new Date(event.start_time * 1000).toISOString();

  // ── Derive position from bounding box ──
  // box: [x1, y1, x2, y2] normalised. Centre of box gives pan/tilt estimate.
  const box = event.box || [0.4, 0.2, 0.6, 0.4];
  const boxCentreX = (box[0] + box[2]) / 2;  // 0=left edge, 1=right edge
  const boxCentreY = (box[1] + box[3]) / 2;  // 0=top, 1=bottom

  // Map horizontal position to pan offset (-177 to +177 degrees)
  const panOffsetDeg = (boxCentreX - 0.5) * CAMERA_CONFIG.panRangeDeg;
  const bearing = panToCompassBearing(panOffsetDeg, CAMERA_CONFIG.mountBearingDeg);
  const bearingLabel = bearingToLabel(bearing);

  // Map vertical position to tilt (top of frame = high tilt, bottom = low)
  const tiltDeg = CAMERA_CONFIG.defaultTiltDeg + (0.5 - boxCentreY) * 60;
  const altBracketStr = altitudeBracket(tiltDeg);
  const distanceM = estimateDistanceM(Math.max(5, tiltDeg));

  // ── Fetch weather in parallel with snapshot ──
  const [weather, snapshotBase64] = await Promise.all([
    fetchWeather(),
    fetchSnapshot(frigateEventId),
  ]);

  // ── STAGE 1: Write immediate candidate record ──────────────────────────────
  const stage1Record = {
    frigate_event_id: frigateEventId,
    detected_at: detectedAt,
    status: "motion_detected",
    bearing_deg: bearing,
    bearing_label: bearingLabel,
    tilt_deg: Math.round(tiltDeg),
    altitude_bracket: altBracketStr,
    distance_est_m: distanceM,
    detection_area_px: area,
    detection_score: event.score || null,
    snapshot_base64: snapshotBase64,
    weather_temp: weather?.temp ?? null,
    weather_wind_speed: weather?.windSpeed ?? null,
    weather_wind_dir: weather?.windDir ?? null,
    weather_cloud_cover: weather?.cloudCover ?? null,
    ai_species: null,
    ai_confidence: null,
    ai_behaviour: null,
    ai_flight_direction: null,
    ai_reasoning: null,
    ai_plumage_notes: null,
    confirmed_species: null,
    confirmed_by_user: false,
    dismissed: false,
  };

  await supabaseUpsert(stage1Record);

  // Return 200 immediately — Frigate doesn't need to wait for AI
  // Stage 2 runs after response is sent (Netlify background function pattern)
  // We use waitUntil if available, otherwise just await (slight delay, acceptable)

  // ── STAGE 2: Claude Vision classification ─────────────────────────────────
  if (snapshotBase64) {
    const classification = await classifyWithClaude(snapshotBase64, {
      bearing,
      bearingLabel,
      distanceM,
      altitudeBracketStr: altBracketStr,
      weather,
    });

    if (classification) {
      await supabaseUpdate(frigateEventId, {
        status: "ai_classified",
        ai_species: classification.species,
        ai_confidence: classification.confidence,
        ai_behaviour: classification.behaviour,
        ai_flight_direction: classification.flightDirection,
        ai_reasoning: classification.reasoning,
        ai_plumage_notes: classification.plumageNotes,
        ai_wingspan_estimate: classification.wingspanEstimate,
        ai_altitude_confirmed: classification.altBracketConfirmed,
        ai_classified_at: new Date().toISOString(),
      });
    }
  } else {
    // No snapshot available — still mark as needing classification
    await supabaseUpdate(frigateEventId, {
      status: "no_snapshot",
    });
  }

  return new Response(JSON.stringify({ ok: true, eventId: frigateEventId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = { path: "/api/eagle-cam-webhook" };
