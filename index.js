// Nap Map Backend - Express + Google Directions API
process.on('unhandledRejection', r => { console.error('UNHANDLED REJECTION', r); process.exit(1); });
process.on('uncaughtException', e => { console.error('UNCAUGHT EXCEPTION', e); process.exit(1); });

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

const PORT = process.env.PORT || 10000;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Health check
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// PLAN endpoint
app.post('/api/plan', async (req, res) => {
  try {
    const { origin, destination, arriveAt } = req.body || {};
    if (!origin || !destination || !arriveAt) {
      return res.status(400).json({ ok:false, error:'origin, destination, arriveAt are required' });
    }
    if (!GOOGLE_KEY) {
      return res.status(500).json({ ok:false, error:'Missing GOOGLE_MAPS_API_KEY' });
    }

    const target = new Date(arriveAt).getTime();
    if (Number.isNaN(target)) return res.status(400).json({ ok:false, error:'arriveAt must be ISO8601' });

    const now = Date.now();
    let lo = Math.min(now, target - 6*3600_000);
    let hi = target - 5*60_000;
    if (hi <= lo) hi = lo + 30*60_000;

    async function getBestRoute(departMs) {
      const { data } = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
        params: {
          origin, destination, mode:'driving', alternatives:true,
          departure_time: Math.floor(departMs/1000),
          traffic_model:'best_guess',
          key: GOOGLE_KEY
        }
      });
      if (data.status !== 'OK' || !data.routes?.length) throw new Error(`Directions error: ${data.status}`);
      let best = null;
      for (const r of data.routes) {
        const leg = r.legs?.[0]; if (!leg) continue;
        const dur = (leg.duration_in_traffic || leg.duration)?.value || 0;
        if (!best || dur < best.durationSec) best = { route:r, leg, durationSec:dur };
      }
      return best;
    }

    function scoreRoute(best) {
      const steps = best.leg?.steps || [];
      let L=0, R=0, stops=0, longest=0, cur=0;
      for (const s of steps) {
        const m = s.maneuver || '';
        if (m.includes('turn-left')) L++;
        if (m.includes('turn-right')) R++;
        const d = s.duration?.value || 0;
        if (d < 25) stops++;
        if (d >= 120) { cur += d; longest = Math.max(longest, cur); } else { cur = 0; }
      }
      return { score: (longest/60) - (L+R) - stops*0.5,
               metrics: { totalDuration: best.durationSec, longestStretch: longest, leftTurns:L, rightTurns:R, stops } };
    }

    let candidate = null;
    for (let i=0;i<12;i++){
      const mid = Math.floor((lo+hi)/2);
      const best = await getBestRoute(mid);
      const arrive = mid + best.durationSec*1000;
      const delta = Math.abs(arrive - target);
      const scored = scoreRoute(best);
      const c = {
        departIso: new Date(mid).toISOString(),
        arriveAtIso: new Date(arrive).toISOString(),
        durationSec: best.durationSec,
        score: scored
      };
      if (!candidate || delta < Math.abs(new Date(candidate.arriveAtIso) - target)) candidate = c;
      if (arrive > target) hi = mid - 120000; else lo = mid + 120000;
      if (delta <= 60000 || (hi - lo) < 120000) break;
    }
    if (!candidate) return res.status(502).json({ ok:false, error:'No route found' });

    const enc = encodeURIComponent;
    const gArriveUnix = Math.floor(new Date(candidate.arriveAtIso).getTime()/1000);
    const handoff = {
      google: `https://www.google.com/maps/dir/?api=1&origin=${enc(origin)}&destination=${enc(destination)}&travelmode=driving&arrival_time=${gArriveUnix}`,
      apple:  `maps://?saddr=${enc(origin)}&daddr=${enc(destination)}&dirflg=d`
    };

    res.json({ ok:true, provider:'google',
      departIso: candidate.departIso, arriveAtIso: candidate.arriveAtIso,
      winner: { durationSec: candidate.durationSec, score: candidate.score },
      handoff
    });
  } catch (e) {
    console.error(e?.response?.data || e.message || e);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

app.listen(PORT, () => console.log(`Nap Map backend running on port ${PORT}`));
