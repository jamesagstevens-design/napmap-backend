// Nap Map Backend — Express + Google Directions (nap-friendly routing)

// --- Safety: log crashes clearly ---
process.on('unhandledRejection', r => { console.error('UNHANDLED REJECTION', r); process.exit(1); });
process.on('uncaughtException', e => { console.error('UNCAUGHT EXCEPTION', e); process.exit(1); });

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// Behind Render's proxy so req.ip comes from X-Forwarded-For (fixes express-rate-limit)
app.set('trust proxy', 1);

// Core middleware
app.use(express.json());
app.use(cors());
app.use(helmet());

// Rate limiter (safe config)
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

// Friendly root page
app.get('/', (_req, res) => {
  res.type('text/plain').send(
    'Nap Map backend is running.\n' +
    'GET  /healthz  -> {"ok":true}\n' +
    'POST /api/plan -> { origin, destination, arriveAt: ISO8601 }\n'
  );
});

// Health check
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// --- /api/plan: choose nap-friendly route that arrives <= target time ---
app.post('/api/plan', async (req, res) => {
  try {
    const { origin, destination, arriveAt } = req.body || {};
    if (!origin || !destination || !arriveAt) {
      return res.status(400).json({ ok: false, error: 'origin, destination, arriveAt are required' });
    }
    if (!GOOGLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing GOOGLE_MAPS_API_KEY' });
    }

    // Parse target time
    const targetTime = new Date(arriveAt).getTime();
    if (Number.isNaN(targetTime)) {
      return res.status(400).json({ ok: false, error: 'arriveAt must be ISO8601 (e.g., 2025-10-28T06:30:00Z)' });
    }

    // Build a safe search window for departure_time (never in the past)
    const now = Date.now();
    const MIN_LEAD = 2 * 60 * 1000;        // must depart at least 2 minutes from now
    const LOOKBACK = 6 * 60 * 60 * 1000;   // consider departures up to 6h before arrival

    let lo = Math.max(now + MIN_LEAD, targetTime - LOOKBACK);
    let hi = Math.max(lo + 30 * 60 * 1000, targetTime - 5 * 60 * 1000); // ensure lo < hi

    // ----- weights (tweak to taste; AU driving favors penalizing right turns) -----
    const W_LONGEST_STRETCH = 3.0;  // minutes of continuous driving
    const W_USED_DURATION   = 1.0;  // total minutes spent driving (fills available time)
    const W_HIGHWAY_HINTS   = 0.8;  // ramps/merges/keeps ≈ freeway segments
    const P_LEFT_TURN       = 1.0;
    const P_RIGHT_TURN      = 1.6;
    const P_UTURN           = 3.0;
    const P_STOP            = 0.5;  // short steps <25s ≈ lights/stop signs
    const EARLY_ARRIVAL_PEN = 0.002; // tiny penalty per second early (prefer using time)

    async function getAlternatives(departMs) {
      const { data } = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
        params: {
          origin,
          destination,
          mode: 'driving',
          alternatives: true,
          departure_time: Math.floor(departMs / 1000),
          traffic_model: 'best_guess',
          key: GOOGLE_KEY
        }
      });
      if (data.status !== 'OK' || !Array.isArray(data.routes) || data.routes.length === 0) {
        throw new Error(`Directions error: ${data.status}`);
      }
      return data.routes.map(r => {
        const leg = r.legs?.[0];
        const dur = (leg?.duration_in_traffic || leg?.duration)?.value || 0;
        return { route: r, leg, durationSec: dur };
      });
    }

    function scoreRoute(candidate) {
      const steps = candidate.leg?.steps || [];
      let lefts = 0, rights = 0, uturns = 0, stops = 0, longestStretch = 0, currentStretch = 0, highwayHints = 0;

      for (const s of steps) {
        const m = s.maneuver || '';

        // turn counters
        if (m.includes('turn-left'))  lefts++;
        if (m.includes('turn-right')) rights++;
        if (m.includes('uturn'))      uturns++;

        // rough highway/freeway hints
        if (m.includes('ramp') || m.includes('merge') || m.includes('keep-left') || m.includes('keep-right')) {
          highwayHints++;
        }

        // stop/short-step heuristic
        const d = s.duration?.value || 0; // seconds
        if (d < 25) stops++;

        // continuous stretch calculation (>= 2 min)
        if (d >= 120) {
          currentStretch += d;
          if (currentStretch > longestStretch) longestStretch = currentStretch;
        } else {
          currentStretch = 0;
        }
      }

      const usedMinutes = candidate.durationSec / 60.0;
      const longestMins = longestStretch / 60.0;

      const score =
          W_LONGEST_STRETCH * longestMins +
          W_USED_DURATION   * usedMinutes   +
          W_HIGHWAY_HINTS   * highwayHints  -
          (P_LEFT_TURN  * lefts)           -
          (P_RIGHT_TURN * rights)          -
          (P_UTURN      * uturns)          -
          (P_STOP       * stops);

      return {
        score,
        metrics: {
          totalDuration: candidate.durationSec,
          longestStretch, // seconds
          leftTurns: lefts,
          rightTurns: rights,
          uturns,
          stops,
          highwayHints
        }
      };
    }

    // SEARCH window: choose the route with the HIGHEST "nap score" that arrives <= target
    let bestChoice = null;

    for (let i = 0; i < 12; i++) {
      let mid = Math.floor((lo + hi) / 2);
      if (mid < now + MIN_LEAD) mid = now + MIN_LEAD;

      const alts = await getAlternatives(mid);

      // evaluate each alternative at this departure time
      for (const cand of alts) {
        const arriveEpoch = mid + cand.durationSec * 1000;
        if (arriveEpoch > targetTime) continue; // skip routes that arrive late

        const scored = scoreRoute(cand);
        const early = targetTime - arriveEpoch; // seconds early (>= 0)
        const effectiveScore = scored.score - EARLY_ARRIVAL_PEN * early;

        const proposal = {
          departIso: new Date(mid).toISOString(),
          arriveAtIso: new Date(arriveEpoch).toISOString(),
          durationSec: cand.durationSec,
          score: scored,
          effectiveScore
        };

        if (!bestChoice || proposal.effectiveScore > bestChoice.effectiveScore) {
          bestChoice = proposal;
        }
      }

      // shrink search window using the fastest alt (to bracket the arrival)
      const fastest = alts.reduce((a, b) => (a.durationSec < b.durationSec ? a : b));
      const fastestArrive = mid + fastest.durationSec * 1000;
      if (fastestArrive > targetTime) {
        hi = mid - 120_000;   // move earlier
      } else {
        lo = mid + 120_000;   // move later
      }
      if ((hi - lo) < 120_000) break; // window small enough
    }

    if (!bestChoice) {
      return res.status(502).json({ ok: false, error: 'No route meets arrival constraint' });
    }

    // Handoff links
    const enc = encodeURIComponent;
    const gArriveUnix = Math.floor(new Date(bestChoice.arriveAtIso).getTime() / 1000);
    const handoff = {
      google: `https://www.google.com/maps/dir/?api=1&origin=${enc(origin)}&destination=${enc(destination)}&travelmode=driving&arrival_time=${gArriveUnix}`,
      apple:  `maps://?saddr=${enc(origin)}&daddr=${enc(destination)}&dirflg=d`
    };

    return res.json({
      ok: true,
      provider: 'google',
      departIso: bestChoice.departIso,
      arriveAtIso: bestChoice.arriveAtIso,
      winner: { durationSec: bestChoice.durationSec, score: bestChoice.score },
      handoff
    });

  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error('PLAN ERROR:', detail);
    return res.status(500).json({ ok: false, error: 'Server error', hint: detail });
  }
});

// Listen (keep last)
app.listen(PORT, () => console.log(`Nap Map backend running on port ${PORT}`));

