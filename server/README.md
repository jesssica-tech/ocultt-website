# Ocultt Tarot — Email Server

Sends real booking confirmation emails via Gmail (Nodemailer). Hardened for
production: input validation, rate limiting, sanitized error responses,
locked-down CORS, and security headers (helmet).

```bash
cd server
npm install
cp .env.example .env
# edit .env with your Gmail address + App Password + allowed origins
npm run dev        # http://localhost:3001
```

Then in `js/script.js`:
```js
const OCULTT_API = 'http://localhost:3001/api';
```

## Files
- `server.js` — Express app: helmet, CORS allowlist, global rate limit, route mounting
- `routes/sendEmail.js` — `POST /api/send-email`, endpoint-specific rate limit (10/hour/IP)
- `utils/validate.js` — input validation + email-header-injection defense
- `utils/mailer.js` — Gmail/Nodemailer transporter + secret-redaction helper for logs
- `utils/emailTemplate.js` — HTML email template (Gmail/Outlook/Apple Mail compatible)
- `.env.example` — copy to `.env`, never commit `.env`

## Endpoints
- `GET /api/health`
- `POST /api/send-email` — body is the exact payload `sendBookingConfirmation()`
  already builds in `js/script.js`

## Production notes
- `ALLOWED_ORIGINS` must be set in `.env` — CORS fails closed (blocks all
  cross-origin requests) if it's empty, rather than defaulting open.
- Rate limits: 100 requests / 15 min globally, 10 / hour on `/send-email`
  specifically (one booking = one email; this comfortably covers retries
  while blocking abuse).
- Client-facing errors are always generic ("Failed to send email...");
  full detail (including SMTP responses) is logged server-side only.
