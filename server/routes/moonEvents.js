const express = require('express');
const { supabase } = require('../db');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// ── GET /api/moon-events ── public, read by every visitor's Group Magic
// page to check for an admin override before falling back to the
// astronomically-calculated next New Moon / Full Moon date (see
// computeNextMoonEvents() in js/script.js).
router.get('/moon-events', async (req, res) => {
  if (!supabase) return res.json({ overrides: {} });
  const { data, error } = await supabase.from('moon_event_overrides').select('*');
  if (error) return res.json({ overrides: {}, error: error.message });
  const overrides = {};
  (data || []).forEach(row => {
    overrides[row.event_type] = { date: row.override_date, time: row.override_time, note: row.note };
  });
  res.json({ overrides });
});

// ── POST /api/moon-events ── admin, set/replace an override for one
// event type. Body: { eventType: 'new_moon'|'full_moon', date, time, note }
router.post('/moon-events', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });
  const b = req.body || {};
  if (!b.eventType || !['new_moon', 'full_moon'].includes(b.eventType)) {
    return res.status(400).json({ ok: false, error: 'eventType must be "new_moon" or "full_moon".' });
  }
  if (!b.date) return res.status(400).json({ ok: false, error: 'A date is required.' });
  const row = { event_type: b.eventType, override_date: b.date, override_time: b.time || null, note: b.note || null, updated_at: new Date().toISOString() };
  const { error } = await supabase.from('moon_event_overrides').upsert(row, { onConflict: 'event_type' });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// ── DELETE /api/moon-events/:eventType ── admin, clear an override —
// the site immediately falls back to the calculated date again.
router.delete('/moon-events/:eventType', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });
  if (!['new_moon', 'full_moon'].includes(req.params.eventType)) {
    return res.status(400).json({ ok: false, error: 'Invalid event type.' });
  }
  const { error } = await supabase.from('moon_event_overrides').delete().eq('event_type', req.params.eventType);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

module.exports = router;
