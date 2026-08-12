const express = require('express');
const { supabase } = require('../db');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// ── GET /api/availability ── public, read by every visitor's booking calendar.
router.get('/availability', async (req, res) => {
  if (!supabase) return res.json({ blocks: [] });
  const { data, error } = await supabase.from('availability_blocks').select('*').order('created_at', { ascending: false });
  if (error) return res.json({ blocks: [], error: error.message });
  res.json({ blocks: data || [] });
});

// ── POST /api/availability ── admin, create/replace a block.
router.post('/availability', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });
  const b = req.body || {};
  if (!b.id || !b.type) return res.status(400).json({ ok: false, error: 'Missing id or type.' });
  const row = { id: b.id, type: b.type, start_date: b.startDate || null, end_date: b.endDate || null, times: b.times || [], note: b.note || null };
  const { error } = await supabase.from('availability_blocks').upsert(row, { onConflict: 'id' });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// ── DELETE /api/availability/:id ── admin
router.delete('/availability/:id', adminAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Database not configured yet.' });
  const { error } = await supabase.from('availability_blocks').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

module.exports = router;
