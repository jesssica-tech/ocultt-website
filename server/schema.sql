-- ═══════════════════════════════════════════════════════════════════
-- The Ocultt Tarot — CRM database schema (Supabase / Postgres)
--
-- HOW TO RUN THIS:
--   1. Open your Supabase project → SQL Editor → New query.
--   2. Paste this entire file, click Run.
--   3. That's it — every table, index, and the 4 CRM logins are created.
--
-- Safe to re-run: every statement uses IF NOT EXISTS / ON CONFLICT, so
-- running this twice never duplicates or wipes data.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── bookings ── every booking of every type (Tarot Audio, Spell, Group,
-- Numerology, Energy Healing). Phone Tarot bookings are ALSO stored here
-- (for CRM visibility) even though scheduling itself stays on Calendly.
create table if not exists bookings (
  id                    text primary key,
  service               text not null,
  package               text,
  duration              text,
  preferred_date        text,
  preferred_time        text,
  appointment_at        timestamptz,           -- real ISO datetime, when known — drives reminders
  format                text,
  intention             text,
  detail                text,
  notes                 text,
  name                  text not null,
  email                 text not null,
  phone                 text,
  payment_status        text default 'Unpaid',
  payment_id            text,
  status                text default 'Booking Received',
  priority              text default 'Normal',
  -- spell-specific fields (only used when service = 'Spell / Magic')
  spell_category        text,
  urgency               text,
  video_url             text,
  video_sent            boolean default false,
  video_sent_at         timestamptz,
  video_link_expires_at timestamptz,
  workflow_stage        text,
  stage_history         jsonb default '[]'::jsonb,
  -- Google Meet / Calendar (Phone Tarot, synced from Calendly's webhook)
  meet_status            text default 'N/A',
  meet_link              text,
  calendar_event_id      text,
  meet_summary           text,                 -- Akanksha's notes/summary after the call
  -- reminders / notifications
  reminder_sent          boolean default false,
  admin_notified         boolean default false,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);
create index if not exists idx_bookings_email        on bookings(email);
create index if not exists idx_bookings_service       on bookings(service);
create index if not exists idx_bookings_appointment   on bookings(appointment_at);
create index if not exists idx_bookings_status        on bookings(status);

-- ── messages ── every message/audio/video Akanksha sends to a client
-- from inside the CRM (and a record of inbound replies, if ever wired
-- up), so she has one thread per client instead of digging through Gmail.
create table if not exists messages (
  id             uuid primary key default gen_random_uuid(),
  booking_id     text references bookings(id) on delete cascade,
  customer_email text,                          -- kept even if booking_id is null (general client note)
  direction      text not null default 'outbound',   -- 'outbound' | 'inbound'
  channel        text not null default 'email',      -- 'email' | 'note'
  subject        text,
  body           text,
  attachment_url text,
  sent_by        text,                           -- CRM user email who sent it
  created_at     timestamptz default now()
);
create index if not exists idx_messages_booking on messages(booking_id);
create index if not exists idx_messages_email   on messages(customer_email);

-- ── availability_blocks ── admin-managed calendar blackout/open blocks
create table if not exists availability_blocks (
  id         text primary key,
  type       text,
  start_date text,
  end_date   text,
  times      jsonb default '[]'::jsonb,
  note       text,
  created_at timestamptz default now()
);

-- ── moon_event_overrides ── lets Akankshaa override the auto-calculated
-- next New Moon / Full Moon date shown on the Group Magic page, for the
-- rare case she's unavailable that day. event_type is the primary key —
-- exactly one row per event type, upserted from the CRM. If a row is
-- absent (or deleted), the site falls back to the astronomically
-- calculated date automatically — nothing manual is required by default.
create table if not exists moon_event_overrides (
  event_type      text primary key,       -- 'new_moon' | 'full_moon'
  override_date   text,                   -- e.g. '2026-09-14'
  override_time   text,                   -- e.g. '8:00 PM IST'
  note            text,
  updated_at      timestamptz default now()
);

-- ── users ── every customer who has ever signed in with Google on the
-- public site (NOT the CRM allowlist — see crm_users below for that).
-- Saved automatically by POST /api/users/sync right after Firebase login.
-- uid is the real Firebase UID, so it's a stable key even if someone
-- changes their Google display name/email later.
create table if not exists users (
  uid          text primary key,
  name         text,
  email        text,
  picture      text,
  created_at   timestamptz default now(),
  last_login_at timestamptz default now()
);
create index if not exists idx_users_email on users(email);

-- ── crm_users ── the allowlist of who may sign into the CRM (4 of you).
-- Login itself is still Google Sign-In (Firebase) — this table is the
-- server-side source of truth for "is this signed-in Google account
-- actually allowed into the CRM", checked on every admin API request.
create table if not exists crm_users (
  email      text primary key,
  name       text,
  active     boolean default true,
  created_at timestamptz default now()
);
insert into crm_users (email, name) values
  ('ocultt05tarot@gmail.com',      'Akanksha'),
  ('akankshachoudhary10@gmail.com','Akanksha'),
  ('dishasoni99@gmail.com',        'Disha'),
  ('the.ocultt.tarot@gmail.com',   'Team')
on conflict (email) do nothing;
-- Add/remove the 4 real logins here — edit and re-run just this block anytime:
--   insert into crm_users (email, name) values ('someone@gmail.com','Name') on conflict (email) do nothing;
--   update crm_users set active = false where email = 'someone@gmail.com';

-- ═══════════════════════════════════════════════════════════════════
-- V168 — Launch upgrade: email queue, delivery packages, payment-failure
-- tracking. All additive — safe to re-run, never drops/renames anything
-- above this line.
-- ═══════════════════════════════════════════════════════════════════

-- ── email_queue ── every outbound email goes through this table instead
-- of being sent inline-only. We still attempt an immediate send right
-- after enqueueing (so customers get instant confirmations, no waiting
-- on a cron cycle) — this table is what makes that attempt retryable,
-- deduplicated, and visible if it silently failed instead of vanishing.
create table if not exists email_queue (
  id                 uuid primary key default gen_random_uuid(),
  idempotency_key    text unique,              -- prevents the same logical email being queued twice
  template_type      text not null,
  recipient          text not null,
  payload            jsonb not null default '{}'::jsonb,
  status             text not null default 'pending',  -- pending | processing | sent | failed
  attempts           int not null default 0,
  max_attempts       int not null default 5,
  last_error         text,
  next_attempt_at    timestamptz not null default now(),
  sent_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_email_queue_status_next on email_queue(status, next_attempt_at);
create index if not exists idx_email_queue_recipient on email_queue(recipient);

-- ── delivery_packages ── one row per "customer link" — bundles however
-- many files Akanksha attaches into a single secure, expiring URL.
create table if not exists delivery_packages (
  id            uuid primary key default gen_random_uuid(),
  booking_id    text references bookings(id) on delete cascade,
  token         text unique not null,          -- opaque random token, goes in the customer URL
  status        text not null default 'draft', -- draft (Akanksha still adding/replacing files) | sent
  title         text,                          -- e.g. "Your Tarot Reading is Ready"
  expires_at    timestamptz,                   -- set only once status = 'sent'
  sent_at       timestamptz,
  accessed_count int not null default 0,
  last_accessed_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_delivery_packages_token on delivery_packages(token);
create index if not exists idx_delivery_packages_booking on delivery_packages(booking_id);

-- ── delivery_files ── the individual files inside a package. Cloudinary
-- public_id + resource_type are stored (NOT a raw URL) so the backend can
-- mint a fresh short-lived signed URL on every access instead of handing
-- out one permanent link.
create table if not exists delivery_files (
  id            uuid primary key default gen_random_uuid(),
  package_id    uuid references delivery_packages(id) on delete cascade,
  file_type     text not null,                 -- video | audio | image | document
  label         text,                          -- e.g. "Tarot Reading Audio", "Numerology Report"
  cloud_public_id text not null,
  cloud_resource_type text not null default 'video', -- video | image | raw (Cloudinary's own types)
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists idx_delivery_files_package on delivery_files(package_id);

-- ── bookings: payment-failure tracking (additive columns only) ──
alter table bookings add column if not exists payment_failure_notified_at timestamptz;
alter table bookings add column if not exists payment_failure_reason text;

-- Track the Cloudinary identifiers (not just the URL) for the legacy
-- single-video Spell field too, so the send step can mint a secure,
-- time-limited delivery link instead of emailing a permanent Cloudinary URL.
alter table bookings add column if not exists video_cloud_public_id text;
alter table bookings add column if not exists video_cloud_resource_type text default 'video';
-- Added for video+audio recording delivery on Energy Healing, Numerology,
-- and Audio Tarot Reading (see server/routes/media.js) — 'video' or
-- 'audio', purely for CRM display; doesn't affect how the file is stored
-- or delivered (Cloudinary uses 'video' resource_type for both).
alter table bookings add column if not exists video_media_type text;

-- ── coupons ── discount codes Akanksha creates and manages from the CRM.
-- discount_type is 'percent' (0–100) or 'fixed' (a rupee amount off).
-- min_amount is the minimum ORIGINAL (pre-discount) booking amount in
-- rupees required to use this code — per the stated rule, ₹1,000.
create table if not exists coupons (
  code          text primary key,               -- stored/compared uppercase
  discount_type text not null,                   -- 'percent' | 'fixed'
  discount_value numeric not null,
  min_amount    numeric not null default 1000,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ── coupon_redemptions ── one row per successful use. Enforces "no usage
-- more than once per customer" — the unique constraint is the actual
-- enforcement mechanism (not just an application-level check), matched
-- against the email actually charged, at /payments/verify time.
create table if not exists coupon_redemptions (
  id            uuid primary key default gen_random_uuid(),
  coupon_code   text not null references coupons(code),
  email         text not null,
  booking_id    text not null,
  redeemed_at   timestamptz not null default now(),
  unique(coupon_code, email)
);
create index if not exists idx_coupon_redemptions_code on coupon_redemptions(coupon_code);

-- bookings: track which coupon (if any) was applied, and the resulting
-- discount, purely for CRM visibility — the actual amount charged is
-- always Razorpay's own order.amount, never trusted from this column.
alter table bookings add column if not exists coupon_code text;
alter table bookings add column if not exists discount_amount numeric;

-- ═══════════════════════════════════════════════════════════════════
-- V190 — real image/document storage + the "Send Everything to Client"
-- feature (server/routes/attachments.js). Each entry:
--   { id, category: 'image'|'document', publicId, resourceType,
--     originalName, size, uploadedAt }
-- Previously these lived only as browser blob: URLs (never persisted —
-- gone on refresh); now they're real Cloudinary files, same pattern as
-- the video/audio recorder, so they survive and can be attached to an
-- actual email sent straight from the CRM.
-- ═══════════════════════════════════════════════════════════════════
alter table bookings add column if not exists attachments_json jsonb default '[]'::jsonb;

-- ═══════════════════════════════════════════════════════════════════
-- PayPal (international customers) — Razorpay's international-cards
-- request was rejected by their banking partners, so non-Indian
-- customers pay via a separate PayPal checkout instead (see
-- server/routes/paypal.js). payment_provider distinguishes which
-- gateway a booking came through; currency/amount_paid record what was
-- actually charged, since PayPal orders are in USD, not INR, and there's
-- no Razorpay-style "fetch the order later" for a price label.
-- ═══════════════════════════════════════════════════════════════════
alter table bookings add column if not exists payment_provider text default 'razorpay';
alter table bookings add column if not exists currency text default 'INR';
alter table bookings add column if not exists amount_paid numeric;
