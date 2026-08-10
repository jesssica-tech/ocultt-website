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
