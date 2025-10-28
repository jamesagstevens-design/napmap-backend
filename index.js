// Nap Map Backend - Express + Google Directions API

// --- Safety: crash logging so failures show up clearly in logs ---
process.on('unhandledRejection', r => { console.error('UNHANDLED REJECTION', r); process.exit(1); });
process.on('uncaughtException', e => { console.error('UNCAUGHT EXCEPTION', e); process.exit(1); });

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// Trust Render's proxy so req.ip is correct (fixes express-rate-limit with X-Forwarded-For)
app.set('trust proxy', 1);

// Core middleware
app.use(express.json());
app.use(cors());
app.use(helmet());

// Rate limiter (safe; avoid hard-fail validation)
const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: false
});
app.use(limiter);

const PORT = process.env.PORT || 10000;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Friendly root page (so "/" isn't "Cannot GET /")
app.get('/', (_req, res) => {
  res.type('text/plain').send(
    'Nap Map backend is running.\n' +
    'GET  /healthz  -> {"ok":true}\n' +
    'POST /api/plan -> { origin, destination, arriveAt: ISO8601 }'
  );
});

// Health check
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// --- /api/plan: find a route that maximizes continuous "nap" stretch and arrives by target time ---
app.post('/api/plan', async (req, res) => {
  try {
    const { origin, destination, arriveAt } = req.body || {};
    if (!origin || !destination || !arriveAt) {
      return res.status(400).json({ ok: false, error: 'origin, destination, arriveAt are required' });
    }
    if (!GOOGLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing GOOGLE_MAPS_API_KEY' });
    }

    const targetTime = new Date(arriveAt).getTime();
    if (Number.isNaN(targetTime)) {
      return res.status(400).json({ ok: false, error: 'arriveAt must be ISO8601 (e.g., 2025-10-28T06:30:00Z)' });
    }

    // Build a search window for departure_time, never in the past
    const now = Date.now();
    const MIN_LEAD = 2 * 60 * 1000;        // depart at least 2 minutes from now
    const LOOKBACK = 6 * 60 * 60 * 1000;   // consider departures up to 6h before arrival

    // Clamp so we never query Google with a past departure_time
    let lo = Math.max(now + MIN_LEAD, targetTime - LOOKBACK);
    let hi = Math.max(lo + 30 * 60 * 1000, targetTime - 5 * 60 * 1000); // ensure lo < hi

    async function getBestRoute(departMs) {
      const { data } = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
        params: {
          origin,
          destination,
          mode: 'driving',
          alternatives: true,
          departure_time: Math.floor(departMs / 1000), // seconds since epoch
          traffic_model: 'best_guess',
          key: GOOGLE_KEY
        }
      });
      if (data.status !== 'OK' || !Array.isArray(data.routes) || data.routes.length === 0) {
        throw new Error(`Directions error: ${data.status}`);
      }
      // Pick shortest total duration_in_traffic (fallback to duration)
      let pick = null;
      for (const r of data.routes) {
        const leg = r.legs?.[0]; if (!leg) continue;
        const dur = (leg.duration_in_traffic || leg.duration)?.value || 0;
        if (!pick || dur < pick.durationSec) pick = { route: r, leg, durationSec: dur };
      }
      return pick;
    }

    function scoreRoute(best) {
      const steps = best.leg?.steps || [];
      let lefts = 0, rights = 0, stops = 0, longestStretch = 0, currentStretch = 0;
      for (const s of steps) {
        const m = s.maneuver || '';
        if (m.includes('turn-left')) lefts++;
        if (m.includes('turn-right')) rights++;
        const d = s.duration?.value || 0;        // seconds
        if (d < 25) stops++;                      // short steps ≈ stop/slow
        if (d >= 120) {                           // ≥2 min continuous stretch counts toward "nap"
          currentStretch += d;
          if (currentStretch > longestStretch) longestStretch = currentStretch;
        } else {
          currentStretch = 0;
        }
      }
      // Higher is better: long continuous stretch is rewarded, turns & stops are penalized
      const score = (longestStretch / 60) - (lefts + rights) - (stops * 0.5);
      return { score, metrics: {
        totalDuration: best.durationSec,
        longestStretch,
        leftTurns: lefts,
        rightTurns: rights,
        stops
      }};
    }

    let candidate = null;
    for (let i = 0; i < 12; i++) {
      let mid = Math.floor((lo + hi) / 2);
      if (mid < now + MIN_LEAD) mid = now + MIN_LEAD;

      const best = await getBestRoute(mid);
      const arriveEpoch = mid + (best.durationSec * 1000);
      const delta = Math.abs(arriveEpoch - targetTime);
      const scored = scoreRoute(best);

      const c = {
        departIso: new Date(mid).toISOString(),
        arriveAtIso: new Date(arriveEpoch).toISOString(),
        durationSec: best.durationSec,
        score: scored
      };

      if (!candidate || delta < Math.abs(new Date(candidate.arriveAtIso).getTime() - targetTime)) {
        candidate = c;
      }
      // Narrow the window around arrivals vs target
      if (arriveEpoch > targetTime) {
        hi = mid - 120_000;   // 2 min earlier
      } else {
        lo = mid + 120_000;   // 2 min later
      }
      if (delta <= 60_000 || (hi - lo) < 120_000) break; // within 1 min or window tiny
    }

    if (!candidate) {
      return res.status(502).json({ ok: false, error: 'No route found' });
    }

    const enc = encodeURIComponent;
    const gArriveUnix = Math.floor(new Date(candidate.arriveAtIso).getTime() / 1000);
    const handoff = {
      google: `https://www.google.com/maps/dir/?api=1&origin=${enc(origin)}&destination=${enc(destination)}&travelmode=driving&arrival_time=${gArriveUnix}`,
      apple:  `maps://?saddr=${enc(origin)}&daddr=${enc(destination)}&dirflg=d`
    };

    return res.json({
      ok: true,
      provider: 'google',
      departIso: candidate.departIso,
      arriveAtIso: candidate.arriveAtIso,
      winner: { durationSec: candidate.durationSec, score: candidate.score },
      handoff
    });

  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error('PLAN ERROR:', detail);
    return res.status(500).json({ ok: false, error: 'Server error', hint: detail });
  }
});

// Listen (must be last)
app.listen(PORT, () => console.log(`Nap Map backend running on port ${PORT}`));

