// ── Backend API config — declared first, before anything else in this file.
// renderDashboard() (called unconditionally on every page load, further
// below) reads OCULTT_BACKEND_CONNECTED via syncLiveBookingsIntoLocal();
// this must exist before that first call happens, or it throws a
// "Cannot access before initialization" ReferenceError on every page load.
// Values unchanged — only the declaration's position moved.
const OCULTT_API = 'https://ocultt-website.onrender.com/api';
// During local dev, use: const OCULTT_API = 'http://localhost:3001/api';
const OCULTT_BACKEND_CONNECTED = !/your-backend-url/.test(OCULTT_API);

let selectedReading='',selectedDuration='',selectedSpell='',selectedGroupSession='New Moon Circle',selectedGroupDate='July 2, 2026 · 8:00 PM IST',selectedNum='',selectedDay=null,selectedTime='',selectedDayLabel='';
// Urgent/same-day delivery for Audio Tarot Reading (+20%, same pattern as
// Spell) — see onTarotUrgencyChange() / renderAudioQuestionInputs().
let selectedTarotUrgency='No rush';
let tarotStep=1;
// True only while showPage('tarot-booking') is being called to resume a Phone
// Tarot booking after the customer returns from Calendly — tells showPage to
// skip its normal "reset to step 1" behaviour for this one navigation.
let _resumingPhoneTarot=false;
let _bookingSaved=false; // guard against double-fire on step 5
let _paymentVerified=false; // set true after successful Razorpay payment
let _rzpPaymentId=''; // Razorpay payment_id stored for the booking record

// ═══════════════════════════════════════════════════════════════════
// International (non-India) currency detection + PayPal checkout.
// Confirmed Aug 2026 (Jess ↔ Disha): auto-detect visitor location —
// India stays on the existing Razorpay/₹ flow completely unchanged;
// everyone else sees USD pricing at the real INR→USD rate × a 3x
// international markup, and pays via PayPal. The FAIL-SAFE DEFAULT ON
// ANY DETECTION FAILURE IS INDIA/INR — never guess USD, since that's
// the direction that would actually change what a customer is charged.
// The real, authoritative charge is always computed server-side (see
// server/routes/paypal.js computeAmountRupees + toUsd) from the same
// price tables Razorpay uses — this client-side code only decides
// which *display* and which *gateway* to show; it never invents a
// price itself.
// ═══════════════════════════════════════════════════════════════════
window.OT_CURRENCY = 'INR'; // safe default until (if) detection resolves
window.OT_COUNTRY  = null;
const OT_USD_RATE   = 88; // ₹ per $1 — mirror of PAYPAL_USD_RATE's default;
                          // if Akanksha changes PAYPAL_USD_RATE in Render,
                          // update this too so displayed ≈ charged price.
const OT_INTL_MARKUP = 3; // mirror of PAYPAL_INTL_MARKUP's default.

window.OT_CURRENCY_READY = new Promise(function(resolve){
  try {
    const cached = sessionStorage.getItem('ot_currency');
    if (cached === 'INR' || cached === 'USD') {
      window.OT_CURRENCY = cached;
      resolve(cached);
      return;
    }
  } catch(e) { /* sessionStorage unavailable — fall through to detect */ }

  // Two independent geolocation providers, tried one after the other —
  // a real (documented) outage or a blocked/slow request on the first
  // provider alone used to send everyone straight to the India/INR
  // fallback. Only fail safe to INR if BOTH providers come back empty
  // or fail, not just one. Same trust rule as before applies to each:
  // only a genuine, well-formed 2-letter code counts as "not India".
  const timeout = setTimeout(function(){ resolve(finish('INR')); }, 7000);
  function finish(currency){
    clearTimeout(timeout);
    window.OT_CURRENCY = currency;
    try { sessionStorage.setItem('ot_currency', currency); } catch(e){}
    return currency;
  }
  function currencyFromCode(code){
    return code && code !== 'IN' ? 'USD' : 'INR';
  }
  function tryIpapiFallback(){
    fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .then(data => {
        const code = data && typeof data.country_code === 'string' && data.country_code.length === 2
          ? data.country_code : null;
        window.OT_COUNTRY = code;
        resolve(finish(currencyFromCode(code)));
      })
      .catch(() => resolve(finish('INR'))); // both providers failed → India/INR, never guess
  }
  fetch('https://get.geojs.io/v1/ip/country.json', { signal: AbortSignal.timeout(3500) })
    .then(r => r.json())
    .then(data => {
      // Only trust a real, well-formed 2-letter country code as proof of a
      // non-India location. Ad-blockers and privacy extensions commonly
      // intercept geolocation requests like this one and return an empty
      // (but "successful") response rather than blocking it outright —
      // treating that as "confirmed not India" was the bug that showed
      // USD pricing to an Indian visitor. Anything short of a genuine,
      // valid code falls through to the second provider below, same as
      // an outright network failure.
      const code = data && typeof data.country_code === 'string' && data.country_code.length === 2
        ? data.country_code : null;
      if (code) {
        window.OT_COUNTRY = code;
        resolve(finish(currencyFromCode(code)));
      } else {
        tryIpapiFallback();
      }
    })
    .catch(() => tryIpapiFallback()); // first provider failed — try the second before giving up
});

function otToUsd(rupees){
  return Math.round((rupees / OT_USD_RATE) * OT_INTL_MARKUP);
}
// Central display formatter — every customer-facing price should render
// through this so India and international visitors always see a price
// consistent with what they'll actually be charged.
function formatPrice(rupees){
  rupees = Number(rupees) || 0;
  if (window.OT_CURRENCY === 'USD') return '$' + otToUsd(rupees);
  return '₹' + rupees.toLocaleString('en-IN');
}

// ── Once currency resolves, refresh every price the customer can see
// before they've started a booking (dropdowns, service cards, currency
// badges). Anything set later (payment-step totals, success screens)
// already calls formatPrice() directly at render time — see each
// render*PaymentView()/finalize*Booking() function. ──
window.OT_CURRENCY_READY.then(function(currency){
  if (currency !== 'USD') return; // India stays exactly as authored — nothing to do

  document.querySelectorAll('[data-price-rupees]').forEach(function(el){
    const rupees = Number(el.getAttribute('data-price-rupees'));
    if (!isNaN(rupees)) el.textContent = formatPrice(rupees);
  });
  document.querySelectorAll('.currency-badge').forEach(function(el){
    el.textContent = '$ USD';
  });
  localizeSpellCategoryPrices();
  document.querySelectorAll('select option[value*="|"]').forEach(function(opt){
    const parts = opt.value.split('|');
    const rupees = Number(parts[1]);
    if (parts.length === 2 && !isNaN(rupees)) {
      const label = opt.textContent.replace(/—\s*₹[\d,]+\s*$/, '').trim();
      opt.textContent = label + ' — ' + formatPrice(rupees);
    }
  });
  const gPrice = document.getElementById('g-price');
  if (gPrice) {
    Array.from(gPrice.options).forEach(function(opt){
      const rupees = Number(opt.value);
      if (!isNaN(rupees)) opt.textContent = formatPrice(rupees);
    });
  }
});

// ── Shared PayPal checkout core — used by all 5 booking flows for
// visitors detected as international. Mirrors the Razorpay flow's trust
// model exactly: the server independently re-prices every order from
// its own tables (never trusts a client-supplied amount), and only
// PayPal's own server-to-server "COMPLETED" capture response — never
// anything the browser reports back — marks a booking Paid. ──
let _paypalSdkPromise = null;
function loadPayPalSdk(clientId){
  if (_paypalSdkPromise) return _paypalSdkPromise;
  _paypalSdkPromise = new Promise(function(resolve, reject){
    if (window.paypal) { resolve(window.paypal); return; }
    const s = document.createElement('script');
    s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) + '&currency=USD&intent=capture';
    s.onload = function(){ window.paypal ? resolve(window.paypal) : reject(new Error('PayPal SDK failed to load.')); };
    s.onerror = function(){ reject(new Error('PayPal SDK failed to load.')); };
    document.head.appendChild(s);
  });
  return _paypalSdkPromise;
}

// config: { bookingId, type, duration, basePrice, urgency, name, email,
//   phone, couponCode, payBtnId, containerId, statusSetter(msg,color),
//   onApproved() }
function initiatePayPalCheckout(config){
  const payBtn = document.getElementById(config.payBtnId);
  const container = document.getElementById(config.containerId);
  if (payBtn) payBtn.style.display = 'none';
  if (container) { container.style.display = 'block'; container.innerHTML = ''; }
  config.statusSetter('Loading secure payment…', 'var(--text-muted)');

  fetch(OCULTT_API + '/paypal/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bookingId: config.bookingId, type: config.type, duration: config.duration,
      basePrice: config.basePrice, urgency: config.urgency,
      name: config.name, email: config.email, phone: config.phone,
      couponCode: config.couponCode
    })
  })
  .then(r => r.json())
  .then(order => {
    if (order.error) throw { ocultOrderError: true, message: order.error };
    config.statusSetter('', 'var(--text-muted)');
    return loadPayPalSdk(order.clientId).then(function(paypal){ return { paypal, order }; });
  })
  .then(function(result){
    const paypal = result.paypal, order = result.order;
    paypal.Buttons({
      style: { layout: 'vertical', color: 'gold', shape: 'pill', label: 'pay' },
      createOrder: function(){ return order.orderId; },
      onApprove: function(data){
        config.statusSetter('Verifying payment…', 'var(--text-muted)');
        return fetch(OCULTT_API + '/paypal/capture-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: data.orderID, bookingId: config.bookingId, bookingType: config.type })
        })
        .then(r => r.json())
        .then(function(captureResult){
          if (!captureResult.success) throw new Error(captureResult.error || 'Verification failed');
          config.statusSetter('✓ Payment verified! Your booking is confirmed.', 'var(--sage)');
          setTimeout(function(){ config.onApproved(data.orderID); }, 1200);
        })
        .catch(function(err){
          config.statusSetter('✗ Payment verification failed: ' + err.message + '. Please contact support.', '#c0392b');
        });
      },
      onCancel: function(){
        config.statusSetter('Payment cancelled. You can try again above.', 'var(--text-muted)');
      },
      onError: function(err){
        console.error('[PayPal]', err);
        config.statusSetter('Payment could not be completed. Please try again or contact support.', '#c0392b');
      }
    }).render('#' + config.containerId);
  })
  .catch(function(err){
    if (err && err.ocultOrderError) {
      config.statusSetter('✗ ' + err.message, '#c0392b');
    } else {
      config.statusSetter('Could not connect to payment server. Please try again.', '#c0392b');
    }
    console.error('[initiatePayPalCheckout]', err);
  });
}

function generateStars(){
  const c=document.getElementById('stars');
  for(let i=0;i<150;i++){
    const s=document.createElement('div');
    s.className='star';
    s.style.cssText=`left:${Math.random()*100}%;top:${Math.random()*100}%;--d:${2+Math.random()*4}s;--delay:${Math.random()*3}s;opacity:${0.1+Math.random()*0.5}`;
    c.appendChild(s);
  }
}

function generateFloatingCards(){
  const c=document.getElementById('floatingCards');
  if(!c)return;

  // Real tarot card SVG symbols (no emojis)
  const tarotCards=[
    {
      numeral:'I', name:'The Magician', layer:'layer-near',
      x:'3%', y:'14%', r:'-11deg', r2:'-4deg', dur:'8s', delay:'0s', fy:'-26px',
      svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Wand/staff with infinity symbol above -->
        <path d="M22 48 L22 16" stroke="rgba(46,139,110,0.65)" stroke-width="1.2" stroke-linecap="round"/>
        <path d="M22 16 L18 20 M22 16 L26 20" stroke="rgba(46,139,110,0.5)" stroke-width="1" stroke-linecap="round"/>
        <!-- Infinity lemniscate -->
        <path d="M16 10 C16 7 19 5 22 7 C25 9 25 11 22 11 C19 11 19 13 22 15 C25 17 28 15 28 12 C28 9 25 7 22 7" stroke="rgba(46,139,110,0.7)" stroke-width="0.9" fill="none"/>
        <!-- Table with four suit symbols -->
        <rect x="8" y="35" width="28" height="2" rx="1" fill="rgba(46,139,110,0.2)" stroke="rgba(46,139,110,0.35)" stroke-width="0.5"/>
        <!-- Cup symbol -->
        <path d="M11 32 L13 28 L15 32 Z" fill="none" stroke="rgba(46,139,110,0.45)" stroke-width="0.7"/>
        <path d="M11 32 L15 32" stroke="rgba(46,139,110,0.45)" stroke-width="0.7"/>
        <!-- Pentacle circle -->
        <circle cx="22" cy="30" r="3" fill="none" stroke="rgba(46,139,110,0.45)" stroke-width="0.7"/>
        <path d="M22 27 L22.8 29.5 L25.4 29.5 L23.3 31 L24.1 33.5 L22 32 L19.9 33.5 L20.7 31 L18.6 29.5 L21.2 29.5Z" fill="rgba(46,139,110,0.25)"/>
        <!-- Sword -->
        <line x1="30" y1="27" x2="34" y2="33" stroke="rgba(46,139,110,0.45)" stroke-width="0.8" stroke-linecap="round"/>
        <line x1="29" y1="30" x2="35" y2="30" stroke="rgba(46,139,110,0.3)" stroke-width="0.6"/>
      </svg>`
    },
    {
      numeral:'II', name:'High Priestess', layer:'layer-mid',
      x:'93%', y:'13%', r:'9deg', r2:'15deg', dur:'9.5s', delay:'1.2s', fy:'-18px',
      svg:`<svg width="36" height="50" viewBox="0 0 36 50" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Crown / tiara -->
        <path d="M9 14 L18 8 L27 14" stroke="rgba(46,139,110,0.55)" stroke-width="1" stroke-linecap="round" fill="none"/>
        <circle cx="18" cy="8" r="2.5" fill="none" stroke="rgba(46,139,110,0.5)" stroke-width="0.8"/>
        <!-- Veil / curtain lines -->
        <path d="M6 16 C8 22 7 30 9 42" stroke="rgba(46,139,110,0.2)" stroke-width="0.6" stroke-dasharray="2 3"/>
        <path d="M30 16 C28 22 29 30 27 42" stroke="rgba(46,139,110,0.2)" stroke-width="0.6" stroke-dasharray="2 3"/>
        <!-- Scroll of Torah / book -->
        <rect x="11" y="30" width="14" height="10" rx="1" fill="none" stroke="rgba(46,139,110,0.4)" stroke-width="0.8"/>
        <path d="M11 33 L25 33 M11 36 L25 36" stroke="rgba(46,139,110,0.25)" stroke-width="0.5"/>
        <!-- Crescent moon at feet -->
        <path d="M12 44 C12 40 24 40 24 44" stroke="rgba(46,139,110,0.35)" stroke-width="0.8" fill="none"/>
        <!-- Two pillars B & J -->
        <rect x="6" y="16" width="4" height="12" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.6"/>
        <rect x="26" y="16" width="4" height="12" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.6"/>
        <!-- Cross on chest -->
        <line x1="18" y1="18" x2="18" y2="28" stroke="rgba(46,139,110,0.45)" stroke-width="0.7"/>
        <line x1="14" y1="22" x2="22" y2="22" stroke="rgba(46,139,110,0.45)" stroke-width="0.7"/>
      </svg>`
    },
    {
      numeral:'XIX', name:'The Sun', layer:'layer-far',
      x:'1%', y:'62%', r:'-9deg', r2:'0deg', dur:'7.5s', delay:'2.2s', fy:'-14px',
      svg:`<svg width="30" height="40" viewBox="0 0 30 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Sun circle -->
        <circle cx="15" cy="16" r="8" fill="none" stroke="rgba(46,139,110,0.55)" stroke-width="0.9"/>
        <!-- Sun rays (16 rays) -->
        <line x1="15" y1="4" x2="15" y2="6" stroke="rgba(46,139,110,0.5)" stroke-width="0.8" stroke-linecap="round"/>
        <line x1="15" y1="26" x2="15" y2="28" stroke="rgba(46,139,110,0.5)" stroke-width="0.8" stroke-linecap="round"/>
        <line x1="3" y1="16" x2="5" y2="16" stroke="rgba(46,139,110,0.5)" stroke-width="0.8" stroke-linecap="round"/>
        <line x1="25" y1="16" x2="27" y2="16" stroke="rgba(46,139,110,0.5)" stroke-width="0.8" stroke-linecap="round"/>
        <line x1="6.5" y1="7.5" x2="7.9" y2="8.9" stroke="rgba(46,139,110,0.4)" stroke-width="0.8" stroke-linecap="round"/>
        <line x1="22.1" y1="7.5" x2="23.5" y2="8.9" stroke="rgba(46,139,110,0.4)" stroke-width="0.8" stroke-linecap="round"/>
        <line x1="6.5" y1="24.5" x2="7.9" y2="23.1" stroke="rgba(46,139,110,0.4)" stroke-width="0.8" stroke-linecap="round"/>
        <line x1="22.1" y1="24.5" x2="23.5" y2="23.1" stroke="rgba(46,139,110,0.4)" stroke-width="0.8" stroke-linecap="round"/>
        <!-- Face in sun — dot eyes, arc smile -->
        <circle cx="13" cy="15" r="0.8" fill="rgba(46,139,110,0.55)"/>
        <circle cx="17" cy="15" r="0.8" fill="rgba(46,139,110,0.55)"/>
        <path d="M13 18 C14 19.5 16 19.5 17 18" stroke="rgba(46,139,110,0.45)" stroke-width="0.7" fill="none"/>
        <!-- Sunflowers (simple) -->
        <circle cx="8" cy="34" r="2.5" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.6"/>
        <circle cx="15" cy="36" r="2.5" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.6"/>
        <circle cx="22" cy="34" r="2.5" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.6"/>
      </svg>`
    },
    {
      numeral:'X', name:'Wheel of Fortune', layer:'layer-near',
      x:'92%', y:'55%', r:'14deg', r2:'7deg', dur:'10s', delay:'0.6s', fy:'-22px',
      svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Outer wheel -->
        <circle cx="22" cy="28" r="18" fill="none" stroke="rgba(46,139,110,0.4)" stroke-width="0.9"/>
        <!-- Inner wheel -->
        <circle cx="22" cy="28" r="11" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.7"/>
        <!-- Hub -->
        <circle cx="22" cy="28" r="3.5" fill="none" stroke="rgba(46,139,110,0.45)" stroke-width="0.8"/>
        <!-- 8 spokes -->
        <line x1="22" y1="10" x2="22" y2="17" stroke="rgba(46,139,110,0.3)" stroke-width="0.7"/>
        <line x1="22" y1="39" x2="22" y2="46" stroke="rgba(46,139,110,0.3)" stroke-width="0.7"/>
        <line x1="4" y1="28" x2="11" y2="28" stroke="rgba(46,139,110,0.3)" stroke-width="0.7"/>
        <line x1="33" y1="28" x2="40" y2="28" stroke="rgba(46,139,110,0.3)" stroke-width="0.7"/>
        <line x1="9.3" y1="15.3" x2="14.2" y2="20.2" stroke="rgba(46,139,110,0.25)" stroke-width="0.6"/>
        <line x1="29.8" y1="35.8" x2="34.7" y2="40.7" stroke="rgba(46,139,110,0.25)" stroke-width="0.6"/>
        <line x1="34.7" y1="15.3" x2="29.8" y2="20.2" stroke="rgba(46,139,110,0.25)" stroke-width="0.6"/>
        <line x1="14.2" y1="35.8" x2="9.3" y2="40.7" stroke="rgba(46,139,110,0.25)" stroke-width="0.6"/>
        <!-- TARO / ROTA letters on outer ring -->
        <text x="20" y="13.5" font-family="serif" font-size="3.5" fill="rgba(46,139,110,0.5)" text-anchor="middle">T</text>
        <text x="29.5" y="20" font-family="serif" font-size="3.5" fill="rgba(46,139,110,0.5)" text-anchor="middle">A</text>
        <text x="32" y="30" font-family="serif" font-size="3.5" fill="rgba(46,139,110,0.5)" text-anchor="middle">R</text>
        <text x="29.5" y="40" font-family="serif" font-size="3.5" fill="rgba(46,139,110,0.5)" text-anchor="middle">O</text>
        <!-- Anubis / Typhon serpent rising -->
        <path d="M28 40 C30 36 29 32 28 28 C27 24 30 20 28 17" stroke="rgba(46,139,110,0.35)" stroke-width="0.8" fill="none" stroke-linecap="round"/>
        <!-- Sphinx on top -->
        <path d="M18 11 C18 9 20 8 22 8 C24 8 26 9 26 11" stroke="rgba(46,139,110,0.3)" stroke-width="0.6" fill="none"/>
      </svg>`
    },
    {
      numeral:'III', name:'The Empress', layer:'layer-mid',
      x:'6%', y:'83%', r:'-6deg', r2:'-13deg', dur:'6.5s', delay:'3s', fy:'-20px',
      svg:`<svg width="36" height="50" viewBox="0 0 36 50" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Crown of 12 stars -->
        <path d="M9 14 L18 6 L27 14" stroke="rgba(46,139,110,0.5)" stroke-width="0.9" fill="none"/>
        <circle cx="10" cy="12" r="1.2" fill="rgba(46,139,110,0.4)"/>
        <circle cx="14" cy="9" r="1.2" fill="rgba(46,139,110,0.4)"/>
        <circle cx="18" cy="7" r="1.2" fill="rgba(46,139,110,0.4)"/>
        <circle cx="22" cy="9" r="1.2" fill="rgba(46,139,110,0.4)"/>
        <circle cx="26" cy="12" r="1.2" fill="rgba(46,139,110,0.4)"/>
        <!-- Heart shield / Venus symbol -->
        <circle cx="18" cy="22" r="5" fill="none" stroke="rgba(46,139,110,0.45)" stroke-width="0.8"/>
        <line x1="18" y1="27" x2="18" y2="31" stroke="rgba(46,139,110,0.45)" stroke-width="0.8"/>
        <line x1="15" y1="29" x2="21" y2="29" stroke="rgba(46,139,110,0.4)" stroke-width="0.7"/>
        <!-- Wheat sheaves either side -->
        <path d="M9 35 C9 30 7 26 8 22" stroke="rgba(46,139,110,0.3)" stroke-width="0.6" fill="none"/>
        <path d="M27 35 C27 30 29 26 28 22" stroke="rgba(46,139,110,0.3)" stroke-width="0.6" fill="none"/>
        <!-- Waterfall at base -->
        <path d="M8 40 C10 43 14 44 18 43 C22 44 26 43 28 40" stroke="rgba(46,139,110,0.25)" stroke-width="0.7" fill="none"/>
        <!-- Sceptre -->
        <line x1="28" y1="16" x2="28" y2="38" stroke="rgba(46,139,110,0.35)" stroke-width="0.8" stroke-linecap="round"/>
        <circle cx="28" cy="14" r="2" fill="none" stroke="rgba(46,139,110,0.4)" stroke-width="0.7"/>
      </svg>`
    },
    {
      numeral:'XVIII', name:'The Moon', layer:'layer-far',
      x:'87%', y:'80%', r:'11deg', r2:'5deg', dur:'8.5s', delay:'1.8s', fy:'-12px',
      svg:`<svg width="30" height="40" viewBox="0 0 30 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Moon crescent -->
        <path d="M20 6 C12 6 7 11 7 18 C7 25 12 30 20 30 C16 28 13 24 13 18 C13 12 16 8 20 6Z" fill="rgba(46,139,110,0.12)" stroke="rgba(46,139,110,0.5)" stroke-width="0.9"/>
        <!-- 15 falling drops / tears -->
        <line x1="7" y1="32" x2="7" y2="36" stroke="rgba(46,139,110,0.3)" stroke-width="0.6" stroke-linecap="round"/>
        <line x1="11" y1="33" x2="11" y2="37" stroke="rgba(46,139,110,0.25)" stroke-width="0.6" stroke-linecap="round"/>
        <line x1="15" y1="32" x2="15" y2="36" stroke="rgba(46,139,110,0.3)" stroke-width="0.6" stroke-linecap="round"/>
        <line x1="19" y1="33" x2="19" y2="37" stroke="rgba(46,139,110,0.25)" stroke-width="0.6" stroke-linecap="round"/>
        <line x1="23" y1="32" x2="23" y2="36" stroke="rgba(46,139,110,0.3)" stroke-width="0.6" stroke-linecap="round"/>
        <!-- Pool at bottom -->
        <ellipse cx="15" cy="38" rx="9" ry="2" fill="none" stroke="rgba(46,139,110,0.2)" stroke-width="0.5"/>
        <!-- Crayfish / lobster in pool -->
        <path d="M12 38 C13 36 15 35 17 36 C16 38 14 39 12 38Z" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.5"/>
        <!-- Two towers -->
        <rect x="3" y="22" width="4" height="10" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.6"/>
        <rect x="23" y="22" width="4" height="10" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.6"/>
        <!-- Path between towers -->
        <path d="M7 30 C10 31 20 31 23 30" stroke="rgba(46,139,110,0.2)" stroke-width="0.5" fill="none"/>
      </svg>`
    },
    {
      numeral:'XVII', name:'The Star', layer:'layer-mid',
      x:'3%', y:'38%', r:'3deg', r2:'-3deg', dur:'11s', delay:'0.8s', fy:'-16px',
      svg:`<svg width="36" height="50" viewBox="0 0 36 50" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Central 8-pointed star -->
        <polygon points="18,6 20,13 27,13 21.5,17.5 23.5,24.5 18,20 12.5,24.5 14.5,17.5 9,13 16,13" stroke="rgba(46,139,110,0.6)" stroke-width="0.8" fill="rgba(46,139,110,0.08)"/>
        <!-- 7 smaller stars around -->
        <polygon points="5,10 5.8,12.5 8.5,12.5 6.3,14 7.1,16.5 5,15 2.9,16.5 3.7,14 1.5,12.5 4.2,12.5" stroke="rgba(46,139,110,0.35)" stroke-width="0.5" fill="none"/>
        <polygon points="31,10 31.8,12.5 34.5,12.5 32.3,14 33.1,16.5 31,15 28.9,16.5 29.7,14 27.5,12.5 30.2,12.5" stroke="rgba(46,139,110,0.35)" stroke-width="0.5" fill="none"/>
        <!-- Woman kneeling at pool -->
        <!-- Water pool -->
        <ellipse cx="10" cy="40" rx="8" ry="3" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.6"/>
        <!-- Two vessels pouring -->
        <path d="M8 30 C7 34 6 36 6 38" stroke="rgba(46,139,110,0.35)" stroke-width="0.7" fill="none"/>
        <path d="M16 30 C16 33 17 36 18 38" stroke="rgba(46,139,110,0.35)" stroke-width="0.7" fill="none"/>
        <!-- Water ripples from pour -->
        <path d="M4 38 C6 37 8 38 10 37 C12 38 14 37 16 38" stroke="rgba(46,139,110,0.25)" stroke-width="0.5" fill="none"/>
        <!-- Tree / bird at right -->
        <line x1="28" y1="30" x2="28" y2="44" stroke="rgba(46,139,110,0.3)" stroke-width="0.7"/>
        <path d="M25 34 C28 32 31 34 28 36" stroke="rgba(46,139,110,0.25)" stroke-width="0.5" fill="none"/>
        <circle cx="29" cy="33" r="1.2" fill="rgba(46,139,110,0.3)"/>
      </svg>`
    }
  ];

  tarotCards.forEach(({numeral,name,layer,x,y,r,r2,dur,delay,fy,svg})=>{
    const card=document.createElement('div');
    card.className=`float-card ${layer}`;
    card.style.cssText=`left:${x};top:${y};--r:${r};--r2:${r2};--dur:${dur};--delay:${delay};--fy:${fy};--sdur:${parseFloat(dur)*2.5}s;--sdelay:${parseFloat(delay)+1}s`;
    card.innerHTML=`
      <div class="float-card-inner">
        <div class="float-card-sheen"></div>
        <span class="float-card-numeral">${numeral}</span>
        <span class="float-card-numeral-bot">${numeral}</span>
        <div class="float-card-svg">${svg}</div>
        <span class="float-card-name">${name}</span>
      </div>`;
    c.appendChild(card);
  });

  // ── Runtime collision guard ──────────────────────────────────────
  // Guarantees floating cards never visually overlap hero content
  // (logo/nav, kicker, eyebrow, title, subtitle, divider, description,
  // CTA buttons) on any screen size, regardless of hand-tuned x/y%.
  function guardFloatCardCollisions(){
    const heroSelectors=['.hero-kicker','.hero-eyebrow','.hero-title','.hero-sub','.hero-divider-line','.hero-desc','.hero-ctas'];
    const heroBoxes=heroSelectors.map(sel=>document.querySelector(sel)).filter(Boolean).map(el=>el.getBoundingClientRect());
    if(!heroBoxes.length)return;
    // Build one combined safe-zone rectangle with a small buffer margin
    const margin=18;
    const minLeft=Math.min(...heroBoxes.map(b=>b.left))-margin;
    const maxRight=Math.max(...heroBoxes.map(b=>b.right))+margin;
    const minTop=Math.min(...heroBoxes.map(b=>b.top))-margin;
    const maxBottom=Math.max(...heroBoxes.map(b=>b.bottom))+margin;
    document.querySelectorAll('.float-card').forEach(card=>{
      const r=card.getBoundingClientRect();
      const overlaps = r.left < maxRight && r.right > minLeft && r.top < maxBottom && r.bottom > minTop;
      card.style.opacity = overlaps ? '0' : '';
      card.style.transition = 'opacity 0.4s ease';
    });
  }
  // Run after layout settles, and again on resize/orientation change
  setTimeout(guardFloatCardCollisions, 150);
  setTimeout(guardFloatCardCollisions, 900);
  window.addEventListener('resize', ()=>{
    clearTimeout(window._fcGuardTimer);
    window._fcGuardTimer=setTimeout(guardFloatCardCollisions, 150);
  });
}

// Pause hero animations when scrolled out of view — the hero runs ~19
// simultaneous infinite animations (depth pulses, orbit spin, sigil glow,
// floating cards + their sheen sweeps); leaving them running while the
// user reads the rest of the page wastes CPU/GPU and can show up as
// general scroll/interaction choppiness elsewhere on the site.
(function(){
  const hero=document.getElementById('heroSection');
  if(!hero)return;
  const io=new IntersectionObserver((entries)=>{
    entries.forEach(e=>{
      hero.classList.toggle('hero-offscreen', !e.isIntersecting);
    });
  },{threshold:0});
  io.observe(hero);
})();

// Parallax on mousemove for hero depth
(function(){
  const hero=document.getElementById('heroSection');
  if(!hero)return;
  // Skip parallax on small/touch screens and when reduced motion is requested
  // (mirrors hero-premium.js behaviour; avoids wasted work/jitter on phones & tablets)
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  if(window.innerWidth<960)return;
  let ticking=false;
  document.addEventListener('mousemove',function(e){
    if(ticking)return;
    ticking=true;
    requestAnimationFrame(function(){
      if(!document.getElementById('page-home').classList.contains('active')){ticking=false;return;}
      const cx=window.innerWidth/2, cy=window.innerHeight/2;
      const dx=(e.clientX-cx)/cx, dy=(e.clientY-cy)/cy;
      // Move depth layers subtly
      const d1=hero.querySelector('.hero-depth-1');
      const d2=hero.querySelector('.hero-depth-2');
      const d3=hero.querySelector('.hero-depth-3');
      const orb1=hero.querySelectorAll('.hero-orbit')[0];
      const orb2=hero.querySelectorAll('.hero-orbit')[1];
      if(d1)d1.style.transform=`translate(calc(-50% + ${dx*-14}px), calc(-50% + ${dy*-14}px))`;
      if(d2)d2.style.transform=`translate(calc(-50% + ${dx*-8}px), calc(-50% + ${dy*-8}px))`;
      if(d3)d3.style.transform=`translate(calc(-50% + ${dx*-3}px), calc(-50% + ${dy*-3}px))`;
      if(orb1)orb1.style.transform=`translate(calc(-50% + ${dx*-18}px), calc(-50% + ${dy*-18}px))`;
      if(orb2)orb2.style.transform=`translate(calc(-50% + ${dx*10}px), calc(-50% + ${dy*10}px))`;
      // Parallax cards by layer
      hero.querySelectorAll('.float-card.layer-far').forEach(c=>{
        const ox=parseFloat(c.dataset.ox||0), oy=parseFloat(c.dataset.oy||0);
        c.style.marginLeft=`${dx*-6}px`;c.style.marginTop=`${dy*-6}px`;
      });
      hero.querySelectorAll('.float-card.layer-mid').forEach(c=>{
        c.style.marginLeft=`${dx*12}px`;c.style.marginTop=`${dy*12}px`;
      });
      hero.querySelectorAll('.float-card.layer-near').forEach(c=>{
        c.style.marginLeft=`${dx*22}px`;c.style.marginTop=`${dy*22}px`;
      });
      ticking=false;
    });
  });
  // Reset on mouse leave
  document.addEventListener('mouseleave',function(){
    const els=['.hero-depth-1','.hero-depth-2','.hero-depth-3','.hero-orbit'].map(s=>hero.querySelector(s));
    els.forEach(el=>{if(el)el.style.transform='';});
    hero.querySelectorAll('.float-card').forEach(c=>{c.style.marginLeft='';c.style.marginTop='';});
  });
})();

// ── Smart Back: remembers which homepage section the user was viewing
// before navigating into a sub-page, so the floating Back pill returns
// them there instead of just the top of the homepage. ──
const HOME_SECTION_IDS = ['akanksha','about','services','testimonials','draw-a-card'];
let _lastHomeSection = null;

function captureHomeSection(){
  const navH = document.querySelector('nav')?.getBoundingClientRect().height || 80;
  let found = null;
  HOME_SECTION_IDS.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    const rect = el.getBoundingClientRect();
    // Section counts as "current" if it spans the area just below the navbar
    if(rect.top <= navH + 60 && rect.bottom >= navH){
      found = id;
    }
  });
  _lastHomeSection = found; // null means they were up in the hero — top of page is correct
}

function smartBackHome(){
  if(_lastHomeSection){
    scrollToSection(_lastHomeSection);
  } else {
    showPage('home');
  }
}

// ── Deep-linking from real, crawlable landing pages (see /services/*) ──
// Those pages link their "Book Now" CTA to /#tarot-booking etc. — without
// this, the hash would sit unused and every visitor arriving from a
// service page would land on the homepage instead of the booking flow
// the link actually promised.
(function(){
  const targetId = (location.hash || '').replace('#','');
  const validPageIds = ['tarot-booking','spell-booking','energy-healing','numerology-booking','group-booking','all-services','shop'];
  if(targetId && validPageIds.includes(targetId)){
    document.addEventListener('DOMContentLoaded', function(){
      showPage(targetId);
    });
  }
})();

// ── Admin/CRM panel — loaded from a separate static file ──
// The CRM markup used to sit directly in this page's HTML (page-admin),
// which meant every anonymous visitor's browser (and every search
// crawler) downloaded the entire dashboard/bookings/analytics UI along
// with the public site, and search engines saw a document with a dozen+
// H1 headings buried in it. It's now in admin-panel-fragment.html and
// gets fetched and injected into the empty #page-admin mount point here,
// starting as early as possible on page load — well before any real
// admin user could reach it (getting to showPage('admin') requires a
// hidden gesture plus a Google sign-in redirect, which takes far longer
// than this fetch). showPage() still waits on window.OT_ADMIN_FRAGMENT_READY
// before entering the admin page, as a safety net for the rare case the
// fetch hasn't finished yet — see the id==='admin' check there.
//
// Every element ID inside the fragment is byte-for-byte identical to
// before — this only changes WHEN the markup exists in the DOM, never
// WHAT it contains, so every existing getElementById/onclick/CSS rule
// throughout script.js and styles.css keeps working unchanged once the
// fragment is in place. Nothing here alters admin logic or state.
window._adminFragmentLoaded = false;
window.OT_ADMIN_FRAGMENT_READY = fetch('/admin-panel-fragment.html')
  .then(function(r){ if (!r.ok) throw new Error('admin fragment fetch failed: ' + r.status); return r.text(); })
  .then(function(html){
    const mount = document.getElementById('page-admin');
    if (mount) mount.outerHTML = html;
    window._adminFragmentLoaded = true;
  })
  .catch(function(err){
    // If this ever fails (offline, path issue, etc.), #page-admin stays an
    // empty mount — admin login still works exactly as before, it just
    // won't have anything to show. Public-site visitors are completely
    // unaffected either way.
    console.error('[admin-panel-fragment]', err);
    window._adminFragmentLoaded = true; // stop showPage('admin') waiting forever
  });

// ═══════════════════════════════════════════════════════════════════
// Group Magic — auto-calculated New Moon / Full Moon dates.
// Replaces the previously hardcoded, easily-stale session dates for
// the two lunar-phase sessions with a real astronomical calculation,
// so they never go stale again. Akankshaa can still override either
// date from the admin panel (Availability tab) for a specific session
// if she's unavailable — see /api/moon-events. Absent an override, the
// site always shows the next real upcoming date automatically.
//
// The "Abundance Ritual" session (session-3) is a custom seasonal
// ritual, not tied to a lunar phase, so it's NOT covered by this and
// still needs a real date from Akankshaa directly — same as before.
// ═══════════════════════════════════════════════════════════════════
const OT_SYNODIC_MONTH_DAYS = 29.530588853;
const OT_KNOWN_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14, 0); // a known reference New Moon
const OT_MOON_EVENT_DEFAULT_TIME = { new_moon: '8:00 PM IST', full_moon: '9:00 PM IST' };

// phaseFraction: 0 = New Moon, 0.5 = Full Moon
function otNextMoonEventDate(phaseFraction, fromDate){
  fromDate = fromDate || new Date();
  const fromMs = fromDate.getTime();
  const msPerCycle = OT_SYNODIC_MONTH_DAYS * 86400000;
  const cyclesSinceKnown = (fromMs - OT_KNOWN_NEW_MOON_MS) / msPerCycle;
  let n = Math.floor(cyclesSinceKnown - phaseFraction) + phaseFraction;
  let eventMs = OT_KNOWN_NEW_MOON_MS + n * msPerCycle;
  while (eventMs <= fromMs) { n += 1; eventMs = OT_KNOWN_NEW_MOON_MS + n * msPerCycle; }
  return new Date(eventMs);
}
function otFormatMoonDate(date){
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
// Parses an admin override date string ('2026-09-14') into the same
// display format as the calculated dates, so both look consistent.
function otFormatOverrideDate(isoDateStr){
  const d = new Date(isoDateStr + 'T00:00:00Z');
  if (isNaN(d)) return isoDateStr; // fall back to whatever was typed
  return otFormatMoonDate(d);
}

window.OT_MOON_EVENTS_READY = fetch(OCULTT_API + '/moon-events', { signal: AbortSignal.timeout(6000) })
  .then(r => r.json())
  .then(data => data.overrides || {})
  .catch(() => ({})); // any failure (including timeout) → no overrides, calculated dates still work

function otResolveMoonEvent(eventType, phaseFraction){
  return window.OT_MOON_EVENTS_READY.then(function(overrides){
    const ov = overrides[eventType];
    if (ov && ov.date) {
      return { dateLabel: otFormatOverrideDate(ov.date), time: ov.time || OT_MOON_EVENT_DEFAULT_TIME[eventType] };
    }
    const calc = otNextMoonEventDate(phaseFraction);
    return { dateLabel: otFormatMoonDate(calc), time: OT_MOON_EVENT_DEFAULT_TIME[eventType] };
  });
}

// Updates the New Moon / Full Moon session cards on the Group Magic page
// with the resolved date, preserving each card's existing "spots
// remaining" text and icon exactly as authored.
window.OT_MOON_EVENTS_READY.then(function(){
  const cards = [
    { id: 'group-session-1', name: 'New Moon Circle', type: 'new_moon', phase: 0 },
    { id: 'group-session-2', name: 'Full Moon Release', type: 'full_moon', phase: 0.5 }
  ];
  cards.forEach(function(cfg){
    otResolveMoonEvent(cfg.type, cfg.phase).then(function(resolved){
      const dateTimeStr = resolved.dateLabel + ' · ' + resolved.time;
      const el = document.getElementById(cfg.id);
      if (!el) return;
      const pEl = el.querySelector('p');
      if (pEl) {
        const spotsMatch = pEl.textContent.match(/·\s*(\d+\s*spots?\s*remaining)\s*$/i);
        pEl.textContent = dateTimeStr + (spotsMatch ? ' · ' + spotsMatch[1] : '');
      }
      el.onclick = function(){ selectGroupSession(el, cfg.name, dateTimeStr); };
      // Keep the pre-selected default (session-1, New Moon) in sync with
      // the freshly-resolved date, since it's selected before any click.
      if (el.classList.contains('selected')) {
        selectedGroupSession = cfg.name;
        selectedGroupDate = dateTimeStr;
      }
    });
  });
});

// ── Keep the Back button inside the website ──
// The site is a single-page app, so without this the browser's own Back
// button would leave the site entirely (returning to whatever page the
// visitor was on before they arrived). We give the initial view a history
// entry and listen for popstate so Back always lands on an in-site page.
if(!history.state){
  history.replaceState({page:'home'}, '', location.href);
}
window.addEventListener('popstate', function(e){
  const targetId = (e.state && e.state.page) ? e.state.page : 'home';
  showPage(targetId, true);
});

function showPage(id, fromPopstate){
  // ── CRM PROTECTION — only authenticated admin accounts may enter ──
  if (id === 'admin' && !isAdminUser()) {
    const currentlySignedIn = getCurrentAuthUser();
    if (currentlySignedIn) {
      if (typeof showToast === 'function') showToast('This Google account does not have admin access.');
    } else {
      // Not signed in at all — send them to the login page (the Google
      // Sign-In modal is this SPA's login screen; there's no separate URL).
      // Remember that this sign-in was requested in order to reach the
      // dashboard, so a successful login can automatically continue on
      // into the admin page instead of just closing the modal and
      // leaving the visitor back where they started (see
      // _completePendingAdminEntry, called from every sign-in success
      // path below). Also persisted to sessionStorage — on mobile the
      // sign-in flow does a full-page redirect, which resets this
      // in-memory flag, so it needs to survive the reload too.
      _pendingAdminEntry = true;
      try { sessionStorage.setItem('ocultt_pending_admin_entry', '1'); } catch(e) {}
      if (typeof showToast === 'function') showToast('Admin sign-in required to open the dashboard.');
      if (typeof openGauthModal === 'function') openGauthModal();
    }
    if (!fromPopstate) return; // stay put — don't push a history entry for a page they can't see
    id = 'home'; // came from Back/Forward landing on an old #admin entry — send them home instead
  }
  // Safety net — see the fragment loader above. In practice this almost
  // never waits: the fetch starts the instant the page loads, and an
  // admin reaching this point has already gone through a hidden gesture
  // and a Google sign-in redirect, both far slower than this fetch.
  if (id === 'admin' && !window._adminFragmentLoaded) {
    window.OT_ADMIN_FRAGMENT_READY.then(function(){ showPage(id, fromPopstate); });
    return;
  }
  const currentPage=document.querySelector('.page.active');
  // Remember which homepage section was in view before leaving, so the
  // floating Back pill can return there instead of just the top.
  if(currentPage && currentPage.id==='page-home' && id!=='home'){
    captureHomeSection();
  }
  // Keep the browser's own history in sync with in-app navigation, so the
  // hardware/browser Back button steps back through the site's pages
  // instead of leaving the website entirely.
  if(!fromPopstate && (!history.state || history.state.page!==id)){
    history.pushState({page:id}, '', '#'+id);
  }
  const doSwitch=function(){
    document.querySelectorAll('.page').forEach(p=>{p.classList.remove('active');p.classList.remove('page-leaving');});
    const pageEl=document.getElementById('page-'+id);
    window.scrollTo({top:0,behavior:'auto'});
    pageEl.classList.add('active');
    // Reveal-on-scroll elements rely on IntersectionObserver, which cannot
    // detect intersection while a parent .page is display:none. Force any
    // reveal-class content within this page to its visible state now, so
    // headings/sections never stay invisible when navigating via showPage().
    pageEl.querySelectorAll('.reveal,.reveal-left,.reveal-scale,.reveal-up,.v7-reveal,.v7-reveal-l,.v7-reveal-r,.v7-reveal-scale').forEach(el=>{
      el.classList.add('visible','vis');
    });
    if(id!=='tarot-booking') stopSlotHoldTimer(false);
    if(id==='tarot-booking'){
      if(_resumingPhoneTarot){
        // Returning from Calendly for a Phone Tarot booking — keep the
        // duration/details already restored by resumePhoneTarotAfterCalendly()
        // and just render the current step (Payment) instead of resetting.
        _resumingPhoneTarot=false;
        renderTarotStep();
      } else {
        tarotStep=1;selectedReading='';selectedDuration='';selectedDay=null;selectedTime='';selectedDayLabel='';selectedTarotUrgency='No rush';_bookingSaved=false;_paymentVerified=false;_rzpPaymentId='';if(typeof resetCoupon==='function')resetCoupon('t');
        if(typeof _phoneCalendlyAutoTimer!=='undefined' && _phoneCalendlyAutoTimer){ clearTimeout(_phoneCalendlyAutoTimer); _phoneCalendlyAutoTimer=null; }
        renderTarotStep();
      }
    }
    if(id==='spell-booking'){document.getElementById('spell-form-view').style.display='block';document.getElementById('spell-success-view').style.display='none';
      const spellCat=document.getElementById('spell-step-category'); if(spellCat){spellCat.style.display='block'; void spellCat.offsetHeight; spellCat.classList.add('is-active');}
      const spellSpells=document.getElementById('spell-step-spells'); if(spellSpells) spellSpells.classList.remove('is-active');
      const spellPay=document.getElementById('spell-payment-view'); if(spellPay) spellPay.classList.remove('is-active');
      localizeSpellCategoryPrices();
      window.OT_CURRENCY_READY.then(localizeSpellCategoryPrices);
    }
    if(id==='group-booking'){
      const groupForm=document.getElementById('group-form-view'); if(groupForm){groupForm.style.display='block'; void groupForm.offsetHeight; groupForm.classList.add('is-active');}
      const groupSuccess=document.getElementById('group-success-view'); if(groupSuccess){groupSuccess.style.display='none'; groupSuccess.classList.remove('is-active');}
      const groupPay=document.getElementById('group-payment-view'); if(groupPay) groupPay.classList.remove('is-active');
    }
    if(id==='energy-healing'){
      const ehForm=document.getElementById('eh-form-view'); if(ehForm){ehForm.style.display='block'; void ehForm.offsetHeight; ehForm.classList.add('is-active');}
      const ehSuccess=document.getElementById('eh-success-view'); if(ehSuccess){ehSuccess.style.display='none'; ehSuccess.classList.remove('is-active');}
      const ehPay=document.getElementById('eh-payment-view'); if(ehPay) ehPay.classList.remove('is-active');
    }
    if(id==='numerology-booking'){
      const numForm=document.getElementById('num-form-view'); if(numForm){numForm.style.display='block'; void numForm.offsetHeight; numForm.classList.add('is-active');}
      const numSuccess=document.getElementById('num-success-view'); if(numSuccess){numSuccess.style.display='none'; numSuccess.classList.remove('is-active');}
      const numPay=document.getElementById('num-payment-view'); if(numPay) numPay.classList.remove('is-active');
    }
    if(id==='admin'){updateAdminGreeting();renderDashboard(true);}
    const bookingPages=['tarot-booking','spell-booking','group-booking','numerology-booking'];
    const aiBtn=document.getElementById('aiGuideBtn');
    if(aiBtn)aiBtn.classList.toggle('ai-guide-hidden', bookingPages.includes(id));
    const backPill=document.getElementById('floatingBackPill');
    if(backPill)backPill.classList.toggle('show', id!=='home' && id!=='admin');
    if(typeof closeNavKebab==='function') closeNavKebab();
    if(typeof prefillSavedContactInfo==='function') prefillSavedContactInfo();
  };
  // Only play the leave-transition if there's a different page currently showing,
  // and the person hasn't asked for reduced motion. Otherwise switch instantly.
  const reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(currentPage && currentPage.id!=='page-'+id && !reduceMotion){
    currentPage.classList.add('page-leaving');
    setTimeout(doSwitch,170);
  } else {
    doSwitch();
  }
}

function scrollToSection(id){
  showPage('home');
  setTimeout(()=>{
    const el=document.getElementById(id);
    if(!el)return;
    const navEl=document.querySelector('nav');
    const navHeight=navEl?navEl.getBoundingClientRect().height:80;
    const top=el.getBoundingClientRect().top+window.scrollY-navHeight-14;
    window.scrollTo({top:Math.max(0,top),behavior:'smooth'});
  },260);
}

/* ── MOBILE NAV DRAWER (C-01 fix) ── */
function openNavDrawer(){
  const overlay=document.getElementById('navDrawerOverlay');
  const drawer=document.getElementById('navDrawer');
  const btn=document.getElementById('navHamburger');
  if(!overlay||!drawer)return;
  overlay.classList.add('is-open');
  drawer.classList.add('is-open');
  btn.classList.add('is-open');
  btn.setAttribute('aria-expanded','true');
  document.body.style.overflow='hidden';
}

/* ── MOBILE CRM SIDEBAR DRAWER ── */
function openAdminSidebar(){
  const overlay=document.getElementById('adminSidebarOverlay');
  const drawer=document.getElementById('adminSidebar');
  const btn=document.getElementById('adminMobileHamburger');
  if(!overlay||!drawer)return;
  overlay.classList.add('is-open');
  drawer.classList.add('is-open');
  if(btn){btn.classList.add('is-open');btn.setAttribute('aria-expanded','true');}
  document.body.style.overflow='hidden';
}
function closeAdminSidebar(){
  const overlay=document.getElementById('adminSidebarOverlay');
  const drawer=document.getElementById('adminSidebar');
  const btn=document.getElementById('adminMobileHamburger');
  if(!overlay||!drawer)return;
  overlay.classList.remove('is-open');
  drawer.classList.remove('is-open');
  if(btn){btn.classList.remove('is-open');btn.setAttribute('aria-expanded','false');}
  document.body.style.overflow='';
}
function toggleAdminSidebar(){
  const drawer=document.getElementById('adminSidebar');
  if(drawer && drawer.classList.contains('is-open')){
    closeAdminSidebar();
  } else {
    openAdminSidebar();
  }
}
document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeAdminSidebar();}});

function closeNavDrawer(){
  const overlay=document.getElementById('navDrawerOverlay');
  const drawer=document.getElementById('navDrawer');
  const btn=document.getElementById('navHamburger');
  if(!overlay||!drawer)return;
  overlay.classList.remove('is-open');
  drawer.classList.remove('is-open');
  btn.classList.remove('is-open');
  btn.setAttribute('aria-expanded','false');
  document.body.style.overflow='';
}
function toggleNavDrawer(){
  const drawer=document.getElementById('navDrawer');
  if(drawer && drawer.classList.contains('is-open')){
    closeNavDrawer();
  } else {
    openNavDrawer();
  }
}

/* ── DESKTOP/TABLET/LAPTOP KEBAB MENU (Book a Session + Sign In) ── */
function openNavKebab(){
  const wrap=document.getElementById('navKebabWrap');
  const btn=document.getElementById('navKebabBtn');
  if(!wrap||!btn)return;
  wrap.classList.add('is-open');
  btn.setAttribute('aria-expanded','true');
}
function closeNavKebab(){
  const wrap=document.getElementById('navKebabWrap');
  const btn=document.getElementById('navKebabBtn');
  if(!wrap||!btn)return;
  wrap.classList.remove('is-open');
  btn.setAttribute('aria-expanded','false');
}
function toggleNavKebab(){
  const wrap=document.getElementById('navKebabWrap');
  if(wrap && wrap.classList.contains('is-open')){
    closeNavKebab();
  } else {
    openNavKebab();
  }
}
// Close on outside click / Escape, so it behaves like a normal dropdown.
document.addEventListener('click', function(e){
  const wrap=document.getElementById('navKebabWrap');
  if(!wrap || !wrap.classList.contains('is-open'))return;
  if(!wrap.contains(e.target)) closeNavKebab();
});
document.addEventListener('keydown', function(e){
  if(e.key==='Escape') closeNavKebab();
});
/* Close drawer on Escape */
document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeNavDrawer();}});

/* ── HIDDEN ADMIN ACCESS (C-04 fix) ──
   Triple-click the nav logo OR type the key sequence A-D-M-I-N
   to open the admin panel. Not visible in the public nav.        */
(function(){
  var logoClicks=0,logoTimer=null;
  var logoEl=document.querySelector('.nav-logo');
  if(logoEl){
    logoEl.addEventListener('click',function(){
      logoClicks++;
      clearTimeout(logoTimer);
      if(logoClicks>=5){logoClicks=0;showPage('admin');return;}
      logoTimer=setTimeout(function(){logoClicks=0;},600);
    });
  }
  var seq=[],target='ADMIN';
  document.addEventListener('keydown',function(e){
    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')return;
    seq.push(e.key.toUpperCase());
    if(seq.length>target.length)seq.shift();
    if(seq.join('')===target){showPage('admin');}
  });
})();

function updateProgress(){
  document.querySelectorAll('#tarot-progress .progress-step').forEach((el,i)=>{
    el.classList.remove('active','done');
    if(i+1===tarotStep)el.classList.add('active');
    else if(i+1<tarotStep)el.classList.add('done');
  });
}

// ── Shared step/view fade-swap helper — same cross-fade pattern as
// renderTarotStep() below, reused by the Spell/Group Magic/Numerology/
// Energy Healing flows so every booking flow's step transitions feel
// consistent instead of each one hard-cutting with display:none/block. ──
function swapStep(hideId, showId){
  const hideEl = hideId ? document.getElementById(hideId) : null;
  const showEl = showId ? document.getElementById(showId) : null;
  if(hideEl){
    if(hideEl.classList.contains('is-active')){
      hideEl.classList.remove('is-active');
      setTimeout(()=>{ if(!hideEl.classList.contains('is-active')) hideEl.style.display='none'; },280);
    } else {
      hideEl.style.display='none';
    }
  }
  if(showEl){
    showEl.style.display='block';
    void showEl.offsetHeight;
    showEl.classList.add('is-active');
  }
}
function renderTarotStep(){
  for(let i=1;i<=5;i++){
    const stepEl=document.getElementById('tarot-step-'+i);
    if(i===tarotStep){
      stepEl.style.display='block';
      // force layout so the browser registers the pre-transition state
      // before is-active flips opacity/transform, so it actually animates
      void stepEl.offsetHeight;
      stepEl.classList.add('is-active');
    } else if(stepEl.classList.contains('is-active')){
      stepEl.classList.remove('is-active');
      setTimeout(()=>{ if(!stepEl.classList.contains('is-active')) stepEl.style.display='none'; },280);
    } else {
      stepEl.style.display='none';
    }
  }
  updateProgress();
  if(tarotStep===2)buildCalendar();
  if(tarotStep===3){
    renderAudioQuestionInputs();
    // Step 3 always opens on the Details form; the Calendly view is only
    // shown by an explicit showCalendlyStepForPhone() call further down
    // the Phone Tarot flow, never as a side effect of just rendering step 3.
    const detailsView = document.getElementById('t-details-view');
    const calendlyView = document.getElementById('t-calendly-view');
    if(detailsView) detailsView.style.display='block';
    if(calendlyView) calendlyView.style.display='none';
    if(typeof _phoneCalendlyAutoTimer!=='undefined' && _phoneCalendlyAutoTimer){ clearTimeout(_phoneCalendlyAutoTimer); _phoneCalendlyAutoTimer=null; }
  }
  if(tarotStep===4)populatePaymentStep();
  if(tarotStep===5)showConfirmation();
  // Smooth-scroll to the top of the new step — same convention already used
  // by the Spell booking flow's own step transitions (see nextToSpells/
  // backToCategories) — so moving between steps never leaves the viewport
  // scrolled to an unrelated position from the previous step.
  window.scrollTo({top:0, behavior:'smooth'});
}

/* ── INLINE VALIDATION HELPERS (C-06 fix) ── */
function _showFieldError(inputId,errId){
  const inp=document.getElementById(inputId);
  const err=document.getElementById(errId);
  if(inp)inp.classList.add('field-invalid');
  if(err)err.classList.add('is-visible');
}
function _clearFieldError(inputId,errId){
  const inp=document.getElementById(inputId);
  const err=document.getElementById(errId);
  if(inp)inp.classList.remove('field-invalid');
  if(err)err.classList.remove('is-visible');
}
function _showBanner(bannerId,msg){
  const el=document.getElementById(bannerId);
  if(!el)return;
  el.textContent=msg;
  el.classList.add('is-visible');
  el.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function _clearBanner(bannerId){
  const el=document.getElementById(bannerId);
  if(el){el.textContent='';el.classList.remove('is-visible');}
}

/* Clear field errors when user starts correcting */
['t-name','t-email','t-phone','s-name','s-email','s-phone','s-goal','g-name','g-email','g-phone','n-name','n-email','n-phone','n-dob'].forEach(function(id){
  const el=document.getElementById(id);
  if(el)el.addEventListener('input',function(){
    el.classList.remove('field-invalid');
    const errEl=document.getElementById(id+'-err');
    if(errEl)errEl.classList.remove('is-visible');
    _clearBanner('spell-error');
    _clearBanner('group-error');
    _clearBanner('num-error');
  });
});

/* Live validation on blur — Tarot booking Details step.
   Catches errors as soon as the person moves to the next field, rather
   than waiting until they click Continue, so mistakes are caught earlier
   and feel less punishing. */
(function(){
  const rules=[
    {id:'t-name', test:v=>v.trim().length>0, err:'t-name-err'},
    {id:'t-email', test:v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()), err:'t-email-err'},
    {id:'t-phone', test:v=>v.trim().length>0, err:'t-phone-err'}
  ];
  rules.forEach(function(r){
    const el=document.getElementById(r.id);
    if(!el)return;
    el.addEventListener('blur',function(){
      const v=el.value;
      if(v.trim()==='')return; // don't scold an untouched empty field on first blur-through
      if(!r.test(v)){_showFieldError(r.id,r.err);}
      else{_clearFieldError(r.id,r.err);}
    });
  });
})();

/* Clear consent error when checkbox ticked */
(function(){
  const cb=document.getElementById('s-consent');
  if(cb)cb.addEventListener('change',function(){
    if(cb.checked){
      const errEl=document.getElementById('s-consent-err');
      if(errEl)errEl.classList.remove('is-visible');
    }
  });
})();

// ══════════════════════════════════════════════════════════════════
// PHONE TAROT — CALENDLY EVENT LINKS — REPLACE WITH REAL URLS HERE ONLY
// ══════════════════════════════════════════════════════════════════
// This object is the single, complete configuration block for every
// Phone Tarot Calendly event link — all six durations, nowhere else in
// the codebase. To point Phone Tarot at real/different Calendly events,
// edit ONLY the six URL strings below; nothing else needs to change.
// Used exclusively by the Phone Tarot branch of tarotNext(); no other
// reading format, service, or booking flow reads from this map.
const PHONE_TAROT_CALENDLY_LINKS = {
  '10': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-10-minutes',
  '15': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-15-minutes',
  '20': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-20-minutes',
  '30': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-30-minutes',
  '45': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-45-minutes',
  '60': 'https://calendly.com/the-ocultt-tarot/phone-tarot-reading-60-minutes'
};
// The exact query string Calendly must be configured to redirect back to,
// on ALL SIX Phone Tarot event types, after a booking is completed (Calendly
// event type → Confirmation Page → "Redirect to an external site").
const PHONE_TAROT_RETURN_PARAM = 'phoneTarotBooked';
const PHONE_TAROT_DRAFT_KEY = 'oc_phone_tarot_draft';

function savePhoneTarotDraft(draft){
  try { localStorage.setItem(PHONE_TAROT_DRAFT_KEY, JSON.stringify(draft)); } catch(e){}
}
function loadPhoneTarotDraft(){
  try {
    const raw = localStorage.getItem(PHONE_TAROT_DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e){ return null; }
}
function clearPhoneTarotDraft(){
  try { localStorage.removeItem(PHONE_TAROT_DRAFT_KEY); } catch(e){}
}

function tarotNext(from){
  if(from===1){
    _clearBanner('step1-error');
    const isAudio = selectedReading && selectedReading.startsWith('Audio');
    if(!selectedReading){_showBanner('step1-error','Please select a reading format and option to continue');return}
    if(!isAudio && !selectedDuration){_showBanner('step1-error','Please select a session duration to continue');return}
    if(isAudio){selectedDuration=selectedReading;}
  }
  if(from===2){
    _clearBanner('step2-error');
    if(!selectedDay||!selectedTime){_showBanner('step2-error','Please select both a date and a time slot to continue');return}
  }
  if(from===3){
    let hasError=false;
    const nm=(document.getElementById('t-name')?.value||'').trim();
    const em=(document.getElementById('t-email')?.value||'').trim();
    const ph=(document.getElementById('t-phone')?.value||'').trim();
    _clearFieldError('t-name','t-name-err');
    _clearFieldError('t-email','t-email-err');
    _clearFieldError('t-phone','t-phone-err');
    if(!nm){_showFieldError('t-name','t-name-err');hasError=true;}
    if(!em||!em.includes('@')){_showFieldError('t-email','t-email-err');hasError=true;}
    if(!ph){_showFieldError('t-phone','t-phone-err');hasError=true;}
    if(hasError){
      // Scroll to first error
      const firstErr=document.querySelector('#tarot-step-3 .field-invalid');
      if(firstErr)firstErr.scrollIntoView({behavior:'smooth',block:'center'});
      return;
    }
    // Phone Tarot Reading → Personal Details are already collected above.
    // Save them, then show the matching Calendly event inline on this same
    // page (see showCalendlyStepForPhone) so the customer never leaves the
    // site. If the Calendly embed script hasn't loaded for any reason, fall
    // back to a full-page redirect + resume via resumePhoneTarotAfterCalendly().
    // Every other reading format/service continues straight to Payment below,
    // exactly as before.
    if(selectedReading && selectedReading.startsWith('Phone')){
      const mins = (selectedDuration||'').split(' ')[0];
      const calendlyUrl = PHONE_TAROT_CALENDLY_LINKS[mins];
      if(!calendlyUrl){
        _showBanner('step1-error','Please select a valid call duration to continue');
        tarotStep=1; renderTarotStep();
        return;
      }
      savePhoneTarotDraft({
        selectedReading, selectedDuration, selectedPriceOverride,
        name: nm, email: em, phone: ph,
        dob: (document.getElementById('t-dob')?.value||'').trim(),
        intent: (document.getElementById('t-intent')?.value||'').trim()
      });
      if(window.Calendly && typeof window.Calendly.initInlineWidget==='function'){
        showCalendlyStepForPhone(calendlyUrl, nm, em);
      } else {
        // Fallback: embed script not ready — redirect out and resume on return.
        const sep = calendlyUrl.includes('?') ? '&' : '?';
        window.location.href = calendlyUrl + sep + 'name=' + encodeURIComponent(nm) + '&email=' + encodeURIComponent(em);
      }
      return;
    }
  }
  if(from===4){
    _clearBanner('step4-error');
    if(!_paymentVerified){_showBanner('step4-error','Please complete payment to continue');return}
  }
  // Audio and Phone readings both skip the internal calendar (step 2) —
  // Audio has no live slot to book, Phone books its slot via Calendly instead.
  if(from===1 && selectedReading && (selectedReading.startsWith('Audio') || selectedReading.startsWith('Phone'))){
    tarotStep=3;renderTarotStep();
  } else {
    tarotStep=from+1;renderTarotStep();
  }
}
function tarotBack(from){
  // Audio and Phone readings never visit the internal Calendar (step 2) going
  // forward — Back must mirror that, or clicking Back from Details would
  // resurrect the old, unused internal calendar UI for these formats.
  if(from===3 && selectedReading && (selectedReading.startsWith('Audio') || selectedReading.startsWith('Phone'))){
    tarotStep=1;
  } else {
    tarotStep=from-1;
  }
  renderTarotStep();
}

// ── Phone Tarot: inline Calendly embed within Step 3 ──
// Keeps the customer on our own site the whole time. When Calendly reports
// the booking is scheduled, we show a confirmation and move on to Payment
// automatically after a short delay, with a manual button as a fallback.
let _phoneCalendlyHandled = false;
let _phoneCalendlyAutoTimer = null;

function showCalendlyStepForPhone(calendlyUrl, nm, em){
  const detailsView = document.getElementById('t-details-view');
  const calendlyView = document.getElementById('t-calendly-view');
  const widgetEl = document.getElementById('calendlyInlineWidget');
  const statusEl = document.getElementById('calendlyReturnStatus');
  const continueBtn = document.getElementById('calendlyContinueBtn');
  if(detailsView) detailsView.style.display='none';
  if(calendlyView) calendlyView.style.display='block';
  if(statusEl) statusEl.style.display='none';
  _phoneCalendlyHandled = false;
  // Enforce the intended flow: "Continue to Payment" stays disabled until
  // Calendly actually confirms a real slot was booked (see
  // onPhoneTarotCalendlyScheduled below) — a customer can no longer reach
  // Payment merely by opening this step. Reset on every entry (including
  // re-entering after Back) so a previous booking's enabled state never
  // carries over to a fresh visit to this step.
  if(continueBtn){ continueBtn.disabled = true; continueBtn.style.opacity = '0.4'; continueBtn.style.cursor = 'not-allowed'; continueBtn.title = 'Please select a call time in the calendar above first'; }
  if(_phoneCalendlyAutoTimer){ clearTimeout(_phoneCalendlyAutoTimer); _phoneCalendlyAutoTimer=null; }
  if(widgetEl){
    widgetEl.style.display='block';
    widgetEl.innerHTML='';
    const sep = calendlyUrl.includes('?') ? '&' : '?';
    window.Calendly.initInlineWidget({
      url: calendlyUrl + sep + 'hide_gdpr_banner=1',
      parentElement: widgetEl,
      prefill: { name: nm, email: em }
    });
  }
  window.scrollTo({top:0, behavior:'smooth'});
}

function backToDetailsFromCalendly(){
  const detailsView = document.getElementById('t-details-view');
  const calendlyView = document.getElementById('t-calendly-view');
  if(calendlyView) calendlyView.style.display='none';
  if(detailsView) detailsView.style.display='block';
  if(_phoneCalendlyAutoTimer){ clearTimeout(_phoneCalendlyAutoTimer); _phoneCalendlyAutoTimer=null; }
  window.scrollTo({top:0, behavior:'smooth'});
}

// Fires once Calendly confirms the invitee scheduled an event inside our
// inline widget. Shows the confirmation panel, then auto-advances to
// Payment after ~2.5s — the "Continue to Payment" button stays available
// the whole time as a fallback if the auto-advance doesn't fire.
function onPhoneTarotCalendlyScheduled(){
  if(_phoneCalendlyHandled) return;
  _phoneCalendlyHandled = true;
  const widgetEl = document.getElementById('calendlyInlineWidget');
  const statusEl = document.getElementById('calendlyReturnStatus');
  const continueBtn = document.getElementById('calendlyContinueBtn');
  if(widgetEl) widgetEl.style.display='none';
  if(statusEl) statusEl.style.display='block';
  // Only now — a real 'calendly.event_scheduled' message from Calendly's
  // own iframe — is a genuine booking confirmed, so only now does Continue
  // to Payment become usable.
  if(continueBtn){ continueBtn.disabled = false; continueBtn.style.opacity = '1'; continueBtn.style.cursor = 'pointer'; continueBtn.title = ''; continueBtn.style.display='inline-block'; }
  _phoneCalendlyAutoTimer = setTimeout(proceedFromCalendlyToPayment, 2500);
}

function proceedFromCalendlyToPayment(){
  // Defensive re-check (belt-and-braces alongside the disabled button
  // above): never advance to Payment for a Phone Tarot booking without a
  // real Calendly 'calendly.event_scheduled' confirmation having fired.
  if(!_phoneCalendlyHandled) return;
  if(_phoneCalendlyAutoTimer){ clearTimeout(_phoneCalendlyAutoTimer); _phoneCalendlyAutoTimer=null; }
  tarotStep = 4;
  renderTarotStep();
}

// Calendly's inline widget posts window messages as the customer progresses;
// 'calendly.event_scheduled' fires once their slot is actually booked.
window.addEventListener('message', function(e){
  if(!e.origin || e.origin.indexOf('calendly.com')===-1) return;
  if(!e.data || typeof e.data!=='object' || typeof e.data.event!=='string') return;
  if(e.data.event.indexOf('calendly.')!==0) return;
  if(e.data.event==='calendly.event_scheduled') onPhoneTarotCalendlyScheduled();
});

// ── Resume a Phone Tarot booking after the customer returns from Calendly ──
// Calendly's "redirect after booking" setting (configured per event type in
// the Calendly dashboard, same URL on all six Phone Tarot event types) sends
// the customer back here with ?phoneTarotBooked=1 in the URL. We restore the
// duration/details saved just before the redirect and resume at the existing
// Payment step, so Razorpay payment is still required before any booking is
// confirmed — nothing here bypasses payment.
function resumePhoneTarotAfterCalendly(){
  const params = new URLSearchParams(window.location.search);
  if(params.get(PHONE_TAROT_RETURN_PARAM) !== '1') return;
  // Strip the marker so a page refresh/share doesn't re-trigger this.
  history.replaceState({page:'tarot-booking'}, '', window.location.pathname);
  const draft = loadPhoneTarotDraft();
  if(!draft){
    showPage('tarot-booking');
    if(typeof showToast==='function') showToast('Welcome back! Please re-select your Phone Tarot duration and details to complete payment.');
    return;
  }
  selectedReading = draft.selectedReading;
  selectedDuration = draft.selectedDuration;
  selectedPriceOverride = draft.selectedPriceOverride;
  tarotStep = 4;
  _paymentVerified = false;
  _bookingSaved = false;
  _resumingPhoneTarot = true;
  showPage('tarot-booking');
  setTimeout(function(){
    const setVal=(id,val)=>{ const el=document.getElementById(id); if(el) el.value = val||''; };
    setVal('t-name', draft.name);
    setVal('t-email', draft.email);
    setVal('t-phone', draft.phone);
    setVal('t-dob', draft.dob);
    setVal('t-intent', draft.intent);
    if(typeof showToast==='function') showToast('Welcome back — your Calendly slot is booked! Please complete payment to confirm your session.');
  }, 300);
}
document.addEventListener('DOMContentLoaded', resumePhoneTarotAfterCalendly);

function selectReading(el,name){
  document.querySelectorAll('#tarot-step-1 .service-select-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');selectedReading=name;
  updateSummaryBar();
  checkStep1Ready();
}

// ── Reading format dropdowns (replaces the long list of individual price cards) ──
let selectedPriceOverride = null;
function formatRupees(n){ return '₹' + Number(n).toLocaleString('en-IN'); }
let _audioQCount = 0;
function handleAudioReadingSelect(sel){
  sel.classList.toggle('has-value', !!sel.value);
  const phoneSel = document.getElementById('phoneDurationSelect');
  if(!sel.value){
    selectedReading = null; selectedDuration = null; selectedPriceOverride = null;
    _audioQCount = 0;
    updateSummaryBar(); checkStep1Ready(); return;
  }
  const [qty, price] = sel.value.split('|');
  _audioQCount = parseInt(qty, 10) || 1;
  selectedReading = 'Audio — ' + qty + (qty === '1' ? ' Question' : ' Questions');
  selectedDuration = null;
  selectedPriceOverride = formatRupees(price);
  if(phoneSel){ phoneSel.value = ''; phoneSel.classList.remove('has-value'); }
  updateSummaryBar();
  checkStep1Ready();
}
function renderAudioQuestionInputs(){
  const intentWrap = document.getElementById('t-intent-wrap');
  const audioWrap  = document.getElementById('t-audio-questions-wrap');
  const urgentWrap = document.getElementById('t-urgent-wrap');
  if(!intentWrap||!audioWrap) return;
  const isAudio = selectedReading && selectedReading.startsWith('Audio') && _audioQCount > 0;
  if(isAudio){
    intentWrap.style.display = 'none';
    let html = `<label style="margin-bottom:0.8rem;display:block">Your Questions <span style="font-family:'Montserrat',sans-serif;font-size:0.83rem;color:var(--text-dim);font-weight:400;font-style:italic">— max ~30 words each</span></label>`;
    for(let i=1;i<=_audioQCount;i++){
      html += `<div style="margin-bottom:0.75rem">
        <label style="font-family:'Gudlak Bold',sans-serif;font-size:0.6rem;letter-spacing:0.12em;color:var(--gold);text-transform:uppercase;margin-bottom:0.3rem;display:block">Question ${i}</label>
        <textarea id="t-audio-q${i}" rows="3" placeholder="Type your question here..." style="width:100%;resize:vertical;min-height:68px"></textarea>
      </div>`;
    }
    audioWrap.innerHTML = html;
    audioWrap.style.display = '';
    // Urgent/same-day delivery option — only meaningful for Audio Tarot
    // Reading (a recorded delivery with a turnaround time to speed up).
    // Phone Tarot is a live scheduled call via Calendly, so there's no
    // "delivery speed" to expedite — this option is intentionally never
    // shown for it.
    if(urgentWrap) urgentWrap.style.display = '';
  } else {
    intentWrap.style.display = '';
    audioWrap.style.display = 'none';
    audioWrap.innerHTML = '';
    if(urgentWrap) urgentWrap.style.display = 'none';
    selectedTarotUrgency = 'No rush';
  }
}
function onTarotUrgencyChange(){
  const sel = document.getElementById('t-urgent');
  selectedTarotUrgency = (sel && sel.value === 'Urgent') ? 'Urgent' : 'No rush';
}
function handlePhoneReadingSelect(sel){
  sel.classList.toggle('has-value', !!sel.value);
  const audioSel = document.getElementById('audioQuestionsSelect');
  if(!sel.value){
    selectedReading = null; selectedDuration = null; selectedPriceOverride = null;
    updateSummaryBar(); checkStep1Ready(); return;
  }
  const [mins, price] = sel.value.split('|');
  selectedReading = 'Phone — ' + mins + ' Minutes';
  selectedDuration = mins + ' Min';
  selectedPriceOverride = formatRupees(price);
  if(audioSel){ audioSel.value = ''; audioSel.classList.remove('has-value'); }
  updateSummaryBar();
  checkStep1Ready();
}

function selectDuration(el,dur){
  document.querySelectorAll('.duration-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');selectedDuration=dur;
  updateSummaryBar();
  checkStep1Ready();
}

function checkStep1Ready(){
  const btn=document.getElementById('tarot-next-1');
  const isAudio = selectedReading && selectedReading.startsWith('Audio');
  const ready = isAudio ? !!selectedReading : (!!selectedReading && !!selectedDuration);
  btn.disabled=!ready;btn.style.opacity=ready?'1':'0.4';
}

const PRICE_MAP={'15 Min':'₹ 999','30 Min':'₹ 1,555','45 Min':'₹ 1,888','60 Min':'₹ 2,555'};
function updateSummaryBar(){
  const rEl=document.getElementById('summary-reading');
  const dEl=document.getElementById('summary-duration');
  const pEl=document.getElementById('summary-price');
  if(rEl){
    if(selectedReading){rEl.textContent=selectedReading;rEl.classList.remove('empty');}
    else{rEl.textContent='Not selected';rEl.classList.add('empty');}
  }
  if(dEl){
    if(selectedDuration){dEl.textContent=selectedDuration+' Session';dEl.classList.remove('empty');}
    else{dEl.textContent='Not selected';dEl.classList.add('empty');}
  }
  if(pEl){
    const price=selectedPriceOverride || PRICE_MAP[selectedDuration] || null;
    if(price){pEl.textContent=price;pEl.classList.remove('empty');}
    else{pEl.textContent='—';pEl.classList.add('empty');}
  }
  const fEl=document.getElementById('summary-format');
  if(fEl){
    if(selectedReading && selectedReading.startsWith('Phone')){
      fEl.textContent='Google Meet · 1 on 1';
    } else if(selectedReading && selectedReading.startsWith('Audio')){
      fEl.textContent='Recorded Audio · Delivered via Email';
    } else {
      fEl.textContent='Google Meet · 1 on 1';
    }
  }
}

// ── Tarot topic selection ────────────────────────────────────────────
let _selectedTarotTopic = '';
function selectTarotTopic(el, topic) {
  // Toggle active state
  document.querySelectorAll('.tarot-topic-pill').forEach(p => p.classList.remove('active'));
  if (_selectedTarotTopic === topic) {
    // Clicking same topic deselects
    _selectedTarotTopic = '';
    document.getElementById('tarot-topic-selected').style.display = 'none';
    return;
  }
  el.classList.add('active');
  _selectedTarotTopic = topic;
  // Show feedback
  const disp = document.getElementById('tarot-topic-selected');
  document.getElementById('tarot-topic-name').textContent = topic.replace(/&amp;/g,'&');
  disp.style.display = 'block';
  // Smooth scroll to format picker
  const formatCard = el.closest('.form-card').nextElementSibling;
  if (formatCard) {
    setTimeout(() => formatCard.scrollIntoView({behavior:'smooth', block:'start'}), 100);
  }
  // If summary bar exists, update focus area label
  const sumReading = document.getElementById('summary-reading');
  if (sumReading && !selectedReading) {
    sumReading.textContent = topic.replace(/&amp;/g,'&') + ' reading';
    sumReading.classList.remove('empty');
  }
}

// ── Spell category data (exact from document) ────────────────────────
const SPELL_CATEGORIES = {
  'self-love': {
    title: 'Self Love Spells',
    desc: 'Designed to strengthen self-love, build confidence, and prioritize your own well-being. All spells from ₹1,666.',
    spells: [
      {name:'Self-Love Spell', note:'Prioritize loving yourself first.', price:'₹1,666'},
      {name:'Self-Care Spell', note:'Make yourself your highest priority.', price:'₹1,666'},
      {name:'Self-Confidence Booster Spell', note:'Boost self-assurance and inner strength.', price:'₹1,666'},
    ]
  },
  'relationship': {
    title: 'Relationship & Marriage Spells',
    desc: 'For couples seeking healing, commitment, emotional bonding, and marriage. Prices from ₹2,999.',
    spells: [
      {name:'Relationship Spell for Couples', note:'Love, commitment, understanding & partnership.', price:'₹2,999'},
      {name:'Relationship Healing for Husband & Wife', note:'Heal the relationship and strengthen bonding.', price:'₹2,999'},
      {name:'Marriage Spell', note:'Support for early marriage.', price:'₹2,999'},
      {name:'Marriage with a Specific Person', note:'', price:'₹2,999'},
      {name:'Bring Back Passion Between Husband & Wife', note:'', price:'₹2,999'},
      {name:'Bring Back Passion Between Couples', note:'', price:'₹2,999'},
      {name:'Loyalty Between Husband & Wife', note:'', price:'₹2,999'},
      {name:'Attract the Right Partner', note:'Attract your future life partner.', price:'₹2,999'},
      {name:'Attract a Specific Person / Crush', note:'', price:'₹2,999'},
    ]
  },
  'abundance': {
    title: 'Abundance & Money Spells',
    desc: 'Remove financial blockages and attract prosperity. All spells from ₹1,666.',
    spells: [
      {name:'Money Attraction Spell', note:'Invite money inflow.', price:'₹1,666'},
      {name:'Money Blockage Removal', note:'Remove energetic financial blockages.', price:'₹1,666'},
      {name:'Money Stays With Me', note:'Improve savings and reduce unnecessary expenses.', price:'₹1,666'},
      {name:'Business Development Spell', note:'Good luck, abundance and business growth.', price:'₹1,666'},
      {name:'Opportunity Spell', note:'Career and business opportunities.', price:'₹1,666'},
      {name:'Client Attraction Spell', note:'Attract more clients.', price:'₹1,666'},
      {name:'Loan/Debt Removal Spell', note:'', price:'₹1,666'},
      {name:'Loan Approval Spell', note:'', price:'₹1,666'},
      {name:'Recover Money from Friends or Family', note:'', price:'₹1,666'},
    ]
  },
  'career': {
    title: 'Career & Job Spells',
    desc: 'Support your professional journey and career growth. All spells from ₹1,555.',
    spells: [
      {name:'Job Spell', note:'Find employment quickly.', price:'₹1,555'},
      {name:'Desired Job Spell', note:'Specific company, salary or designation.', price:'₹1,555'},
      {name:'Desired Location Job Spell', note:'Dream city or preferred location.', price:'₹1,555'},
      {name:'Career Stability Spell', note:'Stable professional life.', price:'₹1,555'},
      {name:'Impress Seniors Spell', note:'Recognition from managers and colleagues.', price:'₹1,555'},
      {name:'Private Company Offer Letter Acceptance Spell', note:'', price:'₹1,555'},
      {name:'Promotion & Salary Increment Spell', note:'', price:'₹1,555'},
      {name:'Target Achievement Spell', note:'', price:'₹1,555'},
    ]
  },
  'government': {
    title: 'Government Career Spells',
    desc: 'For aspirants preparing for government careers. All spells from ₹1,555.',
    spells: [
      {name:'Government Job Spell', note:'Desired government job.', price:'₹1,555'},
      {name:'Competitive Exam Success Spell', note:'Supports your hard work with spiritual energy.', price:'₹1,555'},
      {name:'Government Offer Letter Acceptance Spell', note:'', price:'₹1,555'},
      {name:'Government Promotion & Salary Increment Spell', note:'', price:'₹1,555'},
      {name:'Government College Admission Spell', note:'', price:'₹1,555'},
    ]
  },
  'student': {
    title: 'Student Success Spells',
    desc: 'For academic focus, examinations and admissions. All spells from ₹1,555.',
    spells: [
      {name:'Exam Success Spell', note:'Supports your hard work with positive energy.', price:'₹1,555'},
      {name:'Mental Clarity Spell', note:'Better focus while studying.', price:'₹1,555'},
      {name:'Focus & Concentration Spell', note:'Helps reduce distractions.', price:'₹1,555'},
      {name:'Desired College Admission Spell', note:'', price:'₹1,555'},
    ]
  },
  'abroad': {
    title: 'Abroad & Visa Spells',
    desc: 'For overseas education, careers and settlement. All spells from ₹1,999.',
    spells: [
      {name:'Visa Approval Spell', note:'Speed up your visa process.', price:'₹1,999'},
      {name:'Scholarship Opportunity Spell', note:'', price:'₹1,999'},
      {name:'Abroad College Admission Spell', note:'', price:'₹1,999'},
      {name:'Abroad Job Opportunity Spell', note:'', price:'₹1,999'},
      {name:'Permanent Residency (PR) Approval Spell', note:'', price:'₹1,999'},
      {name:'Settling Abroad Spell', note:'', price:'₹1,999'},
    ]
  },
  'family': {
    title: 'Family Spells',
    desc: 'Create harmony, protection and stronger family bonds. Pricing varies by family size.',
    spells: [
      {name:'Family Health Spell', note:'', price:'₹2,222'},
      {name:'Family Protection from Evil Eye', note:'', price:'₹2,222'},
      {name:'Family Negativity Removal', note:'', price:'₹2,222'},
      {name:'Resolve Misunderstandings within Family & Friends', note:'', price:'₹2,222'},
      {name:'Family Harmony Spell', note:'', price:'₹2,222'},
      {name:'Father-Daughter Bond Spell', note:'', price:'₹2,222'},
      {name:'Father-Son Bond Spell', note:'', price:'₹2,222'},
      {name:'Family Package (2 Members)', note:'', price:'₹2,222'},
      {name:'Family Package (4 Members)', note:'', price:'₹4,444'},
      {name:'Family Package (6 Members)', note:'', price:'₹6,666'},
    ]
  },
  'house': {
    title: 'House Spells',
    desc: 'For your dream home and peaceful living. All spells from ₹1,666.',
    spells: [
      {name:'Dream House Buying Spell', note:'', price:'₹1,666'},
      {name:'Smooth Property Selling Spell', note:'', price:'₹1,666'},
      {name:'Happiness & Positive Energy for Your Home', note:'', price:'₹1,666'},
    ]
  },
  'protection': {
    title: 'Protection & Negativity Removal',
    desc: 'Release unwanted energies and invite protection. All spells from ₹1,666.',
    spells: [
      {name:'Negativity Removal Spell', note:'Remove negativity and restore harmony.', price:'₹1,666'},
      {name:'Protection Spell', note:'Protection from surrounding negative energies.', price:'₹1,666'},
      {name:'Evil Eye Removal Spell', note:'', price:'₹1,666'},
      {name:'Addiction Removal Spell', note:'For mild addiction patterns.', price:'₹1,666'},
      {name:'Anger Healing Spell', note:'', price:'₹1,666'},
    ]
  },
  'peace': {
    title: 'Peace of Mind Spells',
    desc: 'Restore emotional balance and inner calm. All spells from ₹1,555.',
    spells: [
      {name:'Peace Spell', note:'Bring back peace of mind and positive thinking.', price:'₹1,555'},
      {name:'Anxiety Removal Spell', note:'Only for Stage 1 Anxiety.', price:'₹1,555'},
      {name:'Feeling Lively Spell', note:'Reconnect with joy and enthusiasm.', price:'₹1,555'},
    ]
  },
  'beauty': {
    title: 'Beauty & Confidence Spell',
    desc: 'Enhance natural beauty, increase confidence, strengthen self-esteem, and increase personal magnetism.',
    spells: [
      {name:'Beauty & Confidence Spell', note:'Enhance natural beauty, confidence, self-esteem and personal magnetism. Align with self-love, confidence and radiance.', price:'₹1,888'},
    ]
  },
  'aura': {
    title: 'Aura Cleansing Ritual',
    desc: 'Recommended if you experience constant stress, feeling drained, relationship disturbances, mood fluctuations, or heavy energy.',
    spells: [
      {name:'Aura Cleansing Ritual', note:'One complete spell focusing on cleansing your overall aura and restoring energetic balance.', price:'₹5,555'},
    ]
  },
  'monthly': {
    title: '6 Months Bundle',
    desc: 'A 6-month package of ongoing energy support, at special bundled pricing.',
    spells: [
      {name:'Monthly Negativity Removal Spell', note:'Ongoing support to clear negative energy, for 6 months.', price:'₹8,888 (6 months)'},
      {name:'Monthly Good Luck Spell', note:'Ongoing positive energy and good fortune, for 6 months.', price:'₹8,888 (6 months)'},
      {name:'Monthly Protection Spell', note:'Continuous energetic protection, for 6 months.', price:'₹8,888 (6 months)'},
    ]
  },
};

// SPELL_CATEGORIES stores every price as an authored ₹ string (e.g. '₹1,666',
// '₹8,888/month', or embedded in a sentence like 'All spells from ₹1,666.').
// This converts any such ₹amount inside a string to the visitor's detected
// currency via formatPrice(), leaving surrounding text (like "/month") intact.
function _localizePriceText(str) {
  return String(str).replace(/₹[\d,]+/g, function(match) {
    return formatPrice(Number(match.replace(/[₹,]/g, '')));
  });
}

// Spell category picker cards ("❤️ From ₹1,666") are static prose text, not
// a single number, so they can't go through formatPrice() at render time
// the way other flows' prices do — instead we localize the ₹ amount in
// place. This has to be re-run every time the spell category screen is
// shown (not just once when currency detection first resolves), because a
// visitor can land directly on this screen before that background check
// finishes — it's the very first screen of the flow, unlike other flows
// where pricing is only shown a few clicks in, by which point detection has
// long since completed. Safe to call repeatedly: matching an already-
// converted price (no ₹ left) is simply a no-op.
function localizeSpellCategoryPrices() {
  document.querySelectorAll('#spell-step-category .sc-eyebrow').forEach(function(el){
    el.textContent = _localizePriceText(el.textContent);
  });
}

function openSpellCategory(catKey) {
  const cat = SPELL_CATEGORIES[catKey];
  if (!cat) return;
  selectedSpell = '';

  // Update UI
  document.getElementById('spell-cat-title').textContent = cat.title;
  document.getElementById('spell-cat-desc').textContent = _localizePriceText(cat.desc);

  // Build spell option cards
  const grid = document.getElementById('spell-options-grid');
  grid.innerHTML = cat.spells.map(spell => `
    <div class="service-select-card" onclick="selectSpellOption(this,'${spell.name.replace(/'/g,"\'")}','${spell.price}')" style="cursor:pointer;padding:1rem">
      <div class="check">✓</div>
      <h3 style="font-size:0.85rem;line-height:1.4">${spell.name}</h3>
      ${spell.note ? `<div class="sc-rule"></div><p style="font-size:0.85rem;font-style:italic">${spell.note}</p>` : ''}
      <div class="sc-tags"><span class="sc-tag">${_localizePriceText(spell.price)}</span></div>
    </div>
  `).join('');

  // Show spells step, hide category step
  swapStep('spell-step-category', 'spell-step-spells');
  document.getElementById('spell-selected-display').style.display = 'none';
  window.scrollTo({top: 0, behavior:'smooth'});
}

function backToCategories() {
  swapStep('spell-step-spells', 'spell-step-category');
  selectedSpell = '';
  window.scrollTo({top: 0, behavior:'smooth'});
}

function selectSpellOption(el, name, price) {
  document.querySelectorAll('#spell-options-grid .service-select-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  // Keep the ₹ amount in selectedSpell — _extractPriceNumber() (used later to
  // compute the actual charge) always expects the authored rupee value here.
  selectedSpell = name + ' — ' + price;
  const disp = document.getElementById('spell-selected-display');
  document.getElementById('spell-selected-name').textContent = name + ' — ' + _localizePriceText(price);
  disp.style.display = 'block';
}

function selectSpell(el, name) {
  // Legacy shim - kept for backward compat
  document.querySelectorAll('#page-spell-booking .service-select-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  selectedSpell = name;
}

function selectGroupSession(el,name,date){
  document.querySelectorAll('#page-group-booking .service-select-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');selectedGroupSession=name;selectedGroupDate=date;
}

function selectNum(el,name){
  document.querySelectorAll('#page-numerology-booking .service-select-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');selectedNum=name;
  const reportIncludes=document.getElementById('num-report-includes');
  if(reportIncludes)reportIncludes.style.display=name.indexOf('Complete 20-Page')===0?'block':'none';
}

/* ── CALENDAR MONTH STATE (H-01 fix) ── */
var _calYear=null,_calMonth=null;

function buildCalendar(yearOverride,monthOverride){
  const now=new Date();
  // Initialise on first call; subsequent nav calls pass explicit values
  if(yearOverride===undefined||monthOverride===undefined){
    _calYear=now.getFullYear();_calMonth=now.getMonth();
  } else {
    _calYear=yearOverride;_calMonth=monthOverride;
  }
  const year=_calYear,monthIdx=_calMonth;
  const todayYear=now.getFullYear(),todayMonth=now.getMonth(),todayDate=now.getDate();
  const month=new Date(year,monthIdx,1).toLocaleString('default',{month:'long'});
  const firstDay=new Date(year,monthIdx,1).getDay();
  const daysInMonth=new Date(year,monthIdx+1,0).getDate();
  const unavailable=[];
  for(let d=1;d<=daysInMonth;d++){const dow=new Date(year,monthIdx,d).getDay();if(dow===0||dow===6)unavailable.push(d);}
  const booked=[];
  // Pull Akanksha's manually-set unavailability from the admin dashboard
  const availIdx = (typeof OculttDB!=='undefined') ? OculttDB.getAvailabilityIndex() : {fullyBlockedDates:new Set(),blockedTimesByDate:{}};
  const toISODate = (y,m,d) => `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  for(let d=1;d<=daysInMonth;d++){
    if(availIdx.fullyBlockedDates.has(toISODate(year,monthIdx,d)) && !unavailable.includes(d)) unavailable.push(d);
  }
  // Determine if prev button should be disabled (can't go before current real month)
  const isCurrentMonth=(year===todayYear&&monthIdx===todayMonth);
  const calMonthLabel=month+' '+year;
  let html=`<h2>Select Your Session Date</h2>
  <div class="availability-badge"><span class="availability-badge-dot"></span>Limited slots this week — booking fills fast</div>
  <div class="cal-header">
    <button class="cal-nav" onclick="calNavMonth(-1)" aria-label="Previous month"${isCurrentMonth?' disabled style="opacity:0.3;cursor:default"':''}>‹</button>
    <span class="cal-month">${calMonthLabel}</span>
    <button class="cal-nav" onclick="calNavMonth(1)" aria-label="Next month">›</button>
  </div>
  <div class="cal-grid">`;
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d=>html+=`<div class="cal-day-name">${d}</div>`);
  for(let i=0;i<firstDay;i++)html+=`<div class="cal-day empty"></div>`;
  for(let d=1;d<=daysInMonth;d++){
    const isPast=(year<todayYear)||(year===todayYear&&monthIdx<todayMonth)||(year===todayYear&&monthIdx===todayMonth&&d<todayDate);
    let cls='cal-day';
    if(isPast)cls+=' past';
    else if(unavailable.includes(d))cls+=' unavailable';
    else if(booked.includes(d))cls+=' unavailable';
    else cls+=' available';
    const clickable=cls.includes('available');
    html+=`<div class="${cls}"${clickable?` onclick="selectDay(this,${d},${year},${monthIdx})"`:''} >${d}</div>`;
  }
  html+=`</div><div class="time-slots" id="timeSlots" style="display:none"><h3>Available Times</h3><div class="slots-grid">`;
  ['10:00 AM','11:00 AM','12:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM'].forEach((t,i)=>{
    // Deterministic "slots left" seed so the FOMO indicator is consistent per day, not randomly re-rolled on every render
    const seed=(d=>{let h=0;for(let c of d)h=(h*31+c.charCodeAt(0))>>>0;return h;})(year+'-'+monthIdx+'-'+t);
    const left=1+(seed%3); // 1, 2 or 3 spots left
    const tag = left<=2 ? `<span class="slot-left-tag${left===1?' urgent':''}">${left} left</span>` : '';
    html+=`<div class="time-slot" onclick="selectTime(this,'${t}')">${t}${tag}</div>`;
  });
  html+=`</div></div>`;
  document.getElementById('calendarWidget').innerHTML=html;
}

function calNavMonth(dir){
  let m=(_calMonth||0)+dir,y=_calYear||new Date().getFullYear();
  if(m>11){m=0;y++;}else if(m<0){m=11;y--;}
  // Do not allow going before the current real month
  const now=new Date();
  if(y<now.getFullYear()||(y===now.getFullYear()&&m<now.getMonth()))return;
  buildCalendar(y,m);
}

function selectDay(el,d,yr,mo){
  document.querySelectorAll('.cal-day').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');selectedDay=d;
  // Use passed year/month if provided, else fall back to cal state vars
  const y=yr!==undefined?yr:(_calYear||new Date().getFullYear());
  const m=mo!==undefined?mo:(_calMonth!==null?_calMonth:new Date().getMonth());
  const dateLabel=new Date(y,m,d).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'});
  selectedDayLabel=dateLabel;
  const sdEl=document.getElementById('summary-date');
  if(sdEl){sdEl.textContent=dateLabel;sdEl.classList.remove('empty');}
  document.getElementById('timeSlots').style.display='block';
  selectedTime='';
  const stEl=document.getElementById('summary-time');
  if(stEl){stEl.textContent='Not selected';stEl.classList.add('empty');}
  // Rebuild the time-slot grid for THIS specific date, excluding any times
  // Akanksha has blocked for it via the admin dashboard's Availability tab.
  const iso=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const availIdx=(typeof OculttDB!=='undefined')?OculttDB.getAvailabilityIndex():{blockedTimesByDate:{}};
  const blockedTimes=availIdx.blockedTimesByDate[iso]||new Set();
  const slotsGrid=document.querySelector('#timeSlots .slots-grid');
  if(slotsGrid){
    let slotsHtml='';
    ['10:00 AM','11:00 AM','12:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM'].forEach(t=>{
      if(blockedTimes.has(t))return; // hidden entirely — Akanksha is unavailable at this time
      const seed=(s=>{let h=0;for(let c of s)h=(h*31+c.charCodeAt(0))>>>0;return h;})(y+'-'+m+'-'+d+'-'+t);
      const left=1+(seed%3);
      const tag=left<=2?`<span class="slot-left-tag${left===1?' urgent':''}">${left} left</span>`:'';
      slotsHtml+=`<div class="time-slot" onclick="selectTime(this,'${t}')">${t}${tag}</div>`;
    });
    if(!slotsHtml)slotsHtml='<p style="font-style:italic;opacity:0.7;grid-column:1/-1">No time slots available this day — please choose another date.</p>';
    slotsGrid.innerHTML=slotsHtml;
  }
  const btn=document.getElementById('tarot-next-2');btn.disabled=true;btn.style.opacity='0.4';
}

function selectTime(el,t){
  document.querySelectorAll('.time-slot').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');selectedTime=t;
  const stEl=document.getElementById('summary-time');
  if(stEl){stEl.textContent=t+' IST';stEl.classList.remove('empty');}
  const btn=document.getElementById('tarot-next-2');btn.disabled=false;btn.style.opacity='1';
}

function showConfirmation(){
  if(_bookingSaved) return; // prevent double-fire if renderTarotStep called twice on step 5
  _bookingSaved=true;
  stopSlotHoldTimer(false);
  const name  = (document.getElementById('t-name')?.value||'').trim()||'Valued Client';
  const email = (document.getElementById('t-email')?.value||'').trim();
  const phone = (document.getElementById('t-phone')?.value||'').trim();
  const dob   = (document.getElementById('t-dob')?.value||'').trim();
  const intent= (() => {
    // Audio readings: collect individual question inputs
    if (selectedReading && selectedReading.startsWith('Audio') && _audioQCount > 0) {
      const qs = [];
      for (let i = 1; i <= _audioQCount; i++) {
        const v = (document.getElementById('t-audio-q'+i)?.value||'').trim();
        if (v) qs.push('Q'+i+': '+v);
      }
      return qs.join('\n') || '';
    }
    return (document.getElementById('t-intent')?.value||'').trim();
  })();
  // Reuse the SAME id used for the Razorpay order/verify/webhook (set by
  // initiateRazorpay just before payment) instead of minting a new one here —
  // otherwise the Supabase row created below never matches what Razorpay's
  // notes/webhook reference, and payment.failed/payment.captured events can
  // never find the right booking. Fallback only covers a defensive edge case
  // (payment verified without going through initiateRazorpay as expected).
  const id    = _pendingBookingId || ('OT-'+Math.floor(100000+Math.random()*900000));

  const priceLabel = selectedPriceOverride || PRICE_MAP[selectedDuration] || null;
  const price = priceLabel ? formatPrice(_extractPriceNumber(priceLabel)) : 'TBC';
  const isPhoneBooking = selectedReading && selectedReading.startsWith('Phone');
  const dateLabel = selectedDayLabel || (selectedDay ? 'Day '+selectedDay : (isPhoneBooking ? 'Booked via Calendly' : 'TBC'));
  const _audioQsArr = (() => {
    if (selectedReading && selectedReading.startsWith('Audio') && _audioQCount > 0) {
      const arr = [];
      for (let i = 1; i <= _audioQCount; i++) {
        arr.push((document.getElementById('t-audio-q'+i)?.value||'').trim());
      }
      return arr;
    }
    return null;
  })();
  const booking = {
    id, service:'Tarot Reading', package:selectedReading,
    duration:selectedDuration, price, name, email, phone, dob,
    intention:intent,
    audioQuestions: _audioQsArr,
    date: dateLabel,
    time: selectedTime|| (isPhoneBooking ? 'See Calendly confirmation email' : 'TBC'),
    razorpayPaymentId: _rzpPaymentId||'',
    paymentStatus: _rzpPaymentId ? 'Paid' : 'Unpaid',
    priority: 'Normal',
    // Google Meet is created by Calendly itself once its Google Calendar +
    // Meet location are configured (see project notes) — this codebase has
    // no automated way to write the resulting link back here yet, so it
    // starts unset and is filled in manually until that's built.
    meetStatus: isPhoneBooking ? 'Not Created' : 'N/A',
    meetLink: '',
    calendarEventId: '',
    status:'Booking Received', createdAt: new Date().toISOString()
  };
  // Save to local DB as fallback (local-only cache for the admin UI;
  // the live sync — see syncLiveBookingsIntoLocal — overwrites this with
  // the backend's real payment_status on next CRM load)
  OculttDB.saveBooking(booking);
  // NOTE: no confirmation email is sent from here. The backend is the sole
  // authority on payment status — the customer's "booking confirmed" email
  // is sent exclusively from the server, triggered by real Razorpay
  // signature verification (routes/payments.js /verify) or the webhook
  // (routes/razorpayWebhook.js payment.captured), never by the browser
  // reaching this step.

  // POST to real backend — payment_status/payment_id are intentionally
  // NOT sent here; the backend never trusts a client-supplied payment
  // status (see routes/bookings.js) and already has the real value from
  // /payments/verify, which ran moments ago in initiateRazorpay().
  if (OCULTT_BACKEND_CONNECTED) fetch(OCULTT_API + '/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id:            booking.id,
      service:       booking.service,
      package:       booking.package,
      duration:      booking.duration,
      preferredDate: booking.date,
      preferredTime: booking.time,
      format:        isPhoneBooking ? 'Google Meet' : 'Recorded Audio (delivered via email)',
      intention:     booking.intention,
      name:          booking.name,
      email:         booking.email,
      phone:         booking.phone
    })
  }).catch(e => console.warn('[booking POST]', e.message));

  const greetEl=document.getElementById('confirm-greeting');
  if(greetEl){
    greetEl.textContent = isPhoneBooking
      ? `Your booking is confirmed, ${name}. Akanksha will send a confirmation email to ${email||'you'} with your Google Meet link shortly.`
      : `Your booking is confirmed, ${name}. Akanksha will personally record your Audio Tarot Reading and send it to ${email||'you'} by email once it's ready.`;
  }
  document.getElementById('bookingId').textContent=id;
  document.getElementById('bookingDetails').innerHTML=`
    <div class="detail-row"><span class="detail-label">Booking ID</span><span class="detail-value">${id}</span></div>
    <div class="detail-row"><span class="detail-label">Service</span><span class="detail-value">Tarot Reading</span></div>
    <div class="detail-row"><span class="detail-label">Package</span><span class="detail-value">${selectedReading}</span></div>
    <div class="detail-row"><span class="detail-label">Duration</span><span class="detail-value">${selectedDuration} Session</span></div>
    <div class="detail-row"><span class="detail-label">Price</span><span class="detail-value">${price}</span></div>
    <div class="detail-row"><span class="detail-label">Client</span><span class="detail-value">${name}</span></div>
    <div class="detail-row"><span class="detail-label">Email</span><span class="detail-value">${email}</span></div>
    <div class="detail-row"><span class="detail-label">Date</span><span class="detail-value">${dateLabel}</span></div>
    <div class="detail-row"><span class="detail-label">Time</span><span class="detail-value">${isPhoneBooking ? (selectedTime||'See Calendly confirmation email') : (selectedTime||'TBC') + ' IST'}</span></div>
    <div class="detail-row"><span class="detail-label">Format</span><span class="detail-value">${isPhoneBooking ? 'Google Meet (link via email)' : 'Recorded Audio Reading (delivered via email)'}</span></div>`;

  if (isPhoneBooking) clearPhoneTarotDraft();
}

function submitSpell(){
  // V26: Full required-field validation before consent check
  var nameEl  = document.getElementById('s-name');
  var emailEl = document.getElementById('s-email');
  var phoneEl = document.getElementById('s-phone');
  var goalEl  = document.getElementById('s-goal');
  ['s-name','s-email','s-phone','s-goal'].forEach(function(id){
    var f=document.getElementById(id); if(f)f.classList.remove('field-invalid');
    var e=document.getElementById(id+'-err'); if(e)e.classList.remove('is-visible');
  });
  _clearBanner('spell-error');
  var hasError=false;
  var nameVal  = (nameEl?.value||'').trim();
  var emailVal = (emailEl?.value||'').trim();
  var phoneVal = (phoneEl?.value||'').trim();
  var goalVal  = (goalEl?.value||'').trim();
  if(!nameVal){if(nameEl)nameEl.classList.add('field-invalid');var ne=document.getElementById('s-name-err');if(ne)ne.classList.add('is-visible');hasError=true;}
  if(!emailVal||!emailVal.includes('@')){if(emailEl)emailEl.classList.add('field-invalid');var ee=document.getElementById('s-email-err');if(ee)ee.classList.add('is-visible');hasError=true;}
  if(!phoneVal){if(phoneEl)phoneEl.classList.add('field-invalid');var pe=document.getElementById('s-phone-err');if(pe)pe.classList.add('is-visible');hasError=true;}
  if(!goalVal){if(goalEl)goalEl.classList.add('field-invalid');var ge=document.getElementById('s-goal-err');if(ge)ge.classList.add('is-visible');hasError=true;}
  if(hasError){_showBanner('spell-error','Please fill in all required fields before submitting');return;}
  if(!document.getElementById('s-consent').checked){
    var consentErr=document.getElementById('s-consent-err');
    if(consentErr){consentErr.classList.add('is-visible');consentErr.scrollIntoView({behavior:'smooth',block:'nearest'});}
    return;
  }
  const name  = nameVal;
  const email = emailVal;
  const phone = phoneVal;
  const intent= goalVal;  // H-08 fix: was s-intent (non-existent), now correctly reads s-goal
  const urgency = document.getElementById('s-urgency')?.value || 'No rush';
  const spellId = 'OS-SP-' + Math.floor(100000 + Math.random() * 900000);
  const basePrice  = _extractPriceNumber(selectedSpell);
  // Urgent adds up to 20% — this is a DISPLAY-ONLY calculation so the
  // payment step can show an accurate total before checkout opens. The
  // server (routes/payments.js) independently recomputes this same 20%
  // from the verified base tier and never trusts this client-side number
  // as the actual amount to charge.
  const finalPrice = urgency === 'Urgent' ? Math.round(basePrice * 1.2) : basePrice;

  // Payment now happens BEFORE the request is submitted to Akanksha —
  // held here and only actually created (POST /spells) once Razorpay
  // checkout succeeds, in initiateSpellRazorpay()'s handler below.
  _pendingSpellBooking = {
    id: spellId, service: 'Spell / Magic', package: selectedSpell || 'Custom',
    basePrice, finalPrice, name, email, phone, intention: intent,
    detail: (document.getElementById('s-detail')?.value || '').trim(),
    notes:  (document.getElementById('s-notes')?.value  || '').trim(),
    urgency, priority: urgency === 'Urgent' ? 'Urgent' : 'Normal'
  };

  renderSpellPaymentView();
  swapStep('spell-step-spells', 'spell-payment-view');
  window.scrollTo({top: 0, behavior: 'smooth'});
}

// ── Spell / Magic payment step ──────────────────────────────────────
let _pendingSpellBooking = null;

function renderSpellPaymentView(){
  const b = _pendingSpellBooking;
  if (!b) return;
  const nameOnly = (b.package || '').replace(/\s*—\s*₹[\d,]+$/, '');
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText('spell-pay-name', nameOnly || b.package || '—');
  setText('spell-pay-urgency', b.urgency);
  setText('spell-pay-base', formatPrice(b.basePrice));
  const urgentRow = document.getElementById('spell-pay-urgent-row');
  if (urgentRow) {
    if (b.urgency === 'Urgent' && b.finalPrice > b.basePrice) {
      urgentRow.style.display = 'flex';
      setText('spell-pay-urgent-fee', '+ ' + formatPrice(b.finalPrice - b.basePrice) + ' (20% urgent fee)');
    } else {
      urgentRow.style.display = 'none';
    }
  }
  setText('spell-pay-total', formatPrice(b.finalPrice));
  resetCoupon('spell');
  refreshCouponDisplay('spell');
  const payBtn = document.getElementById('spell-rzp-pay-btn');
  if (payBtn) { payBtn.style.display = ''; payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; payBtn.onclick = function(){ payForSpellBooking(); }; }
  const paypalContainer = document.getElementById('spell-paypal-container');
  if (paypalContainer) { paypalContainer.style.display = 'none'; paypalContainer.innerHTML = ''; }
  const statusEl = document.getElementById('spell-rzp-status-msg');
  if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
}

function backFromSpellPayment(){
  swapStep('spell-payment-view', 'spell-step-spells');
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function spellRzpSetStatus(msg, color){
  const el = document.getElementById('spell-rzp-status-msg');
  if (!el) return;
  el.style.display = 'block'; el.style.color = color; el.textContent = msg;
}

function finalizeSpellBooking(b, paymentId){
  const finalBooking = {
    id: b.id, service: 'Spell / Magic', package: b.package,
    price: formatPrice(b.finalPrice),
    duration: '—', name: b.name, email: b.email, phone: b.phone, intention: b.intention,
    urgency: b.urgency, priority: b.priority,
    paymentStatus: 'Paid', razorpayPaymentId: paymentId,
    date: 'TBC', time: 'TBC', status: 'Booking Received', createdAt: new Date().toISOString()
  };
  OculttDB.saveBooking(finalBooking);
  swapStep('spell-payment-view', 'spell-success-view');
  window.scrollTo({top: 0, behavior: 'smooth'});
  _pendingSpellBooking = null;
}

function payForSpellBooking(){
  const b = _pendingSpellBooking;
  if (!b) return;
  if (window.OT_CURRENCY === 'USD') {
    initiatePayPalCheckout({
      bookingId: b.id, type: 'spell', basePrice: b.basePrice, urgency: b.urgency,
      name: b.name, email: b.email, phone: b.phone,
      couponCode: _appliedCoupons.spell ? _appliedCoupons.spell.code : null,
      payBtnId: 'spell-rzp-pay-btn', containerId: 'spell-paypal-container',
      statusSetter: spellRzpSetStatus,
      onApproved: function(paypalOrderId){
        fetch(OCULTT_API + '/spells', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: b.id, name: b.name, email: b.email, phone: b.phone,
            spellCategory: b.package, urgency: b.urgency, goal: b.intention,
            detail: b.detail, notes: b.notes
          })
        })
        .then(r => { if (!r.ok) console.warn('[payForSpellBooking] POST /spells did not succeed (status ' + r.status + ') — payment already verified against the placeholder row, but the request\'s full details may not have saved. Check the CRM.'); })
        .catch(() => {})
        .then(function(){ finalizeSpellBooking(b, 'PAYPAL-' + paypalOrderId); });
      }
    });
  } else {
    initiateSpellRazorpay();
  }
}

function initiateSpellRazorpay(){
  const b = _pendingSpellBooking;
  if (!b) return;
  const payBtn = document.getElementById('spell-rzp-pay-btn');
  if (payBtn) { payBtn.disabled = true; payBtn.style.opacity = '0.5'; payBtn.textContent = 'Creating order…'; }

  // ── TEST MODE: simulate a successful payment without calling Razorpay ──
  if (TEST_MODE) {
    if (payBtn) payBtn.textContent = 'Simulating test payment…';
    spellRzpSetStatus('TEST MODE — simulating payment, no real charge is made…', 'var(--gold)');
    setTimeout(function(){
      spellRzpSetStatus('✓ TEST MODE — payment simulated, booking confirmed.', 'var(--sage)');
      setTimeout(function(){ finalizeSpellBooking(b, 'TEST-' + Math.floor(100000 + Math.random() * 900000)); }, 1200);
    }, 900);
    return;
  }

  // ── STEP 1: Create order server-side (amount is enforced by server —
  // see SPELL_PRICE_TIERS_RUPEES in server/routes/payments.js) ──
  fetch(OCULTT_API + '/payments/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId: b.id, type: 'spell', basePrice: b.basePrice, urgency: b.urgency, name: b.name, email: b.email, phone: b.phone, couponCode: _appliedCoupons.spell ? _appliedCoupons.spell.code : null })
  })
  .then(r => r.json())
  .then(order => {
    if (order.error) throw { ocultOrderError: true, message: order.error };
    if (payBtn) payBtn.textContent = 'Opening payment…';

    const options = {
      key:         order.keyId,
      order_id:    order.orderId,
      amount:      order.amount,
      currency:    order.currency,
      name:        'The Ocultt Tarot',
      description: b.package,
      prefill:     { name: b.name, email: b.email, contact: b.phone },
      notes:       { spellId: b.id, urgency: b.urgency },
      theme:       { color: '#2E8B6E' },
      modal: {
        ondismiss: function() {
          if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
          spellRzpSetStatus('Payment cancelled. Click "Pay & Confirm Booking" to try again.', 'var(--text-muted)');
        }
      },
      handler: function(response) {
        spellRzpSetStatus('Verifying payment…', 'var(--text-muted)');
        // ── STEP 2: only now — payment already succeeded — create the
        // actual request (this is what Akanksha sees/is notified of), then
        // verify the signature server-side, which is what actually marks
        // it Paid and sends the customer's real confirmation email. ──
        fetch(OCULTT_API + '/spells', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: b.id, name: b.name, email: b.email, phone: b.phone,
            spellCategory: b.package, urgency: b.urgency, goal: b.intention,
            detail: b.detail, notes: b.notes
          })
        })
        .then(r => { if (!r.ok) console.warn('[initiateSpellRazorpay] POST /spells did not succeed (status ' + r.status + ') — payment will still be verified against the placeholder row created at order time, but the request\'s full details may not have saved. Check the CRM.'); })
        .then(() => fetch(OCULTT_API + '/payments/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            razorpay_order_id:   response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature:  response.razorpay_signature,
            bookingId: b.id,
            bookingType: 'spell'
          })
        }))
        .then(r => r.json())
        .then(result => {
          if (!result.success) throw new Error(result.error || 'Verification failed');
          spellRzpSetStatus('✓ Payment verified! Your booking is confirmed.', 'var(--sage)');
          setTimeout(function(){ finalizeSpellBooking(b, response.razorpay_payment_id); }, 1200);
        })
        .catch(err => {
          spellRzpSetStatus('✗ Payment verification failed: ' + err.message + '. Please contact support.', '#c0392b');
          if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
        });
      }
    };

    try {
      const rzp = new Razorpay(options);
      rzp.on('payment.failed', function(response) {
        if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; payBtn.onclick = function(){ initiateSpellRazorpay(); }; }
        spellRzpSetStatus('✗ Payment failed: ' + (response.error.description || 'Please try again.'), '#c0392b');
      });
      rzp.open();
    } catch(e) {
      if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
      spellRzpSetStatus('Payment gateway could not be loaded. Please disable any ad-blockers and try again.', '#c0392b');
    }
  })
  .catch(err => {
    if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
    if (err && err.ocultOrderError) {
      spellRzpSetStatus('✗ ' + err.message, '#c0392b');
    } else {
      spellRzpSetStatus('Could not connect to payment server. Please try again.', '#c0392b');
    }
    console.error('[initiateSpellRazorpay]', err);
  });
}

// ── Group Magic — participant fields scale with the "Number of
// Participants" select (1/2/3). Participant 1 reuses the main Full Name
// field above; participants 2+ get their own Name field. Every
// participant gets their own DOB + Intention, matching the actual need
// (a couple booking together has two different birth charts and two
// different intentions, not one shared one).
function renderGroupParticipantFields(){
  const count = parseInt(document.getElementById('g-participants')?.value || '1', 10);
  const wrap = document.getElementById('group-participants-wrap');
  if (!wrap) return;
  let html = '';
  for (let i = 1; i <= count; i++) {
    const isPrimary = i === 1;
    html += `<div class="form-grid" style="margin-bottom:${i < count ? '1.2rem' : '0'};padding-bottom:${i < count ? '1.2rem' : '0'};${i < count ? 'border-bottom:1px solid var(--border)' : ''}">
      <p style="grid-column:1/-1;font-family:'Gudlak Bold',sans-serif;font-size:0.65rem;letter-spacing:0.15em;color:var(--gold);text-transform:uppercase;margin-bottom:0.2rem">${isPrimary ? 'Your Details' : 'Participant ' + i}</p>
      ${isPrimary ? '' : `<div class="form-group"><label>Full Name *</label><input type="text" id="g-p${i}-name" placeholder="Full name"><span class="field-error" id="g-p${i}-name-err">Please enter this participant's name</span></div>`}
      <div class="form-group${isPrimary?' full':''}"><label>Date of Birth *</label><input type="date" id="g-p${i}-dob"><span class="field-error" id="g-p${i}-dob-err">Please enter date of birth</span></div>
      <div class="form-group full"><label>Intention (Optional)</label><textarea id="g-p${i}-intent" placeholder="What is ${isPrimary?'your':'their'} intention for this circle?"></textarea></div>
    </div>`;
  }
  wrap.innerHTML = html;
}
document.addEventListener('DOMContentLoaded', function() { renderGroupParticipantFields(); });

function submitGroup(){
  const nameEl  = document.getElementById('g-name');
  const emailEl = document.getElementById('g-email');
  const phoneEl = document.getElementById('g-phone');
  const notesEl = document.getElementById('g-notes');
  const name    = (nameEl?.value||'').trim();
  const email   = (emailEl?.value||'').trim();
  const phone   = (phoneEl?.value||'').trim();
  const notes   = (notesEl?.value||'').trim();
  ['g-name','g-email','g-phone'].forEach(function(id){
    const f=document.getElementById(id); if(f)f.classList.remove('field-invalid');
    const e=document.getElementById(id+'-err'); if(e)e.classList.remove('is-visible');
  });
  _clearBanner('group-error');
  let hasError=false;
  if(!name){if(nameEl)nameEl.classList.add('field-invalid');const e=document.getElementById('g-name-err');if(e)e.classList.add('is-visible');hasError=true;}
  if(!email||!email.includes('@')){if(emailEl)emailEl.classList.add('field-invalid');const e=document.getElementById('g-email-err');if(e)e.classList.add('is-visible');hasError=true;}
  if(!phone){if(phoneEl)phoneEl.classList.add('field-invalid');const e=document.getElementById('g-phone-err');if(e)e.classList.add('is-visible');hasError=true;}
  if(!selectedGroupSession){_showBanner('group-error','Please select a session above before registering');return;}

  // Collect + validate each participant's DOB (required) and name
  // (required for participants 2+, participant 1 reuses g-name).
  const count = parseInt(document.getElementById('g-participants')?.value || '1', 10);
  const participants = [];
  for (let i = 1; i <= count; i++) {
    const isPrimary = i === 1;
    const pNameEl = document.getElementById('g-p' + i + '-name');
    const pDobEl  = document.getElementById('g-p' + i + '-dob');
    const pIntentEl = document.getElementById('g-p' + i + '-intent');
    if (pNameEl) pNameEl.classList.remove('field-invalid');
    if (pDobEl)  pDobEl.classList.remove('field-invalid');
    const pNameErrEl = document.getElementById('g-p' + i + '-name-err'); if (pNameErrEl) pNameErrEl.classList.remove('is-visible');
    const pDobErrEl  = document.getElementById('g-p' + i + '-dob-err');  if (pDobErrEl)  pDobErrEl.classList.remove('is-visible');

    const pName = isPrimary ? name : (pNameEl?.value || '').trim();
    const pDob  = (pDobEl?.value || '').trim();
    const pIntent = (pIntentEl?.value || '').trim();

    if (!isPrimary && !pName) { pNameEl?.classList.add('field-invalid'); pNameErrEl?.classList.add('is-visible'); hasError = true; }
    if (!pDob) { pDobEl?.classList.add('field-invalid'); pDobErrEl?.classList.add('is-visible'); hasError = true; }
    participants.push({ name: pName, dob: pDob, intention: pIntent });
  }

  if(hasError){
    _showBanner('group-error','Please fill in all required fields to continue');
    const firstErr=document.querySelector('#page-group-booking .field-invalid');
    if(firstErr)firstErr.scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }
  const groupId = 'OG-' + Math.floor(100000 + Math.random() * 900000);
  const basePrice = parseInt(document.getElementById('g-price')?.value || '1000', 10);
  // No structured "participants" column exists (see schema.sql) — folded
  // into a readable multi-line summary in the intention field instead, so
  // it's visible in the CRM without a schema change.
  const participantsSummary = participants.map((p, i) =>
    `Participant ${i+1}${i===0?' (Primary)':''}: ${p.name || '—'} · DOB: ${p.dob || '—'}` + (p.intention ? ` · Intention: ${p.intention}` : '')
  ).join('\n') + (notes ? '\n\nNotes: ' + notes : '');

  // Payment now happens BEFORE the registration is saved — held here and
  // only actually created (POST /bookings) once Razorpay checkout
  // succeeds, in initiateGroupRazorpay()'s handler below. Matches the
  // same pattern already proven for Spell/Energy Healing/Numerology.
  _pendingGroupBooking = {
    id: groupId, service: 'Group Magic', package: selectedGroupSession,
    basePrice, name, email, phone, preferredDate: selectedGroupDate,
    intention: participantsSummary
  };

  renderGroupPaymentView();
  swapStep('group-form-view', 'group-payment-view');
  window.scrollTo({top: 0, behavior: 'smooth'});
}

// ── Group Magic payment step ────────────────────────────────────────
let _pendingGroupBooking = null;

function renderGroupPaymentView(){
  const b = _pendingGroupBooking;
  if (!b) return;
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText('group-pay-session', b.package || '—');
  setText('group-pay-total', formatPrice(b.basePrice));
  resetCoupon('group');
  refreshCouponDisplay('group');
  const payBtn = document.getElementById('group-rzp-pay-btn');
  if (payBtn) { payBtn.style.display = ''; payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Registration →'; payBtn.onclick = function(){ payForGroupBooking(); }; }
  const paypalContainer = document.getElementById('group-paypal-container');
  if (paypalContainer) { paypalContainer.style.display = 'none'; paypalContainer.innerHTML = ''; }
  const statusEl = document.getElementById('group-rzp-status-msg');
  if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
}

function backFromGroupPayment(){
  swapStep('group-payment-view', 'group-form-view');
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function groupRzpSetStatus(msg, color){
  const el = document.getElementById('group-rzp-status-msg');
  if (!el) return;
  el.style.display = 'block'; el.style.color = color; el.textContent = msg;
}

function finalizeGroupBooking(paymentId){
  const b = _pendingGroupBooking;
  if (b) {
    OculttDB.saveBooking({
      id: b.id, service: 'Group Magic', package: b.package,
      price: formatPrice(b.basePrice),
      duration: '—', name: b.name, email: b.email, phone: b.phone, intention: b.intention,
      paymentStatus: 'Paid', razorpayPaymentId: paymentId,
      date: b.preferredDate, time: '', status: 'Booking Received', createdAt: new Date().toISOString()
    });
  }
  swapStep('group-payment-view', 'group-success-view');
  window.scrollTo({top: 0, behavior: 'smooth'});
  _pendingGroupBooking = null;
}

function payForGroupBooking(){
  const b = _pendingGroupBooking;
  if (!b) return;
  if (window.OT_CURRENCY === 'USD') {
    initiatePayPalCheckout({
      bookingId: b.id, type: 'group_magic', basePrice: b.basePrice,
      name: b.name, email: b.email, phone: b.phone,
      couponCode: _appliedCoupons.group ? _appliedCoupons.group.code : null,
      payBtnId: 'group-rzp-pay-btn', containerId: 'group-paypal-container',
      statusSetter: groupRzpSetStatus,
      onApproved: function(paypalOrderId){
        fetch(OCULTT_API + '/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.id, service: 'Group Magic', package: b.package, preferredDate: b.preferredDate, name: b.name, email: b.email, phone: b.phone, intention: b.intention })
        })
        .then(r => { if (!r.ok) console.warn('[payForGroupBooking] POST /bookings did not succeed (status ' + r.status + ') — payment already verified against the placeholder row, but the request\'s full details may not have saved. Check the CRM.'); })
        .catch(() => {})
        .then(function(){ finalizeGroupBooking('PAYPAL-' + paypalOrderId); });
      }
    });
  } else {
    initiateGroupRazorpay();
  }
}

function initiateGroupRazorpay(){
  const b = _pendingGroupBooking;
  if (!b) return;
  const payBtn = document.getElementById('group-rzp-pay-btn');
  if (payBtn) { payBtn.disabled = true; payBtn.style.opacity = '0.5'; payBtn.textContent = 'Creating order…'; }

  if (TEST_MODE) {
    if (payBtn) payBtn.textContent = 'Simulating test payment…';
    groupRzpSetStatus('TEST MODE — simulating payment, no real charge is made…', 'var(--gold)');
    setTimeout(function(){
      groupRzpSetStatus('✓ TEST MODE — payment simulated, registration confirmed.', 'var(--sage)');
      setTimeout(function(){ finalizeGroupBooking('TEST-' + Math.floor(100000 + Math.random() * 900000)); }, 1200);
    }, 900);
    return;
  }

  fetch(OCULTT_API + '/payments/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId: b.id, type: 'group_magic', basePrice: b.basePrice, name: b.name, email: b.email, phone: b.phone, couponCode: _appliedCoupons.group ? _appliedCoupons.group.code : null })
  })
  .then(r => r.json())
  .then(order => {
    if (order.error) throw { ocultOrderError: true, message: order.error };
    if (payBtn) payBtn.textContent = 'Opening payment…';

    const options = {
      key:         order.keyId,
      order_id:    order.orderId,
      amount:      order.amount,
      currency:    order.currency,
      name:        'The Ocultt Tarot',
      description: b.package,
      prefill:     { name: b.name, email: b.email, contact: b.phone },
      notes:       { groupId: b.id },
      theme:       { color: '#2E8B6E' },
      modal: {
        ondismiss: function() {
          if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Registration →'; }
          groupRzpSetStatus('Payment cancelled. Click "Pay & Confirm Registration" to try again.', 'var(--text-muted)');
        }
      },
      handler: function(response) {
        groupRzpSetStatus('Verifying payment…', 'var(--text-muted)');
        fetch(OCULTT_API + '/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.id, service: 'Group Magic', package: b.package, preferredDate: b.preferredDate, name: b.name, email: b.email, phone: b.phone, intention: b.intention })
        })
        .then(r => { if (!r.ok) console.warn('[initiateGroupRazorpay] POST /bookings did not succeed (status ' + r.status + ') — payment will still be verified against the placeholder row created at order time, but the request\'s full details may not have saved. Check the CRM.'); })
        .then(() => fetch(OCULTT_API + '/payments/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            razorpay_order_id:   response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature:  response.razorpay_signature,
            bookingId: b.id,
            bookingType: 'group_magic'
          })
        }))
        .then(r => r.json())
        .then(result => {
          if (!result.success) throw new Error(result.error || 'Verification failed');
          groupRzpSetStatus('✓ Payment verified! Your registration is confirmed.', 'var(--sage)');
          setTimeout(function(){ finalizeGroupBooking(response.razorpay_payment_id); }, 1200);
        })
        .catch(err => {
          groupRzpSetStatus('✗ Payment verification failed: ' + err.message + '. Please contact support.', '#c0392b');
          if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Registration →'; }
        });
      }
    };

    try {
      const rzp = new Razorpay(options);
      rzp.on('payment.failed', function(response) {
        if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Registration →'; payBtn.onclick = function(){ initiateGroupRazorpay(); }; }
        groupRzpSetStatus('✗ Payment failed: ' + (response.error.description || 'Please try again.'), '#c0392b');
      });
      rzp.open();
    } catch(e) {
      if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Registration →'; }
      groupRzpSetStatus('Payment gateway could not be loaded. Please disable any ad-blockers and try again.', '#c0392b');
    }
  })
  .catch(err => {
    if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Registration →'; }
    if (err && err.ocultOrderError) {
      groupRzpSetStatus('✗ ' + err.message, '#c0392b');
    } else {
      groupRzpSetStatus('Could not connect to payment server. Please try again.', '#c0392b');
    }
    console.error('[initiateGroupRazorpay]', err);
  });
}

function submitNum(){
  const nameEl  = document.getElementById('n-name');
  const emailEl = document.getElementById('n-email');
  const phoneEl = document.getElementById('n-phone');
  const dobEl   = document.getElementById('n-dob');
  const name    = (nameEl?.value||'').trim();
  const email   = (emailEl?.value||'').trim();
  const phone   = (phoneEl?.value||'').trim();
  const dob     = (dobEl?.value||'').trim();
  ['n-name','n-email','n-phone','n-dob'].forEach(function(id){
    const f=document.getElementById(id); if(f)f.classList.remove('field-invalid');
    const e=document.getElementById(id+'-err'); if(e)e.classList.remove('is-visible');
  });
  _clearBanner('num-error');
  let hasError=false;
  if(!name){if(nameEl)nameEl.classList.add('field-invalid');const e=document.getElementById('n-name-err');if(e)e.classList.add('is-visible');hasError=true;}
  if(!email||!email.includes('@')){if(emailEl)emailEl.classList.add('field-invalid');const e=document.getElementById('n-email-err');if(e)e.classList.add('is-visible');hasError=true;}
  if(!dob){if(dobEl)dobEl.classList.add('field-invalid');const e=document.getElementById('n-dob-err');if(e)e.classList.add('is-visible');hasError=true;}
  if(!selectedNum){_showBanner('num-error','Please select a numerology package above before continuing');return;}
  if(hasError){
    _showBanner('num-error','Please fill in all required fields to continue');
    const firstErr=document.querySelector('#page-numerology-booking .field-invalid');
    if(firstErr)firstErr.scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }
  const id = 'ON-' + Math.floor(100000 + Math.random() * 900000);
  const basePrice = _extractPriceNumber(selectedNum);
  _pendingNumBooking = { id, service: 'Numerology', package: selectedNum, basePrice, name, email, phone, dob };

  renderNumPaymentView();
  swapStep('num-form-view', 'num-payment-view');
  window.scrollTo({top: 0, behavior: 'smooth'});
}

// ── Numerology payment step ─────────────────────────────────────────
let _pendingNumBooking = null;

function renderNumPaymentView(){
  const b = _pendingNumBooking;
  if (!b) return;
  const nameOnly = (b.package || '').replace(/\s*—\s*₹[\d,]+$/, '');
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText('num-pay-name', nameOnly || b.package || '—');
  setText('num-pay-total', formatPrice(b.basePrice));
  resetCoupon('num');
  refreshCouponDisplay('num');
  const payBtn = document.getElementById('num-rzp-pay-btn');
  if (payBtn) { payBtn.style.display = ''; payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; payBtn.onclick = function(){ payForNumBooking(); }; }
  const paypalContainer = document.getElementById('num-paypal-container');
  if (paypalContainer) { paypalContainer.style.display = 'none'; paypalContainer.innerHTML = ''; }
  const statusEl = document.getElementById('num-rzp-status-msg');
  if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
}

function backFromNumPayment(){
  swapStep('num-payment-view', 'num-form-view');
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function numRzpSetStatus(msg, color){
  const el = document.getElementById('num-rzp-status-msg');
  if (!el) return;
  el.style.display = 'block'; el.style.color = color; el.textContent = msg;
}

function finalizeNumBooking(b, paymentId){
  const finalBooking = {
    id: b.id, service: 'Numerology', package: b.package,
    price: formatPrice(b.basePrice),
    duration: '—', name: b.name, email: b.email, phone: b.phone, dob: b.dob, intention: '',
    paymentStatus: 'Paid', razorpayPaymentId: paymentId,
    date: 'TBC', time: 'TBC', status: 'Booking Received', createdAt: new Date().toISOString()
  };
  OculttDB.saveBooking(finalBooking);
  swapStep('num-payment-view', 'num-success-view');
  window.scrollTo({top: 0, behavior: 'smooth'});
  _pendingNumBooking = null;
}

function payForNumBooking(){
  const b = _pendingNumBooking;
  if (!b) return;
  if (window.OT_CURRENCY === 'USD') {
    initiatePayPalCheckout({
      bookingId: b.id, type: 'numerology', basePrice: b.basePrice,
      name: b.name, email: b.email, phone: b.phone,
      couponCode: _appliedCoupons.num ? _appliedCoupons.num.code : null,
      payBtnId: 'num-rzp-pay-btn', containerId: 'num-paypal-container',
      statusSetter: numRzpSetStatus,
      onApproved: function(paypalOrderId){
        fetch(OCULTT_API + '/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.id, service: 'Numerology', package: b.package, name: b.name, email: b.email, phone: b.phone, intention: b.dob ? ('DOB: ' + b.dob) : null })
        })
        .then(r => { if (!r.ok) console.warn('[payForNumBooking] POST /bookings did not succeed (status ' + r.status + ') — payment already verified against the placeholder row, but the request\'s full details may not have saved. Check the CRM.'); })
        .catch(() => {})
        .then(function(){ finalizeNumBooking(b, 'PAYPAL-' + paypalOrderId); });
      }
    });
  } else {
    initiateNumRazorpay();
  }
}

function initiateNumRazorpay(){
  const b = _pendingNumBooking;
  if (!b) return;
  const payBtn = document.getElementById('num-rzp-pay-btn');
  if (payBtn) { payBtn.disabled = true; payBtn.style.opacity = '0.5'; payBtn.textContent = 'Creating order…'; }

  if (TEST_MODE) {
    if (payBtn) payBtn.textContent = 'Simulating test payment…';
    numRzpSetStatus('TEST MODE — simulating payment, no real charge is made…', 'var(--gold)');
    setTimeout(function(){
      numRzpSetStatus('✓ TEST MODE — payment simulated, booking confirmed.', 'var(--sage)');
      setTimeout(function(){ finalizeNumBooking(b, 'TEST-' + Math.floor(100000 + Math.random() * 900000)); }, 1200);
    }, 900);
    return;
  }

  fetch(OCULTT_API + '/payments/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId: b.id, type: 'numerology', basePrice: b.basePrice, name: b.name, email: b.email, phone: b.phone, couponCode: _appliedCoupons.num ? _appliedCoupons.num.code : null })
  })
  .then(r => r.json())
  .then(order => {
    if (order.error) throw { ocultOrderError: true, message: order.error };
    if (payBtn) payBtn.textContent = 'Opening payment…';

    const options = {
      key:         order.keyId,
      order_id:    order.orderId,
      amount:      order.amount,
      currency:    order.currency,
      name:        'The Ocultt Tarot',
      description: b.package,
      prefill:     { name: b.name, email: b.email, contact: b.phone },
      notes:       { numId: b.id },
      theme:       { color: '#2E8B6E' },
      modal: {
        ondismiss: function() {
          if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
          numRzpSetStatus('Payment cancelled. Click "Pay & Confirm Booking" to try again.', 'var(--text-muted)');
        }
      },
      handler: function(response) {
        numRzpSetStatus('Verifying payment…', 'var(--text-muted)');
        fetch(OCULTT_API + '/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.id, service: 'Numerology', package: b.package, name: b.name, email: b.email, phone: b.phone, intention: b.dob ? ('DOB: ' + b.dob) : null })
        })
        .then(r => { if (!r.ok) console.warn('[initiateNumRazorpay] POST /bookings did not succeed (status ' + r.status + ') — payment will still be verified against the placeholder row created at order time, but the request\'s full details may not have saved. Check the CRM.'); })
        .then(() => fetch(OCULTT_API + '/payments/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            razorpay_order_id:   response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature:  response.razorpay_signature,
            bookingId: b.id,
            bookingType: 'numerology'
          })
        }))
        .then(r => r.json())
        .then(result => {
          if (!result.success) throw new Error(result.error || 'Verification failed');
          numRzpSetStatus('✓ Payment verified! Your booking is confirmed.', 'var(--sage)');
          setTimeout(function(){ finalizeNumBooking(b, response.razorpay_payment_id); }, 1200);
        })
        .catch(err => {
          numRzpSetStatus('✗ Payment verification failed: ' + err.message + '. Please contact support.', '#c0392b');
          if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
        });
      }
    };

    try {
      const rzp = new Razorpay(options);
      rzp.on('payment.failed', function(response) {
        if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; payBtn.onclick = function(){ initiateNumRazorpay(); }; }
        numRzpSetStatus('✗ Payment failed: ' + (response.error.description || 'Please try again.'), '#c0392b');
      });
      rzp.open();
    } catch(e) {
      if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
      numRzpSetStatus('Payment gateway could not be loaded. Please disable any ad-blockers and try again.', '#c0392b');
    }
  })
  .catch(err => {
    if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
    if (err && err.ocultOrderError) {
      numRzpSetStatus('✗ ' + err.message, '#c0392b');
    } else {
      numRzpSetStatus('Could not connect to payment server. Please try again.', '#c0392b');
    }
    console.error('[initiateNumRazorpay]', err);
  });
}

function showAdminTab(id,el){
  document.querySelectorAll('.admin-tab').forEach(t=>t.style.display='none');
  document.getElementById('admin-'+id).style.display='block';
  document.querySelectorAll('.admin-nav-item').forEach(n=>n.classList.remove('active'));
  el.classList.add('active');
  // Render live data whenever a tab is opened
  if(id==='bookings')  renderAdminBookings(true);
  if(id==='customers') renderAdminCustomers();
  if(id==='dashboard') { updateAdminGreeting(); renderDashboard(true); }
  if(id==='emailqueue') renderEmailQueue();
  if(id==='availability') renderAvailabilityBlocks();
  if(id==='spells') renderAdminSpells();
  if(id==='sessions') renderSessionHistory();
  if(id==='analytics') renderAnalytics();
  if(id==='coupons') renderCoupons();
}


// ── SCROLL REVEAL ──
function initReveal(){
  const els = document.querySelectorAll('.reveal,.reveal-left,.reveal-scale');
  if(!els.length) return;
  const io = new IntersectionObserver((entries)=>{
    entries.forEach(e=>{
      if(e.isIntersecting){e.target.classList.add('visible');io.unobserve(e.target);}
    });
  },{threshold:0.12,rootMargin:'0px 0px -40px 0px'});
  els.forEach(el=>io.observe(el));
  // Safety net: if an observer somehow never fires for an element still in
  // the DOM (slow devices, odd layout timing), force it visible rather than
  // leaving headings/content permanently invisible.
  setTimeout(()=>{
    els.forEach(el=>{ if(!el.classList.contains('visible')) el.classList.add('visible'); });
  }, 2500);
}
document.addEventListener('DOMContentLoaded', initReveal);
// ── JOURNEY SCROLL DOTS ──
function scrollJourney(idx){
  const row = document.getElementById('journeyScroll');
  if(!row) return;
  const cards = row.querySelectorAll('.jcard');
  if(!cards[idx]) return;
  row.scrollTo({left: cards[idx].offsetLeft - row.offsetLeft, behavior:'smooth'});
  document.querySelectorAll('#journeyDots .journey-dot').forEach((d,i)=>{
    d.classList.toggle('active', i===idx);
  });
}
// ── JOURNEY ARROW NAV (left/right buttons) ──
function journeyArrowNav(dir){
  const row = document.getElementById('journeyScroll');
  if(!row) return;
  const cards = row.querySelectorAll('.jcard');
  if(!cards.length) return;
  // Find currently-closest card to the scroll container's left edge
  let closest = 0, minD = Infinity;
  cards.forEach((c,i)=>{
    const d = Math.abs(c.getBoundingClientRect().left - row.getBoundingClientRect().left);
    if(d < minD){minD=d; closest=i;}
  });
  const next = Math.max(0, Math.min(cards.length-1, closest+dir));
  scrollJourney(next);
}
(function(){
  const row = document.getElementById('journeyScroll');
  if(!row) return;
  let ticking = false;
  row.addEventListener('scroll', function(){
    if(ticking) return; ticking = true;
    requestAnimationFrame(()=>{
      const cards = row.querySelectorAll('.jcard');
      let closest = 0, minD = Infinity;
      cards.forEach((c,i)=>{
        const d = Math.abs(c.getBoundingClientRect().left - row.getBoundingClientRect().left);
        if(d < minD){minD=d; closest=i;}
      });
      document.querySelectorAll('#journeyDots .journey-dot').forEach((d,i)=>{
        d.classList.toggle('active', i===closest);
      });
      ticking = false;
    });
  });
})();


// ── TRUST SCROLL DOTS (Carry Away) ──
function scrollTrust(idx){
  const row = document.getElementById('trustScroll');
  if (!row) return;
  const cards = row.querySelectorAll('.trust-pillar');
  if (!cards[idx]) return;
  row.scrollTo({left: cards[idx].offsetLeft - row.offsetLeft, behavior:'smooth'});
  document.querySelectorAll('#trustDots .trust-dot').forEach((d,i)=>{
    d.classList.toggle('active', i===idx);
  });
}
function trustArrowNav(dir){
  const row = document.getElementById('trustScroll');
  if (!row) return;
  const cards = row.querySelectorAll('.trust-pillar');
  if (!cards.length) return;
  let closest = 0, minD = Infinity;
  cards.forEach((c,i)=>{
    const d = Math.abs(c.getBoundingClientRect().left - row.getBoundingClientRect().left);
    if(d < minD){minD=d; closest=i;}
  });
  const next = Math.max(0, Math.min(cards.length-1, closest+dir));
  scrollTrust(next);
}
(function(){
  const row = document.getElementById('trustScroll');
  if (!row) return;
  let ticking = false;
  row.addEventListener('scroll', function(){
    if(ticking) return; ticking = true;
    requestAnimationFrame(()=>{
      const cards = row.querySelectorAll('.trust-pillar');
      let closest = 0, minD = Infinity;
      cards.forEach((c,i)=>{
        const d = Math.abs(c.getBoundingClientRect().left - row.getBoundingClientRect().left);
        if(d < minD){minD=d; closest=i;}
      });
      document.querySelectorAll('#trustDots .trust-dot').forEach((d,i)=>{
        d.classList.toggle('active', i===closest);
      });
      ticking = false;
    });
  });
})();


// ── v7 ENHANCED REVEAL ──
(function(){
  const els = document.querySelectorAll('.v7-reveal,.v7-reveal-l,.v7-reveal-r,.v7-reveal-scale,.reveal-up');
  if(!els.length) return;
  const io = new IntersectionObserver((entries)=>{
    entries.forEach(e=>{
      if(e.isIntersecting){
        e.target.classList.add('visible','vis');
        io.unobserve(e.target);
      }
    });
  },{threshold:0.1,rootMargin:'0px 0px -50px 0px'});
  els.forEach(el=>io.observe(el));
  // re-run on DOM ready in case called before content ready
  document.addEventListener('DOMContentLoaded',()=>els.forEach(el=>io.observe(el)));
  // Safety net: force visible after a short delay if still hidden
  setTimeout(()=>{
    els.forEach(el=>{ if(!el.classList.contains('visible')) el.classList.add('visible','vis'); });
  }, 2500);
})();

// ── NEWSLETTER SUBMIT ──
function handleNLSubmit(){
  const inp = document.getElementById('nl-email-input');
  const val = inp ? inp.value.trim() : '';
  if(!val || !val.includes('@')){
    inp && inp.focus();
    return;
  }
  inp.value = '';
  inp.placeholder = 'Thank you — the stars have your address ✦';
  setTimeout(()=>{if(inp)inp.placeholder='Your email address';},5000);
}

// ── FIX 4: TOAST NOTIFICATION ────────────────────────────────────────
// V27: 6s minimum visibility, slide-up entry, close button, smooth fade.
var _toastTimer = null;
function showToast(msg, duration) {
  var el    = document.getElementById('ocultt-toast');
  var msgEl = document.getElementById('ocultt-toast-msg');
  if (!el) return;
  // Enforce 9 second minimum so messages stay readable and don't vanish too quickly
  duration = (typeof duration === 'number' && duration > 9000) ? duration : 9000;
  if (msgEl) msgEl.textContent = msg;
  // Reset any running timer so repeated calls extend visibility
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  el.classList.add('toast-visible');
  _toastTimer = setTimeout(function() {
    el.classList.remove('toast-visible');
    _toastTimer = null;
  }, duration);
}
function closeToast() {
  var el = document.getElementById('ocultt-toast');
  if (el) el.classList.remove('toast-visible');
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
}

// ── FLOATING AI GUIDE (premium placeholder) ──
function toggleAiGuide(){
  const panel = document.getElementById('aiGuidePanel');
  const btn = document.getElementById('aiGuideBtn');
  if(!panel) return;
  const opening = !panel.classList.contains('open');
  panel.classList.toggle('open', opening);
  panel.setAttribute('aria-hidden', opening ? 'false' : 'true');
  if(btn) btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
  if(opening){
    // Move focus into the panel for keyboard/screen-reader users
    const closeBtn = panel.querySelector('.aig-close');
    if(closeBtn) setTimeout(()=>closeBtn.focus(), 50);
  } else if(btn){
    // Return focus to the trigger button when closing
    btn.focus();
  }
}
document.addEventListener('click', function(e){
  const panel = document.getElementById('aiGuidePanel');
  const btn = document.getElementById('aiGuideBtn');
  if(!panel || !panel.classList.contains('open')) return;
  if(!panel.contains(e.target) && !btn.contains(e.target)){
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden','true');
    if(btn) btn.setAttribute('aria-expanded','false');
  }
});
document.addEventListener('keydown', function(e){
  if(e.key !== 'Escape') return;
  const panel = document.getElementById('aiGuidePanel');
  const btn = document.getElementById('aiGuideBtn');
  if(!panel || !panel.classList.contains('open')) return;
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden','true');
  if(btn){ btn.setAttribute('aria-expanded','false'); btn.focus(); }
});

// ── ABOUT SECTION: Interactive Tarot Flip Card ──
const ABOUT_TAROT_CARDS = [
  {
    numeral:'XVIII', name:'The Moon', essence:'Intuition · Mystery · The Subconscious',
    meaning:'The Moon invites you to trust what you feel before you can explain it. Illusions fade as your inner knowing rises to meet the light.',
    guidance:'Trust your intuition today — the answer you seek is already within you.',
    svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22 6 C13 6 6 14 6 24 C6 34 13 42 22 42 C16 36 12 30 12 24 C12 18 16 12 22 6Z" fill="rgba(46,139,110,0.12)" stroke="var(--gold)" stroke-width="1"/><circle cx="22" cy="24" r="16" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.6" stroke-dasharray="2 4"/><path d="M22 44 L22 50 M16 50 L28 50" stroke="rgba(46,139,110,0.4)" stroke-width="0.8" stroke-linecap="round"/></svg>`
  },
  {
    numeral:'I', name:'The Magician', essence:'Manifestation · Willpower · Creation',
    meaning:'All the tools you need are already in your hands. The Magician asks you to act — to turn intention into reality through focused will.',
    guidance:'You have every tool you need. Take one focused step forward today.',
    svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22 48 L22 16" stroke="rgba(46,139,110,0.65)" stroke-width="1.2" stroke-linecap="round"/><path d="M16 10 C16 7 19 5 22 7 C25 9 25 11 22 11 C19 11 19 13 22 15 C25 17 28 15 28 12 C28 9 25 7 22 7" stroke="rgba(46,139,110,0.7)" stroke-width="0.9" fill="none"/><rect x="8" y="35" width="28" height="2" rx="1" fill="rgba(46,139,110,0.2)" stroke="rgba(46,139,110,0.35)" stroke-width="0.5"/><circle cx="22" cy="30" r="3" fill="none" stroke="rgba(46,139,110,0.45)" stroke-width="0.7"/></svg>`
  },
  {
    numeral:'X', name:'Wheel of Fortune', essence:'Cycles · Destiny · Change',
    meaning:'What turns must turn again. The Wheel reminds you that every ending seeds a new beginning — flow with the cycle, not against it.',
    guidance:'Embrace the change ahead — it is carrying you toward something better.',
    svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="22" cy="28" r="18" fill="none" stroke="rgba(46,139,110,0.4)" stroke-width="0.9"/><circle cx="22" cy="28" r="11" fill="none" stroke="rgba(46,139,110,0.3)" stroke-width="0.7"/><circle cx="22" cy="28" r="3.5" fill="none" stroke="rgba(46,139,110,0.45)" stroke-width="0.8"/><line x1="22" y1="10" x2="22" y2="16" stroke="rgba(46,139,110,0.35)" stroke-width="0.7"/><line x1="22" y1="40" x2="22" y2="46" stroke="rgba(46,139,110,0.35)" stroke-width="0.7"/></svg>`
  },
  {
    numeral:'XVII', name:'The Star', essence:'Hope · Renewal · Healing',
    meaning:'After the storm, The Star pours quiet healing back into your life. Have faith — what feels broken is already mending in the dark.',
    guidance:'Hold onto hope. Healing is happening even when you cannot see it yet.',
    svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg"><polygon points="22,8 25,18 36,18 27,24 30,34 22,28 14,34 17,24 8,18 19,18" stroke="rgba(46,139,110,0.6)" stroke-width="0.9" fill="rgba(46,139,110,0.1)"/><path d="M10 44 C14 40 30 40 34 44" stroke="rgba(46,139,110,0.3)" stroke-width="0.7" fill="none"/></svg>`
  },
  {
    numeral:'XIX', name:'The Sun', essence:'Vitality · Joy · Clarity',
    meaning:'The fog has lifted. The Sun marks a season of warmth, success and plain-sight truth — enjoy the clarity you have earned.',
    guidance:'Let yourself feel joy fully today — you have earned this clarity.',
    svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="22" cy="24" r="10" fill="none" stroke="rgba(46,139,110,0.55)" stroke-width="1"/><line x1="22" y1="4" x2="22" y2="8" stroke="rgba(46,139,110,0.5)" stroke-width="0.9" stroke-linecap="round"/><line x1="22" y1="40" x2="22" y2="44" stroke="rgba(46,139,110,0.5)" stroke-width="0.9" stroke-linecap="round"/><line x1="2" y1="24" x2="6" y2="24" stroke="rgba(46,139,110,0.5)" stroke-width="0.9" stroke-linecap="round"/><line x1="38" y1="24" x2="42" y2="24" stroke="rgba(46,139,110,0.5)" stroke-width="0.9" stroke-linecap="round"/></svg>`
  },
  {
    numeral:'VIII', name:'Strength', essence:'Courage · Compassion · Inner Power',
    meaning:'True strength is gentle. You are being asked to meet a challenge not with force, but with quiet courage and a soft, steady heart.',
    guidance:'Meet today\'s challenge gently. Your quiet courage is enough.',
    svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22 8 C30 8 34 18 30 26 C34 30 32 38 24 40" stroke="rgba(46,139,110,0.55)" stroke-width="1" fill="none"/><circle cx="20" cy="22" r="9" fill="none" stroke="rgba(46,139,110,0.4)" stroke-width="0.8"/><path d="M8 44 C14 40 28 40 34 46" stroke="rgba(46,139,110,0.3)" stroke-width="0.7" fill="none"/></svg>`
  },
  {
    numeral:'III', name:'The Empress', essence:'Abundance · Nurturing · Growth',
    meaning:'Life is ready to flourish around you. The Empress brings fertile ground for new ideas, relationships, and creative work to take root.',
    guidance:'Nurture what you\'re growing — it is closer to blooming than you think.',
    svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="22" cy="18" r="7" fill="none" stroke="rgba(46,139,110,0.5)" stroke-width="0.9"/><path d="M22 25 C14 30 12 40 14 48 M22 25 C30 30 32 40 30 48" stroke="rgba(46,139,110,0.4)" stroke-width="0.8" fill="none"/><path d="M10 46 Q22 40 34 46" stroke="rgba(46,139,110,0.3)" stroke-width="0.7" fill="none"/></svg>`
  },
  {
    numeral:'XXI', name:'The World', essence:'Completion · Wholeness · Arrival',
    meaning:'A cycle closes with grace. The World marks the fulfillment of something long worked toward — pause here and let yourself feel proud.',
    guidance:'Celebrate how far you\'ve come before starting the next chapter.',
    svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="22" cy="28" rx="15" ry="20" fill="none" stroke="rgba(46,139,110,0.45)" stroke-width="0.9"/><ellipse cx="22" cy="28" rx="15" ry="20" fill="none" stroke="rgba(46,139,110,0.25)" stroke-width="0.6" stroke-dasharray="2 3" transform="rotate(90 22 28)"/><circle cx="22" cy="28" r="3" fill="rgba(46,139,110,0.2)" stroke="rgba(46,139,110,0.4)" stroke-width="0.6"/></svg>`
  },
  {
    numeral:'Ace', name:'Ace of Cups', essence:'New Love · Emotional Renewal · Openness',
    meaning:'A fresh wave of feeling is entering your life — love, connection, or a renewed relationship with yourself. Let your heart stay open.',
    guidance:'Stay open-hearted. A new emotional beginning is arriving for you.',
    svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 20 C14 30 14 38 22 38 C30 38 30 30 30 20" stroke="rgba(46,139,110,0.55)" stroke-width="1" fill="none"/><ellipse cx="22" cy="20" rx="8" ry="3" fill="none" stroke="rgba(46,139,110,0.45)" stroke-width="0.8"/><line x1="22" y1="38" x2="22" y2="46" stroke="rgba(46,139,110,0.4)" stroke-width="0.8"/><line x1="15" y1="46" x2="29" y2="46" stroke="rgba(46,139,110,0.4)" stroke-width="0.8"/></svg>`
  },
  {
    numeral:'XIV', name:'Temperance', essence:'Balance · Patience · Harmony',
    meaning:'Slow, steady blending brings the best results now. Temperance asks for patience — the right balance is already forming, one measured step at a time.',
    guidance:'Slow down and find balance — patience will serve you well today.',
    svg:`<svg width="44" height="56" viewBox="0 0 44 56" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 16 L16 40" stroke="rgba(46,139,110,0.45)" stroke-width="0.9"/><path d="M32 16 L28 40" stroke="rgba(46,139,110,0.45)" stroke-width="0.9"/><path d="M12 24 Q22 18 32 24" stroke="rgba(46,139,110,0.35)" stroke-width="0.8" fill="none"/><circle cx="22" cy="28" r="4" fill="none" stroke="rgba(46,139,110,0.4)" stroke-width="0.7"/></svg>`
  }
];

function renderAboutCard(idx, skipFlipReset){
  const card = ABOUT_TAROT_CARDS[idx];
  if(!card) return;
  document.getElementById('aboutCardNumeral').textContent = card.numeral;
  document.getElementById('aboutCardName').textContent = card.name;
  document.getElementById('aboutCardNameBack').textContent = card.name;
  document.getElementById('aboutCardNumeralBack').textContent = card.numeral;
  document.getElementById('aboutCardMeaning').textContent = card.meaning;
  document.getElementById('aboutCardGuidance').textContent = card.guidance || '';
  document.getElementById('aboutCardSvg').innerHTML = card.svg;
  document.getElementById('aboutCardSvgBack').innerHTML = card.svg;
  if(!skipFlipReset){
    const inner = document.getElementById('aboutTflip');
    if(inner) inner.classList.remove('flipped');
  }
}

// ── Soft-login daily card: same card all day for this browser, new (different) one tomorrow ──
function getDailyCardIndex(){
  const key = 'ocultt_daily_card_v1';
  const today = new Date().toISOString().slice(0,10); // YYYY-MM-DD, local browser date
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(key) || 'null'); } catch(e) { stored = null; }
  if (stored && stored.date === today && typeof stored.idx === 'number' && stored.idx < ABOUT_TAROT_CARDS.length) {
    return { idx: stored.idx, isNewToday: false };
  }
  const prevIdx = stored ? stored.idx : -1;
  let idx;
  do { idx = Math.floor(Math.random() * ABOUT_TAROT_CARDS.length); }
  while (ABOUT_TAROT_CARDS.length > 1 && idx === prevIdx);
  try { localStorage.setItem(key, JSON.stringify({ date: today, idx })); } catch(e) {}
  return { idx, isNewToday: true };
}

// ── ABOUT STATS: count-up animation on scroll into view ──
// ── TESTIMONIALS: duplicate cards once for a seamless infinite marquee ──
(function initTestimonialsMarquee(){
  const track = document.getElementById('testimonialsTrack');
  const marquee = document.getElementById('testimonialsMarquee');
  if(!track || !marquee) return;

  const originalCards = Array.from(track.children);
  originalCards.forEach(card=>{
    const clone = card.cloneNode(true);
    clone.setAttribute('aria-hidden','true');
    clone.classList.remove('reveal','reveal-delay-1','reveal-delay-2','reveal-delay-3','reveal-delay-4');
    track.appendChild(clone);
  });

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const speedPxPerSec = 32; // auto-scroll speed
  let pos = 0;              // current translateX, always <= 0
  let hoverPaused = false;  // true while a mouse is actively hovering (desktop)
  let touchPausedUntil = 0; // timestamp; briefly pauses after a touch, then auto-resumes (mobile)
  let singleSetWidth = 0;

  function measure(){
    const gap = parseFloat(getComputedStyle(track).gap) || 0;
    singleSetWidth = originalCards.reduce((sum, card) => sum + card.getBoundingClientRect().width + gap, 0);
  }
  measure();
  window.addEventListener('resize', measure);

  function apply(px){
    track.style.transform = `translateX(${px}px)`;
  }

  // Desktop: real hover works fine with enter/leave
  marquee.addEventListener('mouseenter', ()=>{ hoverPaused = true; });
  marquee.addEventListener('mouseleave', ()=>{ hoverPaused = false; });

  // Mobile/touch: 'mouseleave' is unreliable after a tap (can leave the scroll stuck
  // paused forever), so touches get a timed pause that auto-resumes instead.
  marquee.addEventListener('touchstart', ()=>{ touchPausedUntil = Date.now() + 2500; }, {passive:true});

  // ── Manual scroll: drag/swipe left-right, and wheel/trackpad ──
  function wrapPos(p){
    if(singleSetWidth <= 0) return p;
    while(p > 0) p -= singleSetWidth;
    while(p <= -singleSetWidth) p += singleSetWidth;
    return p;
  }
  let isDragging = false, dragStartX = 0, dragStartPos = 0;
  marquee.addEventListener('pointerdown', (e)=>{
    isDragging = true;
    dragStartX = e.clientX;
    dragStartPos = pos;
    hoverPaused = true;
    if(marquee.setPointerCapture){ try{ marquee.setPointerCapture(e.pointerId); }catch(err){} }
  });
  marquee.addEventListener('pointermove', (e)=>{
    if(!isDragging) return;
    pos = wrapPos(dragStartPos + (e.clientX - dragStartX));
    apply(pos);
  });
  function endDrag(){
    if(!isDragging) return;
    isDragging = false;
    hoverPaused = false;
    touchPausedUntil = Date.now() + 1200;
  }
  marquee.addEventListener('pointerup', endDrag);
  marquee.addEventListener('pointercancel', endDrag);
  marquee.addEventListener('pointerleave', endDrag);
  marquee.addEventListener('wheel', (e)=>{
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    if(delta === 0) return;
    e.preventDefault();
    pos = wrapPos(pos - delta);
    apply(pos);
    touchPausedUntil = Date.now() + 1200;
  }, {passive:false});

  if(reduceMotion){
    marquee.style.overflowX = 'auto';
    return;
  }

  let lastTime = null;
  function tick(now){
    if(lastTime === null) lastTime = now;
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    const paused = hoverPaused || Date.now() < touchPausedUntil;
    if(!paused && singleSetWidth > 0){
      pos -= speedPxPerSec * dt;
      if(pos <= -singleSetWidth) pos += singleSetWidth;
      apply(pos);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

(function initStatsCounter(){
  const row = document.getElementById('aboutStatsRow');
  if(!row) return;
  const nums = row.querySelectorAll('.stat-num[data-count-target]');
  if(!nums.length) return;
  let played = false;
  function formatVal(val, el){
    const decimals = parseInt(el.dataset.countDecimal || '0', 10);
    let str = val.toFixed(decimals);
    if(el.dataset.countFormat === 'comma'){
      const parts = str.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      str = parts.join('.');
    }
    return str + (el.dataset.countSuffix || '');
  }
  function animateOne(el){
    const target = parseFloat(el.dataset.countTarget);
    const duration = 1600;
    const start = performance.now();
    function tick(now){
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.textContent = formatVal(target * eased, el);
      if(p < 1) requestAnimationFrame(tick);
      else el.textContent = formatVal(target, el);
    }
    requestAnimationFrame(tick);
  }
  function playAll(){
    if(played) return;
    played = true;
    nums.forEach(animateOne);
  }
  if('IntersectionObserver' in window){
    const io = new IntersectionObserver((entries)=>{
      entries.forEach(entry=>{ if(entry.isIntersecting) playAll(); });
    }, {threshold:0.4});
    io.observe(row);
  } else {
    playAll();
  }
})();

// ── Draw a Card: shuffle → draw (random cycle) → reveal state machine ──
let _drawState = 'idle'; // idle | shuffling | drawing | drawn | revealed
let _dailyCardIdx = 0;

function setDrawCaption(text){
  const cap = document.getElementById('aboutTflipCaption');
  if(cap) cap.textContent = text;
}

function initDrawCard(){
  const el = document.getElementById('aboutTflip');
  if(!el) return;
  const { idx, isNewToday } = getDailyCardIndex();
  _dailyCardIdx = idx;

  if (isNewToday) {
    _drawState = 'idle';
    document.getElementById('aboutCardNumeral').textContent = '✦';
    document.getElementById('aboutCardName').textContent = 'Tap to Shuffle';
    document.getElementById('aboutCardSvg').innerHTML = '';
    setDrawCaption('Tap to shuffle & draw your card for today');
  } else {
    renderAboutCard(_dailyCardIdx, true);
    _drawState = 'drawn';
    setDrawCaption('Tap to reveal its meaning');
  }
}

function handleCardClick(){
  const el = document.getElementById('aboutTflip');
  if(!el) return;
  if (_drawState === 'idle') {
    playShuffleThenDraw();
  } else if (_drawState === 'drawn') {
    el.classList.add('flipped');
    _drawState = 'revealed';
    setDrawCaption('Your card for today ✦');
  } else if (_drawState === 'revealed') {
    el.classList.toggle('flipped');
    setDrawCaption(el.classList.contains('flipped') ? 'Your card for today ✦' : 'Tap to reveal its meaning');
  }
  // Clicks are ignored mid-animation (shuffling / drawing)
}

function playShuffleThenDraw(){
  const el = document.getElementById('aboutTflip');
  const frame = document.querySelector('.draw-card-visual .about-frame');
  _drawState = 'shuffling';
  el.classList.add('shuffling');
  if (frame) frame.classList.add('is-shuffling');
  setDrawCaption('Shuffling the deck…');

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Even with reduced motion, keep the shuffle on screen long enough (a few
  // interval ticks) to actually be visible — 400ms was so short it read as
  // "no shuffle happened" on devices/browsers with this preference set.
  const shuffleDuration = reduceMotion ? 900 : 3000;

  const shuffleInterval = setInterval(() => {
    const randIdx = Math.floor(Math.random() * ABOUT_TAROT_CARDS.length);
    document.getElementById('aboutCardNumeral').textContent = ABOUT_TAROT_CARDS[randIdx].numeral;
  }, 160);

  setTimeout(() => {
    clearInterval(shuffleInterval);
    el.classList.remove('shuffling');
    if (frame) frame.classList.remove('is-shuffling');
    playDrawCycle();
  }, shuffleDuration);
}

function playDrawCycle(){
  const el = document.getElementById('aboutTflip');
  _drawState = 'drawing';
  el.classList.add('drawing');
  setDrawCaption('Drawing your card…');

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const totalCycles = reduceMotion ? 5 : 14;
  let cycles = 0;

  const cycleInterval = setInterval(() => {
    cycles++;
    const randIdx = Math.floor(Math.random() * ABOUT_TAROT_CARDS.length);
    document.getElementById('aboutCardNumeral').textContent = ABOUT_TAROT_CARDS[randIdx].numeral;
    document.getElementById('aboutCardName').textContent = ABOUT_TAROT_CARDS[randIdx].name;
    document.getElementById('aboutCardSvg').innerHTML = ABOUT_TAROT_CARDS[randIdx].svg;
    if (cycles >= totalCycles) {
      clearInterval(cycleInterval);
      el.classList.remove('drawing');
      renderAboutCard(_dailyCardIdx, true);
      _drawState = 'drawn';
      setDrawCaption('Tap to reveal its meaning');
    }
  }, 90);
}

if(document.getElementById('aboutTflip')){
  initDrawCard();
}

generateStars();
generateFloatingCards();
initReveal();

// ════════════════════════════════════════════════════════════════════
// V23 — ACCORDION: Reading selection on mobile (≤600px only)
// Converts the 5 reading cards into a tap-to-expand accordion.
// Desktop grid is completely unaffected.
// ════════════════════════════════════════════════════════════════════
(function(){
  'use strict';

  var MOBILE_BP = 600; // px — matches the CSS breakpoint

  function isMobile(){ return window.innerWidth <= MOBILE_BP; }

  // Build accordion markup inside the reading-selection grid
  function buildAccordion(grid){
    if(!grid || grid.classList.contains('v23-accordion')) return;
    grid.classList.add('v23-accordion');

    Array.prototype.forEach.call(
      grid.querySelectorAll('.service-select-card'),
      function(card){
        // Pull data from existing DOM
        var eyebrowEl = card.querySelector('.sc-eyebrow');
        var titleEl   = card.querySelector('h3');
        var descEl    = card.querySelector('p');
        var tagsEl    = card.querySelector('.sc-tags');

        var eyebrow = eyebrowEl ? eyebrowEl.textContent.trim() : '';
        var title   = titleEl   ? titleEl.textContent.trim()   : '';
        var desc    = descEl    ? descEl.innerHTML              : '';
        var tagsHTML = '';
        if(tagsEl){
          tagsHTML = '<div class="v23-acc-tags">';
          Array.prototype.forEach.call(
            tagsEl.querySelectorAll('.sc-tag'),
            function(tag){
              tagsHTML += '<span class="sc-tag">' + tag.textContent + '</span>';
            }
          );
          tagsHTML += '</div>';
        }

        // Header
        var hdr = document.createElement('div');
        hdr.className = 'v23-acc-hdr';
        hdr.innerHTML =
          '<div class="v23-acc-check">✓</div>' +
          '<div class="v23-acc-labels">' +
            '<span class="v23-acc-sub">' + eyebrow + '</span>' +
            '<span class="v23-acc-title">' + title + '</span>' +
          '</div>' +
          '<span class="v23-acc-arrow">▾</span>';

        // Body
        var body = document.createElement('div');
        body.className = 'v23-acc-body';
        body.innerHTML = '<p class="v23-acc-desc">' + desc + '</p>' + tagsHTML;

        card.appendChild(hdr);
        card.appendChild(body);

        // Tap: toggle this card, collapse others, call selectReading
        hdr.addEventListener('click', function(){
          var wasOpen = body.classList.contains('is-open');

          // Collapse all
          Array.prototype.forEach.call(
            grid.querySelectorAll('.v23-acc-body'), function(b){ b.classList.remove('is-open'); }
          );
          Array.prototype.forEach.call(
            grid.querySelectorAll('.v23-acc-arrow'), function(a){ a.classList.remove('is-open'); }
          );

          // Open this one if it was closed
          if(!wasOpen){
            body.classList.add('is-open');
            hdr.querySelector('.v23-acc-arrow').classList.add('is-open');
          }

          // Trigger original onclick (selectReading)
          var fn = card.getAttribute('onclick');
          if(fn){ try{ (new Function(fn))(); }catch(e){} }
        });
      }
    );
  }

  // Teardown: remove accordion markup and class
  function destroyAccordion(grid){
    if(!grid || !grid.classList.contains('v23-accordion')) return;
    grid.classList.remove('v23-accordion');
    Array.prototype.forEach.call(
      grid.querySelectorAll('.v23-acc-hdr, .v23-acc-body'),
      function(el){ el.parentNode && el.parentNode.removeChild(el); }
    );
  }

  // Target: only the tarot booking reading-selection grid
  function getGrid(){
    return document.querySelector('#tarot-step-1 .service-select-grid');
  }

  function applyOrRemove(){
    var grid = getGrid();
    if(!grid) return;
    if(isMobile()){ buildAccordion(grid); }
    else { destroyAccordion(grid); }
  }

  // Hook into showPage so accordion is built whenever the tarot page opens
  var _origShowPage = window.showPage;
  if(typeof _origShowPage === 'function'){
    window.showPage = function(id){
      _origShowPage(id);
      if(id === 'tarot-booking') setTimeout(applyOrRemove, 60);
    };
  }

  // Run on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(applyOrRemove, 120);
  });

  // Re-check on resize (debounced)
  var _resizeTimer;
  window.addEventListener('resize', function(){
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(applyOrRemove, 200);
  });

})();

// ════════════════════════════════════════════════════════════════════
// OCULTT DB — Persistent booking storage (localStorage)
// ════════════════════════════════════════════════════════════════════
const OculttDB = (() => {
  const BOOKINGS_KEY = 'ocultt_bookings_v1';
  const CUSTOMERS_KEY = 'ocultt_customers_v1';
  const AVAILABILITY_KEY = 'ocultt_availability_blocks_v1';
  const SESSION_NOTES_KEY = 'ocultt_session_notes_v1';
  const ATTACHMENTS_KEY = 'ocultt_customer_attachments_v1';
  const FOLLOWUP_KEY = 'ocultt_followups_v1';
  const BOOKING_NOTES_KEY = 'ocultt_booking_notes_v1';
  const CUSTOMER_NOTES_KEY = 'ocultt_customer_notes_v1';
  const ACTIVITY_KEY = 'ocultt_activity_log_v1';

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); }
    catch(e) { return []; }
  }
  function save(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); } catch(e){}
  }

  function logActivity(entry) {
    const log = load(ACTIVITY_KEY);
    log.push({
      id: 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
      bookingId: entry.bookingId || null,
      email: (entry.email || '').toLowerCase(),
      type: entry.type,     // 'created' | 'status' | 'note' | 'attachment' | 'stage'
      label: entry.label,
      at: entry.at || new Date().toISOString()
    });
    save(ACTIVITY_KEY, log);
  }
  // Pass { bookingId } for a single booking's timeline, or { email } for everything
  // across a customer's bookings (used by the Customer Profile activity feed).
  function getActivity(filter) {
    const log = load(ACTIVITY_KEY);
    if (filter && filter.bookingId) return log.filter(a => a.bookingId === filter.bookingId);
    if (filter && filter.email) return log.filter(a => a.email === (filter.email||'').toLowerCase());
    return log;
  }

  function saveBooking(booking) {
    const bookings = load(BOOKINGS_KEY);
    const existingIdx = booking.id ? bookings.findIndex(b => b.id === booking.id) : -1;
    if (existingIdx > -1) {
      // Update in place — this is an edit to an existing booking (e.g. status change),
      // not a new one. Must NOT re-count it against the customer's session total.
      const prevStatus = bookings[existingIdx].status;
      bookings[existingIdx] = { ...bookings[existingIdx], ...booking };
      if (booking.status && booking.status !== prevStatus) {
        logActivity({ bookingId: booking.id, email: bookings[existingIdx].email, type: 'status',
          label: `Status changed to "${booking.status}"` + (prevStatus ? ` (from "${prevStatus}")` : '') });
      }
    } else {
      bookings.unshift(booking); // genuinely new booking — newest first
      upsertCustomer(booking);
      logActivity({ bookingId: booking.id, email: booking.email, type: 'created',
        label: `Booking created — ${booking.service||'Service'}${booking.package ? ' ('+booking.package+')' : ''}`,
        at: booking.createdAt });
    }
    save(BOOKINGS_KEY, bookings);
    // Always refresh dashboard stats; refresh tables only if their tab is visible
    renderDashboard();
    const bTab = document.getElementById('admin-bookings');
    if (bTab && bTab.style.display !== 'none') renderAdminBookings();
    const cTab = document.getElementById('admin-customers');
    if (cTab && cTab.style.display !== 'none') renderAdminCustomers();
  }

  function upsertCustomer(booking) {
    if (!booking.email) return;
    const customers = load(CUSTOMERS_KEY);
    const idx = customers.findIndex(c => c.email.toLowerCase() === booking.email.toLowerCase());
    // If the currently signed-in Google account matches this booking's email,
    // carry its uid/picture onto the customer record — covers signing in
    // before ever booking, complementing linkCustomerAccount() above.
    let authExtra = {};
    try {
      const authUser = getCurrentAuthUser ? getCurrentAuthUser() : null;
      if (authUser && authUser.email && authUser.email.toLowerCase() === booking.email.toLowerCase()) {
        authExtra = { uid: authUser.uid || '', picture: authUser.picture || '', accountLinked: true };
      }
    } catch(e) {}
    if (idx === -1) {
      customers.push({
        name: booking.name,
        email: booking.email,
        phone: booking.phone || '',
        services: [booking.service],
        sessions: 1,
        lastBooking: booking.createdAt,
        status: 'New',
        firstSeen: booking.createdAt,
        ...authExtra
      });
    } else {
      const c = customers[idx];
      c.sessions = (c.sessions || 0) + 1;
      c.lastBooking = booking.createdAt;
      if (!c.services.includes(booking.service)) c.services.push(booking.service);
      c.status = c.sessions >= 5 ? 'VIP' : c.sessions >= 2 ? 'Active' : 'New';
      c.phone = booking.phone || c.phone;
      Object.assign(c, authExtra);
      customers[idx] = c;
    }
    save(CUSTOMERS_KEY, customers);
  }

  // Newest booking first, everywhere this is used across the CRM — a
  // booking made today should always appear above yesterday's, which
  // appears above older ones, regardless of the order they happened to
  // sync/load in from the database.
  function getBookings() {
    return load(BOOKINGS_KEY).slice().sort((a, b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));
  }
  function getCustomers() { return load(CUSTOMERS_KEY); }
  function clearBookings() { save(BOOKINGS_KEY, []); save(CUSTOMERS_KEY, []); }

  // ── Availability blocks ──
  // Each block: { id, type: 'full-day'|'date-range'|'time-slots', startDate, endDate, times: [], note }
  function getAvailabilityBlocks() { return load(AVAILABILITY_KEY); }

  function addAvailabilityBlock(block) {
    const blocks = load(AVAILABILITY_KEY);
    block.id = 'blk_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
    block.createdAt = new Date().toISOString();
    blocks.push(block);
    save(AVAILABILITY_KEY, blocks);
    return block;
  }

  function removeAvailabilityBlock(id) {
    const blocks = load(AVAILABILITY_KEY).filter(b => b.id !== id);
    save(AVAILABILITY_KEY, blocks);
  }

  // Returns { fullyBlockedDates: Set('YYYY-MM-DD'), blockedTimesByDate: Map('YYYY-MM-DD' -> Set(times)) }
  function getAvailabilityIndex() {
    const blocks = load(AVAILABILITY_KEY);
    const fullyBlockedDates = new Set();
    const blockedTimesByDate = {};
    const toISO = d => {
      const yy = d.getFullYear(), mm = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
      return `${yy}-${mm}-${dd}`;
    };
    blocks.forEach(b => {
      if (!b.startDate) return;
      const start = new Date(b.startDate + 'T00:00:00');
      const end = b.endDate ? new Date(b.endDate + 'T00:00:00') : start;
      for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
        const iso = toISO(d);
        if (b.type === 'time-slots' && Array.isArray(b.times) && b.times.length) {
          blockedTimesByDate[iso] = blockedTimesByDate[iso] || new Set();
          b.times.forEach(t => blockedTimesByDate[iso].add(t));
        } else {
          fullyBlockedDates.add(iso);
        }
      }
    });
    return { fullyBlockedDates, blockedTimesByDate };
  }

  // ── Session notes (manual summary Akanksha writes after each session) ──
  // Stored as { [bookingId]: { text, updatedAt } }
  function getSessionNote(bookingId) {
    const all = load(SESSION_NOTES_KEY);
    const map = Array.isArray(all) ? {} : all; // guard against old array shape
    return map[bookingId] || null;
  }
  function saveSessionNote(bookingId, text) {
    let all = load(SESSION_NOTES_KEY);
    if (Array.isArray(all)) all = {}; // guard against old array shape
    if (text && text.trim()) {
      all[bookingId] = { text: text.trim(), updatedAt: new Date().toISOString() };
    } else {
      delete all[bookingId]; // empty text clears the note
    }
    save(SESSION_NOTES_KEY, all);
  }

  // ── Attachments (data structure only — no real upload backend yet) ──
  // Stored as { [email]: { audio: [], video: [], images: [], reports: [] } }
  // Each entry, once real upload exists, would hold { name, url, uploadedAt }.
  function getCustomerAttachments(email) {
    const all = load(ATTACHMENTS_KEY);
    const map = Array.isArray(all) ? {} : all;
    const key = (email || '').toLowerCase();
    return map[key] || { audio: [], video: [], images: [], reports: [] };
  }
  function saveCustomerAttachment(email, category, fileMeta) {
    let all = load(ATTACHMENTS_KEY);
    if (Array.isArray(all)) all = {};
    const key = (email || '').toLowerCase();
    if (!all[key]) all[key] = { audio: [], video: [], images: [], reports: [] };
    if (!all[key][category]) all[key][category] = [];
    all[key][category].push(fileMeta);
    save(ATTACHMENTS_KEY, all);
  }
  // Patches one attachment's metadata in place — used to record the
  // server-side (Cloudinary) attachment id onto a local file entry once
  // its background upload to the booking's real attachments_json
  // completes, so removing it locally can also clean it up server-side.
  function patchCustomerAttachment(email, category, fileId, patch) {
    let all = load(ATTACHMENTS_KEY);
    if (Array.isArray(all)) all = {};
    const key = (email || '').toLowerCase();
    if (!all[key] || !all[key][category]) return;
    const idx = all[key][category].findIndex(f => f.id === fileId);
    if (idx === -1) return;
    all[key][category][idx] = { ...all[key][category][idx], ...patch };
    save(ATTACHMENTS_KEY, all);
  }
  function removeCustomerAttachment(email, category, fileId) {
    let all = load(ATTACHMENTS_KEY);
    if (Array.isArray(all)) all = {};
    const key = (email || '').toLowerCase();
    if (!all[key] || !all[key][category]) return;
    all[key][category] = all[key][category].filter(f => f.id !== fileId);
    save(ATTACHMENTS_KEY, all);
  }
  function renameCustomerAttachment(email, category, fileId, newName) {
    let all = load(ATTACHMENTS_KEY);
    if (Array.isArray(all)) all = {};
    const key = (email || '').toLowerCase();
    if (!all[key] || !all[key][category]) return;
    const f = all[key][category].find(f => f.id === fileId);
    if (f) f.name = newName;
    save(ATTACHMENTS_KEY, all);
  }

  // ── Edit existing customer record in place (no duplication) ──
  function updateCustomer(email, updates) {
    const customers = load(CUSTOMERS_KEY);
    const idx = customers.findIndex(c => (c.email||'').toLowerCase() === (email||'').toLowerCase());
    if (idx > -1) {
      customers[idx] = { ...customers[idx], ...updates };
      save(CUSTOMERS_KEY, customers);
    }
    return idx > -1 ? customers[idx] : null;
  }

  // ── Follow-up reminders (one per customer, keyed by email) ──
  function getFollowUp(email) {
    const all = load(FOLLOWUP_KEY);
    const map = Array.isArray(all) ? {} : all;
    return map[(email||'').toLowerCase()] || null;
  }
  function saveFollowUp(email, date, note) {
    let all = load(FOLLOWUP_KEY);
    if (Array.isArray(all)) all = {};
    const key = (email||'').toLowerCase();
    const prev = all[key];
    const prevHistory = (prev && Array.isArray(prev.history)) ? prev.history : [];
    // Archive the previous follow-up (if any) into history before overwriting
    const history = (prev && prev.date) ? [...prevHistory, { date: prev.date, note: prev.note || '', setAt: prev.setAt }] : prevHistory;
    if (date) {
      all[key] = { date, note: note || '', setAt: new Date().toISOString(), history };
    } else {
      delete all[key];
    }
    save(FOLLOWUP_KEY, all);
  }

  // ── Booking Notes (internal, per booking — distinct from Session Summary) ──
  function getBookingNotes(bookingId) {
    const all = load(BOOKING_NOTES_KEY);
    const map = Array.isArray(all) ? {} : all;
    const entry = map[bookingId];
    // Migrate old single-note shape ({text, updatedAt}) to a list transparently
    if (entry && !Array.isArray(entry)) return [{ text: entry.text, author: 'Admin', at: entry.updatedAt }];
    return entry || [];
  }
  function addBookingNote(bookingId, text) {
    if (!text || !text.trim()) return;
    let all = load(BOOKING_NOTES_KEY);
    if (Array.isArray(all)) all = {};
    const existing = getBookingNotes(bookingId);
    existing.push({ text: text.trim(), author: 'Admin', at: new Date().toISOString() });
    all[bookingId] = existing;
    save(BOOKING_NOTES_KEY, all);
    const owner = load(BOOKINGS_KEY).find(b => b.id === bookingId);
    logActivity({ bookingId, email: owner ? owner.email : '', type: 'note', label: 'Internal note added' });
  }

  // ── Customer Notes (general, per customer — not tied to any single booking) ──
  function getCustomerNotes(email) {
    const all = load(CUSTOMER_NOTES_KEY);
    const map = Array.isArray(all) ? {} : all;
    const key = (email||'').toLowerCase();
    const entry = map[key];
    if (entry && !Array.isArray(entry)) return [{ text: entry.text, author: 'Admin', at: entry.updatedAt }];
    return entry || [];
  }
  function addCustomerNote(email, text) {
    if (!text || !text.trim()) return;
    let all = load(CUSTOMER_NOTES_KEY);
    if (Array.isArray(all)) all = {};
    const key = (email||'').toLowerCase();
    const existing = getCustomerNotes(email);
    existing.push({ text: text.trim(), author: 'Admin', at: new Date().toISOString() });
    all[key] = existing;
    save(CUSTOMER_NOTES_KEY, all);
    logActivity({ bookingId: null, email, type: 'note', label: 'Customer note added' });
  }

  // ── Link a signed-in Google account to an existing customer record ──
  // Called on every successful sign-in. If no booking exists yet for this
  // email, there's nothing to link to — the uid/picture get attached
  // automatically the moment they do book (see saveBooking's upsertCustomer call).
  function linkCustomerAccount(authUser) {
    if (!authUser || !authUser.email) return;
    const customers = load(CUSTOMERS_KEY);
    const idx = customers.findIndex(c => (c.email||'').toLowerCase() === authUser.email.toLowerCase());
    if (idx === -1) return;
    customers[idx] = {
      ...customers[idx],
      uid: authUser.uid || customers[idx].uid || '',
      picture: authUser.picture || customers[idx].picture || '',
      accountLinked: true
    };
    save(CUSTOMERS_KEY, customers);
  }

  // ── mergeRemoteBookings — upserts bookings fetched from the live backend
  // (Supabase, via GET /api/bookings) into local storage, so bookings made
  // on OTHER devices/browsers become visible here too. Deliberately skips
  // logActivity/render-triggering (unlike saveBooking) since this runs as a
  // passive background sync from inside render functions themselves — the
  // caller re-renders once after the merge completes instead.
  function mergeRemoteBookings(remoteList) {
    if (!Array.isArray(remoteList) || !remoteList.length) return;
    const bookings = load(BOOKINGS_KEY);
    remoteList.forEach(rb => {
      if (!rb || !rb.id) return;
      const idx = bookings.findIndex(b => b.id === rb.id);
      if (idx > -1) {
        bookings[idx] = { ...bookings[idx], ...rb };
      } else {
        bookings.push(rb);
        upsertCustomer(rb);
      }
    });
    save(BOOKINGS_KEY, bookings);
  }

  // ── mergeRemoteUsers — upserts customer *accounts* (people who signed in
  // with Google, whether or not they've ever booked yet) fetched from the
  // live backend (GET /api/users) into the local customers list. Without
  // this, a sign-in-only visitor (no booking) never appears anywhere in the
  // CRM, since the Customers list is otherwise built purely from bookings.
  function mergeRemoteUsers(remoteUsers) {
    if (!Array.isArray(remoteUsers) || !remoteUsers.length) return;
    const customers = load(CUSTOMERS_KEY);
    remoteUsers.forEach(u => {
      if (!u || !u.email) return;
      const idx = customers.findIndex(c => (c.email || '').toLowerCase() === u.email.toLowerCase());
      if (idx === -1) {
        // Signed in, never booked — add them as a customer so Akanksha can
        // see they exist, distinct from someone who's actually booked.
        customers.push({
          name: u.name || u.email,
          email: u.email,
          phone: '',
          services: [],
          sessions: 0,
          lastBooking: null,
          status: 'Signed Up',
          firstSeen: u.created_at || u.last_login_at || new Date().toISOString(),
          uid: u.uid || '',
          picture: u.picture || '',
          accountLinked: true
        });
      } else {
        // Already a customer (has a booking) — just carry the account
        // details onto their existing record, same as linkCustomerAccount().
        customers[idx] = {
          ...customers[idx],
          uid: u.uid || customers[idx].uid || '',
          picture: u.picture || customers[idx].picture || '',
          accountLinked: true
        };
      }
    });
    save(CUSTOMERS_KEY, customers);
  }

  return { saveBooking, getBookings, getCustomers, clearBookings, getAvailabilityBlocks, addAvailabilityBlock, removeAvailabilityBlock, getAvailabilityIndex, getSessionNote, saveSessionNote, getCustomerAttachments, saveCustomerAttachment, patchCustomerAttachment, removeCustomerAttachment, renameCustomerAttachment, updateCustomer, getFollowUp, saveFollowUp, getBookingNotes, addBookingNote, getCustomerNotes, addCustomerNote, logActivity, getActivity, linkCustomerAccount, mergeRemoteBookings, mergeRemoteUsers };
})();

// ════════════════════════════════════════════════════════════════════
// ADMIN RENDER FUNCTIONS
// ════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// AVAILABILITY ADMIN UI
// ════════════════════════════════════════════════════════════════════
const ALL_TIME_SLOTS = ['10:00 AM','11:00 AM','12:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM'];

function onAvailTypeChange(){
  const type = document.getElementById('avail-type').value;
  document.getElementById('avail-end-wrap').style.display = (type==='date-range') ? 'block' : 'none';
  document.getElementById('avail-times-wrap').style.display = (type==='time-slots') ? 'block' : 'none';
  if(type==='time-slots'){
    const wrap = document.getElementById('avail-times-checks');
    if(wrap && !wrap.dataset.built){
      wrap.innerHTML = ALL_TIME_SLOTS.map(t=>
        `<label style="display:flex;align-items:center;gap:0.4rem;font-family:'Montserrat',sans-serif;font-size:0.95rem;cursor:pointer;text-transform:none;letter-spacing:normal">
          <input type="checkbox" value="${t}" class="avail-time-check"> ${t}
        </label>`
      ).join('');
      wrap.dataset.built = '1';
    }
  }
}

function addAvailabilityBlockFromForm(){
  const errEl = document.getElementById('avail-form-error');
  errEl.textContent=''; errEl.classList.remove('is-visible');

  const type = document.getElementById('avail-type').value;
  const start = document.getElementById('avail-start').value;
  const end = document.getElementById('avail-end').value;
  const note = document.getElementById('avail-note').value.trim();

  if(!start){
    errEl.textContent='Please choose a start date.'; errEl.classList.add('is-visible'); return;
  }
  if(type==='date-range' && !end){
    errEl.textContent='Please choose an end date for the range.'; errEl.classList.add('is-visible'); return;
  }
  if(type==='date-range' && end < start){
    errEl.textContent='End date must be on or after the start date.'; errEl.classList.add('is-visible'); return;
  }

  let times = [];
  if(type==='time-slots'){
    times = Array.from(document.querySelectorAll('.avail-time-check:checked')).map(c=>c.value);
    if(!times.length){
      errEl.textContent='Please select at least one time to block.'; errEl.classList.add('is-visible'); return;
    }
  }

  if (_editingAvailBlockId) {
    OculttDB.removeAvailabilityBlock(_editingAvailBlockId);
    _editingAvailBlockId = null;
    const addBtn = document.querySelector('button[onclick="addAvailabilityBlockFromForm()"]');
    if (addBtn) addBtn.textContent = '+ Add Block';
  }

  OculttDB.addAvailabilityBlock({
    type,
    startDate: start,
    endDate: type==='date-range' ? end : start,
    times,
    note
  });

  // Reset form
  document.getElementById('avail-start').value='';
  document.getElementById('avail-end').value='';
  document.getElementById('avail-note').value='';
  document.querySelectorAll('.avail-time-check').forEach(c=>c.checked=false);

  renderAvailabilityBlocks();
}

function removeAvailabilityBlockUI(id){
  OculttDB.removeAvailabilityBlock(id);
  renderAvailabilityBlocks();
}

function renderAvailabilityBlocks(){
  const tbody = document.getElementById('avail-tbody');
  const empty = document.getElementById('avail-empty');
  if(!tbody) return;
  const blocks = OculttDB.getAvailabilityBlocks().slice().sort((a,b)=>(a.startDate||'').localeCompare(b.startDate||''));

  if(!blocks.length){
    tbody.innerHTML=''; empty.style.display='block'; return;
  }
  empty.style.display='none';

  const typeLabel = { 'full-day':'Single Day', 'date-range':'Date Range', 'time-slots':'Specific Times' };
  const typeBadgeCls = { 'full-day':'badge-cancelled', 'date-range':'badge-review', 'time-slots':'badge-pending' };
  tbody.innerHTML = blocks.map(b=>{
    const dateStr = (b.type==='date-range' && b.endDate!==b.startDate)
      ? `${b.startDate} → ${b.endDate}` : b.startDate;
    const timesStr = (b.type==='time-slots' && b.times?.length) ? b.times.join(', ') : '— Full day —';
    return `<tr>
      <td><span class="badge ${typeBadgeCls[b.type]||'badge-pending'}">${typeLabel[b.type]||b.type}</span></td>
      <td style="font-weight:600;color:var(--text)">${dateStr}</td>
      <td>${timesStr}</td>
      <td style="font-style:italic;color:var(--text-dim)">${b.note?b.note:'—'}</td>
      <td style="display:flex;gap:0.4rem">
        <button onclick="editAvailabilityBlockUI('${b.id}')" style="font-family:'Gudlak Bold',sans-serif;font-size:0.6rem;letter-spacing:0.1em;padding:0.35rem 0.7rem;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--gold-dk)">Edit</button>
        <button onclick="removeAvailabilityBlockUI('${b.id}')" style="font-family:'Gudlak Bold',sans-serif;font-size:0.6rem;letter-spacing:0.1em;padding:0.35rem 0.7rem;border:1px solid var(--border);background:transparent;cursor:pointer;color:#C0392B">Remove</button>
      </td>
    </tr>`;
  }).join('');
}

let _editingAvailBlockId = null;

function editAvailabilityBlockUI(id){
  const block = OculttDB.getAvailabilityBlocks().find(b => b.id === id);
  if (!block) return;
  _editingAvailBlockId = id;

  document.getElementById('avail-type').value = block.type;
  document.getElementById('avail-type').dispatchEvent(new Event('change'));
  document.getElementById('avail-start').value = block.startDate || '';
  document.getElementById('avail-end').value = block.endDate || '';
  document.getElementById('avail-note').value = block.note || '';
  document.querySelectorAll('.avail-time-check').forEach(c => {
    c.checked = (block.times || []).includes(c.value);
  });

  const addBtn = document.querySelector('button[onclick="addAvailabilityBlockFromForm()"]');
  if (addBtn) addBtn.textContent = '✓ Update Block';
  document.getElementById('avail-start').scrollIntoView({behavior:'smooth', block:'center'});
}


// Extracts a ₹ price from package strings like "Name — ₹555" so every booking
// type can store a consistent `price` field for Analytics, even though most
// service forms only ever captured price embedded inside the package name.
function _extractPrice(pkg){
  if (!pkg) return 'TBC';
  const match = pkg.match(/₹[\d,]+/);
  return match ? match[0] : 'TBC';
}
// Numeric rupee value from a "Name — ₹1,555" style string — used to send
// the base price to the server for validation (see SPELL_PRICE_TIERS_RUPEES
// in server/routes/payments.js, which is the actual source of truth; this
// is only for display and for what create-order sends, never trusted as
// the final charged amount).
function _extractPriceNumber(pkg){
  const label = _extractPrice(pkg);
  const digits = label.replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

// ── CRM toast notification — replaces alert() for non-blocking feedback ──
function _crmToast(msg, type) {
  const old = document.getElementById('_crm-toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.id = '_crm-toast';
  t.textContent = msg;
  const bg = type === 'error' ? '#C0392B' : type === 'success' ? '#2E8B6E' : '#3a3a3a';
  t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;font-family:'Gudlak Bold',sans-serif;font-size:0.65rem;letter-spacing:0.1em;padding:0.65rem 1.4rem;border-radius:2px;z-index:99999;opacity:0;transition:opacity 0.25s;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.25)`;
  document.body.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; });
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

// ── CRM inline modal — replaces blocking prompt() / alert() ──────────
let _crmModalResolve = null;
let _crmModalFields  = [];

/**
 * _crmPrompt(title, fields) → Promise<object|null>
 * fields: [{id, label, type:'text'|'date'|'textarea', value:''}]
 * Returns { fieldId: value, … } on confirm, null on cancel.
 */
function _crmPrompt(title, fields) {
  return new Promise(resolve => {
    _crmModalResolve = resolve;
    _crmModalFields  = fields;
    const overlay = document.getElementById('_crm-modal-overlay');
    const titleEl = document.getElementById('_crm-modal-title');
    const fieldsEl = document.getElementById('_crm-modal-fields');
    titleEl.textContent = title;
    fieldsEl.innerHTML = fields.map(f => {
      const tag = f.type === 'textarea'
        ? `<textarea id="_cmf-${f.id}" placeholder="${f.label}">${f.value||''}</textarea>`
        : `<input type="${f.type||'text'}" id="_cmf-${f.id}" placeholder="${f.label}" value="${(f.value||'').replace(/"/g,'&quot;')}">`;
      return `<label style="font-family:'Gudlak Bold',sans-serif;font-size:0.58rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-dim);display:block;margin-bottom:0.3rem">${f.label}</label>${tag}`;
    }).join('');
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    // Focus first field
    const first = fieldsEl.querySelector('input,textarea');
    if (first) setTimeout(() => first.focus(), 50);
  });
}
function _crmModalConfirm() {
  if (!_crmModalResolve) return;
  const result = {};
  _crmModalFields.forEach(f => {
    const el = document.getElementById('_cmf-'+f.id);
    result[f.id] = el ? el.value : '';
  });
  _crmModalClose();
  _crmModalResolve(result);
  _crmModalResolve = null;
}
function _crmModalCancel() {
  _crmModalClose();
  if (_crmModalResolve) { _crmModalResolve(null); _crmModalResolve = null; }
}
function _crmModalClose() {
  const overlay = document.getElementById('_crm-modal-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'}) +
           ' · ' + d.toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'});
  } catch(e) { return iso; }
}

function serviceBadgeClass(svc) {
  if (!svc) return 'badge-pending';
  const s = svc.toLowerCase();
  if (s.includes('tarot'))     return 'badge-pending';
  if (s.includes('spell'))     return 'badge-review';
  if (s.includes('group'))     return 'badge-completed';
  if (s.includes('numerology')) return 'badge-review';
  if (s.includes('energy'))    return 'badge-vip';
  return 'badge-pending';
}
function statusBadgeClass(st) {
  if (!st) return 'badge-pending';
  const s = st.toLowerCase();
  if (s.includes('cancel'))               return 'badge-cancelled';
  if (s.includes('complete'))             return 'badge-completed';
  if (s.includes('in progress'))          return 'badge-review';
  if (s.includes('waiting'))              return 'badge-review';
  if (s.includes('scheduled'))            return 'badge-confirmed';
  if (s.includes('booking received'))     return 'badge-pending';
  if (s.includes('reschedul'))            return 'badge-pending';
  if (s.includes('confirm'))              return 'badge-confirmed';
  if (s.includes('pending') || s.includes('review')) return 'badge-pending';
  return 'badge-pending';
}

function updateBookingStatus(id, status) {
  const bookings = OculttDB.getBookings();
  const idx = bookings.findIndex(b => b.id === id);
  if (idx > -1) {
    bookings[idx].status = status;
    OculttDB.saveBooking(bookings[idx]);
  }
  renderAdminBookings();
  renderDashboard();
}

let _bookingsFilterWhen    = 'all';
let _bookingsFilterService = 'all';
let _bookingsFilterStatus  = 'all';
let _bookingsFilterPriority = 'all';
let _bookingsFilterCustomDate = '';
let _bookingsShowArchived = false;
// Format = Audio vs Phone Tarot Reading — a finer-grained filter than Service,
// used by the "Audio Readings" / "Phone Readings" quick-view presets below.
let _bookingsFilterFormat = 'all';
// When true, unpaid bookings are listed first — used by the "Payments" preset.
let _bookingsSortUnpaidFirst = false;
function toggleBookingsArchivedView(checked){
  _bookingsShowArchived = !!checked;
  renderAdminBookings();
}

// ── Quick View presets ──────────────────────────────────────────────
// One-click named views built entirely from the existing When/Service/Status
// filters (plus the new Format filter and payment sort above) — no new data
// layer, just convenient combinations so bookings are never one big mixed
// list by default.
function setBookingsQuickView(view, el){
  document.querySelectorAll('#bookings-quickviews .range-tab').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');

  _bookingsFilterWhen = 'all'; _bookingsFilterService = 'all';
  _bookingsFilterStatus = 'all'; _bookingsFilterFormat = 'all';
  _bookingsSortUnpaidFirst = false;

  if (view === 'upcoming')       { _bookingsFilterWhen = 'upcoming'; }
  else if (view === 'today')     { _bookingsFilterWhen = 'today-appt'; }
  else if (view === 'completed') { _bookingsFilterStatus = 'Completed'; }
  else if (view === 'cancelled') { _bookingsFilterStatus = 'Cancelled'; }
  else if (view === 'audio')     { _bookingsFilterService = 'Tarot'; _bookingsFilterFormat = 'Audio'; }
  else if (view === 'phone')     { _bookingsFilterService = 'Tarot'; _bookingsFilterFormat = 'Phone'; }
  else if (view === 'payments')  { _bookingsSortUnpaidFirst = true; }
  // 'all' leaves every axis at 'all'

  // Keep the granular filter row buttons underneath visually in sync, so
  // they never show a stale selection that no longer matches the preset.
  document.querySelectorAll('#bookings-filter-tabs [data-filter-axis] .range-tab').forEach(b => b.classList.remove('active'));
  const syncRow = (axis, value) => {
    const row = document.querySelector('#bookings-filter-tabs [data-filter-axis="'+axis+'"]');
    if (!row) return;
    const match = Array.from(row.querySelectorAll('.range-tab')).find(b => b.getAttribute('onclick')?.includes("'"+value+"'"));
    (match || row.querySelector('.range-tab')).classList.add('active');
  };
  syncRow('when', _bookingsFilterWhen === 'today-appt' ? 'all' : _bookingsFilterWhen);
  syncRow('service', _bookingsFilterService);
  syncRow('status', _bookingsFilterStatus);
  syncRow('priority', 'all');

  // Force a real sync here (not just on first opening the Bookings tab) —
  // this is the button Akanksha actually checks against "did today's
  // booking come through", so it must never show a stale snapshot just
  // because the normal 15s throttle hasn't elapsed yet.
  renderAdminBookings(true);
}

function setBookingsFilter(axis, value, el) {
  if (axis === 'when')     _bookingsFilterWhen     = value;
  if (axis === 'service')  _bookingsFilterService  = value;
  if (axis === 'status')   _bookingsFilterStatus   = value;
  if (axis === 'priority') _bookingsFilterPriority = value;
  // A manual filter change means the customer is no longer looking at a
  // clean quick-view preset — clear the preset highlight and any settings
  // a preset applied that this axis doesn't cover, so behaviour stays
  // predictable instead of silently keeping an old preset's side-effects.
  document.querySelectorAll('#bookings-quickviews .range-tab').forEach(b => b.classList.remove('active'));
  if (axis !== 'service') _bookingsFilterFormat = 'all';
  if (axis === 'status' || axis === 'when') _bookingsSortUnpaidFirst = false;
  // Deactivate buttons in the same row only
  const row = el ? el.closest('[data-filter-axis="'+axis+'"]') : null;
  if (row) row.querySelectorAll('.range-tab').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  // Hide custom date picker unless custom is chosen
  const cdPicker = document.getElementById('bookings-custom-date');
  if (cdPicker) cdPicker.style.display = (axis === 'when' && value === 'custom') ? 'inline-block' : (cdPicker.style.display);
  if (value !== 'custom' && axis === 'when') { _bookingsFilterCustomDate = ''; if (cdPicker) cdPicker.style.display = 'none'; }
  // Same reasoning as setBookingsQuickView — the WHEN row (All/Today/
  // Yesterday/etc.) is exactly what's being checked for "is it here yet",
  // so force a fresh sync rather than risk a stale throttled snapshot.
  renderAdminBookings(axis === 'when');
}

function setBookingsCustomDate(val) {
  _bookingsFilterCustomDate = val || '';
  renderAdminBookings(true);
}

// Keep legacy single-arg form working (used in existing onclick= attributes above)
function _legacySetBookingsFilter(filter, el) {
  if (filter === 'all')           { setBookingsFilter('service','all',el); return; }
  if (filter === 'date:today')    { setBookingsFilter('when','today',el); return; }
  if (filter === 'date:upcoming') { setBookingsFilter('when','upcoming',el); return; }
  if (filter.startsWith('status:')) { setBookingsFilter('status', filter.split(':')[1], el); return; }
  setBookingsFilter('service', filter, el);
}

async function renderAdminBookings(forceSync) {
  const tbody  = document.getElementById('bookings-tbody');
  const empty  = document.getElementById('bookings-empty');
  const sub    = document.getElementById('bookings-sub');
  if (!tbody) return;

  // Best-effort sync with the live backend so bookings made on other
  // devices/browsers show up here too — falls back to whatever's already
  // cached locally if the live API is unreachable (see syncLiveBookingsIntoLocal).
  // Forced (bypasses the normal 15s throttle) the moment someone actually
  // opens the Bookings tab, so "All Bookings" can never show a stale/partial
  // list just because a previous sync happened recently elsewhere in the CRM
  // — that was the cause of bookings appearing to only show up once a more
  // specific filter (like "Yesterday") happened to trigger a fresh sync.
  await syncLiveBookingsIntoLocal(forceSync);

  const q = (document.getElementById('booking-search')?.value || '').toLowerCase();
  let bookings = OculttDB.getBookings();

  // ── Archived view toggle — archived bookings are hidden from the normal
  // working view by default; checking "Show Archived" flips to show only those ──
  bookings = bookings.filter(b => !!b.archived === _bookingsShowArchived);

  // ── Cascading WHEN filter ──
  const now = new Date(); now.setHours(0,0,0,0);
  const todayStr = new Date().toDateString();
  if (_bookingsFilterWhen === 'today') {
    bookings = bookings.filter(b => {
      const d = new Date(b.createdAt||b.date||'');
      return d.toDateString() === todayStr;
    });
  } else if (_bookingsFilterWhen === 'yesterday') {
    const yest = new Date(now); yest.setDate(yest.getDate()-1);
    const yestStr = yest.toDateString();
    bookings = bookings.filter(b => {
      const d = new Date(b.createdAt||b.date||'');
      return d.toDateString() === yestStr;
    });
  } else if (_bookingsFilterWhen === 'this-week') {
    const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate()-7);
    bookings = bookings.filter(b => {
      const d = new Date(b.createdAt||b.date||'');
      return d >= weekAgo && d <= new Date();
    });
  } else if (_bookingsFilterWhen === 'upcoming') {
    bookings = bookings.filter(b => {
      if (!b.date || b.date === 'TBC') return false;
      const d = new Date(b.date);
      return !isNaN(d) && d >= now
        && !(b.status||'').toLowerCase().includes('cancel')
        && !(b.status||'').toLowerCase().includes('complete');
    });
  } else if (_bookingsFilterWhen === 'today-appt') {
    // "Today's Appointments" — by the booked appointment date, not when the
    // booking was created (that's what plain 'today' above means).
    bookings = bookings.filter(b => {
      if (!b.date || b.date === 'TBC') return false;
      const d = new Date(b.date);
      return !isNaN(d) && d.toDateString() === todayStr;
    });
  } else if (_bookingsFilterWhen === 'custom' && _bookingsFilterCustomDate) {
    const targetStr = new Date(_bookingsFilterCustomDate).toDateString();
    bookings = bookings.filter(b => {
      const d = new Date(b.createdAt||b.date||'');
      return d.toDateString() === targetStr;
    });
  }

  // ── Cascading SERVICE filter ──
  if (_bookingsFilterService && _bookingsFilterService !== 'all') {
    bookings = bookings.filter(b => (b.service||'').toLowerCase().includes(_bookingsFilterService.toLowerCase()));
  }

  // ── FORMAT filter (Audio vs Phone Tarot) — used by the "Audio Readings"
  // and "Phone Readings" quick-view presets; matches the reading format
  // already stored in the booking's package field (e.g. "Audio — 2 Questions"). ──
  if (_bookingsFilterFormat && _bookingsFilterFormat !== 'all') {
    bookings = bookings.filter(b => (b.package||'').toLowerCase().startsWith(_bookingsFilterFormat.toLowerCase()));
  }

  // ── Cascading STATUS filter ──
  if (_bookingsFilterStatus && _bookingsFilterStatus !== 'all') {
    bookings = bookings.filter(b => (b.status||'').toLowerCase().includes(_bookingsFilterStatus.toLowerCase()));
  }

  // ── Cascading PRIORITY filter ──
  if (_bookingsFilterPriority && _bookingsFilterPriority !== 'all') {
    bookings = bookings.filter(b => (b.priority||'Normal') === _bookingsFilterPriority);
  }

  // ── Search ──
  if (q) bookings = bookings.filter(b =>
    (b.name||'').toLowerCase().includes(q)  ||
    (b.email||'').toLowerCase().includes(q) ||
    (b.phone||'').toLowerCase().includes(q) ||
    (b.service||'').toLowerCase().includes(q) ||
    (b.package||'').toLowerCase().includes(q) ||
    (b.id||'').toLowerCase().includes(q)    ||
    (b.date||'').toLowerCase().includes(q)
  );

  // ── Payments quick-view: unpaid bookings first, so they're never buried ──
  // (stable sort — OculttDB.getBookings() above is already newest-first,
  // so ties within "unpaid" or "paid" keep that order)
  if (_bookingsSortUnpaidFirst) {
    bookings = bookings.slice().sort((a, b) => {
      const aUnpaid = (a.paymentStatus||'').toLowerCase() !== 'paid';
      const bUnpaid = (b.paymentStatus||'').toLowerCase() !== 'paid';
      if (aUnpaid === bUnpaid) return 0;
      return aUnpaid ? -1 : 1;
    });
  }

  if (sub) sub.textContent = `${bookings.length} booking${bookings.length!==1?'s':''} total`;

  if (!bookings.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  tbody.innerHTML = bookings.map(b => `
    <tr class="crm-row-clickable" onclick="openBookingDetail('${b.id}')">
      <td style="font-size:0.8rem;color:var(--text-muted)">${fmtDate(b.createdAt)}</td>
      <td style="font-family:'Gudlak Bold',sans-serif;font-size:0.6rem;color:var(--text-dim);letter-spacing:0.06em;opacity:0.75">${b.id||'—'}</td>
      <td><div class="client-cell">
        <div class="avatar">${initials(b.name)}</div>
        <div>
          <div class="client-name">${b.name||'—'}${(b.priority||'Normal')==='Urgent' ? ' <span title="Urgent" style="color:#C0392B">🔥</span>' : ''}</div>
          <div class="client-email">${b.email||''}</div>
        </div>
      </div></td>
      <td><span class="badge ${serviceBadgeClass(b.service)}">${b.service||'—'}</span></td>
      <td style="color:var(--text-muted);font-size:0.85rem">${b.package||'—'}</td>
      <td style="color:var(--text-muted);font-size:0.85rem">${b.duration||'—'}</td>
      <td><span class="badge ${(b.paymentStatus||'').toLowerCase()==='paid' ? 'badge-confirmed' : 'badge-pending'}">${b.paymentStatus||'Unpaid'}</span></td>
      <td>${
        b.meetStatus==='Created' && b.meetLink
          ? `<a href="${b.meetLink}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="badge badge-confirmed">✓ Meet Ready</a>`
          : b.meetStatus==='N/A'
            ? `<span class="badge" style="opacity:0.5">N/A</span>`
            : `<span class="badge badge-pending">Not Created</span>`
      }</td>
      <td onclick="event.stopPropagation()">
        <select onchange="updateBookingStatus('${b.id}', this.value)" style="font-family:'Gudlak Bold',sans-serif;font-size:0.6rem;letter-spacing:0.08em;padding:4px 8px;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--text)">
          <option value="Booking Received"      ${(b.status||'')==='Booking Received'      ?'selected':''}>Booking Received</option>
          <option value="Scheduled"             ${(b.status||'')==='Scheduled'             ?'selected':''}>Scheduled</option>
          <option value="Waiting for Akanksha"  ${(b.status||'')==='Waiting for Akanksha'  ?'selected':''}>Waiting for Akanksha</option>
          <option value="In Progress"           ${(b.status||'')==='In Progress'           ?'selected':''}>In Progress</option>
          <option value="Completed"             ${(b.status||'')==='Completed'             ?'selected':''}>Completed</option>
          <option value="Cancelled"             ${(b.status||'')==='Cancelled'             ?'selected':''}>Cancelled</option>
          <option value="Rescheduled"           ${(b.status||'')==='Rescheduled'           ?'selected':''}>Rescheduled</option>
        </select>
      </td>    </tr>`).join('');
}

function openCustomerDetail(email) {
  const overlay = document.getElementById('customer-profile-overlay');
  const panel = document.getElementById('customer-profile-panel');
  if (!overlay || !panel) return;

  const customers = OculttDB.getCustomers();
  const customer = customers.find(c => (c.email||'').toLowerCase() === (email||'').toLowerCase());
  const bookingsDesc = OculttDB.getBookings()
    .filter(b => (b.email||'').toLowerCase() === (email||'').toLowerCase())
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)); // newest first
  const bookingsChrono = bookingsDesc.slice().reverse(); // oldest → newest, for the Timeline

  const displayName = customer ? customer.name : (bookingsDesc[0]?.name || email);
  document.getElementById('cd-client-name').textContent = displayName;
  panel.dataset.customerEmail = email;

  // ── Personal Information ──
  const dobBooking = bookingsDesc.find(b => b.dob);
  const firstBooking = bookingsChrono[0];
  const latestBooking = bookingsDesc[0];
  const phone = customer?.phone || bookingsDesc[0]?.phone || '';

  const infoItems = [
    ['Full Name', displayName || '—'],
    ['Email', customer?.email || email || '—'],
    ['Phone', phone || '—'],
    ['Date of Birth', dobBooking ? dobBooking.dob : '—'],
    ['Birth Time', customer?.birthTime || '—'],
    ['Birth Place', customer?.birthPlace || '—'],
    ['First Booking', firstBooking ? fmtDate(firstBooking.createdAt) : '—'],
    ['Last Booking', latestBooking ? fmtDate(latestBooking.createdAt) : '—'],
  ];
  const statusBadge = `<span class="badge ${customer?.status==='VIP'?'badge-vip':customer?.status==='Active'?'badge-confirmed':'badge-pending'}">${customer?.status||'New'}</span>`;

  document.getElementById('cd-client-summary').innerHTML = `
    <div class="cd-info-grid">
      ${infoItems.map(([label, val]) => `
        <div class="cd-info-item">
          <span class="cd-info-label">${label}</span>
          <span class="cd-info-value">${val}</span>
        </div>`).join('')}
      <div class="cd-info-item">
        <span class="cd-info-label">Customer Status</span>
        ${statusBadge}
      </div>
    </div>`;

  // ── Statistics ──
  const totalSpent = bookingsDesc.reduce((sum, b) => sum + (parsePriceToNumber(b.price) || 0), 0);
  const activeCount = bookingsDesc.filter(b => ['confirmed','pending review','in progress'].includes((b.status||'').toLowerCase())).length;
  const completedCount = bookingsDesc.filter(b => (b.status||'').toLowerCase().includes('complete')).length;
  const pendingCount = bookingsDesc.filter(b => (b.status||'').toLowerCase().includes('pending')).length;

  document.getElementById('cd-stats').innerHTML = `
    <div class="stat-card"><span class="label">Total Sessions</span><div class="value">${customer?.sessions || bookingsDesc.length || 0}</div></div>
    <div class="stat-card"><span class="label">Total Spend</span><div class="value" style="color:var(--gold)">${totalSpent > 0 ? '₹' + totalSpent.toLocaleString('en-IN') : '₹0'}</div></div>
    <div class="stat-card"><span class="label">Active Bookings</span><div class="value">${activeCount}</div></div>
    <div class="stat-card"><span class="label">Completed Sessions</span><div class="value">${completedCount}</div></div>
    <div class="stat-card"><span class="label">Pending Sessions</span><div class="value">${pendingCount}</div></div>
  `;

  // ── Quick Actions ──
  document.getElementById('cd-quick-actions').innerHTML = `
    <button class="cd-action-btn" onclick="viewLatestBookingInTimeline()">◷ View Booking</button>
    <button class="cd-action-btn" onclick="openEditCustomer('${(email||'').replace(/'/g,"\\'")}')">✎ Edit Customer</button>
    <button class="cd-action-btn" onclick="addNoteToLatestBooking('${(email||'').replace(/'/g,"\\'")}')">📝 Add Note</button>
    <button class="cd-action-btn" onclick="openScheduleFollowUp('${(email||'').replace(/'/g,"\\'")}')">📅 Schedule Follow-up</button>
    <button class="cd-action-btn" onclick="closeCustomerDetail()">✕ Close Profile</button>
  `;

  // ── Booking Timeline (chronological — oldest to newest) — now merged with file-upload activity ──
  const timelineEl = document.getElementById('cd-timeline');
  const empty = document.getElementById('cd-history-empty');
  const fileActivity = getFileActivity(email);
  if (!bookingsChrono.length && !fileActivity.length) {
    timelineEl.innerHTML = '';
    if (empty) empty.style.display = 'block';
  } else {
    if (empty) empty.style.display = 'none';
    const latestId = latestBooking?.id;
    const bookingEntries = bookingsChrono.map(b => ({ type: 'booking', at: b.createdAt, b }));
    const fileEntries = fileActivity.map(f => ({ type: 'file', at: f.at, label: f.label }));
    const merged = [...bookingEntries, ...fileEntries].sort((x,y) => new Date(x.at) - new Date(y.at));

    timelineEl.innerHTML = merged.map(entry => {
      if (entry.type === 'file') {
        return `<div class="cd-timeline-item" style="border-left-color:var(--border)">
          <div class="fa-timeline-file">
            <span style="font-size:0.8rem;color:var(--text-muted)">${fmtDate(entry.at)}</span>
            <span style="font-size:0.85rem;color:var(--text-dim);font-style:italic">📎 ${entry.label}</span>
          </div>
        </div>`;
      }
      const b = entry.b;
      const paymentStatus = b.paymentStatus || (parsePriceToNumber(b.price) ? 'Unpaid' : 'N/A');
      return `<div class="cd-timeline-item${b.id===latestId?' is-latest':''}" id="cd-tl-${b.id}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.5rem">
          <div>
            <span style="font-size:0.8rem;color:var(--text-muted)">${fmtDate(b.createdAt)}</span>
            <div style="margin-top:0.3rem"><span class="badge ${serviceBadgeClass(b.service)}">${b.service||'—'}</span> <span style="color:var(--text-muted);font-size:0.85rem;margin-left:0.4rem">${b.package||'—'}</span></div>
          </div>
          <div style="text-align:right">
            <div style="font-family:'Gudlak Bold',sans-serif;font-size:1rem;color:var(--gold-dk)">${b.price||'TBC'}</div>
            <div style="display:flex;gap:0.4rem;margin-top:0.3rem;justify-content:flex-end">
              <span class="badge ${statusBadgeClass(b.status)}">${b.status||'—'}</span>${rescheduleTag(b)}
              <span class="badge badge-pay ${paymentStatus==='Paid'?'badge-confirmed':paymentStatus==='Refunded'?'badge-cancelled':'badge-pending'}">${paymentStatus}</span>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // ── Session History (previous summaries, practitioner notes, attachments) ──
  const shEl = document.getElementById('cd-session-history');
  if (!bookingsDesc.length) {
    shEl.innerHTML = `<p style="font-family:'Montserrat',sans-serif;font-size:0.9rem;color:var(--text-dim);font-style:italic">No sessions yet.</p>`;
  } else {
    shEl.innerHTML = bookingsDesc.map(b => {
      const note = OculttDB.getSessionNote(b.id);
      const safeName = (b.name||'').replace(/'/g, "\\'");
      const attach = OculttDB.getCustomerAttachments(b.email);
      const hasAttachments = Object.values(attach).some(arr => arr.length);
      return `<div style="border:1px solid var(--border);border-radius:6px;padding:0.9rem 1rem;margin-bottom:0.6rem">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4rem">
          <span style="font-size:0.8rem;color:var(--text-muted)">${fmtDate(b.createdAt)} · ${b.service||'—'}</span>
        </div>
        ${note
          ? `<p style="font-size:0.88rem;color:var(--text-muted);font-style:italic;margin-bottom:0.4rem;cursor:pointer" onclick="editSessionNote('${b.id}','${safeName}')" title="Click to edit">${note.text}</p>`
          : `<button onclick="editSessionNote('${b.id}','${safeName}')" style="font-family:'Gudlak Bold',sans-serif;font-size:0.55rem;letter-spacing:0.06em;padding:3px 8px;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--text-dim);margin-bottom:0.4rem">+ ADD SUMMARY / PRACTITIONER NOTE</button>`}
        <div style="font-size:0.72rem;color:var(--text-dim);font-style:italic">${hasAttachments ? '📎 Has attachments' : '📎 No attachments'}</div>
      </div>`;
    }).join('');
  }

  // ── Payments ──
  const paidCount = bookingsDesc.filter(b => (b.paymentStatus||'')==='Paid').length;
  const pendingPayCount = bookingsDesc.filter(b => (b.paymentStatus||'Unpaid')==='Unpaid' && parsePriceToNumber(b.price)).length;
  const refundedCount = bookingsDesc.filter(b => (b.paymentStatus||'')==='Refunded').length;
  document.getElementById('cd-payments').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.75rem">
      <div class="stat-card"><span class="label">Paid</span><div class="value" style="color:#40815F">${paidCount}</div></div>
      <div class="stat-card"><span class="label">Pending</span><div class="value" style="color:#1A7055">${pendingPayCount}</div></div>
      <div class="stat-card"><span class="label">Refund Status</span><div class="value" style="color:#C0392B">${refundedCount}</div></div>
    </div>`;

  // ── Attachments (UI + data structure only — no real upload backend yet) ──
  renderFilesAttachments(email, 'cd-attachments');

  // ── Follow-up ──
  renderCustomerFollowUp(email);

  // ── Internal Remarks (customer-level notes, not tied to a booking) ──
  renderCustomerInternalNotes(email);

  overlay.style.display = 'block';
  panel.style.display = 'block';
  requestAnimationFrame(() => panel.classList.add('is-open'));
  document.body.style.overflow = 'hidden';
}

function viewLatestBookingInTimeline(){
  const items = document.querySelectorAll('.cd-timeline-item');
  if (!items.length) return;
  const latest = document.querySelector('.cd-timeline-item.is-latest') || items[items.length-1];
  latest.scrollIntoView({behavior:'smooth', block:'center'});
  latest.style.transition = 'background 0.3s';
  latest.style.background = 'rgba(46,139,110,0.08)';
  setTimeout(() => { latest.style.background = ''; }, 1200);
}

function openEditCustomer(email){
  const customer = OculttDB.getCustomers().find(c => (c.email||'').toLowerCase() === (email||'').toLowerCase());
  if (!customer) return;
  const newName = prompt('Full name:', customer.name || '');
  if (newName === null) return;
  const newPhone = prompt('Phone:', customer.phone || '');
  if (newPhone === null) return;
  const newBirthTime = prompt('Birth time (e.g. 07:45 AM) — leave blank if unknown:', customer.birthTime || '');
  if (newBirthTime === null) return;
  const newBirthPlace = prompt('Birth place (city, country) — leave blank if unknown:', customer.birthPlace || '');
  if (newBirthPlace === null) return;
  OculttDB.updateCustomer(email, { name: newName.trim() || customer.name, phone: newPhone.trim(), birthTime: newBirthTime.trim(), birthPlace: newBirthPlace.trim() });
  openCustomerDetail(email); // refresh panel with updated info
  renderAdminCustomers();
}

function addNoteToLatestBooking(email){
  const latest = OculttDB.getBookings()
    .filter(b => (b.email||'').toLowerCase() === (email||'').toLowerCase())
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!latest) {
    _crmToast('No bookings found for this client yet.');
    return;
  }
  editSessionNote(latest.id, latest.name || '');
  setTimeout(() => openCustomerDetail(email), 100);
}

function openScheduleFollowUp(email){
  const existing = OculttDB.getFollowUp(email);
  const date = prompt('Follow-up date (YYYY-MM-DD):', existing?.date || '');
  if (date === null) return;
  const note = prompt('Note for this follow-up (optional):', existing?.note || '');
  OculttDB.saveFollowUp(email, date.trim(), (note||'').trim());
  if (date.trim()) _crmToast('Follow-up scheduled for ' + date.trim() + '.');
  refreshVisibleCrmTables();
  renderCustomerFollowUp(email);
}

function renderCustomerFollowUp(email){
  const el = document.getElementById('cd-followup');
  if (!el) return;
  const fu = OculttDB.getFollowUp(email);
  const history = (fu && Array.isArray(fu.history)) ? fu.history : [];
  const todayISO = new Date().toISOString().slice(0,10);

  let html = '';
  if (fu && fu.date) {
    const overdue = fu.date < todayISO;
    const due = fu.date === todayISO;
    html += `<div class="stat-card" style="margin-bottom:0.75rem">
      <span class="label">Next Follow-up</span>
      <div class="value" style="font-size:1.1rem;color:${overdue?'#C0392B':due?'var(--gold-dk)':'var(--text)'}">${fmtDate(fu.date)}${overdue?' (Overdue)':due?' (Today)':''}</div>
      ${fu.note ? `<div style="font-family:'Montserrat',sans-serif;font-size:0.85rem;color:var(--text-dim);font-style:italic;margin-top:0.3rem">${fu.note}</div>` : ''}
    </div>`;
  } else {
    html += `<p style="font-family:'Montserrat',sans-serif;font-size:0.9rem;color:var(--text-dim);font-style:italic;margin-bottom:0.75rem">No follow-up currently scheduled.</p>`;
  }
  html += `<button class="cd-action-btn" onclick="openScheduleFollowUp('${(email||'').replace(/'/g,"\\'")}')" style="margin-bottom:0.75rem">📅 ${fu&&fu.date?'Reschedule':'Schedule'} Follow-up</button>`;

  if (history.length) {
    html += `<p class="cd-section-label" style="font-size:0.55rem;margin-bottom:0.5rem">Past Follow-ups</p>`;
    html += history.slice().reverse().map(h => `
      <div style="border-left:2px solid var(--border);padding:0.4rem 0 0.4rem 0.8rem;margin-bottom:0.4rem">
        <div style="font-family:'Gudlak Bold',sans-serif;font-size:0.55rem;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase">${fmtDate(h.date)}</div>
        ${h.note ? `<div style="font-size:0.85rem;color:var(--text-muted);font-style:italic">${h.note}</div>` : ''}
      </div>`).join('');
  }
  el.innerHTML = html;
}

function renderCustomerInternalNotes(email){
  const el = document.getElementById('cd-internal-notes');
  if (!el) return;
  const notes = OculttDB.getCustomerNotes(email);
  const safeEmail = (email||'').replace(/'/g,"\\'");
  el.innerHTML = faRenderNotesList(notes) +
    `<button class="cd-action-btn" onclick="editCustomerNoteQuick('${safeEmail}');setTimeout(()=>renderCustomerInternalNotes('${safeEmail}'),50)">📝 Add Remark</button>`;
}

function updateBookingPaymentStatus(id, value){
  const bookings = OculttDB.getBookings();
  const idx = bookings.findIndex(b => b.id === id);
  if (idx > -1) {
    bookings[idx].paymentStatus = value;
    OculttDB.saveBooking(bookings[idx]);
  }
  refreshVisibleCrmTables();
}

// ── Attachments: local data structure only, no real upload/backend yet ──
// ════════════════════════════════════════════════════════════════════
// FILES & ATTACHMENTS — full multi-file upload system
// Files live in-browser only (object URLs), consistent with the rest of
// this local-testing environment. No backend to upload to yet.
// ════════════════════════════════════════════════════════════════════
const FA_CATEGORIES = {
  video:   { icon: '🎥', label: 'Videos',    accept: 'video/*',        display: 'list' },
  audio:   { icon: '🎧', label: 'Audio',     accept: 'audio/*',        display: 'list' },
  images:  { icon: '🖼',  label: 'Images',    accept: 'image/*',        display: 'grid' },
  reports: { icon: '📄', label: 'Documents', accept: 'application/pdf', display: 'list' },
};

function faFormatFileSize(bytes){
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}
function faFormatDuration(sec){
  if (!sec || isNaN(sec)) return '';
  const m = Math.floor(sec/60), s = Math.floor(sec%60);
  return m + ':' + String(s).padStart(2,'0');
}

function renderFilesAttachments(email, containerId, bookingId){
  const container = document.getElementById(containerId);
  if (!container) return;
  container.dataset.email = email;
  // Persist bookingId across internal re-renders (after an upload/delete)
  // that only call renderFilesAttachments(email, containerId) with no 3rd
  // arg — without this, the Send-to-Client bar would vanish the moment a
  // file is added or removed.
  if (bookingId) container.dataset.bookingId = bookingId;
  else bookingId = container.dataset.bookingId || '';
  const stored = OculttDB.getCustomerAttachments(email);

  let html = Object.entries(FA_CATEGORIES).map(([cat, cfg]) => {
    const files = stored[cat] || [];
    const dzId = `fa-input-${containerId}-${cat}`;
    return `
      <div class="fa-category-block" data-category="${cat}">
        <div class="fa-category-header">
          <span class="fa-category-title">${cfg.icon} ${cfg.label} <span class="fa-category-count">(${files.length})</span></span>
        </div>
        <div class="fa-dropzone" id="fa-dz-${containerId}-${cat}"
             ondragover="faDragOver(event)" ondragleave="faDragLeave(event)"
             ondrop="faDrop(event,'${email}','${cat}','${containerId}')"
             onclick="document.getElementById('${dzId}').click()">
          <p class="fa-dropzone-text">Drag &amp; drop ${cfg.label.toLowerCase()} here, or</p>
          <button type="button" class="fa-browse-btn" onclick="event.stopPropagation();document.getElementById('${dzId}').click()">Browse Files</button>
          <input type="file" id="${dzId}" accept="${cfg.accept}" multiple style="display:none"
                 onchange="faHandleFiles('${email}','${cat}',this.files,'${containerId}');this.value=''">
        </div>
        <div class="fa-progress-wrap" id="fa-progress-${containerId}-${cat}"><div class="fa-progress-bar" id="fa-progress-bar-${containerId}-${cat}"></div></div>
        ${files.length === 0
          ? `<p class="fa-empty-note">No ${cfg.label.toLowerCase()} yet.</p>`
          : cfg.display === 'grid'
            ? `<div class="fa-image-grid">${files.map(f => faRenderImageTile(f, email, cat, containerId)).join('')}</div>`
            : `<div class="fa-file-list">${files.map(f => faRenderFileRow(f, email, cat, containerId)).join('')}</div>`
        }
      </div>`;
  }).join('');

  // ── Consolidated "Send to Client" bar — only in the Booking Details
  // panel (where we have a specific bookingId to send for), not in the
  // Customer Profile's file list, which isn't tied to a single booking.
  // Lets Akanksha write one message and send everything ready to go in one
  // action — a real, server-sent email, all from inside the CRM.
  if (bookingId) {
    const b = OculttDB.getBookings().find(x => x.id === bookingId);
    const audioFiles = (stored.audio || []).length;
    const hasRealRecording = !!(b && b.video_url);
    const recordingSent    = !!(b && b.video_sent);
    const recordingLine = hasRealRecording
      ? (recordingSent ? '✓ Recording already sent to client' : '🎥 Recording ready to send')
      : '🎥 No recording uploaded yet (use the Booking Details recorder to add one)';
    const cloudImages = (stored.images || []).filter(f => f.cloudAttachmentId).length;
    const cloudDocs   = (stored.reports || []).filter(f => f.cloudAttachmentId).length;
    const pendingImages = (stored.images || []).length - cloudImages;
    const pendingDocs   = (stored.reports || []).length - cloudDocs;
    const attachLine = (cloudImages + cloudDocs) > 0
      ? `📎 ${cloudImages} image(s) and ${cloudDocs} document(s) will be attached to the email`
      : '';
    const pendingLine = (pendingImages + pendingDocs) > 0
      ? `⏳ ${pendingImages + pendingDocs} file(s) still uploading — wait a moment before sending so they're included`
      : '';
    const audioNote = audioFiles > 0
      ? `${audioFiles} audio file above ${audioFiles===1?'is':'are'} saved here for reference only (use the recorder above for a sendable audio link).`
      : '';
    html += `
      <div class="fa-send-all-bar" style="margin-top:1.75rem;padding-top:1.5rem;border-top:1px solid var(--border)">
        <p class="cd-section-label">Send to Client</p>
        <textarea id="fa-send-message-${containerId}" placeholder="Write a note to include (optional)…" style="width:100%;min-height:70px;padding:0.7rem 0.9rem;border:1px solid var(--border);background:rgba(255,255,255,0.7);font-family:'Montserrat',sans-serif;font-size:0.9rem;color:var(--text);resize:vertical;margin-bottom:0.6rem;box-sizing:border-box"></textarea>
        <p style="font-family:'Montserrat',sans-serif;font-size:0.82rem;color:var(--text-muted);margin-bottom:0.3rem">${recordingLine}</p>
        ${attachLine ? `<p style="font-family:'Montserrat',sans-serif;font-size:0.82rem;color:var(--text-muted);margin-bottom:0.3rem">${attachLine}</p>` : ''}
        ${pendingLine ? `<p style="font-family:'Montserrat',sans-serif;font-size:0.8rem;color:#946C4F;margin-bottom:0.3rem">${pendingLine}</p>` : ''}
        ${audioNote ? `<p style="font-family:'Montserrat',sans-serif;font-size:0.78rem;color:var(--text-dim);font-style:italic;margin-bottom:0.3rem">${audioNote}</p>` : ''}
        <button type="button" class="cd-action-btn" style="background:var(--gold-dk);color:#fff;margin-top:0.6rem" id="fa-send-btn-${containerId}" onclick="sendAllToClient('${bookingId}','${containerId}')">📤 Send Everything to Client</button>
        <p id="fa-send-status-${containerId}" style="font-family:'Montserrat',sans-serif;font-size:0.82rem;margin-top:0.6rem"></p>
      </div>`;
  }

  container.innerHTML = html;
}

// ── One consolidated, real send — straight from the CRM, nothing else
// opens. The server sends one email containing Akanksha's note, the
// recording link (if any), and every uploaded image/document as a real
// attachment (see server/routes/attachments.js's /send-all).
async function sendAllToClient(bookingId, containerId){
  const btn = document.getElementById('fa-send-btn-' + containerId);
  const statusEl = document.getElementById('fa-send-status-' + containerId);
  const msgEl = document.getElementById('fa-send-message-' + containerId);
  const message = (msgEl && msgEl.value || '').trim();
  const b = OculttDB.getBookings().find(x => x.id === bookingId);
  if (!b) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  if (statusEl) { statusEl.style.color = 'var(--text-muted)'; statusEl.textContent = 'Sending…'; }

  try {
    if (!OCULTT_BACKEND_CONNECTED) throw new Error('No backend connected yet — using local storage');
    const r = await fetch(OCULTT_API + '/bookings/' + bookingId + '/send-all', {
      method: 'POST',
      headers: { 'x-admin-key': getAdminKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    const result = await r.json();
    if (!result.success) throw new Error(result.error || 'Send failed');

    let statusMsg = '✓ Sent.';
    if (result.recordingIncluded) statusMsg += ' Recording link included.';
    if (result.attachmentsSent) statusMsg += ` ${result.attachmentsSent} file(s) attached.`;
    if (result.skipped && result.skipped.length) statusMsg += ` (Couldn't include: ${result.skipped.join(', ')} — too large or unavailable.)`;
    if (statusEl) { statusEl.style.color = '#5BB888'; statusEl.textContent = statusMsg; }
    if (btn) { btn.textContent = '✓ Sent'; }
    if (msgEl) msgEl.value = '';

    // Reflect the (possibly now-sent) recording status locally too.
    const bookings = OculttDB.getBookings();
    const idx = bookings.findIndex(x => x.id === bookingId);
    if (idx > -1 && result.recordingIncluded) {
      bookings[idx].video_sent = true;
      bookings[idx].video_sent_at = new Date().toISOString();
      OculttDB.saveBooking(bookings[idx]);
    }
    renderFilesAttachments(b.email, containerId, bookingId);
  } catch (err) {
    console.error('[sendAllToClient]', err.message);
    if (statusEl) { statusEl.style.color = '#c0392b'; statusEl.textContent = '✗ ' + err.message; }
    if (btn) { btn.disabled = false; btn.textContent = '📤 Send Everything to Client'; }
  }
}

function faRenderFileRow(f, email, cat, containerId){
  const isVideo = cat === 'video';
  const isAudio = cat === 'audio';
  const thumb = isVideo
    ? (f.thumbnail ? `<div class="fa-file-thumb"><img src="${f.thumbnail}" alt=""></div>` : `<div class="fa-file-icon">🎥</div>`)
    : `<div class="fa-file-icon">${FA_CATEGORIES[cat].icon}</div>`;
  const metaBits = [faFormatFileSize(f.size)];
  if (f.duration) metaBits.push(faFormatDuration(f.duration));
  metaBits.push('Uploaded ' + fmtDate(f.uploadedAt));

  const audioPlayer = isAudio ? `<audio controls src="${f.url}"></audio>` : '';

  return `<div class="fa-file-row ${isAudio ? 'fa-audio-row' : ''}">
    ${!isAudio ? thumb : ''}
    <div class="fa-file-info">
      <div class="fa-file-name">${f.name}</div>
      <div class="fa-file-meta">${metaBits.join(' · ')}</div>
      ${audioPlayer}
    </div>
    <div class="fa-file-actions">
      ${isVideo || cat==='reports' ? `<button class="fa-file-action-btn" onclick="faPreviewFile('${cat}','${f.url}','${(f.name||'').replace(/'/g,"\\'")}')" title="Preview">👁</button>` : ''}
      <button class="fa-file-action-btn" onclick="faDownloadFile('${f.url}','${(f.name||'').replace(/'/g,"\\'")}')" title="Download">⬇</button>
      <button class="fa-file-action-btn" onclick="faRenameFile('${email}','${cat}','${f.id}','${containerId}')" title="Rename">✎</button>
      <button class="fa-file-action-btn" onclick="faReplaceFile('${email}','${cat}','${f.id}','${containerId}')" title="Replace">⇄</button>
      <button class="fa-file-action-btn danger" onclick="faRemoveFile('${email}','${cat}','${f.id}','${containerId}')" title="Delete">✕</button>
    </div>
  </div>`;
}

function faRenderImageTile(f, email, cat, containerId){
  return `<div class="fa-image-tile" onclick="faPreviewFile('images','${f.url}','${(f.name||'').replace(/'/g,"\\'")}')">
    <img src="${f.url}" alt="${f.name}">
    <div class="fa-image-tile-overlay">
      <button onclick="event.stopPropagation();faDownloadFile('${f.url}','${(f.name||'').replace(/'/g,"\\'")}')" title="Download">⬇</button>
      <button onclick="event.stopPropagation();faRemoveFile('${email}','${cat}','${f.id}','${containerId}')" title="Delete">✕</button>
    </div>
  </div>`;
}

function faDragOver(e){ e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function faDragLeave(e){ e.currentTarget.classList.remove('drag-over'); }
function faDrop(e, email, cat, containerId){
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  faHandleFiles(email, cat, e.dataTransfer.files, containerId);
}

function faHandleFiles(email, cat, fileList, containerId){
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const progWrap = document.getElementById(`fa-progress-${containerId}-${cat}`);
  const progBar = document.getElementById(`fa-progress-bar-${containerId}-${cat}`);
  if (progWrap) progWrap.style.display = 'block';
  if (progBar) progBar.style.width = '0%';

  // Images/documents also get durably uploaded to the booking itself (see
  // attachments.js) — this is what makes them real, sendable files instead
  // of a browser preview that vanishes on reload. Video/audio in this
  // panel are untouched — those keep working exactly as they do today.
  const container = document.getElementById(containerId);
  const bookingId = container ? container.dataset.bookingId : '';
  const backendCategory = cat === 'images' ? 'image' : cat === 'reports' ? 'document' : null;

  let done = 0;
  files.forEach(file => {
    faProcessOneFile(file, cat, (meta) => {
      OculttDB.saveCustomerAttachment(email, cat, meta);
      faLogTimelineActivity(email, cat, meta.name);
      done++;
      if (progBar) progBar.style.width = Math.round((done/files.length)*100) + '%';
      if (done === files.length) {
        setTimeout(() => {
          if (progWrap) progWrap.style.display = 'none';
          renderFilesAttachments(email, containerId);
          refreshVisibleCrmTables();
        }, 250);
      }
      if (bookingId && backendCategory) faUploadAttachmentToServer(bookingId, file, backendCategory, email, cat, meta.id, containerId);
    });
  });
}

// ── Background real upload for images/documents — happens alongside the
// existing local preview, doesn't block or change that flow. Once it
// succeeds, the real server-side attachment id is stamped onto the local
// file record so deleting it locally can also clean it up server-side.
async function faUploadAttachmentToServer(bookingId, file, backendCategory, email, cat, localFileId, containerId){
  const statusEl = document.getElementById('fa-send-status-' + containerId);
  try {
    if (!OCULTT_BACKEND_CONNECTED) throw new Error('No backend connected yet');
    const formData = new FormData();
    formData.append('file', file, file.name || backendCategory);
    formData.append('category', backendCategory);
    const r = await fetch(OCULTT_API + '/bookings/' + bookingId + '/attachments/upload', {
      method: 'POST',
      headers: { 'x-admin-key': getAdminKey() },
      body: formData
    });
    const result = await r.json();
    if (!result.success) throw new Error(result.error || 'Upload failed');
    OculttDB.patchCustomerAttachment(email, cat, localFileId, { cloudAttachmentId: result.attachment.id });
    // Keep the local booking cache in sync too, so Send Everything sees it
    // immediately without waiting on the next full bookings sync.
    const bookings = OculttDB.getBookings();
    const idx = bookings.findIndex(b => b.id === bookingId);
    if (idx > -1) { bookings[idx].attachments_json = result.attachments; OculttDB.saveBooking(bookings[idx]); }
  } catch (err) {
    console.warn('[faUploadAttachmentToServer]', err.message);
    if (statusEl) { statusEl.style.color = '#c0392b'; statusEl.textContent = `"${file.name}" is only saved here for now — it couldn't be uploaded for sending (${err.message}). It still shows above.`; }
  }
}

function faProcessOneFile(file, cat, callback){
  const url = URL.createObjectURL(file);
  const baseMeta = {
    id: 'F-' + Date.now() + '-' + Math.random().toString(36).slice(2,7),
    name: file.name,
    size: file.size,
    type: file.type,
    url,
    uploadedAt: new Date().toISOString()
  };

  if (cat === 'video') {
    const videoEl = document.createElement('video');
    videoEl.preload = 'metadata';
    videoEl.src = url;
    videoEl.muted = true;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; callback(baseMeta); } };
    // Safety net: never let an upload hang forever waiting on video events that might not fire
    const hardTimeout = setTimeout(finish, 4000);

    videoEl.onloadedmetadata = () => {
      baseMeta.duration = videoEl.duration;
      try {
        videoEl.currentTime = Math.min(1, (videoEl.duration || 2) / 2) || 0.1;
      } catch(e) { clearTimeout(hardTimeout); finish(); return; }
      const seekTimeout = setTimeout(() => { clearTimeout(hardTimeout); finish(); }, 2000);
      videoEl.onseeked = () => {
        clearTimeout(seekTimeout);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 160; canvas.height = 100;
          canvas.getContext('2d').drawImage(videoEl, 0, 0, 160, 100);
          baseMeta.thumbnail = canvas.toDataURL('image/jpeg', 0.7);
        } catch(e) { /* cross-origin or decode issue — fall back to icon */ }
        clearTimeout(hardTimeout);
        finish();
      };
    };
    videoEl.onerror = () => { clearTimeout(hardTimeout); finish(); };
  } else if (cat === 'audio') {
    const audioEl = document.createElement('audio');
    audioEl.preload = 'metadata';
    audioEl.src = url;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; callback(baseMeta); } };
    const hardTimeout = setTimeout(finish, 4000);
    audioEl.onloadedmetadata = () => { baseMeta.duration = audioEl.duration; clearTimeout(hardTimeout); finish(); };
    audioEl.onerror = () => { clearTimeout(hardTimeout); finish(); };
  } else {
    callback(baseMeta);
  }
}

function faRemoveFile(email, cat, fileId, containerId){
  if (!confirm('Delete this file? This cannot be undone.')) return;
  const stored = OculttDB.getCustomerAttachments(email);
  const f = (stored[cat] || []).find(x => x.id === fileId);
  OculttDB.removeCustomerAttachment(email, cat, fileId);
  renderFilesAttachments(email, containerId);
  refreshVisibleCrmTables();
  // If this file was also uploaded for real (see faUploadAttachmentToServer),
  // remove it there too — otherwise it would still go out next time
  // "Send Everything to Client" is used, even though it's gone from view.
  const container = document.getElementById(containerId);
  const bookingId = container ? container.dataset.bookingId : '';
  if (f && f.cloudAttachmentId && bookingId && OCULTT_BACKEND_CONNECTED) {
    fetch(OCULTT_API + '/bookings/' + bookingId + '/attachments/' + f.cloudAttachmentId, {
      method: 'DELETE', headers: { 'x-admin-key': getAdminKey() }
    }).then(r => r.json()).then(result => {
      if (result && result.success) {
        const bookings = OculttDB.getBookings();
        const idx = bookings.findIndex(b => b.id === bookingId);
        if (idx > -1) { bookings[idx].attachments_json = result.attachments; OculttDB.saveBooking(bookings[idx]); }
      }
    }).catch(err => console.warn('[faRemoveFile] server-side cleanup failed:', err.message));
  }
}

function faRenameFile(email, cat, fileId, containerId){
  const stored = OculttDB.getCustomerAttachments(email);
  const f = (stored[cat]||[]).find(x => x.id === fileId);
  if (!f) return;
  const newName = prompt('Rename file:', f.name);
  if (newName === null || !newName.trim()) return;
  OculttDB.renameCustomerAttachment(email, cat, fileId, newName.trim());
  renderFilesAttachments(email, containerId);
  refreshVisibleCrmTables();
}

function faReplaceFile(email, cat, fileId, containerId){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = FA_CATEGORIES[cat].accept;
  input.onchange = () => {
    if (!input.files.length) return;
    faProcessOneFile(input.files[0], cat, (meta) => {
      meta.id = fileId; // keep same id/position
      const stored = OculttDB.getCustomerAttachments(email);
      const idx = (stored[cat]||[]).findIndex(x => x.id === fileId);
      if (idx > -1) {
        stored[cat][idx] = meta;
        // Save directly via the same mechanism as add (overwrite whole list for this customer)
        const oldName = stored[cat][idx].name;
        OculttDB.removeCustomerAttachment(email, cat, fileId);
        OculttDB.saveCustomerAttachment(email, cat, meta);
        faLogTimelineActivity(email, cat, meta.name, true);
      }
      renderFilesAttachments(email, containerId);
      refreshVisibleCrmTables();
    });
  };
  input.click();
}

function faPreviewFile(cat, url, name){
  const lightbox = document.getElementById('fa-lightbox');
  const content = document.getElementById('fa-lightbox-content');
  if (cat === 'images') {
    content.innerHTML = `<img src="${url}" alt="${name}">`;
  } else if (cat === 'video') {
    content.innerHTML = `<video src="${url}" controls autoplay></video>`;
  } else if (cat === 'reports') {
    window.open(url, '_blank'); // PDFs open natively in a new tab
    return;
  }
  lightbox.classList.add('open');
}
function closeFaLightbox(){
  const lightbox = document.getElementById('fa-lightbox');
  lightbox.classList.remove('open');
  document.getElementById('fa-lightbox-content').innerHTML = '';
}

function faDownloadFile(url, name){
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Records a file-upload activity so it shows in the Customer Timeline
function faLogTimelineActivity(email, cat, fileName, isReplace){
  const labels = { video: 'Video uploaded', audio: 'Audio added', images: 'Image attached', reports: 'PDF attached' };
  const label = (isReplace ? 'Replaced — ' : '') + (labels[cat] || 'File added') + ': ' + fileName;
  let all = JSON.parse(localStorage.getItem('ocultt_file_activity_v1') || '{}');
  const key = (email||'').toLowerCase();
  if (!all[key]) all[key] = [];
  all[key].push({ label, at: new Date().toISOString() });
  localStorage.setItem('ocultt_file_activity_v1', JSON.stringify(all));
}
function getFileActivity(email){
  const all = JSON.parse(localStorage.getItem('ocultt_file_activity_v1') || '{}');
  return all[(email||'').toLowerCase()] || [];
}


function closeCustomerDetail() {
  const overlay = document.getElementById('customer-profile-overlay');
  const panel = document.getElementById('customer-profile-panel');
  if (panel) panel.classList.remove('is-open');
  setTimeout(() => {
    if (overlay) overlay.style.display = 'none';
    if (panel) panel.style.display = 'none';
  }, 350);
  document.body.style.overflow = '';
  // Refresh the customer list in case a note or payment status changed while open
  renderAdminCustomers();
}

// ════════════════════════════════════════════════════════════════════
// BOOKING DETAILS PANEL
// ════════════════════════════════════════════════════════════════════
const BOOKING_LIFECYCLE = ['Booking Received', 'Scheduled', 'Waiting for Akanksha', 'In Progress', 'Completed'];

// ════════════════════════════════════════════════════════════════════
// SPELL WORKFLOW — the real day-to-day process Akanksha follows
// ════════════════════════════════════════════════════════════════════
const SPELL_WORKFLOW_STAGES = [
  'New Request',
  'Payment Received',
  'Spell Started',
  'Recording in Progress',
  'Video Uploaded',
  'Ready to Send',
  'Completed'
];

// The action that moves a spell FROM this stage TO the next one.
const SPELL_STAGE_ACTIONS = {
  'New Request':            { label: '✓ Mark Payment Received', next: 'Payment Received' },
  'Payment Received':       { label: '✦ Start Spell Work',       next: 'Spell Started' },
  'Spell Started':          { label: '🎥 Mark Recording Started', next: 'Recording in Progress' },
  'Recording in Progress':  { label: '⬆ Upload Video',           next: null }, // handled by openVideoModal, not a simple stage-set
  'Video Uploaded':         { label: '✉ Mark Ready to Send',     next: 'Ready to Send' },
  'Ready to Send':          { label: '📤 Send Video to Customer', next: null }, // handled by openVideoModal's send flow
  'Completed':              null
};

// Derives the current stage from explicit workflowStage if set, otherwise
// infers a sensible stage from existing signals (payment, video upload/send)
// so spells created before this feature still show something reasonable.
function getSpellWorkflowStage(b) {
  if (b.workflowStage && SPELL_WORKFLOW_STAGES.includes(b.workflowStage)) return b.workflowStage;
  if (b.video_sent) return 'Completed';
  if (b.video_url) return 'Video Uploaded';
  if (b.payment_status === 'Paid' || b.paymentStatus === 'Paid') return 'Payment Received';
  return 'New Request';
}

function advanceSpellStage(bookingId, newStage) {
  const bookings = OculttDB.getBookings();
  const idx = bookings.findIndex(b => b.id === bookingId);
  if (idx === -1) return;
  const b = bookings[idx];
  const stageHistory = b.stageHistory || [];
  stageHistory.push({ stage: newStage, at: new Date().toISOString() });
  const updated = { ...b, workflowStage: newStage, stageHistory };
  // Keep the simpler status field in sync so Active/Completed filtering still works correctly
  if (newStage === 'Completed') updated.status = 'Completed';
  else if (newStage !== 'New Request') updated.status = 'In Progress';
  OculttDB.saveBooking(updated);
  OculttDB.logActivity({ bookingId, email: b.email, type: 'stage', label: `Spell workflow: "${newStage}"` });
  const idxCache = _spellsCache.findIndex(s => s.id === bookingId);
  if (idxCache > -1) _spellsCache[idxCache].status = updated.status;
  // Spell progress must reflect everywhere it appears — Spell Requests, Dashboard,
  // Analytics, Customer Profile/Timeline — not just the panel that triggered it
  refreshVisibleCrmTables();
}


// ── "✉ Send Email" quick action ── a mailto: link opens the ADMIN'S OWN
// email client for a manual, ad-hoc message — it is not, and can never be,
// a way to deliver an attachment (mailto: links cannot carry file
// attachments in any browser; that's a platform limitation, not something
// fixable in this codebase). What WAS fixable is that it previously opened
// completely blank. It now pre-fills a subject/body with the customer's
// name and booking context, and — if this booking already has a
// recording link sent to it (video_url/audio_url) — includes that real
// link in the body, so it doubles as a manual resend/follow-up option.
// The actual, reliable way to deliver a fresh recording remains the
// dedicated "🎥 VIDEO" / audio Send Now buttons, which send server-side.
function buildBookingMailtoLink(b){
  const name = b.name || 'there';
  const service = b.service || 'your booking';
  const subject = `The Ocultt Tarot — ${service}${b.id ? ' (' + b.id + ')' : ''}`;
  let body = `Hi ${name},\n\n`;
  const link = b.video_url || b.audio_url;
  if (link) {
    body += `Here is the link to your recording: ${link}\n(This link expires 7 days from when it was sent.)\n\n`;
  }
  body += `— The Ocultt Tarot`;
  return `mailto:${b.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function openBookingDetail(bookingId) {
  const overlay = document.getElementById('booking-detail-overlay');
  const panel = document.getElementById('booking-detail-panel');
  if (!overlay || !panel) return;

  const b = OculttDB.getBookings().find(x => x.id === bookingId);
  if (!b) return;
  panel.dataset.bookingId = bookingId;

  document.getElementById('bd-booking-id').textContent = b.id;
  const isSpell = (b.service||'').includes('Spell');

  // ── Progress indicator: spell-specific 7-stage workflow, or generic booking lifecycle ──
  const progEl = document.getElementById('bd-progress');
  const nextActionEl = document.getElementById('bd-next-action');
  const timelineWrap = document.getElementById('bd-timeline-wrap');

  if ((b.status||'').toLowerCase().includes('cancel')) {
    progEl.innerHTML = `<div class="bd-cancelled-banner">✕ This booking was cancelled</div>`;
    nextActionEl.innerHTML = '';
  } else if (isSpell) {
    const stage = getSpellWorkflowStage(b);
    const idx = SPELL_WORKFLOW_STAGES.indexOf(stage);
    progEl.innerHTML = `<div class="bd-stepper" style="flex-wrap:wrap;row-gap:1.2rem">${
      SPELL_WORKFLOW_STAGES.map((s, i) => `
        <div class="bd-step ${i < idx ? 'done' : i === idx ? 'current' : ''}" style="min-width:90px">
          <div class="bd-step-dot">${i < idx ? '✓' : i+1}</div>
          <div class="bd-step-label">${s}</div>
        </div>`).join('')
    }</div>`;

    // Highlight the single recommended next action for this stage
    const action = SPELL_STAGE_ACTIONS[stage];
    if (stage === 'Recording in Progress') {
      nextActionEl.innerHTML = `<button class="cd-action-btn" style="background:var(--gold-dk);color:#fff;font-size:0.68rem;padding:0.75rem 1.3rem" onclick="openVideoModal('${b.id}')">⬆ Upload Video Now</button>`;
    } else if (stage === 'Ready to Send') {
      nextActionEl.innerHTML = `<button class="cd-action-btn" style="background:var(--gold-dk);color:#fff;font-size:0.68rem;padding:0.75rem 1.3rem" onclick="openVideoModal('${b.id}')">📤 Open &amp; Send Video</button>`;
    } else if (action && action.next) {
      nextActionEl.innerHTML = `<button class="cd-action-btn" style="background:var(--gold-dk);color:#fff;font-size:0.68rem;padding:0.75rem 1.3rem" onclick="advanceSpellStage('${b.id}','${action.next}')">${action.label}</button>`;
    } else {
      nextActionEl.innerHTML = `<p style="font-family:'Montserrat',sans-serif;font-size:0.88rem;color:var(--text-dim);font-style:italic">✓ This request is complete — nothing further needed.</p>`;
    }
  } else {
    const currentIdx = BOOKING_LIFECYCLE.findIndex(s => s.toLowerCase() === (b.status||'pending').toLowerCase());
    const idx = currentIdx === -1 ? 0 : currentIdx;
    progEl.innerHTML = `<div class="bd-stepper">${
      BOOKING_LIFECYCLE.map((stage, i) => `
        <div class="bd-step ${i < idx ? 'done' : i === idx ? 'current' : ''}">
          <div class="bd-step-dot">${i < idx ? '✓' : i+1}</div>
          <div class="bd-step-label">${stage}</div>
        </div>`).join('')
    }</div>`;
    nextActionEl.innerHTML = '';
  }

  // ── Activity Timeline — every booking gets one, not just spells (Phase 2) ──
  // Combines: booking creation, status/stage changes, internal notes, and file
  // uploads, all logged automatically as they happen (see OculttDB.logActivity).
  timelineWrap.style.display = 'block';
  {
    const events = [];
    const log = OculttDB.getActivity({ bookingId: b.id });
    if (!log.some(a => a.type === 'created')) events.push({ label: 'Booking created', at: b.createdAt });
    log.forEach(a => events.push({ label: a.label, at: a.at }));
    if (isSpell && b.video_sent) events.push({ label: 'Video sent to customer', at: b.video_sent_at || b.createdAt });
    getFileActivity(b.email).forEach(f => events.push({ label: '📎 ' + f.label, at: f.at }));
    events.sort((x,y) => new Date(x.at) - new Date(y.at));
    document.getElementById('bd-timeline-events').innerHTML = events.map(e => `
      <div class="cd-timeline-item">
        <span style="font-size:0.8rem;color:var(--text-muted)">${fmtDate(e.at)}</span>
        <div style="font-size:0.9rem;color:var(--text);margin-top:0.2rem">${e.label}</div>
      </div>`).join('');
  }

  // ── Booking Information ──
  const appointmentDisplay = (b.date && b.date !== 'TBC')
    ? b.date + (b.time && b.time !== 'TBC' ? ' · ' + b.time : '')
    : '—';
  const bookedOnDisplay = b.createdAt
    ? (() => { const d = new Date(b.createdAt); return d.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) + ' · ' + d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}); })()
    : '—';

  document.getElementById('bd-info').innerHTML = `
    <div class="cd-info-grid">
      <div class="cd-info-item"><span class="cd-info-label">Booking ID</span><span class="cd-info-value" style="font-family:'Gudlak Bold',sans-serif;font-size:0.68rem;letter-spacing:0.06em">${b.id||'—'}</span></div>
      <div class="cd-info-item"><span class="cd-info-label">Customer Name</span><span class="cd-info-value">${b.name||'—'}</span></div>
      <div class="cd-info-item"><span class="cd-info-label">Service</span><span class="cd-info-value">${b.service||'—'}</span></div>
      <div class="cd-info-item"><span class="cd-info-label">Package / Format</span><span class="cd-info-value">${b.package||'—'}</span></div>
      <div class="cd-info-item"><span class="cd-info-label">Booked On</span><span class="cd-info-value" style="color:var(--text-muted)">${bookedOnDisplay}</span></div>
      <div class="cd-info-item"><span class="cd-info-label">Appointment Date &amp; Time</span><span class="cd-info-value" style="color:var(--gold-dk);font-weight:600">${appointmentDisplay}</span></div>
      <div class="cd-info-item"><span class="cd-info-label">Duration</span><span class="cd-info-value">${b.duration||'—'}</span></div>
      <div class="cd-info-item"><span class="cd-info-label">Price</span><span class="cd-info-value" style="color:var(--gold-dk)">${b.price||'TBC'}</span></div>
      <div class="cd-info-item"><span class="cd-info-label">Payment Status</span>${(() => {
        const ps = b.paymentStatus || (parsePriceToNumber(b.price) ? 'Unpaid' : 'N/A');
        return `<span class="badge badge-pay ${ps==='Paid'?'badge-confirmed':ps==='Refunded'?'badge-cancelled':'badge-pending'}">${ps}</span>`;
      })()}</div>
      <div class="cd-info-item"><span class="cd-info-label">Booking Status</span><span class="badge ${statusBadgeClass(b.status)}">${b.status||'—'}</span>${rescheduleTag(b)}</div>
      ${b.dob ? `<div class="cd-info-item"><span class="cd-info-label">Date of Birth</span><span class="cd-info-value">${b.dob}</span></div>` : ''}
      ${b.topic ? `<div class="cd-info-item"><span class="cd-info-label">Topic Selected</span><span class="cd-info-value">${b.topic}</span></div>` : ''}
      ${b.meetStatus && b.meetStatus !== 'N/A' ? `<div class="cd-info-item"><span class="cd-info-label">Google Meet Status</span>${
        b.meetStatus==='Created' && b.meetLink
          ? `<a href="${b.meetLink}" target="_blank" rel="noopener" class="badge badge-confirmed">✓ ${b.meetLink}</a>`
          : `<span class="badge badge-pending">Not Created</span>`
      }</div>` : ''}
      ${b.calendarEventId ? `<div class="cd-info-item"><span class="cd-info-label">Calendar Event ID</span><span class="cd-info-value" style="font-family:'Gudlak Bold',sans-serif;font-size:0.65rem;letter-spacing:0.04em">${b.calendarEventId}</span></div>` : ''}
    </div>
    ${(() => {
      // Audio questions — structured display
      if (b.audioQuestions && b.audioQuestions.length) {
        const qs = b.audioQuestions.filter(q => q);
        if (qs.length) return `<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border)">
          <p class="cd-info-label" style="margin-bottom:0.5rem">Questions Submitted</p>
          ${qs.map((q,i)=>`<div style="margin-bottom:0.5rem"><span class="cd-info-label" style="font-size:0.55rem">Question ${i+1}</span><p style="font-size:0.9rem;color:var(--text);line-height:1.55;margin:0.15rem 0 0">${q}</p></div>`).join('')}
        </div>`;
      }
      // Single intention / question
      if (b.intention) return `<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border)">
        <p class="cd-info-label" style="margin-bottom:0.4rem">Question / Intention</p>
        <p style="font-family:'Montserrat',sans-serif;font-size:0.95rem;color:var(--text);font-style:italic;line-height:1.6;margin:0">${b.intention}</p>
      </div>`;
      // Spell fields
      if (b.goal || b.wish) return `<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border)">
        ${b.wish ? `<div style="margin-bottom:0.5rem"><p class="cd-info-label" style="margin-bottom:0.2rem">Wish / Desire</p><p style="font-size:0.9rem;color:var(--text);line-height:1.55;margin:0">${b.wish}</p></div>` : ''}
        ${b.goal ? `<div style="margin-bottom:0.5rem"><p class="cd-info-label" style="margin-bottom:0.2rem">Goal / Intention</p><p style="font-size:0.9rem;color:var(--text);line-height:1.55;margin:0">${b.goal}</p></div>` : ''}
        ${b.urgency ? `<div class="cd-info-item"><span class="cd-info-label">Urgency</span><span class="cd-info-value">${b.urgency}</span></div>` : ''}
        ${b.additionalNotes ? `<div style="margin-top:0.5rem"><p class="cd-info-label" style="margin-bottom:0.2rem">Additional Notes</p><p style="font-size:0.9rem;color:var(--text);line-height:1.55;margin:0">${b.additionalNotes}</p></div>` : ''}
      </div>`;
      return '';
    })()}
    <div id="bd-crm-extra" style="margin-top:1rem"></div>`;
  renderCrmExtras(bookingId);

  // ── Customer Contact ──
  document.getElementById('bd-contact').innerHTML = `
    <div class="cd-info-grid">
      <div class="cd-info-item"><span class="cd-info-label">Email</span><span class="cd-info-value">${b.email||'—'}</span></div>
      <div class="cd-info-item"><span class="cd-info-label">Phone</span><span class="cd-info-value">${b.phone||'—'}</span></div>
    </div>`;

  // ── Quick Actions ──
  const waPhone = (b.phone || '').replace(/[^\d]/g, '');
  const unconfirmedStates = ['booking received','pending review','waiting for akanksha'];
  const canConfirm = unconfirmedStates.includes((b.status||'').toLowerCase());
  document.getElementById('bd-quick-actions').innerHTML = `
    ${canConfirm ? `<button class="cd-action-btn" style="background:var(--gold-dk);color:#fff" onclick="confirmBookingQuick('${b.id}')">✓ Confirm Booking</button>` : ''}
    <button class="cd-action-btn" onclick="editBookingQuick('${b.id}')">✎ Edit Booking</button>
    <button class="cd-action-btn" onclick="rescheduleBookingQuick('${b.id}')">📅 Reschedule</button>
    <button class="cd-action-btn danger" onclick="cancelBookingQuick('${b.id}')">✕ Cancel Booking</button>
    <button class="cd-action-btn" onclick="markBookingCompletedQuick('${b.id}')">✓ Mark Completed</button>
    <button class="cd-action-btn" onclick="${b.archived ? 'unarchiveBookingQuick' : 'archiveBookingQuick'}('${b.id}')">${b.archived ? '📤 Unarchive' : '🗄 Archive Booking'}</button>
    <button class="cd-action-btn" onclick="jumpToCustomerProfile('${(b.email||'').replace(/'/g,"\\'")}')">◈ Open Customer Profile</button>
    <button class="cd-action-btn" onclick="addInternalNoteToBooking('${b.id}')">📝 Add Internal Note</button>
    ${b.email ? `<a class="cd-action-btn" href="${buildBookingMailtoLink(b)}">✉ Send Email</a>` : ''}
    ${waPhone ? `<a class="cd-action-btn" href="https://wa.me/${waPhone}" target="_blank" rel="noopener">◈ Send WhatsApp</a>` : ''}
    ${isMediaEligible(b) ? `<button class="cd-action-btn" style="background:var(--gold-dk);color:#fff" onclick="openMediaModal('${b.id}')">🎥 Send Recording to Client</button>` : ''}
  `;

  // ── Customer Notes (general, not tied to this specific booking) ──
  renderBookingPanelCustomerNote(b.email);

  // ── Booking Notes (internal, this booking specifically) ──
  renderBookingPanelBookingNote(b.id);

  // ── Session Summary (existing session-notes system) ──
  const summary = OculttDB.getSessionNote(b.id);
  const safeName = (b.name||'').replace(/'/g, "\\'");
  document.getElementById('bd-session-summary').innerHTML = summary
    ? `<p style="font-size:0.9rem;color:var(--text-muted);font-style:italic;cursor:pointer;line-height:1.6" onclick="editSessionNote('${b.id}','${safeName}');setTimeout(()=>openBookingDetail('${b.id}'),100)" title="Click to edit">${summary.text}</p>`
    : `<p style="font-family:'Montserrat',sans-serif;font-size:0.88rem;color:var(--text-dim);font-style:italic;margin-bottom:0.5rem">No session summary yet.</p><button onclick="editSessionNote('${b.id}','${safeName}');setTimeout(()=>openBookingDetail('${b.id}'),100)" style="font-family:'Gudlak Bold',sans-serif;font-size:0.55rem;letter-spacing:0.06em;padding:3px 8px;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--text-dim)">+ ADD SUMMARY</button>`;

  // ── Files & Attachments — available for every booking type (Phase 2), linked
  // to the customer's email and visible from any of their booking detail panels ──
  const attachWrap = document.getElementById('bd-attachments-wrap');
  attachWrap.style.display = 'block';
  renderFilesAttachments(b.email, 'bd-attachments', b.id);

  overlay.style.display = 'block';
  panel.style.display = 'block';
  requestAnimationFrame(() => panel.classList.add('is-open'));
  document.body.style.overflow = 'hidden';
}

// ══════════════════════════════════════════════════════════════════════
// CRM EXTRAS — live backend data for the booking detail panel: this
// client's history across every device/browser (not just this one, which
// is all OculttDB/localStorage can see), and a message thread so sending
// something to a client never requires leaving the CRM to open Gmail.
// Everything here is best-effort — if the backend isn't connected yet,
// it shows a quiet note instead of an error.
// ══════════════════════════════════════════════════════════════════════
async function renderCrmExtras(bookingId) {
  const el = document.getElementById('bd-crm-extra');
  if (!el) return;

  if (!OCULTT_BACKEND_CONNECTED) {
    el.innerHTML = `<p style="font-family:'Montserrat',sans-serif;font-size:0.82rem;color:var(--text-dim);font-style:italic;padding-top:0.75rem;border-top:1px solid var(--border)">Client history & messages will appear here once the CRM backend is connected.</p>`;
    return;
  }

  el.innerHTML = `<p style="font-size:0.82rem;color:var(--text-dim);font-style:italic;padding-top:0.75rem;border-top:1px solid var(--border)">Loading history &amp; messages…</p>`;

  let data;
  try {
    data = await apiGet('/bookings/' + bookingId);
    if (data.error) throw new Error(data.error);
  } catch (err) {
    console.warn('[renderCrmExtras]', err.message);
    el.innerHTML = `<p style="font-family:'Montserrat',sans-serif;font-size:0.82rem;color:var(--text-dim);font-style:italic;padding-top:0.75rem;border-top:1px solid var(--border)">Couldn't load client history right now.</p>`;
    return;
  }

  const history = data.history || [];
  const messages = data.messages || [];

  el.innerHTML = `
    <div style="padding-top:0.75rem;border-top:1px solid var(--border)">
      <p class="cd-info-label" style="margin-bottom:0.5rem">Client History — Other Bookings</p>
      ${history.length ? history.map(h => `
        <div class="cd-info-item" style="margin-bottom:0.3rem">
          <span class="cd-info-value" style="cursor:pointer" onclick="openBookingDetail('${h.id}')">${h.service} · ${h.id}</span>
          <span class="badge ${statusBadgeClass(h.status)}">${h.status||'—'}</span>
        </div>`).join('') : `<p style="font-size:0.85rem;color:var(--text-dim);font-style:italic">No other bookings from this email yet.</p>`}
    </div>

    ${data.booking && data.booking.meet_status && data.booking.meet_status !== 'N/A' ? `
    <div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border)">
      <p class="cd-info-label" style="margin-bottom:0.5rem">Google Meet Summary</p>
      <textarea id="bd-meet-summary" rows="3" placeholder="Notes from the call — what was discussed, follow-ups, anything worth remembering next time." style="width:100%;font-family:'Montserrat',sans-serif;font-size:0.88rem;padding:0.6rem;border:1px solid var(--border);background:transparent;color:var(--text);resize:vertical">${(data.booking && data.booking.meet_summary) || ''}</textarea>
      <button class="cd-action-btn" style="margin-top:0.5rem" onclick="saveMeetSummary('${bookingId}')">Save Summary</button>
      <span id="bd-meet-summary-status" style="font-size:0.78rem;color:var(--text-dim);margin-left:0.5rem"></span>
    </div>` : ''}

    <div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border)">
      <p class="cd-info-label" style="margin-bottom:0.5rem">Messages to Client</p>
      <div id="bd-message-thread" style="max-height:220px;overflow-y:auto;margin-bottom:0.6rem">
        ${messages.length ? messages.map(m => `
          <div class="cd-timeline-item">
            <span style="font-size:0.78rem;color:var(--text-muted)">${fmtDate(m.created_at)} · ${m.sent_by||'CRM'}</span>
            <div style="font-size:0.88rem;color:var(--text);margin-top:0.15rem">${m.subject ? '<strong>'+m.subject+'</strong><br>' : ''}${m.body||''}${m.attachment_url ? '<br><a href="'+m.attachment_url+'" target="_blank" rel="noopener">📎 Attachment</a>' : ''}</div>
          </div>`).join('') : `<p style="font-size:0.85rem;color:var(--text-dim);font-style:italic">No messages sent yet.</p>`}
      </div>
      <input id="bd-msg-subject" type="text" placeholder="Subject (optional)" style="width:100%;margin-bottom:0.4rem;font-family:'Montserrat',sans-serif;font-size:0.85rem;padding:0.5rem;border:1px solid var(--border);background:transparent;color:var(--text)">
      <textarea id="bd-msg-body" rows="2" placeholder="Message to the client…" style="width:100%;margin-bottom:0.4rem;font-family:'Montserrat',sans-serif;font-size:0.85rem;padding:0.5rem;border:1px solid var(--border);background:transparent;color:var(--text);resize:vertical"></textarea>
      <input id="bd-msg-attachment" type="file" accept="audio/*,video/*,image/*,.pdf" style="font-size:0.8rem;margin-bottom:0.4rem">
      <br>
      <button class="cd-action-btn" style="background:var(--gold-dk);color:#fff" onclick="sendCrmMessage('${bookingId}')">✉ Send to Client</button>
      <span id="bd-msg-status" style="font-size:0.78rem;color:var(--text-dim);margin-left:0.5rem"></span>
    </div>`;
}

async function saveMeetSummary(bookingId) {
  const statusEl = document.getElementById('bd-meet-summary-status');
  const value = document.getElementById('bd-meet-summary').value;
  statusEl.textContent = 'Saving…';
  try {
    const result = await apiPatch('/bookings/' + bookingId, { meet_summary: value });
    if (!result.ok) throw new Error(result.error || 'Save failed');
    statusEl.textContent = '✓ Saved';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  } catch (err) {
    statusEl.textContent = '✗ ' + err.message;
  }
}

async function sendCrmMessage(bookingId) {
  const subject = document.getElementById('bd-msg-subject').value.trim();
  const body = document.getElementById('bd-msg-body').value.trim();
  const fileInput = document.getElementById('bd-msg-attachment');
  const file = fileInput.files[0];
  const statusEl = document.getElementById('bd-msg-status');

  if (!body && !file) { statusEl.textContent = 'Write a message or attach a file first.'; return; }

  statusEl.textContent = 'Sending…';
  try {
    const formData = new FormData();
    if (subject) formData.append('subject', subject);
    if (body) formData.append('body', body);
    if (file) formData.append('attachment', file);

    const r = await fetch(OCULTT_API + '/bookings/' + bookingId + '/messages', {
      method: 'POST',
      headers: { 'x-admin-key': getAdminKey() },
      body: formData
    });
    const result = await r.json();
    if (!result.ok) throw new Error(result.error || 'Send failed');
    statusEl.textContent = '✓ Sent';
    document.getElementById('bd-msg-subject').value = '';
    document.getElementById('bd-msg-body').value = '';
    fileInput.value = '';
    renderCrmExtras(bookingId);
  } catch (err) {
    statusEl.textContent = '✗ ' + err.message;
  }
}

function faRenderNotesList(notes){
  if (!notes.length) return '';
  // Chronological — oldest first, newest last (reads like a running log)
  const sorted = notes.slice().sort((a,b) => new Date(a.at) - new Date(b.at));
  return `<div style="margin-bottom:0.75rem">${sorted.map(n => `
    <div style="border-left:2px solid var(--border);padding:0.5rem 0 0.5rem 0.8rem;margin-bottom:0.5rem">
      <div style="font-family:'Gudlak Bold',sans-serif;font-size:0.56rem;letter-spacing:0.1em;color:var(--text-dim);text-transform:uppercase;margin-bottom:0.2rem">${n.author||'Admin'} · ${fmtDate(n.at)}</div>
      <div style="font-size:0.88rem;color:var(--text);line-height:1.6">${n.text}</div>
    </div>`).join('')}</div>`;
}

function renderBookingPanelCustomerNote(email){
  const notes = OculttDB.getCustomerNotes(email);
  const safeEmail = (email||'').replace(/'/g,"\\'");
  document.getElementById('bd-customer-notes').innerHTML =
    faRenderNotesList(notes) +
    `<button onclick="editCustomerNoteQuick('${safeEmail}')" style="font-family:'Gudlak Bold',sans-serif;font-size:0.55rem;letter-spacing:0.06em;padding:3px 8px;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--text-dim)">+ ADD CUSTOMER NOTE</button>`;
}

function renderBookingPanelBookingNote(bookingId){
  const notes = OculttDB.getBookingNotes(bookingId);
  document.getElementById('bd-booking-notes').innerHTML =
    faRenderNotesList(notes) +
    `<button onclick="addInternalNoteToBooking('${bookingId}')" style="font-family:'Gudlak Bold',sans-serif;font-size:0.55rem;letter-spacing:0.06em;padding:3px 8px;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--text-dim)">+ ADD BOOKING NOTE</button>`;
}

function editCustomerNoteQuick(email){
  const text = prompt('New note about this customer:', '');
  if (text === null || !text.trim()) return;
  OculttDB.addCustomerNote(email, text);
  renderBookingPanelCustomerNote(email);
  refreshVisibleCrmTables();
}

function addInternalNoteToBooking(bookingId){
  const text = prompt('New internal note for this booking:', '');
  if (text === null || !text.trim()) return;
  OculttDB.addBookingNote(bookingId, text);
  renderBookingPanelBookingNote(bookingId);
  refreshVisibleCrmTables();
}

function editBookingQuick(bookingId){
  const bookings = OculttDB.getBookings();
  const idx = bookings.findIndex(b => b.id === bookingId);
  if (idx === -1) return;
  const b = bookings[idx];
  const newPackage = prompt('Package:', b.package || '');
  if (newPackage === null) return;
  OculttDB.saveBooking({ ...b, package: newPackage.trim() || b.package });
  openBookingDetail(bookingId);
  refreshVisibleCrmTables();
}

function rescheduleBookingQuick(bookingId){
  const bookings = OculttDB.getBookings();
  const idx = bookings.findIndex(b => b.id === bookingId);
  if (idx === -1) return;
  const b = bookings[idx];
  const newDate = prompt('New date (e.g. 20 Aug 2026):', b.date && b.date!=='TBC' ? b.date : '');
  if (newDate === null) return;
  const newTime = prompt('New time (e.g. 4:00 PM):', b.time || '');
  if (newTime === null) return;
  const trimmedDate = newDate.trim() || b.date;
  const trimmedTime = newTime.trim() || b.time;
  const dateChanged = trimmedDate !== b.date || trimmedTime !== b.time;
  const rescheduleHistory = Array.isArray(b.rescheduleHistory) ? b.rescheduleHistory : [];
  const updated = { ...b, date: trimmedDate, time: trimmedTime };
  if (dateChanged) {
    updated.rescheduleHistory = [...rescheduleHistory, { from: `${b.date||'TBC'} · ${b.time||'TBC'}`, to: `${trimmedDate} · ${trimmedTime}`, at: new Date().toISOString() }];
  }
  OculttDB.saveBooking(updated);
  openBookingDetail(bookingId);
  refreshVisibleCrmTables();
}

// Renders a small dashed "Rescheduled" tag next to a status badge when a
// booking has reschedule history. Purely additive — never touches b.status.
function rescheduleTag(b){
  const hist = Array.isArray(b?.rescheduleHistory) ? b.rescheduleHistory : [];
  if (!hist.length) return '';
  const latest = hist[hist.length - 1];
  const title = `Rescheduled ${hist.length > 1 ? hist.length + '× — ' : ''}from ${latest.from} to ${latest.to}`;
  return `<span class="badge-reschedule-tag" title="${title.replace(/"/g,'&quot;')}">↻ Rescheduled</span>`;
}

function cancelBookingQuick(bookingId){
  if (!confirm('Cancel this booking? This will update its status to Cancelled.')) return;
  updateBookingStatus(bookingId, 'Cancelled');
  openBookingDetail(bookingId);
  refreshVisibleCrmTables();
}

function markBookingCompletedQuick(bookingId){
  updateBookingStatus(bookingId, 'Completed');
  openBookingDetail(bookingId);
  refreshVisibleCrmTables();
}

function confirmBookingQuick(bookingId){
  updateBookingStatus(bookingId, 'Scheduled');
  openBookingDetail(bookingId);
  refreshVisibleCrmTables();
}

// Archiving hides a booking from the default Bookings/Dashboard views without
// deleting it — for old completed/cancelled requests Akankshaa wants out of the
// way. It's a separate flag, not a status, so the underlying workflow status
// (Completed, Cancelled, etc.) is preserved and restored on unarchive.
function archiveBookingQuick(bookingId){
  const bookings = OculttDB.getBookings();
  const b = bookings.find(x => x.id === bookingId);
  if (!b) return;
  OculttDB.saveBooking({ ...b, archived: true });
  OculttDB.logActivity({ bookingId, email: b.email, type: 'status', label: 'Booking archived' });
  openBookingDetail(bookingId);
  refreshVisibleCrmTables();
}
function unarchiveBookingQuick(bookingId){
  const bookings = OculttDB.getBookings();
  const b = bookings.find(x => x.id === bookingId);
  if (!b) return;
  OculttDB.saveBooking({ ...b, archived: false });
  OculttDB.logActivity({ bookingId, email: b.email, type: 'status', label: 'Booking unarchived' });
  openBookingDetail(bookingId);
  refreshVisibleCrmTables();
}

function jumpToCustomerProfile(email){
  closeBookingDetail();
  setTimeout(() => openCustomerDetail(email), 380); // wait for close animation
}

function refreshVisibleCrmTables(){
  renderDashboard();
  ['admin-bookings','admin-sessions','admin-spells','admin-customers'].forEach(id => {
    const tab = document.getElementById(id);
    if (tab && tab.style.display !== 'none') {
      if (id==='admin-bookings') renderAdminBookings();
      if (id==='admin-sessions') renderSessionHistory();
      if (id==='admin-spells') renderAdminSpells();
      if (id==='admin-customers') renderAdminCustomers();
    }
  });
  const analyticsTab = document.getElementById('admin-analytics');
  if (analyticsTab && analyticsTab.style.display !== 'none') renderAnalytics();

  // If a Booking Details or Customer Profile panel is currently open, refresh
  // its contents too so live changes made elsewhere show up immediately
  // instead of requiring the admin to close and reopen it.
  const bookingPanel = document.getElementById('booking-detail-panel');
  if (bookingPanel && bookingPanel.classList.contains('is-open') && bookingPanel.dataset.bookingId) {
    openBookingDetail(bookingPanel.dataset.bookingId);
  }
  const customerPanel = document.getElementById('customer-profile-panel');
  if (customerPanel && customerPanel.classList.contains('is-open') && customerPanel.dataset.customerEmail) {
    openCustomerDetail(customerPanel.dataset.customerEmail);
  }
}

function closeBookingDetail() {
  const overlay = document.getElementById('booking-detail-overlay');
  const panel = document.getElementById('booking-detail-panel');
  if (panel) panel.classList.remove('is-open');
  setTimeout(() => {
    if (overlay) overlay.style.display = 'none';
    if (panel) panel.style.display = 'none';
  }, 350);
  document.body.style.overflow = '';
  refreshVisibleCrmTables();
}

async function renderAdminCustomers() {
  const tbody = document.getElementById('customers-tbody');
  const empty = document.getElementById('customers-empty');
  const sub   = document.getElementById('customers-sub');
  if (!tbody) return;

  // Best-effort sync with the live backend — customers created on other
  // devices/browsers are derived from their bookings, so syncing bookings
  // (see syncLiveBookingsIntoLocal) is what brings them in here too.
  await syncLiveBookingsIntoLocal();

  const q = (document.getElementById('customer-search')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('customer-status-filter')?.value || '';
  let customers = OculttDB.getCustomers();
  if (statusFilter) customers = customers.filter(c => (c.status||'New') === statusFilter);
  if (q) customers = customers.filter(c =>
    (c.name||'').toLowerCase().includes(q) ||
    (c.email||'').toLowerCase().includes(q) ||
    (c.phone||'').toLowerCase().includes(q)
  );

  if (sub) sub.textContent = `${customers.length} client${customers.length!==1?'s':''} total`;

  if (!customers.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  const svcs = c => c.services.map(s => {
    const cls = serviceBadgeClass(s);
    const short = s.includes('Numerology') ? 'Numerology'
      : s.includes('Group') ? 'Group'
      : s.includes('Spell') ? 'Spell'
      : s.includes('Energy') ? 'Energy'
      : s.includes('Tarot') ? 'Tarot'
      : s; // fall back to the raw service name rather than silently mislabeling it
    return `<span class="badge ${cls}" style="margin-right:3px">${short}</span>`;
  }).join('');

  const statusCls = st => {
    if(!st) return 'badge-pending';
    if(st==='VIP') return 'badge-vip';
    if(st==='Active') return 'badge-confirmed';
    return 'badge-pending';
  };

  tbody.innerHTML = customers.map(c => `
    <tr onclick="openCustomerDetail('${(c.email||'').replace(/'/g,"\\'")}')" style="cursor:pointer">
      <td><div class="client-cell">
        <div class="avatar">${initials(c.name)}</div>
        <div><div class="client-name">${c.name||'—'}</div></div>
      </div></td>
      <td style="color:var(--text-muted);font-size:0.85rem">${c.email||'—'}</td>
      <td style="color:var(--text-muted);font-size:0.85rem">${c.phone||'—'}</td>
      <td>${svcs(c)}</td>
      <td style="color:var(--gold);text-align:center;font-family:'Gudlak Bold',sans-serif">${c.sessions||0}</td>
      <td style="color:var(--text-muted);font-size:0.82rem">${c.lastBooking ? new Date(c.lastBooking).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—'}</td>
      <td><span class="badge ${statusCls(c.status)}">${c.status||'New'}</span></td>
    </tr>`).join('');
}

// ════════════════════════════════════════════════════════════════════
// ANALYTICS
// ════════════════════════════════════════════════════════════════════
let _analyticsRange = 'all';

const SERVICE_COLORS = {
  'Tarot Reading':  '#2E8B6E',
  'Spell / Magic':  '#6E46B4',
  'Energy Healing': '#C88232',
  'Numerology':     '#3278C8',
  'Group Magic':    '#4A9B8E'
};

function parsePriceToNumber(price){
  if (!price || typeof price !== 'string') return null;
  const digits = price.replace(/[^\d.]/g, '');
  if (!digits) return null;
  const n = parseFloat(digits);
  return isNaN(n) ? null : n;
}

function setAnalyticsRange(range, el){
  _analyticsRange = range;
  document.querySelectorAll('#analytics-range-tabs .range-tab').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderAnalytics();
}

function analyticsRangeStart(range){
  const now = new Date();
  const start = new Date(now);
  if (range === '30') { start.setDate(start.getDate() - 30); }
  else if (range === '60') { start.setDate(start.getDate() - 60); }
  else if (range === 'month') { start.setDate(1); start.setHours(0,0,0,0); }
  else if (range === '6m') { start.setMonth(start.getMonth() - 6); }
  else if (range === 'year') { start.setMonth(0,1); start.setHours(0,0,0,0); }
  else { return null; } // 'all' — lifetime, no start bound
  return start;
}

function renderAnalytics(){
  const allBookings = OculttDB.getBookings();
  const start = analyticsRangeStart(_analyticsRange);
  const bookings = start ? allBookings.filter(b => new Date(b.createdAt) >= start) : allBookings;

  // ── Stat cards ──
  const priced = bookings.map(b => parsePriceToNumber(b.price)).filter(n => n !== null);
  const revenue = priced.reduce((sum, n) => sum + n, 0);
  const avg = priced.length ? Math.round(revenue / priced.length) : 0;

  // New clients = first-ever booking for that email falls inside this range
  const firstBookingByEmail = {};
  allBookings.slice().sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt)).forEach(b => {
    if (b.email && !(b.email in firstBookingByEmail)) firstBookingByEmail[b.email] = b.createdAt;
  });
  const newClients = Object.entries(firstBookingByEmail).filter(([email, createdAt]) => {
    return start ? new Date(createdAt) >= start : true;
  }).length;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('an-stat-bookings', bookings.length);
  set('an-stat-revenue', '₹' + revenue.toLocaleString('en-IN'));
  set('an-stat-clients', newClients);
  set('an-stat-avg', '₹' + avg.toLocaleString('en-IN'));
  set('an-stat-bookings-d', bookings.length ? `${bookings.length} booking${bookings.length!==1?'s':''}` : 'No bookings in this range');
  set('an-stat-revenue-d', priced.length ? `From ${priced.length} priced booking${priced.length!==1?'s':''}` : 'No priced bookings yet');

  renderAnalyticsBarChart(bookings);
  renderAnalyticsDonutChart(bookings);
}

function renderAnalyticsBarChart(bookings){
  const container = document.getElementById('an-bar-chart');
  if (!container) return;
  if (!bookings.length) {
    container.innerHTML = '<p style="font-family:\'Montserrat\',sans-serif;font-style:italic;color:var(--text-dim);padding:2rem 0;text-align:center">No bookings in this range yet.</p>';
    return;
  }

  // Choose a sensible bucket size based on the selected range
  const bucketMode = ['30','60'].includes(_analyticsRange) ? 'day'
    : ['month','6m'].includes(_analyticsRange) ? 'week'
    : 'month';

  const buckets = {}; // key -> count
  function bucketKey(d){
    const dt = new Date(d);
    if (bucketMode === 'day') return dt.toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
    if (bucketMode === 'week') {
      const onejan = new Date(dt.getFullYear(),0,1);
      const week = Math.ceil((((dt - onejan) / 86400000) + onejan.getDay() + 1) / 7);
      return dt.toLocaleDateString('en-IN',{month:'short'}) + ' W' + week;
    }
    return dt.toLocaleDateString('en-IN', { month:'short', year: '2-digit' });
  }
  bookings.forEach(b => {
    const k = bucketKey(b.createdAt);
    buckets[k] = (buckets[k] || 0) + 1;
  });

  // Keep buckets in chronological order as they were first seen (createdAt sorted)
  const sorted = bookings.slice().sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
  const orderedKeys = [];
  sorted.forEach(b => { const k = bucketKey(b.createdAt); if (!orderedKeys.includes(k)) orderedKeys.push(k); });

  // Cap to the most recent 16 buckets so it never gets unreadably dense
  const visibleKeys = orderedKeys.slice(-16);
  const maxCount = Math.max(...visibleKeys.map(k => buckets[k]));

  container.innerHTML = `<div class="an-bar-row">${visibleKeys.map(k => {
    const count = buckets[k];
    const heightPct = Math.max(4, Math.round((count / maxCount) * 100));
    return `<div class="an-bar-col">
      <div class="an-bar-value">${count}</div>
      <div class="an-bar" style="height:${heightPct}%"></div>
      <div class="an-bar-label">${k}</div>
    </div>`;
  }).join('')}</div>`;
}

function renderAnalyticsDonutChart(bookings){
  const container = document.getElementById('an-donut-chart');
  if (!container) return;
  if (!bookings.length) {
    container.innerHTML = '<p style="font-family:\'Montserrat\',sans-serif;font-style:italic;color:var(--text-dim);padding:2rem 0;text-align:center">No bookings yet.</p>';
    return;
  }

  const counts = {};
  bookings.forEach(b => { const s = b.service || 'Other'; counts[s] = (counts[s]||0) + 1; });
  const total = bookings.length;
  const entries = Object.entries(counts).sort((a,b) => b[1]-a[1]);

  const radius = 52, circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = entries.map(([service, count]) => {
    const frac = count / total;
    const dash = frac * circumference;
    const seg = `<circle cx="70" cy="70" r="${radius}" fill="none" stroke="${SERVICE_COLORS[service]||'#999'}" stroke-width="18"
      stroke-dasharray="${dash} ${circumference-dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"/>`;
    offset += dash;
    return seg;
  }).join('');

  const legend = entries.map(([service, count]) => `
    <div class="an-donut-legend-item">
      <span class="an-donut-swatch" style="background:${SERVICE_COLORS[service]||'#999'}"></span>
      <span>${service} — ${count} (${Math.round(count/total*100)}%)</span>
    </div>`).join('');

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center">
      <svg width="140" height="140" viewBox="0 0 140 140">${segments}
        <text x="70" y="66" text-anchor="middle" font-family="'Gudlak Bold',sans-serif" font-size="22" fill="var(--gold)">${total}</text>
        <text x="70" y="82" text-anchor="middle" font-family="'Gudlak Bold',sans-serif" font-size="8" letter-spacing="1" fill="var(--text-dim)">TOTAL</text>
      </svg>
    </div>
    <div class="an-donut-legend">${legend}</div>`;
}

function renderSessionHistory() {
  const tbody = document.getElementById('sessions-tbody');
  const empty = document.getElementById('sessions-empty');
  const sub   = document.getElementById('sessions-sub');
  if (!tbody) return;

  const q = (document.getElementById('session-search')?.value || '').toLowerCase();
  const serviceFilter = document.getElementById('session-service-filter')?.value || '';
  const dateFilter = document.getElementById('session-date-filter')?.value || '';

  let bookings = OculttDB.getBookings()
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // explicit reverse chronological

  if (q) bookings = bookings.filter(b => (b.name||'').toLowerCase().includes(q));

  if (serviceFilter) bookings = bookings.filter(b => (b.service||'').toLowerCase().includes(serviceFilter.toLowerCase()));

  if (dateFilter) bookings = bookings.filter(b => {
    if (!b.createdAt) return false;
    const bDate = new Date(b.createdAt).toISOString().slice(0,10);
    return bDate === dateFilter;
  });

  if (sub) sub.textContent = `${bookings.length} session${bookings.length!==1?'s':''} total`;

  if (!bookings.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  tbody.innerHTML = bookings.map(b => {
    const note = OculttDB.getSessionNote(b.id);
    const safeName = (b.name||'').replace(/'/g, "\\'");
    const noteCell = note
      ? `<div style="max-width:220px;font-size:0.85rem;color:var(--text-muted);font-style:italic;cursor:pointer;line-height:1.5" onclick="editSessionNote('${b.id}','${safeName}')" title="Click to edit">${note.text.length>90 ? note.text.slice(0,90)+'…' : note.text}</div>`
      : `<button onclick="editSessionNote('${b.id}','${safeName}')" style="font-family:'Gudlak Bold',sans-serif;font-size:0.58rem;letter-spacing:0.08em;padding:4px 10px;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--text-dim)">+ ADD SUMMARY</button>`;

    return `<tr class="crm-row-clickable" onclick="openBookingDetail('${b.id}')">
      <td style="font-size:0.8rem;color:var(--text-muted)">${fmtDate(b.createdAt)}</td>
      <td><div class="client-cell">
        <div class="avatar">${initials(b.name)}</div>
        <div>
          <div class="client-name">${b.name || '—'}</div>
          <div class="client-email">${b.email || ''}</div>
        </div>
      </div></td>
      <td><span class="badge ${serviceBadgeClass(b.service)}">${b.service || '—'}</span></td>
      <td style="color:var(--text-muted);font-size:0.85rem">${b.package || '—'}</td>
      <td><span class="badge ${statusBadgeClass(b.status)}">${b.status || '—'}</span>${rescheduleTag(b)}</td>
      <td onclick="event.stopPropagation()">${noteCell}</td>
    </tr>`;
  }).join('');
}

function editSessionNote(bookingId, clientName) {
  const existing = OculttDB.getSessionNote(bookingId);
  const text = prompt('Session summary for ' + clientName + ':', existing ? existing.text : '');
  if (text === null) return; // cancelled — leave unchanged
  OculttDB.saveSessionNote(bookingId, text);
  renderSessionHistory();
}

let _lastLiveBookingsSyncAt = 0;
const LIVE_BOOKINGS_SYNC_MIN_INTERVAL_MS = 15000;
let _lastSignedInUsersSyncAt = 0;
const SIGNED_IN_USERS_SYNC_MIN_INTERVAL_MS = 15000;
async function syncSignedInUsersIntoLocal() {
  if (!OCULTT_BACKEND_CONNECTED || !getAdminKey()) return false;
  if (Date.now() - _lastSignedInUsersSyncAt < SIGNED_IN_USERS_SYNC_MIN_INTERVAL_MS) return false;
  try {
    const { users, error } = await apiGet('/users');
    if (error) throw new Error(error);
    OculttDB.mergeRemoteUsers(users || []);
    _lastSignedInUsersSyncAt = Date.now();
    return true;
  } catch (err) {
    console.warn('[syncSignedInUsersIntoLocal] live API unavailable, using local data only:', err.message);
    return false;
  }
}
async function renderDashboard(forceSync) {
  // Best-effort sync with the live backend so today's stats reflect bookings
  // made on other devices/browsers too — falls back to local data if the
  // live API is unreachable or this isn't an authenticated admin session.
  await syncLiveBookingsIntoLocal(forceSync);
  // Same idea, but for customer accounts (Google sign-ins) — including
  // someone who signed in but hasn't booked yet, who otherwise wouldn't
  // show up anywhere in the CRM.
  await syncSignedInUsersIntoLocal();

  const bookings  = OculttDB.getBookings().filter(b => !b.archived);
  const customers = OculttDB.getCustomers();
  const today     = new Date().toDateString();
  const todayISO  = new Date().toISOString().slice(0,10);

  const set = (id, v) => { const el=document.getElementById(id); if(el) el.textContent=v; };

  // New Bookings Today (created today)
  const todayCount = bookings.filter(b => new Date(b.createdAt).toDateString() === today).length;
  set('dash-today', todayCount);
  set('dash-today-d', todayCount ? `${todayCount} booking${todayCount!==1?'s':''} today` : 'No bookings today yet');

  // Today's Sessions (scheduled FOR today, not just created today)
  const todaySessions = bookings.filter(b => b.date && b.date !== 'TBC' && b.date.includes(new Date().getFullYear()) &&
    new Date(b.date).toDateString && !isNaN(new Date(b.date)) && new Date(b.date).toDateString() === today).length;
  set('dash-today-sessions', todaySessions);
  set('dash-today-sessions-d', todaySessions ? `${todaySessions} session${todaySessions!==1?'s':''} scheduled` : 'Nothing scheduled today');

  // Tomorrow's Sessions
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const tomorrowStr = tomorrow.toDateString();
  const tomorrowSessions = bookings.filter(b => b.date && b.date !== 'TBC' &&
    !isNaN(new Date(b.date)) && new Date(b.date).toDateString() === tomorrowStr).length;
  set('dash-tomorrow-sessions', tomorrowSessions);
  set('dash-tomorrow-sessions-d', tomorrowSessions ? `${tomorrowSessions} session${tomorrowSessions!==1?'s':''} scheduled` : 'Nothing scheduled yet');

  // Upcoming — next 7 days (excludes today), active bookings only
  const in7 = new Date(); in7.setDate(in7.getDate()+7); in7.setHours(23,59,59,999);
  const startOfTomorrow = new Date(); startOfTomorrow.setDate(startOfTomorrow.getDate()+1); startOfTomorrow.setHours(0,0,0,0);
  const upcomingCount = bookings.filter(b => {
    if (!b.date || b.date === 'TBC') return false;
    const d = new Date(b.date);
    return !isNaN(d) && d >= startOfTomorrow && d <= in7
      && !(b.status||'').toLowerCase().includes('cancel') && !(b.status||'').toLowerCase().includes('complete');
  }).length;
  set('dash-upcoming', upcomingCount);
  set('dash-upcoming-d', upcomingCount ? `${upcomingCount} in the next 7 days` : 'Nothing in the next 7 days');

  // Pending Confirmations — bookings still awaiting a scheduled date/confirmation
  const pendingConfirm = bookings.filter(b => ['booking received','pending review','waiting for akanksha'].includes((b.status||'').toLowerCase())).length;
  set('dash-pending-confirm', pendingConfirm);
  set('dash-pending-confirm-d', pendingConfirm ? `${pendingConfirm} awaiting confirmation` : 'All confirmed');

  // Pending Spell Requests (not yet completed)
  const pendingSpells = bookings.filter(b => (b.service||'').includes('Spell') && (b.status||'')!=='Completed' && !(b.status||'').toLowerCase().includes('cancel')).length;
  set('dash-pending-spells', pendingSpells);
  set('dash-pending-spells-d', pendingSpells ? `${pendingSpells} in progress` : 'All caught up');

  // Pending Follow-ups (due today or overdue)
  let followupsDue = 0;
  try {
    const raw = JSON.parse(localStorage.getItem('ocultt_followups_v1') || '{}');
    followupsDue = Object.values(raw).filter(f => f.date && f.date <= todayISO).length;
  } catch(e) {}
  set('dash-followups', followupsDue);
  set('dash-followups-d', followupsDue ? `${followupsDue} due or overdue` : 'None scheduled');

  // Pending Payments (unpaid, but has a real price to collect)
  const pendingPayments = bookings.filter(b => (b.paymentStatus||'Unpaid')==='Unpaid' && parsePriceToNumber(b.price)).length;
  set('dash-pending-payments', pendingPayments);
  set('dash-pending-payments-d', pendingPayments ? `${pendingPayments} awaiting payment` : 'All settled');

  // Recently Uploaded Files (last 48 hours, across all customers)
  let recentFiles = 0;
  try {
    const allActivity = JSON.parse(localStorage.getItem('ocultt_file_activity_v1') || '{}');
    const cutoff = Date.now() - 48*60*60*1000;
    Object.values(allActivity).forEach(list => {
      recentFiles += list.filter(f => new Date(f.at).getTime() >= cutoff).length;
    });
  } catch(e) {}
  set('dash-recent-files', recentFiles);
  set('dash-recent-files-d', recentFiles ? `${recentFiles} file${recentFiles!==1?'s':''} added` : 'None recently');

  set('dash-total', bookings.length);
  set('dash-total-d', 'Across all services');
  set('dash-clients', customers.length);
  set('dash-clients-d', customers.length ? `${customers.length} unique client${customers.length!==1?'s':''}` : 'No clients yet');

  renderAdminNotifications();

  // Recent bookings in dashboard
  const rTbody = document.getElementById('dash-recent-tbody');
  const rEmpty = document.getElementById('dash-recent-empty');
  if (rTbody) {
    const recent = bookings.slice(0, 8);
    if (!recent.length) {
      rTbody.innerHTML = '';
      if (rEmpty) rEmpty.style.display = 'block';
    } else {
      if (rEmpty) rEmpty.style.display = 'none';
      rTbody.innerHTML = recent.map(b => `
        <tr class="crm-row-clickable" onclick="openBookingDetail('${b.id}')">
          <td style="color:var(--text-dim);font-size:0.8rem">${fmtDate(b.createdAt)}</td>
          <td><div class="client-cell">
            <div class="avatar">${initials(b.name)}</div>
            <div><div class="client-name">${b.name||'—'}</div>
                 <div class="client-email">${b.email||''}</div></div>
          </div></td>
          <td><span class="badge ${serviceBadgeClass(b.service)}">${b.service||'—'}</span></td>
          <td style="color:var(--text-muted);font-size:0.85rem">${b.package||'—'}</td>
          <td style="color:var(--text-muted);font-size:0.82rem">${b.date||'TBC'} ${b.time?'· '+b.time:''}</td>
          <td><span class="badge ${statusBadgeClass(b.status)}">${b.status||'—'}</span>${rescheduleTag(b)}</td>
        </tr>`).join('');
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// ADMIN NOTIFICATIONS — computed live from existing booking/customer/
// follow-up/file-activity data. UI-only; no new backend required.
// ════════════════════════════════════════════════════════════════════
function toggleAdminNotifications(e){
  if (e) e.stopPropagation();
  const panel = document.getElementById('admin-notif-panel');
  if (!panel) return;
  panel.classList.toggle('is-open');
}
function closeAdminNotifications(){
  const panel = document.getElementById('admin-notif-panel');
  if (panel) panel.classList.remove('is-open');
}
document.addEventListener('click', function(e){
  const panel = document.getElementById('admin-notif-panel');
  const wrap = document.querySelector('.admin-notif-wrap');
  if (panel && panel.classList.contains('is-open') && wrap && !wrap.contains(e.target)) {
    panel.classList.remove('is-open');
  }
});
function notifTimeAgo(iso){
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff/60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs/24) + 'd ago';
}
function renderAdminNotifications(){
  const listEl  = document.getElementById('admin-notif-list');
  const badgeEl = document.getElementById('admin-notif-badge');
  const countEl = document.getElementById('admin-notif-count');
  if (!listEl) return;

  const bookings  = OculttDB.getBookings();
  const customers = OculttDB.getCustomers();
  const todayISO  = new Date().toISOString().slice(0,10);
  const cutoff48h = Date.now() - 48*60*60*1000;
  const items = [];

  bookings.filter(b => b.createdAt && new Date(b.createdAt).getTime() >= cutoff48h).forEach(b => {
    items.push({ icon:'✦', text:`New booking — ${b.name||'Client'} requested ${b.service||'a session'}`, at:b.createdAt, urgent:false, action:`openBookingDetail('${b.id}')` });
  });
  customers.filter(c => c.firstSeen && new Date(c.firstSeen).getTime() >= cutoff48h).forEach(c => {
    const safeEmail = (c.email||'').replace(/'/g,"\\'");
    items.push({ icon:'☆', text:`New client — ${c.name||c.email} joined`, at:c.firstSeen, urgent:false, action:`openCustomerDetail('${safeEmail}')` });
  });
  try {
    const raw = JSON.parse(localStorage.getItem('ocultt_followups_v1') || '{}');
    Object.entries(raw).forEach(([email, f]) => {
      if (f && f.date && f.date <= todayISO) {
        const overdue = f.date < todayISO;
        const safeEmail = email.replace(/'/g,"\\'");
        items.push({ icon:'📅', text:`Follow-up ${overdue?'overdue':'due today'} — ${email}${f.note?': '+f.note:''}`, at:f.setAt||f.date, urgent:true, action:`openCustomerDetail('${safeEmail}')` });
      }
    });
  } catch(e){}
  bookings.filter(b => (b.paymentStatus||'Unpaid')==='Unpaid' && parsePriceToNumber(b.price)).forEach(b => {
    items.push({ icon:'₹', text:`Payment pending — ${b.name||'Client'} (${b.price})`, at:b.createdAt, urgent:true, action:`openBookingDetail('${b.id}')` });
  });
  try {
    const allActivity = JSON.parse(localStorage.getItem('ocultt_file_activity_v1') || '{}');
    Object.entries(allActivity).forEach(([email, list]) => {
      const safeEmail = email.replace(/'/g,"\\'");
      (list||[]).filter(f => f.at && new Date(f.at).getTime() >= cutoff48h).forEach(f => {
        items.push({ icon:'📎', text:`${email} uploaded a file — ${f.label||''}`, at:f.at, urgent:false, action:`openCustomerDetail('${safeEmail}')` });
      });
    });
  } catch(e){}

  items.sort((a,b) => new Date(b.at) - new Date(a.at));
  const urgentCount = items.filter(i => i.urgent).length;
  const showCount = urgentCount || items.length;

  if (badgeEl) {
    badgeEl.textContent = showCount > 9 ? '9+' : showCount;
    badgeEl.classList.toggle('has-items', showCount > 0);
  }
  if (countEl) countEl.textContent = `${items.length} update${items.length!==1?'s':''}`;

  if (!items.length) {
    listEl.innerHTML = `<div class="admin-notif-empty">You're all caught up — nothing needs attention.</div>`;
    return;
  }
  listEl.innerHTML = items.slice(0,20).map(i => `
    <div class="admin-notif-item" onclick="closeAdminNotifications();${i.action}">
      <span class="admin-notif-icon">${i.icon}</span>
      <span class="admin-notif-text">${i.text}<span class="admin-notif-time">${notifTimeAgo(i.at)}</span></span>
    </div>`).join('');
}

// Initial render on page load
document.addEventListener('DOMContentLoaded', () => {
  renderDashboard();
});
renderDashboard();

/* ══════════════════════════════════════
   GOOGLE AUTH — fully fixed v13
   Fixes applied:
   1. sessionStorage → localStorage  (persists across refresh)
   2. Empty CLIENT_ID → functional demo button shown instead
   3. renderButton called only after GIS + DOM both ready (no race)
   4. Avatar handles both <img> and initials correctly
   5. Single clean initialisation path
   6. Logout properly clears state and revokes GIS auto-select
══════════════════════════════════════ */

// ── CONFIG ──────────────────────────────────────────────────────
// Add your Client ID from console.cloud.google.com to enable real Google login.
// Leave empty to use demo mode (fully functional mock sign-in).
const GAUTH_CLIENT_ID = '450095432933-b5cj1hhkjbtk5q0v4n12u31ior80plmd.apps.googleusercontent.com';

const GAUTH_STORAGE_KEY = 'ocultt_user_v1';

// ── CRM ACCESS CONTROL ─────────────────────────────────────────────
// Only Google accounts listed here may open the CRM. Add Akankshaa's real
// Google email before deploying — e.g. ADMIN_EMAILS = ['the.ocultt.tarot@gmail.com'].
// 'demo@ocultt.com' matches the built-in demo sign-in so the CRM gate can be
// tested end-to-end before real Firebase credentials are configured.
const ADMIN_EMAILS = ['demo@ocultt.com', 'ocultt05tarot@gmail.com', 'Akankshachoudhary10@gmail.com', 'dishasoni99@gmail.com', 'the.ocultt.tarot@gmail.com'];

function getCurrentAuthUser(){
  try {
    const stored = localStorage.getItem(GAUTH_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    return (parsed && parsed.email) ? parsed : null;
  } catch(e) { return null; }
}

function isAdminUser(){
  const user = getCurrentAuthUser();
  if (!user) return false;
  return ADMIN_EMAILS.map(e => e.toLowerCase()).includes(user.email.toLowerCase());
}

// ── HIDDEN ADMIN ENTRY: complete the pending dashboard navigation ──────
// showPage('admin') opens this sign-in modal when an unauthenticated
// visitor triggers the hidden admin entry (logo clicks / secret sequence)
// and sets _pendingAdminEntry = true right before doing so. Every sign-in
// success handler below calls this afterward so a successful login for an
// authorized admin account actually lands in the dashboard, instead of
// just closing the modal and leaving the visitor on whatever page they
// started from. Ordinary "Sign In" (nav link) logins never set the flag,
// so they are correctly left alone — no unexpected redirect for a normal
// visitor just signing in.
let _pendingAdminEntry = false;
// Restore across a mobile signInWithRedirect reload — the in-memory flag
// above resets on every page load, but sessionStorage survives it. Only
// meaningful until handleRedirectResult() (called below) resolves.
try { if (sessionStorage.getItem('ocultt_pending_admin_entry') === '1') _pendingAdminEntry = true; } catch(e) {}

function _completePendingAdminEntry(user){
  if (!_pendingAdminEntry) return;
  if (!user) return; // still signed out — nothing to do yet
  _pendingAdminEntry = false;
  try { sessionStorage.removeItem('ocultt_pending_admin_entry'); } catch(e) {}
  if (isAdminUser()) {
    showPage('admin');
  } else if (typeof showToast === 'function') {
    showToast('This Google account does not have admin access.');
  }
}

// ── MODAL ────────────────────────────────────────────────────────
function openGauthModal() {
  document.getElementById('gauthOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  // Render the correct button depending on which auth method is active
  if (window.OculttFirebase && window.OculttFirebase.isConfigured()) {
    _gauthRenderFirebaseButton();          // Firebase + Google popup
  } else if (GAUTH_CLIENT_ID && window.google && window.google.accounts) {
    _gauthRenderButton();                  // Legacy GIS fallback
  } else {
    _gauthRenderDemoButton();              // Demo mode (no credentials yet)
  }
}

function closeGauthModalDirect() {
  document.getElementById('gauthOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

function closeGauthModal(e) {
  if (e.target === document.getElementById('gauthOverlay')) {
    closeGauthModalDirect();
  }
}

// ── UI UPDATE ─────────────────────────────────────────────────────
function gauthUpdateUI(user) {
  if (user && user.email && typeof OculttDB !== 'undefined' && OculttDB.linkCustomerAccount) {
    try { OculttDB.linkCustomerAccount(user); } catch(e) {}
  }
  const signinLink = document.getElementById('navSigninLink');
  const userPill   = document.getElementById('navUserPill');
  const userName   = document.getElementById('navUserName');
  const avatarEl   = document.getElementById('navUserAvatar');
  const logoutBtn  = document.getElementById('navLogoutBtn');

  if (!signinLink || !userPill || !userName || !avatarEl || !logoutBtn) return;

  if (user && (user.name || user.email)) {
    const parts     = (user.name || user.email || '').trim().split(/\s+/);
    const firstName = parts[0] || 'Friend';
    const initials  = parts.slice(0, 2).map(function(w){ return w[0]; }).join('').toUpperCase() || '?';

    signinLink.style.display = 'none';
    userPill.style.display   = 'flex';
    logoutBtn.style.display  = 'inline-block';
    userName.textContent     = firstName;

    // Avatar: photo if available, else initials
    avatarEl.innerHTML = '';
    if (user.picture) {
      var img    = new Image();
      img.src    = user.picture;
      img.alt    = initials;
      img.style.cssText = 'width:24px;height:24px;border-radius:50%;object-fit:cover;display:block;flex-shrink:0';
      img.onerror = function() { avatarEl.textContent = initials; };
      avatarEl.appendChild(img);
    } else {
      avatarEl.textContent = initials;
    }
  } else {
    signinLink.style.display = '';
    userPill.style.display   = 'none';
    logoutBtn.style.display  = 'none';
    avatarEl.innerHTML       = '';
    userName.textContent     = '';
  }
}

// ── REAL GOOGLE CREDENTIAL HANDLER ───────────────────────────────
function gauthHandleCredential(response) {
  try {
    var parts   = response.credential.split('.');
    var segment = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // Pad to a multiple of 4
    while (segment.length % 4) segment += '=';
    var payload = JSON.parse(atob(segment));

    var user = {
      name:    payload.name    || payload.email || '',
      email:   payload.email   || '',
      picture: payload.picture || '',
      loggedInAt: Date.now()
    };

    localStorage.setItem(GAUTH_STORAGE_KEY, JSON.stringify(user));
    gauthUpdateUI(user);
    closeGauthModalDirect();
    _completePendingAdminEntry(user);
  } catch (err) {
    console.error('[Ocultt Auth] Credential decode failed:', err);
  }
}

// ── DEMO SIGN-IN (shown when GAUTH_CLIENT_ID is empty) ────────────
function gauthDemoSignIn() {
  var user = { name: 'Demo User', email: 'demo@ocultt.com', picture: '', loggedInAt: Date.now() };
  localStorage.setItem(GAUTH_STORAGE_KEY, JSON.stringify(user));
  gauthUpdateUI(user);
  closeGauthModalDirect();
  _completePendingAdminEntry(user);
}

// ── SESSION EXPIRATION (legacy / demo sign-in only) ────────────────
// Real Firebase sessions manage their own token lifetime via the SDK's
// own onAuthStateChanged — left untouched. This only applies to the
// legacy-GIS / demo fallback, which has no server session to check against.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches "persistent login"
function checkSessionExpiry() {
  if (window.OculttFirebase && window.OculttFirebase.isConfigured()) return; // Firebase owns this
  try {
    const stored = localStorage.getItem(GAUTH_STORAGE_KEY);
    if (!stored) return;
    const parsed = JSON.parse(stored);
    if (parsed && parsed.loggedInAt && (Date.now() - parsed.loggedInAt) > SESSION_TTL_MS) {
      localStorage.removeItem(GAUTH_STORAGE_KEY);
      gauthUpdateUI(null);
      if (typeof showToast === 'function') showToast('Your session has expired — please sign in again.');
    }
  } catch (e) {}
}

// ── SIGN OUT ──────────────────────────────────────────────────────
function gauthSignOut() {
  if (window.OculttFirebase && window.OculttFirebase.isConfigured()) {
    // Firebase sign-out — clears Firebase session + localStorage
    window.OculttFirebase.signOut()
      .then(function () {
        gauthUpdateUI(null);
        // Re-render sign-in button so the next visitor can log in
        setTimeout(_gauthRenderFirebaseButton, 150);
      })
      .catch(function (err) {
        console.error('[OculttAuth] Firebase sign-out error:', err);
        // Force local sign-out even if Firebase call failed
        localStorage.removeItem(GAUTH_STORAGE_KEY);
        gauthUpdateUI(null);
      });
  } else {
    // Legacy / demo mode sign-out
    localStorage.removeItem(GAUTH_STORAGE_KEY);
    if (window.google && window.google.accounts && window.google.accounts.id) {
      try { window.google.accounts.id.disableAutoSelect(); } catch(e) {}
    }
    gauthUpdateUI(null);
    var btn = document.getElementById('gauth-google-btn');
    if (btn) btn.innerHTML = '';
    if (GAUTH_CLIENT_ID && window.google && window.google.accounts) {
      setTimeout(_gauthRenderButton, 150);
    } else {
      _gauthRenderDemoButton();
    }
  }
}

// ── RENDER FIREBASE GOOGLE BUTTON ────────────────────────────────
// This replaces the GIS renderButton when Firebase credentials are set.
// It creates a Google-branded button whose click handler calls
// OculttFirebase.signInWithGoogle() (popup flow) instead of GIS.
function _gauthRenderFirebaseButton() {
  var container = document.getElementById('gauth-google-btn');
  if (!container) return;

  // Google "G" logo SVG — matches official brand guidelines
  var GOOGLE_ICON = '<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">'
    + '<path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>'
    + '<path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>'
    + '<path d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z" fill="#FBBC05"/>'
    + '<path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>'
    + '</svg>';

  // Render button — same visual style as the existing demo button
  container.innerHTML = '<button id="_gauth-fb-btn"'
    + ' style="display:flex;align-items:center;justify-content:center;gap:10px;width:280px;padding:10px 24px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer;font-family:Roboto,Arial,sans-serif;font-size:14px;color:#3c4043;font-weight:500;letter-spacing:0.25px;box-shadow:0 1px 3px rgba(0,0,0,0.12);transition:box-shadow 0.2s"'
    + ' onmouseover="this.style.boxShadow=\'0 2px 8px rgba(0,0,0,0.18)\'"'
    + ' onmouseout="this.style.boxShadow=\'0 1px 3px rgba(0,0,0,0.12)\'">' 
    + GOOGLE_ICON
    + 'Continue with Google</button>';

  var btn = document.getElementById('_gauth-fb-btn');
  if (!btn) return;

  btn.addEventListener('click', function () {
    // Prevent double-clicks while the popup is open
    btn.disabled = true;
    btn.style.opacity = '0.65';
    btn.style.cursor  = 'default';
    btn.textContent   = 'Opening Google…';

    window.OculttFirebase.signInWithGoogle()
      .then(function (user) {
        // Success — update nav pill and close the modal
        gauthUpdateUI(user);
        closeGauthModalDirect();
        // If this login was requested by the hidden admin entry, continue
        // on into the dashboard now that the user object (and the
        // localStorage it was persisted to) is available.
        _completePendingAdminEntry(user);
      })
      .catch(function (err) {
        // Restore the button so the user can try again
        _gauthRenderFirebaseButton();
        // Ignore "user closed the popup" — not an error worth logging
        if (err.code !== 'auth/popup-closed-by-user' &&
            err.code !== 'auth/cancelled-popup-request') {
          console.error('[OculttAuth] Google sign-in failed:', err.code, err.message);
        }
      });
  });
}

// ── RENDER REAL GOOGLE BUTTON ─────────────────────────────────────
function _gauthRenderButton() {
  var container = document.getElementById('gauth-google-btn');
  if (!container) return;
  if (!GAUTH_CLIENT_ID || !window.google || !window.google.accounts || !window.google.accounts.id) return;

  container.innerHTML = '';
  try {
    window.google.accounts.id.renderButton(container, {
      theme:  'outline',
      size:   'large',
      text:   'continue_with',
      shape:  'rectangular',
      width:  280
    });
  } catch (e) {
    console.warn('[Ocultt Auth] renderButton failed:', e);
  }
}

// ── RENDER DEMO BUTTON ────────────────────────────────────────────
function _gauthRenderDemoButton() {
  var container = document.getElementById('gauth-google-btn');
  if (!container) return;
  container.innerHTML = '<button onclick="gauthDemoSignIn()" style="display:flex;align-items:center;justify-content:center;gap:10px;width:280px;padding:10px 24px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer;font-family:Roboto,Arial,sans-serif;font-size:14px;color:#3c4043;font-weight:500;letter-spacing:0.25px;box-shadow:0 1px 3px rgba(0,0,0,0.12);transition:box-shadow 0.2s" onmouseover="this.style.boxShadow=\'0 2px 8px rgba(0,0,0,0.18)\'" onmouseout="this.style.boxShadow=\'0 1px 3px rgba(0,0,0,0.12)\'">'
    + '<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>'
    + '<path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>'
    + '<path d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z" fill="#FBBC05"/>'
    + '<path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>'
    + '</svg>Continue with Google</button>'
    + '<p style="font-family:\'Gudlak Bold\',sans-serif;font-size:0.46rem;letter-spacing:0.22em;color:var(--text-dim);text-transform:uppercase;margin-top:0.8rem;text-align:center">Demo mode · Add Client ID for real Google login</p>';
}

// ── INITIALISE ────────────────────────────────────────────────────
function gauthInit() {
  checkSessionExpiry();
  // ── PATH A: Firebase credentials are configured ───────────────────
  if (window.OculttFirebase && window.OculttFirebase.isConfigured()) {
    // Register the auth-state listener.
    // Firebase calls this immediately with the cached user (or null),
    // which restores the nav pill on page load without an extra network
    // round-trip. It fires again on every sign-in and sign-out.
    window.OculttFirebase.onAuthStateChanged(function (user) {
      gauthUpdateUI(user);
      // If user just signed out and the modal happens to be open,
      // refresh the button so it is ready for the next visitor.
      if (!user) {
        sessionStorage.removeItem('ocultt_admin_key');
        var container = document.getElementById('gauth-google-btn');
        if (container && container.innerHTML === '') {
          _gauthRenderFirebaseButton();
        }
      } else {
        // Real backend admin auth: store the actual Firebase ID token as
        // the admin key (see getAdminKey()/adminHeaders() below) so the
        // CRM API routes can verify who is really calling them, not just
        // trust a client-side email check. Refreshed on every auth-state
        // change, which Firebase also fires periodically as the token
        // silently renews.
        window.OculttFirebase.getIdToken().then(function (token) {
          if (token) sessionStorage.setItem('ocultt_admin_key', token);
        }).catch(function (e) { console.warn('[gauthInit] getIdToken failed:', e.message); });
      }
      // Covers every real sign-in path (this listener fires after every
      // Firebase auth-state change, including the popup handler above) —
      // continues the hidden admin entry into the dashboard once a user
      // is present, without duplicating work if the button handler above
      // already completed it (_completePendingAdminEntry no-ops once the
      // flag is cleared).
      _completePendingAdminEntry(user);
    });

    // Complete the mobile signInWithRedirect() flow (see
    // OculttFirebase.signInWithGoogle) if this page load is the redirect
    // coming back from Google. onAuthStateChanged above already handles
    // the success case (Firebase fires it automatically once the
    // redirect result is available), so this call exists mainly to catch
    // and surface redirect-specific errors (e.g. an account conflict)
    // that onAuthStateChanged alone would never report — those otherwise
    // fail silently and just look like "still signed out".
    window.OculttFirebase.handleRedirectResult().catch(function (err) {
      _pendingAdminEntry = false;
      try { sessionStorage.removeItem('ocultt_pending_admin_entry'); } catch(e) {}
      console.error('[OculttAuth] Redirect sign-in failed:', err.code, err.message);
      if (typeof showToast === 'function') showToast('Sign-in failed — please try again.');
    });

    // Pre-render the Firebase button inside the modal so it is ready
    // before the user clicks "Enter the Sanctum".
    _gauthRenderFirebaseButton();
    return;
  }

  // ── PATH B: Firebase not yet configured — legacy / demo mode ──────
  // Restore persisted login from localStorage immediately (survives refresh)
  try {
    var stored = localStorage.getItem(GAUTH_STORAGE_KEY);
    if (stored) {
      var parsed = JSON.parse(stored);
      if (parsed && parsed.email) gauthUpdateUI(parsed);
    }
  } catch (e) {}

  // No GIS Client ID → show demo button and stop
  if (!GAUTH_CLIENT_ID) {
    _gauthRenderDemoButton();
    return;
  }

  // GIS not loaded yet → the <script onload="gauthInit()"> will retry
  if (!window.google || !window.google.accounts || !window.google.accounts.id) {
    return;
  }

  // Initialise legacy GIS and render the native Google button
  try {
    window.google.accounts.id.initialize({
      client_id:             GAUTH_CLIENT_ID,
      callback:              gauthHandleCredential,
      auto_select:           false,
      cancel_on_tap_outside: true
    });
  } catch (e) {
    console.error('[Ocultt Auth] GIS initialize failed:', e);
    return;
  }

  _gauthRenderButton();
}

// ── MULTI-TAB SYNC ──────────────────────────────────────────────────
// localStorage writes don't fire a 'storage' event in the tab that made
// them — only in *other* open tabs. So signing in/out in one tab updates
// every other open tab's nav pill (and CRM access) without a manual refresh.
window.addEventListener('storage', function (e) {
  if (e.key !== GAUTH_STORAGE_KEY) return;
  let user = null;
  try { user = e.newValue ? JSON.parse(e.newValue) : null; } catch (err) {}
  gauthUpdateUI(user);
  // If the CRM is open in this tab and the account that just changed no
  // longer qualifies as admin, back out to Home immediately.
  const adminPage = document.getElementById('page-admin');
  if (adminPage && adminPage.classList.contains('active') && !isAdminUser()) {
    showPage('home');
  }
});

// Expose so the GIS <script onload="..."> can call it
window.gauthInit = gauthInit;

// Boot: run now if DOM ready, else wait for it
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', gauthInit);
} else {
  gauthInit();
}

// Re-check session expiry hourly for tabs left open long-term
setInterval(checkSessionExpiry, 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════════════
// EMAIL QUEUE — persistent staging for booking confirmation emails
// ════════════════════════════════════════════════════════════════════

// In-memory array as specified; also mirrored to localStorage for persistence
const emailQueue = [];

const EmailQueue = (() => {
  const STORAGE_KEY = 'ocultt_email_queue_v1';

  function _load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch(e) { return []; }
  }
  function _persist(queue) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(queue)); } catch(e) {}
  }

  // Sync in-memory emailQueue array with localStorage on init
  function init() {
    const stored = _load();
    emailQueue.length = 0;
    stored.forEach(function(item) { emailQueue.push(item); });
  }

  function enqueue(payload) {
    emailQueue.unshift(payload);            // keep newest-first in memory
    _persist(emailQueue);
    // Refresh Email Queue tab if it is currently open
    const tab = document.getElementById('admin-emailqueue');
    if (tab && tab.style.display !== 'none') renderEmailQueue();
  }

  function markSent(id) {
    emailQueue.forEach(function(item) {
      if (item.id === id) { item.status = 'Sent'; item.sentAt = new Date().toISOString(); }
    });
    _persist(emailQueue);
    renderEmailQueue();
  }

  function clearSent() {
    var kept = emailQueue.filter(function(item) { return item.status !== 'Sent'; });
    emailQueue.length = 0;
    kept.forEach(function(item) { emailQueue.push(item); });
    _persist(emailQueue);
  }

  function getAll() { return emailQueue; }

  return { init, enqueue, markSent, clearSent, getAll };
})();

// ── sendRequestReceivedEmail ──────────────────────────────────────
// Used by every REQUEST-type submission (Group Magic, Numerology, Energy
// Healing, Spell / Magic) — none of these have an online payment step,
// so this must never claim the booking/request is "confirmed". The
// backend (routes/sendEmail.js) hardcodes templateType 'request_received'
// for this endpoint regardless of what's sent here, as defense in depth.
// Tarot Reading does NOT use this — its confirmation email is sent
// server-side only, after real Razorpay payment verification.
function sendRequestReceivedEmail(booking) {
  var name       = booking.name      || 'Valued Client';
  var email      = booking.email     || '';
  var service    = booking.service   || '—';
  var pkg        = booking.package   || '—';
  var duration   = booking.duration  || '—';
  var date       = booking.date      || 'TBC';
  var time       = booking.time      || 'TBC';
  var bookingId  = booking.id        || '—';
  var createdAt  = booking.createdAt || new Date().toISOString();

  // Human-readable plain-text body (ready to drop into any email provider)
  var bodyText = [
    'Dear ' + name + ',',
    '',
    'We\u2019ve received your request with The Ocultt Tarot.',
    'This is not yet a confirmed booking \u2014 it is pending confirmation.',
    '',
    '─────────────────────────────',
    'Booking ID  : ' + bookingId,
    'Service     : ' + service,
    'Package     : ' + pkg,
    'Duration    : ' + duration,
    'Date        : ' + date,
    'Time (IST)  : ' + time,
    '─────────────────────────────',
    '',
    'Akankshaa will personally review your request and follow up by email with next steps.',
    '',
    'If you have any questions, reply to this email.',
    '',
    'With love & light,',
    'Akanksha',
    'The Ocultt Tarot'
  ].join('\n');

  var payload = {
    id:         bookingId + '-email',   // unique email record ID
    bookingId:  bookingId,
    to:         email,
    toName:     name,
    subject:    'Request Received — Pending Confirmation — ' + bookingId,
    service:    service,
    package:    pkg,
    duration:   duration,
    date:       date,
    time:       time,
    body:       bodyText,
    status:     'Queued',               // 'Queued' | 'Sent'
    queuedAt:   createdAt,
    sentAt:     null
  };

  EmailQueue.enqueue(payload);

  // ── Real send via backend (Node.js/Express + Nodemailer + Gmail) ──
  // Uses the same OCULTT_API base + OCULTT_BACKEND_CONNECTED gate as every
  // other backend call in this file (see the API client section below).
  // While no backend is deployed, this safely no-ops and the booking stays
  // visible in the CRM's Email Queue tab with status 'Queued', exactly as
  // it already did before this change.
  if (typeof OCULTT_BACKEND_CONNECTED !== 'undefined' && OCULTT_BACKEND_CONNECTED) {
    fetch(OCULTT_API + '/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function(res) {
        if (!res.ok) throw new Error('Email API responded with ' + res.status);
        return res.json();
      })
      .then(function() {
        EmailQueue.markSent(payload.id);
        console.log('[sendRequestReceivedEmail] Gmail send confirmed by backend for', payload.id);
      })
      .catch(function(err) {
        // Stays 'Queued' in the CRM so Akankshaa can see it needs attention —
        // never silently loses a request confirmation.
        console.warn('[sendRequestReceivedEmail] Gmail send failed, booking remains queued:', err.message);
      });
  } else {
    console.log('[sendRequestReceivedEmail] No backend connected yet — email queued locally only (see OCULTT_API).');
  }

  console.log('[Ocultt Email] Queued request-received email for', email, '| ID:', bookingId);
}

// ── RENDER EMAIL QUEUE TAB ────────────────────────────────────────
function renderEmailQueue() {
  var tbody   = document.getElementById('eq-tbody');
  var empty   = document.getElementById('eq-empty');
  var sub     = document.getElementById('emailqueue-sub');
  if (!tbody) return;

  var q = (document.getElementById('eq-search') ? document.getElementById('eq-search').value : '').toLowerCase();
  var all = EmailQueue.getAll();
  var filtered = q ? all.filter(function(e) {
    return (e.to||'').toLowerCase().includes(q) ||
           (e.toName||'').toLowerCase().includes(q) ||
           (e.bookingId||'').toLowerCase().includes(q) ||
           (e.service||'').toLowerCase().includes(q);
  }) : all;

  var queued = all.filter(function(e){ return e.status === 'Queued'; }).length;
  var sent   = all.filter(function(e){ return e.status === 'Sent';   }).length;

  // Stats
  var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
  set('eq-stat-queued',   queued);
  set('eq-stat-queued-d', queued ? queued + ' awaiting send' : 'None pending');
  set('eq-stat-sent',     sent);
  set('eq-stat-total',    all.length);
  if (sub) sub.textContent = all.length + ' email' + (all.length !== 1 ? 's' : '') + ' in queue';

  if (!filtered.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  tbody.innerHTML = filtered.map(function(e) {
    var sentBadge   = e.status === 'Sent'
      ? '<span class="badge badge-confirmed">Sent</span>'
      : '<span class="badge badge-pending">Queued</span>';
    var actionBtn = e.status === 'Queued'
      ? '<span onclick="EmailQueue.markSent(\'' + e.id + '\')" style="color:var(--gold);cursor:pointer;font-family:\'Gudlak Bold\',sans-serif;font-size:0.62rem;letter-spacing:0.1em;margin-right:0.75rem">MARK SENT</span>'
      : '<span style="color:var(--text-dim);font-family:\'Gudlak Bold\',sans-serif;font-size:0.62rem;letter-spacing:0.1em;margin-right:0.75rem">SENT</span>';
    var previewBtn  = '<span onclick="previewEmail(\'' + e.id + '\')" style="color:var(--text-muted);cursor:pointer;font-family:\'Gudlak Bold\',sans-serif;font-size:0.62rem;letter-spacing:0.1em">PREVIEW</span>';
    var qDate = e.queuedAt ? (function(){
      try { return new Date(e.queuedAt).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
      catch(err){ return e.queuedAt; }
    })() : '—';
    return '<tr>'
      + '<td style="font-size:0.8rem;color:var(--text-muted)">' + qDate + '</td>'
      + '<td style="font-family:\'Gudlak Bold\',sans-serif;font-size:0.63rem;color:var(--text-dim);letter-spacing:0.08em">' + (e.bookingId||'—') + '</td>'
      + '<td><div class="client-cell"><div class="avatar">' + initials(e.toName) + '</div><div class="client-name">' + (e.toName||'—') + '</div></div></td>'
      + '<td style="color:var(--text-muted);font-size:0.85rem">' + (e.to||'—') + '</td>'
      + '<td><span class="badge ' + serviceBadgeClass(e.service) + '">' + (e.service||'—') + '</span></td>'
      + '<td style="color:var(--text-muted);font-size:0.82rem">' + (e.date||'—') + (e.time && e.time !== 'TBC' ? ' · ' + e.time : '') + '</td>'
      + '<td>' + sentBadge + '</td>'
      + '<td>' + actionBtn + previewBtn + '</td>'
      + '</tr>';
  }).join('');
}

function previewEmail(emailId) {
  var all = EmailQueue.getAll();
  var entry = null;
  for (var i = 0; i < all.length; i++) { if (all[i].id === emailId) { entry = all[i]; break; } }
  if (!entry) return;

  var wrap = document.getElementById('eq-preview-wrap');
  var body = document.getElementById('eq-preview-body');
  if (!wrap || !body) return;

  body.textContent = [
    'TO      : ' + (entry.to    || '—'),
    'SUBJECT : ' + (entry.subject || '—'),
    '',
    entry.body || ''
  ].join('\n');

  wrap.style.display = 'block';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── INIT EMAIL QUEUE from localStorage on page load ───────────────
EmailQueue.init();


// ════════════════════════════════════════════════════════════════════
// RAZORPAY PAYMENT INTEGRATION
// ════════════════════════════════════════════════════════════════════

// ── Configuration — key comes from server, not hardcoded here ────
// The server creates orders and returns the key_id securely.
const RAZORPAY_KEY_ID = '';  // Set by server on order creation

// ════════════════════════════════════════════════════════════════
// TEST MODE — set to true to simulate a successful payment without
// going through Razorpay at all. Use this while demoing the site or
// testing the booking flow end-to-end.
//
// ⚠️ MUST be set back to false before accepting real customer payments.
// ════════════════════════════════════════════════════════════════
const TEST_MODE = false;

// Paise map kept for display only — server enforces actual amounts
const PRICE_PAISE_MAP = {
  '15 Min': 99900,
  '30 Min': 155500,
  '45 Min': 188800,
  '60 Min': 255500
};

// ── Populate order summary on step 3 render ───────────────────────
// ── SLOT HOLD TIMER (10-minute hold while client completes payment) ──
let _slotHoldInterval = null, _slotHoldDeadline = null;
const SLOT_HOLD_MS = 10 * 60 * 1000;

function startSlotHoldTimer(){
  if(_slotHoldInterval) return; // already running, don't reset on every render
  _slotHoldDeadline = Date.now() + SLOT_HOLD_MS;
  const banner = document.getElementById('slotHoldBanner');
  const timerEl = document.getElementById('slotHoldTimer');
  if(!banner || !timerEl) return;
  banner.classList.remove('expiring');
  _slotHoldInterval = setInterval(function(){
    const remaining = _slotHoldDeadline - Date.now();
    if(remaining <= 0){
      clearInterval(_slotHoldInterval);
      _slotHoldInterval = null;
      timerEl.textContent = '0:00';
      banner.classList.add('expiring');
      banner.querySelector('span:last-child').textContent = 'Your held slot has expired. Please reselect a date and time to continue.';
      _showBanner('step4-error','Your slot hold has expired — please go back and choose a new time.');
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = mins + ':' + String(secs).padStart(2,'0');
    if(remaining <= 120000) banner.classList.add('expiring');
  }, 1000);
}

function stopSlotHoldTimer(silent){
  if(_slotHoldInterval){ clearInterval(_slotHoldInterval); _slotHoldInterval = null; }
  if(silent){
    const banner = document.getElementById('slotHoldBanner');
    if(banner){
      banner.classList.remove('expiring');
      banner.innerHTML = '<span class="slot-hold-icon">✓</span><span>Your slot is confirmed and secured.</span>';
    }
  }
}

// ── Coupons ──────────────────────────────────────────────────────────
// One shared implementation used by all 5 payment flows (Tarot, Spell,
// Energy Healing, Numerology, Group Magic) rather than 5 copies. Only
// ever a PREVIEW here — the server independently re-validates and
// re-applies the discount at /payments/create-order, and the coupon is
// only actually marked used after a real payment succeeds (see
// server/routes/payments.js /verify) — this endpoint and this client
// code can never spend someone's coupon on their behalf.
let _appliedCoupons = { t: null, spell: null, eh: null, num: null, group: null };
const _COUPON_TOTAL_EL = { t: 'pay-total', spell: 'spell-pay-total', eh: 'eh-pay-total', num: 'num-pay-total', group: 'group-pay-total' };

function _couponBaseAmount(prefix){
  if (prefix === 't') {
    const basePriceLabel = selectedPriceOverride || PRICE_MAP[selectedDuration] || null;
    if (!basePriceLabel) return 0;
    const baseNum = _extractPriceNumber(basePriceLabel);
    return selectedTarotUrgency === 'Urgent' ? Math.round(baseNum * 1.2) : baseNum;
  }
  if (prefix === 'spell') return _pendingSpellBooking ? _pendingSpellBooking.finalPrice : 0;
  if (prefix === 'eh')    return _pendingEHBooking    ? _pendingEHBooking.basePrice    : 0;
  if (prefix === 'num')   return _pendingNumBooking   ? _pendingNumBooking.basePrice   : 0;
  if (prefix === 'group') return _pendingGroupBooking ? _pendingGroupBooking.basePrice : 0;
  return 0;
}
function _couponEmail(prefix){
  if (prefix === 't')     return (document.getElementById('t-email')?.value || '').trim();
  if (prefix === 'spell') return _pendingSpellBooking ? _pendingSpellBooking.email : '';
  if (prefix === 'eh')    return _pendingEHBooking    ? _pendingEHBooking.email    : '';
  if (prefix === 'num')   return _pendingNumBooking   ? _pendingNumBooking.email   : '';
  if (prefix === 'group') return _pendingGroupBooking ? _pendingGroupBooking.email : '';
  return '';
}
function resetCoupon(prefix){
  _appliedCoupons[prefix] = null;
  const input = document.getElementById(prefix + '-coupon-input');
  if (input) input.value = '';
  const statusEl = document.getElementById(prefix + '-coupon-status');
  if (statusEl) statusEl.textContent = '';
}
function refreshCouponDisplay(prefix){
  const totalEl = document.getElementById(_COUPON_TOTAL_EL[prefix]);
  const discountRow = document.getElementById(prefix + '-discount-row');
  const discountAmountEl = document.getElementById(prefix + '-discount-amount');
  const applied = _appliedCoupons[prefix];
  const base = _couponBaseAmount(prefix);
  if (applied) {
    if (discountRow) discountRow.style.display = 'flex';
    if (discountAmountEl) discountAmountEl.textContent = '\u2212 ' + formatPrice(applied.discountAmount) + ' (' + applied.code + ')';
    if (totalEl) totalEl.textContent = formatPrice(applied.finalAmount);
  } else {
    if (discountRow) discountRow.style.display = 'none';
    if (totalEl) totalEl.textContent = base ? formatPrice(base) : (totalEl.textContent || '\u2014');
  }
}
async function applyCoupon(prefix){
  const input = document.getElementById(prefix + '-coupon-input');
  const statusEl = document.getElementById(prefix + '-coupon-status');
  const code = (input?.value || '').trim().toUpperCase();
  const setStatus = (msg, color) => { if (statusEl) { statusEl.style.color = color; statusEl.textContent = msg; } };
  if (!code) { setStatus('Please enter a code.', '#c0392b'); return; }
  const amount = _couponBaseAmount(prefix);
  const email = _couponEmail(prefix);
  if (!amount) { setStatus('Please complete the form above first.', '#c0392b'); return; }
  if (!email || !email.includes('@')) { setStatus('Please enter your email above first.', '#c0392b'); return; }
  setStatus('Checking…', 'var(--text-muted)');
  try {
    if (!OCULTT_BACKEND_CONNECTED) throw new Error('Coupons need a live connection — please try again shortly.');
    const r = await fetch(OCULTT_API + '/coupons/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, email, amount })
    });
    const result = await r.json();
    if (!result.valid) throw new Error(result.error || 'Invalid coupon');
    _appliedCoupons[prefix] = { code, discountAmount: result.discountAmount, finalAmount: result.finalAmount };
    setStatus('✓ Coupon applied — you saved ' + formatPrice(result.discountAmount) + '.', '#5BB888');
  } catch (err) {
    _appliedCoupons[prefix] = null;
    setStatus('✗ ' + err.message, '#c0392b');
  }
  refreshCouponDisplay(prefix);
}

function populatePaymentStep() {
  const rEl = document.getElementById('pay-reading');
  const dEl = document.getElementById('pay-duration');
  const tEl = document.getElementById('pay-total');
  const dtEl = document.getElementById('pay-datetime');
  const statusEl = document.getElementById('rzp-status-msg');
  const payBtn   = document.getElementById('rzp-pay-btn');
  const testBadge = document.getElementById('testModeBadge');
  if (testBadge) testBadge.style.display = TEST_MODE ? 'block' : 'none';

  if (rEl) rEl.textContent = selectedReading || '—';
  if (dEl) dEl.textContent = selectedDuration ? selectedDuration + ' Session' : '—';
  // Urgent delivery (+20%, Audio Tarot Reading only) — computed the same
  // way as Spell's urgent fee: display-only here, the server independently
  // recomputes this same 20% from its own verified base price and never
  // trusts this number as the actual amount to charge.
  const basePriceLabel = selectedPriceOverride || PRICE_MAP[selectedDuration] || null;
  const urgentRow = document.getElementById('pay-urgent-row');
  if (basePriceLabel && selectedTarotUrgency === 'Urgent') {
    const baseNum = _extractPriceNumber(basePriceLabel);
    const finalNum = Math.round(baseNum * 1.2);
    if (tEl) tEl.textContent = formatPrice(finalNum);
    if (urgentRow) {
      urgentRow.style.display = 'flex';
      const feeEl = document.getElementById('pay-urgent-fee');
      if (feeEl) feeEl.textContent = '+ ' + formatPrice(finalNum - baseNum) + ' (20% urgent fee)';
    }
  } else {
    if (tEl) tEl.textContent = basePriceLabel ? formatPrice(_extractPriceNumber(basePriceLabel)) : '—';
    if (urgentRow) urgentRow.style.display = 'none';
  }
  refreshCouponDisplay('t');
  if (dtEl) {
    const isPhoneReading = selectedReading && selectedReading.startsWith('Phone');
    dtEl.textContent = isPhoneReading
      ? 'Time slot booked via Calendly'
      : (selectedDayLabel || '—') + (selectedTime ? ' · ' + selectedTime + ' IST' : '');
  }

  // Reset status message and button state each time step renders
  if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
  if (payBtn)   { payBtn.style.display = ''; payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = TEST_MODE ? 'Simulate Test Payment →' : 'Pay & Confirm Booking →'; payBtn.onclick = function() { payForTarotBooking(); }; }
  const paypalContainer = document.getElementById('rzp-paypal-container');
  if (paypalContainer) { paypalContainer.style.display = 'none'; paypalContainer.innerHTML = ''; }

  // Start (or resume) the slot-hold countdown — gives gentle urgency to complete payment
  if (!_paymentVerified) startSlotHoldTimer();
  else stopSlotHoldTimer(true);

  // If payment was already verified (user navigated back), show success state
  if (_paymentVerified) {
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.style.color   = 'var(--sage)';
      statusEl.textContent   = '✓ Payment successful — ' + _rzpPaymentId;
    }
    if (payBtn) {
      payBtn.textContent = 'Continue →';
      payBtn.onclick     = function() { tarotNext(4); };
    }
  }
}

// ── Launch Razorpay checkout ──────────────────────────────────────
// ── Currency-gated entry point for the Tarot "Pay" button — this is the
// ONLY thing that changed for India: previously the button called
// initiateRazorpay() directly; now it calls this dispatcher, which calls
// the exact same unchanged initiateRazorpay() for India, or the new
// PayPal path for everyone else. ──
function payForTarotBooking(){
  if (window.OT_CURRENCY === 'USD') {
    const name  = (document.getElementById('t-name')?.value  || '').trim() || 'Client';
    const email = (document.getElementById('t-email')?.value || '').trim();
    const phone = (document.getElementById('t-phone')?.value || '').trim();
    const isAudioReading = selectedReading && selectedReading.startsWith('Audio');
    if (!selectedReading || (!isAudioReading && !selectedDuration)) {
      _showBanner('step4-error','Reading format not selected — please go back and choose one.');
      return;
    }
    const priceKey = isAudioReading ? selectedReading : selectedDuration;
    const bookingId = 'OT-' + Math.floor(100000 + Math.random() * 900000);
    initiatePayPalCheckout({
      bookingId, type: 'booking', duration: priceKey,
      urgency: isAudioReading ? selectedTarotUrgency : null,
      name, email, phone,
      couponCode: _appliedCoupons.t ? _appliedCoupons.t.code : null,
      payBtnId: 'rzp-pay-btn', containerId: 'rzp-paypal-container',
      statusSetter: rzpSetStatus,
      onApproved: function(paypalOrderId){
        _paymentVerified  = true;
        _rzpPaymentId     = 'PAYPAL-' + paypalOrderId;
        _pendingBookingId = bookingId;
        stopSlotHoldTimer(true);
        if (tarotStep === 4) tarotNext(4);
      }
    });
  } else {
    initiateRazorpay();
  }
}

function initiateRazorpay() {
  const name   = (document.getElementById('t-name')?.value  || '').trim() || 'Client';
  const email  = (document.getElementById('t-email')?.value || '').trim();
  const phone  = (document.getElementById('t-phone')?.value || '').trim();

  const isAudioReading = selectedReading && selectedReading.startsWith('Audio');
  if (!selectedReading || (!isAudioReading && !selectedDuration)) {
    _showBanner('step4-error','Reading format not selected — please go back and choose one.');
    return;
  }

  const payBtn = document.getElementById('rzp-pay-btn');
  if (payBtn) { payBtn.disabled = true; payBtn.style.opacity = '0.5'; payBtn.textContent = 'Creating order…'; }

  const bookingId = 'OT-' + Math.floor(100000 + Math.random() * 900000);

  // ── TEST MODE: simulate a successful payment without calling Razorpay ──
  if (TEST_MODE) {
    if (payBtn) payBtn.textContent = 'Simulating test payment…';
    rzpSetStatus('TEST MODE — simulating payment, no real charge is made…', 'var(--gold)');
    setTimeout(function() {
      _paymentVerified  = true;
      _rzpPaymentId     = 'TEST-' + Math.floor(100000 + Math.random() * 900000);
      _pendingBookingId = bookingId;
      stopSlotHoldTimer(true);
      if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Continue →'; payBtn.onclick = function() { tarotNext(4); }; }
      rzpSetStatus('✓ TEST MODE — payment simulated, booking confirmed (' + _rzpPaymentId + ')', 'var(--sage)');
      setTimeout(function() { if (_paymentVerified && tarotStep === 4) tarotNext(4); }, 1800);
    }, 900);
    return;
  }

  // ── STEP 1: Create order server-side (amount is enforced by server) ──
  // name/email/phone are included so the server can create a placeholder
  // booking row under this same bookingId right away — without it, a
  // payment.failed webhook (sent when a customer abandons checkout, i.e.
  // showConfirmation() never runs) has no row to attach to.
  // Audio Tarot Reading has no minute-based selectedDuration (it's priced
  // by number of questions instead — see handleAudioReadingSelect, which
  // leaves selectedDuration null) — send selectedReading itself
  // ("Audio — 2 Questions") as the price-lookup key in that case, matching
  // the new Audio entries in TAROT_PRICE_PAISE server-side.
  const priceKey = isAudioReading ? selectedReading : selectedDuration;
  fetch(OCULTT_API + '/payments/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId, duration: priceKey, type: 'booking', name, email, phone, urgency: (isAudioReading ? selectedTarotUrgency : null), couponCode: _appliedCoupons.t ? _appliedCoupons.t.code : null })
  })
  .then(r => r.json())
  .then(order => {
    if (order.error) throw { ocultOrderError: true, message: order.error };

    if (payBtn) { payBtn.textContent = 'Opening payment…'; }

    const options = {
      key:         order.keyId,      // key from server
      order_id:    order.orderId,    // order_id from server (required for verification)
      amount:      order.amount,
      currency:    order.currency,
      name:        'The Ocultt Tarot',
      description: (selectedReading || 'Tarot Reading') + ' · ' + (selectedDuration || ''),
      prefill:     { name, email, contact: phone },
      notes:       { reading: selectedReading, duration: selectedDuration },
      theme:       { color: '#2E8B6E' },
      modal: {
        ondismiss: function() {
          if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
          rzpSetStatus('Payment cancelled. Click "Pay & Confirm Booking" to try again.', 'var(--text-muted)');
        }
      },
      handler: function(response) {
        // ── STEP 2: Verify signature server-side before marking paid ──
        rzpSetStatus('Verifying payment…', 'var(--text-muted)');
        fetch(OCULTT_API + '/payments/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            razorpay_order_id:   response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature:  response.razorpay_signature,
            bookingId,
            bookingType: 'booking'
          })
        })
        .then(r => r.json())
        .then(result => {
          if (!result.success) throw new Error(result.error || 'Verification failed');
          _paymentVerified = true;
          _rzpPaymentId    = response.razorpay_payment_id;
          _pendingBookingId = bookingId;
          stopSlotHoldTimer(true);
          if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Continue →'; payBtn.onclick = function() { tarotNext(4); }; }
          rzpSetStatus('✓ Payment verified! Your booking is confirmed.', 'var(--sage)');
          setTimeout(function() { if (_paymentVerified && tarotStep === 4) tarotNext(4); }, 1800);
        })
        .catch(err => {
          rzpSetStatus('✗ Payment verification failed: ' + err.message + '. Please contact support.', '#c0392b');
          if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
        });
      }
    };

    try {
      const rzp = new Razorpay(options);
      rzp.on('payment.failed', function(response) {
        _paymentVerified = false;
        if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; payBtn.onclick = function() { initiateRazorpay(); }; }
        rzpSetStatus('✗ Payment failed: ' + (response.error.description || 'Please try again.'), '#c0392b');
      });
      rzp.open();
    } catch(e) {
      if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
      rzpSetStatus('Payment gateway could not be loaded. Please disable any ad-blockers and try again.', '#c0392b');
    }
  })
  .catch(err => {
    if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
    // Distinguish a genuine network/connection failure (fetch itself
    // rejected) from the server responding but declining to price this
    // booking (order.error, tagged above) — these were previously shown
    // as the same generic "Could not connect" message, which hid real
    // problems (like Audio Tarot Reading's missing price entries) behind
    // a misleading network-sounding error.
    if (err && err.ocultOrderError) {
      rzpSetStatus('✗ ' + err.message, '#c0392b');
    } else {
      rzpSetStatus('Could not connect to payment server. Please try again.', '#c0392b');
    }
    console.error('[initiateRazorpay]', err);
  });
}

// ── Helper: update status message ────────────────────────────────
function rzpSetStatus(msg, color) {
  const el = document.getElementById('rzp-status-msg');
  if (!el) return;
  el.style.display = 'block';
  el.style.color   = color || 'var(--text-muted)';
  el.textContent   = msg;
}

// ── Test-mode bypass (no real key configured) ─────────────────────
// Shows a clearly-labelled test banner and advances the flow without
// hitting the real Razorpay API.  Remove once a live key is configured.
function rzpTestModeBypass() {
  _paymentVerified = true;
  _rzpPaymentId    = 'TEST-' + Math.floor(1000000 + Math.random() * 9000000);
  stopSlotHoldTimer(true);

  const payBtn = document.getElementById('rzp-pay-btn');
  if (payBtn) {
    payBtn.disabled    = false;
    payBtn.style.opacity = '1';
    payBtn.textContent   = 'Continue →';
    payBtn.onclick       = function() { tarotNext(4); };
  }

  rzpSetStatus(
    '⚠ TEST MODE — No Razorpay key configured. Payment simulated (' + _rzpPaymentId + '). Replace RAZORPAY_KEY_ID to go live.',
    'var(--gold)'
  );

  setTimeout(function() {
    if (_paymentVerified && tarotStep === 4) tarotNext(4);
  }, 2200);
}


// ── ARTICLE DATA MAP ─────────────────────────────────────────────
// Maps article titles to full content for the modal
const ARTICLE_DATA = {
  'The Saturn Return and What the Cards Have to Say About It': {
    cat: 'Featured · Astrology & Tarot',
    date: 'June 2026',
    html: '<p>Every soul, at 27–30 and again at 57–60, passes through one of the most seismically disruptive periods in human life. Saturn returns to the position it occupied at your birth — and it brings a reckoning.</p><p>This is not a time for small adjustments. Saturn demands that you examine what you have built — your career, your relationships, your identity — and asks with ruthless clarity: does this still serve your highest path?</p><p>The cards I reach for during a Saturn Return reading are not the comfortable ones. The Tower, yes. Death, often. But also The World, The Hermit, The Star. Because Saturn is not here to punish you. It is here to liberate you from everything you have outgrown.</p><p>If you are in your late twenties or approaching sixty and feel the earth shifting beneath you — know this: you are exactly on schedule. The stars have been arranging this moment for thirty years. Come and let us read what they are saying.</p>'
  },
  '2026: A 1 Universal Year and What It Means for Your Life Path': {
    cat: 'Numerology',
    date: 'May 2026',
    html: '<p>In numerology, every year carries a universal vibration — a collective energy that shapes the themes available to all of us simultaneously. 2026 reduces to 1 (2+0+2+6=10, 1+0=1).</p><p>The 1 Universal Year is the first year of a new nine-year cycle. Seeds planted now — in career, relationships, creative work, spiritual practice — take root and grow across the entire decade that follows.</p><p>This is a year for beginnings, for courage, for claiming your individual path. The collective energy supports independence, originality and decisive action. Hesitation costs more in a 1 year than in any other.</p><p>How this plays out for you personally depends on your own Life Path, Personal Year and the numerological weather you are currently navigating. A full numerology reading will reveal exactly what this universal shift means for the specific arc of your soul.</p>'
  },
  'The New Moon in Cancer: A Ritual for Emotional Clarity': {
    cat: 'Ritual & Magic',
    date: 'June 2026',
    html: '<p>Cancer season calls us inward. The crab does not conquer new territory — it creates a safe, sacred home. And so this new moon asks you to do the same internally: to clear the emotional field and prepare fertile ground for what you most deeply want to grow.</p><p>This ritual requires a candle (white or silver), a glass of water, a piece of paper and a pen. Begin at or after sundown.</p><p>Light your candle. Breathe until you feel settled. Write down everything you wish to release from your emotional body — fears, resentments, grief, old stories. Read each one aloud, then fold the paper away from you and say: <em>I release what no longer serves my highest good.</em></p><p>Then, on fresh paper, write what you are calling in — not wishes, but states of being. Not \"I want love\" but \"I am open to deep and reciprocal love.\" Speak each one as truth. Place the paper beneath the glass of water and leave it overnight under the moon if possible.</p><p>In the morning, drink the water with intention. The ritual is complete.</p>'
  },
  'Why the Tower Card Is Not What You Think': {
    cat: 'Tarot · Practice',
    date: 'April 2026',
    html: '<p>The Tower terrifies most readers. Sixteen. Lightning. A crown struck from a tower, two figures falling. It arrives in a spread and everything tightens.</p><p>But here is what twenty years of reading the Tower has taught me: it never shows up to destroy something that was working. It shows up to dismantle what was already hollow — the career that was slowly suffocating you, the relationship maintained out of fear, the self-image built on other people\'s expectations.</p><p>The Tower is not punishment. It is the universe\'s emergency exit. It is precision demolition. When it falls, what you thought was your foundation was actually your cage.</p><p>The hardest and most liberating truth about the Tower: you cannot rebuild on rubble. But you can — and will — rebuild on cleared, honest ground. And what rises next is yours in a way the old structure never was.</p>'
  }
};

// ── ARTICLE MODAL ─────────────────────────────────────────────────
function openArticle(el) {
  // Find the article title from the card's heading element
  var titleEl = el.querySelector('.ncard-title, .news2-feat-title, .news2-item-title');
  var title = titleEl ? titleEl.textContent.trim() : '';
  var data = ARTICLE_DATA[title];
  if (!data) return; // no data found, do nothing gracefully

  document.getElementById('articleCat').textContent  = data.cat;
  document.getElementById('articleTitle').textContent = title;
  document.getElementById('articleDate').textContent  = data.date;
  document.getElementById('articleText').innerHTML    = data.html;
  document.getElementById('articleOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeArticleModalDirect() {
  document.getElementById('articleOverlay').classList.remove('open');
  document.body.style.overflow = '';
}
function closeArticleModal(e) {
  if (e.target === document.getElementById('articleOverlay')) closeArticleModalDirect();
}

// ── DYNAMIC DASHBOARD GREETING ───────────────────────────────────────
function updateAdminGreeting() {
  var h = document.getElementById('admin-greeting-h1');
  var p = document.getElementById('admin-greeting-p');
  if (!h || !p) return;
  var now = new Date();
  var hr = now.getHours();
  var timeStr = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var dayName = days[now.getDay()];
  var dateStr = dayName + ', ' + now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();
  h.textContent = timeStr + ', Akanksha';
  p.textContent = "Here\u2019s your practice overview for today \u2014 " + dateStr;
}
updateAdminGreeting();


// Cycles through messages: CSS reveal plays first, then JS takes over
(function initHeroCycle() {
  var FADE_IN  = 1000;  // ms
  var VISIBLE  = 8000;  // ms — increased from 5000 for comfortable reading
  var FADE_OUT = 1200;  // ms — slightly longer fade out
  var PAUSE    = 300;   // ms hidden between messages

  var messages = [
    'Est. in the Ancient Tradition',
    'Clarity · Healing · Transformation',
    'Sacred Readings Worldwide',
    'Tarot · Numerology · Ritual Work',
    'Your Path, Illuminated'
  ];

  var el = document.querySelector('.hero-kicker');
  if (!el) return;

  var idx = 0;

  function startCycle() {
    // Take ownership from CSS animation
    el.style.animation  = 'none';
    el.style.opacity    = '1';
    el.style.transition = 'opacity ' + (FADE_IN / 1000) + 's ease';

    function next() {
      // Fade out
      el.style.transition = 'opacity ' + (FADE_OUT / 1000) + 's ease';
      el.style.opacity = '0';

      setTimeout(function() {
        idx = (idx + 1) % messages.length;
        el.textContent = messages[idx];

        setTimeout(function() {
          // Fade in
          el.style.transition = 'opacity ' + (FADE_IN / 1000) + 's ease';
          el.style.opacity = '1';
          // Stay visible, then next
          setTimeout(next, FADE_IN + VISIBLE);
        }, PAUSE);
      }, FADE_OUT);
    }

    // First message already visible; schedule first transition
    setTimeout(next, VISIBLE);
  }

  // Let the page CSS reveal animation finish before cycling begins
  setTimeout(startCycle, 1400);
})();


// ── V34: SCROLL FADE INDICATORS ─────────────────────────────────────────
(function initScrollFades(){
  var wraps = [
    { wrap: document.querySelector('.journey-scroll-wrap'), scroll: document.getElementById('journeyScroll') },
    { wrap: document.querySelector('.trust-scroll-wrap'),   scroll: document.getElementById('trustScroll') }
  ];
  wraps.forEach(function(item){
    if(!item.wrap || !item.scroll) return;
    function update(){
      var el = item.scroll;
      item.wrap.classList.toggle('has-left',  el.scrollLeft > 8);
      item.wrap.classList.toggle('has-right', el.scrollLeft < el.scrollWidth - el.clientWidth - 8);
    }
    item.scroll.addEventListener('scroll', update, {passive:true});
    update();
    // Also update on resize
    window.addEventListener('resize', update, {passive:true});
  });
})();


// ════════════════════════════════════════════════════════════════════
// OCULTT v51 — BACKEND API CLIENT
// All API calls go through here. Change OCULTT_API to your deployed URL.
// ════════════════════════════════════════════════════════════════════
//
// ── FUTURE INTEGRATION READINESS (Phase 2 note — nothing below is wired up) ──
// Google Sign-In, Gmail, Google Calendar, Google Meet, reminder notifications,
// and AI meeting summaries are intentionally NOT implemented yet. The pieces
// below are already shaped so each one is a swap-in later, not a rewrite:
//   • Every booking already carries service/package/date/time/status/priority —
//     the exact fields a Calendar event or Meet link would be created from.
//   • sendRequestReceivedEmail() is the choke point for request-type outbound
//     email (Tarot's paid confirmation is sent server-side, see routes/
//     payments.js and routes/razorpayWebhook.js) — replacing its local
//     EmailQueue.enqueue() with a real Gmail/SMTP call is a one-function change.
//   • apiGet/apiPost/apiPatch already centralize every network call and are
//     gated by OCULTT_BACKEND_CONNECTED — pointing OCULTT_API at a real
//     deploy turns them on with no call-site changes.
//   • OculttDB.logActivity() gives any future integration (calendar synced,
//     reminder sent, AI summary generated) a ready place to record itself
//     on the same timeline notes and status changes already use.
// ══════════════════════════════════════════════════════════════════════════

// ── Backend API config ── moved to the top of this file (see line ~1-9) so
// it's available before renderDashboard()'s unconditional top-level call
// further up runs. Left this comment as a pointer in case anyone searches
// for OCULTT_API here.

// Admin key stored in sessionStorage — set on sign-in, cleared on sign-out
function getAdminKey() { return sessionStorage.getItem('ocultt_admin_key') || ''; }
function adminHeaders() {
  return { 'Content-Type': 'application/json', 'x-admin-key': getAdminKey() };
}

// ── API helpers ─────────────────────────────────────────────────────
// ── Coupons admin screen ────────────────────────────────────────────
async function renderCoupons(){
  const tbody = document.getElementById('cp-tbody');
  const empty = document.getElementById('cp-empty');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-dim);font-style:italic">Loading…</td></tr>`;
  let coupons = [];
  try {
    const result = await apiGet('/coupons');
    if (result.error) throw new Error(result.error);
    coupons = result.coupons || [];
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-dim);font-style:italic">Couldn't load coupons right now.</td></tr>`;
    return;
  }
  if (!coupons.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = coupons.map(c => `
    <tr>
      <td style="font-family:'Gudlak Bold',sans-serif;letter-spacing:0.05em">${c.code}</td>
      <td>${c.discount_type === 'percent' ? c.discount_value + '% off' : '₹' + Number(c.discount_value).toLocaleString('en-IN') + ' off'}</td>
      <td>₹${Number(c.min_amount).toLocaleString('en-IN')}</td>
      <td><span class="badge ${c.active ? 'badge-confirmed' : ''}" style="${c.active ? '' : 'background:#ddd;color:#666'}">${c.active ? 'Active' : 'Inactive'}</span></td>
      <td>${fmtDate(c.created_at)}</td>
      <td><button class="cd-action-btn" onclick="toggleCoupon('${c.code}', ${!c.active})">${c.active ? 'Deactivate' : 'Activate'}</button></td>
    </tr>`).join('');
}

async function createCoupon(){
  const code = (document.getElementById('cp-new-code')?.value || '').trim().toUpperCase();
  const discountType = document.getElementById('cp-new-type')?.value || 'percent';
  const discountValue = Number(document.getElementById('cp-new-value')?.value || 0);
  const minAmount = Number(document.getElementById('cp-new-min')?.value || 1000);
  const statusEl = document.getElementById('cp-create-status');
  const setStatus = (msg, color) => { if (statusEl) { statusEl.style.color = color; statusEl.textContent = msg; } };

  if (!code) { setStatus('Please enter a code.', '#c0392b'); return; }
  if (!discountValue || discountValue <= 0) { setStatus('Please enter a valid discount value.', '#c0392b'); return; }

  setStatus('Creating…', 'var(--text-muted)');
  try {
    const result = await apiPost('/coupons', { code, discountType, discountValue, minAmount });
    if (result.error) throw new Error(result.error);
    setStatus('✓ Coupon "' + code + '" created.', '#5BB888');
    document.getElementById('cp-new-code').value = '';
    document.getElementById('cp-new-value').value = '';
    renderCoupons();
  } catch (err) {
    setStatus('✗ ' + err.message, '#c0392b');
  }
}

async function toggleCoupon(code, activate){
  try {
    const result = await apiPatch('/coupons/' + encodeURIComponent(code), { active: activate });
    if (result.error) throw new Error(result.error);
    renderCoupons();
  } catch (err) {
    showToast('Could not update coupon: ' + err.message);
  }
}
async function apiGet(path) {
  if (!OCULTT_BACKEND_CONNECTED) throw new Error('No backend connected yet — using local storage');
  const r = await fetch(OCULTT_API + path, { headers: adminHeaders() });
  return r.json();
}
async function apiPost(path, body) {
  if (!OCULTT_BACKEND_CONNECTED) throw new Error('No backend connected yet — using local storage');
  const r = await fetch(OCULTT_API + path, { method:'POST', headers: adminHeaders(), body: JSON.stringify(body) });
  return r.json();
}
async function apiPatch(path, body) {
  if (!OCULTT_BACKEND_CONNECTED) throw new Error('No backend connected yet — using local storage');
  const r = await fetch(OCULTT_API + path, { method:'PATCH', headers: adminHeaders(), body: JSON.stringify(body) });
  return r.json();
}

// ── Group Magic moon-date overrides (Availability tab) ──────────────
function moonOverrideSetStatus(msg, color){
  const el = document.getElementById('moon-override-status');
  if (!el) return;
  el.style.display = 'block'; el.style.color = color; el.textContent = msg;
}
async function saveMoonOverride(eventType){
  const prefix = eventType === 'new_moon' ? 'moon-new' : 'moon-full';
  const date = document.getElementById(prefix + '-date')?.value || '';
  const time = document.getElementById(prefix + '-time')?.value.trim() || '';
  if (!date) { moonOverrideSetStatus('Please pick a date first.', '#c0392b'); return; }
  moonOverrideSetStatus('Saving…', 'var(--text-muted)');
  try {
    const result = await apiPost('/moon-events', { eventType, date, time });
    if (result.error) throw new Error(result.error);
    moonOverrideSetStatus('✓ Override saved — the site will show this date until cleared.', '#5BB888');
  } catch (err) {
    moonOverrideSetStatus('✗ ' + err.message, '#c0392b');
  }
}
async function clearMoonOverride(eventType){
  moonOverrideSetStatus('Clearing…', 'var(--text-muted)');
  try {
    const r = await fetch(OCULTT_API + '/moon-events/' + eventType, { method: 'DELETE', headers: { 'x-admin-key': getAdminKey() } });
    const result = await r.json();
    if (result.error) throw new Error(result.error);
    const prefix = eventType === 'new_moon' ? 'moon-new' : 'moon-full';
    const dateEl = document.getElementById(prefix + '-date'); if (dateEl) dateEl.value = '';
    const timeEl = document.getElementById(prefix + '-time'); if (timeEl) timeEl.value = '';
    moonOverrideSetStatus('✓ Override cleared — back to the automatically calculated date.', '#5BB888');
  } catch (err) {
    moonOverrideSetStatus('✗ ' + err.message, '#c0392b');
  }
}

// ── Live bookings sync — pulls GET /api/bookings (Supabase, every non-spell
// booking) into OculttDB/localStorage, so the CRM shows bookings made on
// OTHER devices/browsers too, not just this one. Local storage remains the
// fallback: if the live fetch fails or isn't available, whatever's already
// cached locally is used, exactly as before. Gated on an admin key being
// present (skips silently on public customer-facing pages, where there is
// none) and throttled so it doesn't refire on every keystroke/filter click.
function _mapRemoteBookingToLocal(r) {
  return {
    id: r.id, service: r.service, package: r.package, duration: r.duration,
    date: r.preferred_date, time: r.preferred_time, format: r.format,
    intention: r.intention, detail: r.detail, notes: r.notes,
    name: r.name, email: r.email, phone: r.phone,
    paymentStatus: r.payment_status, razorpayPaymentId: r.payment_id,
    status: r.status, priority: r.priority,
    meetStatus: r.meet_status, meetLink: r.meet_link,
    calendarEventId: r.calendar_event_id, meetSummary: r.meet_summary,
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}
// _lastLiveBookingsSyncAt / LIVE_BOOKINGS_SYNC_MIN_INTERVAL_MS are declared
// up near renderDashboard() (which calls this on every page load, before
// this point in the file — moved there in v187 to fix a real
// "Cannot access before initialization" crash on first page load).
async function syncLiveBookingsIntoLocal(force) {
  if (!OCULTT_BACKEND_CONNECTED || !getAdminKey()) return false;
  if (!force && Date.now() - _lastLiveBookingsSyncAt < LIVE_BOOKINGS_SYNC_MIN_INTERVAL_MS) return false;
  try {
    const { bookings, error } = await apiGet('/bookings');
    if (error) throw new Error(error);
    OculttDB.mergeRemoteBookings((bookings || []).map(_mapRemoteBookingToLocal));
    _lastLiveBookingsSyncAt = Date.now();
    return true;
  } catch (err) {
    console.warn('[syncLiveBookingsIntoLocal] live API unavailable, using local data only:', err.message);
    return false;
  }
}

// ── renderAdminSpells — live data from Supabase ──────────────────────
let _spellsCache = [];

function toggleSpellHistory(){
  const wrap = document.getElementById('spell-history-wrap');
  const chevron = document.getElementById('spell-history-chevron');
  const isOpen = wrap.style.display !== 'none';
  wrap.style.display = isOpen ? 'none' : 'block';
  chevron.textContent = isOpen ? 'SHOW ▾' : 'HIDE ▴';
}

let _spellsFilter = 'all';
function setSpellsFilter(filter, el){
  _spellsFilter = filter;
  document.querySelectorAll('#spells-filter-tabs .range-tab').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderAdminSpells();
}

async function renderAdminSpells() {
  const tbody = document.getElementById('spells-tbody');
  const empty = document.getElementById('spells-empty');
  const histTbody = document.getElementById('spells-history-tbody');
  const histEmpty = document.getElementById('spells-history-empty');
  const histCount = document.getElementById('spell-history-count');
  const sub   = document.getElementById('spells-sub');
  if (!tbody) return;

  // Show loading state
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-dim);font-style:italic">Loading…</td></tr>';
  empty.style.display = 'none';

  try {
    const q = (document.getElementById('spell-search')?.value || '').toLowerCase();
    const url = q ? `/spells?search=${encodeURIComponent(q)}` : '/spells';

    // The live API call is best-effort — if it fails outright (backend down,
    // not yet connected, etc.) we still fall through to the OculttDB fallback
    // below instead of showing a hard error.
    try {
      const { spells, error } = await apiGet(url);
      if (error) throw new Error(error);
      _spellsCache = spells || [];
    } catch (apiErr) {
      console.warn('[renderAdminSpells] live API unavailable, using local fallback:', apiErr.message);
      _spellsCache = [];
    }

    // Fall back to localStorage spells if API unavailable or empty
    if (!_spellsCache.length) {
      const local = OculttDB.getBookings().filter(b => b.service === 'Spell / Magic');
      if (local.length) {
        _spellsCache = local.map(b => ({
          id: b.id, name: b.name, email: b.email, phone: b.phone,
          spell_category: b.package, urgency: '—',
          goal: b.intention, status: b.status || 'Pending',
          payment_status: b.paymentStatus || 'Unpaid', video_sent: !!b.video_sent, video_url: b.video_url || null,
          video_sent_at: b.video_sent_at || null,
          workflowStage: b.workflowStage || null, stageHistory: b.stageHistory || [],
          created_at: b.createdAt
        }));
      }
    }

    // Split into Active (Pending / In Progress) and Completed (history)
    let activeSpells      = _spellsCache.filter(s => s.status !== 'Completed');
    const completedSpells = _spellsCache.filter(s => s.status === 'Completed');

    if (_spellsFilter && _spellsFilter !== 'all') {
      activeSpells = activeSpells.filter(s => s.status === _spellsFilter);
    }

    // Stats
    const pending  = _spellsCache.filter(s => s.status === 'Pending').length;
    const inProg   = _spellsCache.filter(s => s.status === 'In Progress').length;
    const done     = completedSpells.length;
    if (document.getElementById('sp-stat-pending'))  document.getElementById('sp-stat-pending').textContent = pending;
    if (document.getElementById('sp-stat-progress')) document.getElementById('sp-stat-progress').textContent = inProg;
    if (document.getElementById('sp-stat-done'))     document.getElementById('sp-stat-done').textContent = done;
    if (sub) sub.textContent = `${activeSpells.length} active request${activeSpells.length !== 1 ? 's' : ''} · ${pending} pending review`;
    if (histCount) histCount.textContent = completedSpells.length ? `(${completedSpells.length})` : '';

    const urgencyColor = {
      'Urgent':          '#C0392B',
      'Within a month':  'var(--text-dim)',
      'No rush':         'var(--text-dim)'
    };

    function renderRow(s){
      const videoStatus = s.video_sent
        ? `<span style="color:#40815F;font-size:0.75rem">✓ Sent<br><span style="font-size:0.7rem;opacity:0.7">${s.video_link_expires_at ? 'Exp ' + new Date(s.video_link_expires_at).toLocaleDateString('en-IN',{day:'numeric',month:'short'}) : ''}</span></span>`
        : s.video_url
        ? `<span style="color:#E8A87C;font-size:0.75rem">Uploaded<br>Not sent</span>`
        : `<span style="color:var(--text-dim);font-size:0.75rem">—</span>`;

      return `<tr class="crm-row-clickable" onclick="openBookingDetail('${s.id}')">
        <td style="font-size:0.8rem;color:var(--text-muted)">${fmtDate(s.created_at)}</td>
        <td><div class="client-cell">
          <div class="avatar">${initials(s.name)}</div>
          <div>
            <div class="client-name">${s.name || '—'}</div>
            <div class="client-email">${s.email || ''}</div>
            <div class="client-email">${s.phone || ''}</div>
          </div>
        </div></td>
        <td><span class="badge badge-review">${s.spell_category || '—'}</span></td>
        <td>${(() => {
          const stage = getSpellWorkflowStage(s);
          const stageIdx = SPELL_WORKFLOW_STAGES.indexOf(stage);
          const cls = stage==='Completed' ? 'badge-confirmed' : stageIdx >= 4 ? 'badge-review' : 'badge-pending';
          return `<span class="badge ${cls}" style="white-space:nowrap">${stage}</span>`;
        })()}</td>
        <td style="font-family:'Gudlak Bold',sans-serif;font-size:0.62rem;letter-spacing:0.1em;color:${urgencyColor[s.urgency] || 'var(--text-dim)'}">${(s.urgency || '—').toUpperCase()}</td>
        <td onclick="event.stopPropagation()">
          <select onchange="updateSpellStatus('${s.id}', this.value)" style="font-family:'Gudlak Bold',sans-serif;font-size:0.6rem;letter-spacing:0.1em;padding:4px 8px;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--text)">
            <option value="Booking Received"     ${s.status==='Booking Received'    ?'selected':''}>Booking Received</option>
            <option value="Scheduled"            ${s.status==='Scheduled'           ?'selected':''}>Scheduled</option>
            <option value="Waiting for Akanksha" ${s.status==='Waiting for Akanksha'?'selected':''}>Waiting for Akanksha</option>
            <option value="In Progress"          ${s.status==='In Progress'         ?'selected':''}>In Progress</option>
            <option value="Completed"            ${s.status==='Completed'           ?'selected':''}>Completed</option>
            <option value="Cancelled"            ${s.status==='Cancelled'           ?'selected':''}>Cancelled</option>
          </select>
        </td>
        <td><span class="badge badge-pay ${s.payment_status==='Paid'?'badge-confirmed':'badge-pending'}">${s.payment_status || 'Unpaid'}</span></td>
        <td>${videoStatus}</td>
        <td onclick="event.stopPropagation()">
          <div style="display:flex;flex-direction:column;gap:4px">
            <button onclick="openVideoModal('${s.id}')" style="font-family:'Gudlak Bold',sans-serif;font-size:0.58rem;letter-spacing:0.08em;padding:4px 8px;border:1px solid var(--gold);background:transparent;cursor:pointer;color:var(--gold)">🎥 VIDEO</button>
            <button onclick="openBookingDetail('${s.id}')" style="font-family:'Gudlak Bold',sans-serif;font-size:0.58rem;letter-spacing:0.08em;padding:4px 8px;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--text-dim)">DETAIL</button>
          </div>
        </td>
      </tr>`;
    }

    // Active table
    if (!activeSpells.length) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      tbody.innerHTML = activeSpells.map(renderRow).join('');
    }

    // Completed / history table
    if (histTbody) {
      if (!completedSpells.length) {
        histTbody.innerHTML = '';
        if (histEmpty) histEmpty.style.display = 'block';
      } else {
        if (histEmpty) histEmpty.style.display = 'none';
        histTbody.innerHTML = completedSpells.map(renderRow).join('');
      }
    }
  } catch (err) {
    console.error('[renderAdminSpells]', err);
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:#c0392b;font-style:italic">Could not load spell requests. Check backend connection.</td></tr>';
  }
}

async function updateSpellStatus(id, status) {
  // Update local cache + OculttDB immediately so the UI (and re-render) is
  // correct even when the live backend isn't connected yet.
  const idx = _spellsCache.findIndex(s => s.id === id);
  if (idx > -1) _spellsCache[idx].status = status;
  const localBookings = OculttDB.getBookings();
  const localIdx = localBookings.findIndex(b => b.id === id);
  if (localIdx > -1) {
    localBookings[localIdx].status = status;
    OculttDB.saveBooking(localBookings[localIdx]);
  }
  renderAdminSpells();

  // Best-effort sync to live backend
  try {
    await apiPatch('/spells/' + id + '/status', { status });
  } catch(err) {
    console.warn('[updateSpellStatus] live sync failed, local update kept:', err.message);
  }
}


// ════════════════════════════════════════════════════════════════════
// VIDEO MODAL — Upload, Record, Send
// ════════════════════════════════════════════════════════════════════

let _vmSpellId     = null;
let _mediaRecorder = null;
let _recordChunks  = [];
let _recordedBlob  = null;
let _videoStream   = null;

function openVideoModal(spellId) {
  _vmSpellId = spellId;
  const s = _spellsCache.find(x => x.id === spellId);
  document.getElementById('vm-spell-id').textContent = spellId;
  document.getElementById('vm-client-name').textContent = s ? 'Client: ' + s.name + ' · ' + (s.spell_category || '') + ' Spell' : '';

  // Reset modal state
  switchVideoTab('upload');
  document.getElementById('vm-file-name').textContent = '';
  document.getElementById('vm-upload-btn').disabled = true;
  document.getElementById('vm-upload-btn').style.opacity = '0.4';
  document.getElementById('vm-upload-btn').style.pointerEvents = 'none';
  document.getElementById('vm-progress').style.display = 'none';
  document.getElementById('vm-status').style.display = 'none';
  document.getElementById('vm-record-status').textContent = '';
  document.getElementById('vm-stop-btn').style.display = 'none';
  document.getElementById('vm-save-recording-btn').style.display = 'none';
  document.getElementById('vm-file-input').value = '';
  _recordedBlob = null;

  // Show send section if video already uploaded (paused — no auto countdown on reopen)
  clearInterval(_sendCountdownInterval);
  if (s && s.video_url && !s.video_sent) {
    const section = document.getElementById('vm-send-section');
    section.style.display = 'block';
    document.getElementById('vm-send-countdown-label').textContent = 'This video is uploaded but not yet sent. Send it now, or cancel to re-record.';
    document.getElementById('vm-send-btn').textContent = '✉ SEND NOW';
    document.getElementById('vm-send-status').textContent = '';
  } else {
    document.getElementById('vm-send-section').style.display = 'none';
  }

  const modal = document.getElementById('spell-video-modal');
  modal.style.display = 'flex';
}

function closeVideoModal() {
  stopVideoStream();
  clearInterval(_sendCountdownInterval);
  document.getElementById('spell-video-modal').style.display = 'none';
}

function switchVideoTab(tab) {
  const uploadActive = tab === 'upload';
  document.getElementById('vm-upload-panel').style.display = uploadActive ? 'block' : 'none';
  document.getElementById('vm-record-panel').style.display = uploadActive ? 'none' : 'block';
  document.getElementById('vm-tab-upload').style.borderBottomColor = uploadActive ? '#1A7055' : 'transparent';
  document.getElementById('vm-tab-upload').style.color = uploadActive ? '#1A7055' : 'var(--text-dim)';
  document.getElementById('vm-tab-record').style.borderBottomColor = uploadActive ? 'transparent' : '#1A7055';
  document.getElementById('vm-tab-record').style.color = uploadActive ? 'var(--text-dim)' : '#1A7055';
  if (!uploadActive) initCamera();
  else stopVideoStream();
}

function onVideoFileSelected(input) {
  if (!input.files.length) return;
  const file = input.files[0];
  document.getElementById('vm-file-name').textContent = file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + ' MB)';
  document.getElementById('vm-upload-btn').disabled = false;
  document.getElementById('vm-upload-btn').style.opacity = '1';
  document.getElementById('vm-upload-btn').style.pointerEvents = 'auto';
}

async function uploadRitualVideo() {
  const fileInput = document.getElementById('vm-file-input');
  if (!fileInput.files.length) return;

  const file = fileInput.files[0];
  await doVideoUpload(file, 'upload');
}

async function doVideoUpload(file, type) {
  const btn = type === 'upload' ? document.getElementById('vm-upload-btn') : document.getElementById('vm-save-recording-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }

  document.getElementById('vm-progress').style.display = 'block';
  document.getElementById('vm-progress-bar').style.width = '0%';
  document.getElementById('vm-progress-text').textContent = 'Uploading video to secure storage…';
  document.getElementById('vm-status').style.display = 'none';

  // Simulate progress (fetch doesn't natively support upload progress)
  let fakeProgress = 0;
  const progressInterval = setInterval(() => {
    fakeProgress = Math.min(fakeProgress + 8, 88);
    document.getElementById('vm-progress-bar').style.width = fakeProgress + '%';
  }, 400);

  const finishSuccess = (videoUrl, expiresAt) => {
    clearInterval(progressInterval);
    document.getElementById('vm-progress-bar').style.width = '100%';
    document.getElementById('vm-progress-text').textContent = 'Upload complete!';
    showVmStatus('✓ Video uploaded and secured. Expires in 7 days from now.', '#5BB888');
    startSendCountdown();

    const idx = _spellsCache.findIndex(s => s.id === _vmSpellId);
    if (idx > -1) {
      _spellsCache[idx].video_url = videoUrl;
      _spellsCache[idx].video_link_expires_at = expiresAt;
    }
    // Keep OculttDB in sync so this survives a refresh even without a live backend
    const localBookings = OculttDB.getBookings();
    const localIdx = localBookings.findIndex(b => b.id === _vmSpellId);
    if (localIdx > -1) {
      localBookings[localIdx].video_url = videoUrl;
      OculttDB.saveBooking(localBookings[localIdx]);
    }
    // Move the workflow forward — video is uploaded, ready to review before sending
    const currentStage = getSpellWorkflowStage(localIdx > -1 ? localBookings[localIdx] : {});
    if (['New Request','Payment Received','Spell Started','Recording in Progress'].includes(currentStage)) {
      advanceSpellStage(_vmSpellId, 'Video Uploaded');
    }
  };

  try {
    if (!OCULTT_BACKEND_CONNECTED) throw new Error('No backend connected yet — using local storage');
    const formData = new FormData();
    formData.append('video', file, file.name || 'recording.webm');
    const endpoint = type === 'record' ? '/spells/' + _vmSpellId + '/video/record' : '/spells/' + _vmSpellId + '/video/upload';
    const r = await fetch(OCULTT_API + endpoint, {
      method: 'POST',
      headers: { 'x-admin-key': getAdminKey() },
      body: formData
    });
    const result = await r.json();
    if (!result.success) throw new Error(result.error || 'Upload failed');
    finishSuccess(result.spell?.video_url || 'uploaded', result.expiresAt);
  } catch (err) {
    // Backend not connected yet — fall back to a local object URL so the
    // rest of the workflow (review → countdown → send) can still be tested.
    console.warn('[doVideoUpload] live backend unavailable, simulating locally:', err.message);
    try {
      const localUrl = URL.createObjectURL(file);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      finishSuccess(localUrl, expiresAt);
    } catch (fallbackErr) {
      clearInterval(progressInterval);
      showVmStatus('Upload failed: ' + fallbackErr.message, '#c0392b');
      if (btn) { btn.disabled = false; btn.textContent = type === 'record' ? 'SAVE & UPLOAD RECORDING' : 'UPLOAD VIDEO'; }
      console.error('[doVideoUpload]', fallbackErr);
    }
  }
}

let _sendCountdownInterval = null;
let _sendCountdownSeconds  = 0;
const SEND_COUNTDOWN_TOTAL = 8;

function startSendCountdown(){
  clearInterval(_sendCountdownInterval);
  _sendCountdownSeconds = SEND_COUNTDOWN_TOTAL;
  const section = document.getElementById('vm-send-section');
  section.style.display = 'block';
  section.dataset.cancelled = '0';
  renderSendCountdown();

  _sendCountdownInterval = setInterval(() => {
    _sendCountdownSeconds--;
    if (_sendCountdownSeconds <= 0) {
      clearInterval(_sendCountdownInterval);
      sendVideoToCustomer();
      return;
    }
    renderSendCountdown();
  }, 1000);
}

function renderSendCountdown(){
  const label = document.getElementById('vm-send-countdown-label');
  const btn = document.getElementById('vm-send-btn');
  if (label) label.textContent = `Sending to customer in ${_sendCountdownSeconds}s — review the recording above, or cancel to re-record.`;
  if (btn) btn.textContent = `✉ SEND NOW (${_sendCountdownSeconds}s)`;
}

function cancelPendingSend(){
  clearInterval(_sendCountdownInterval);
  const idx = _spellsCache.findIndex(s => s.id === _vmSpellId);
  if (idx > -1) { _spellsCache[idx].video_url = null; }
  const localBookings = OculttDB.getBookings();
  const localIdx = localBookings.findIndex(b => b.id === _vmSpellId);
  if (localIdx > -1) { localBookings[localIdx].video_url = null; OculttDB.saveBooking(localBookings[localIdx]); }

  document.getElementById('vm-send-section').style.display = 'none';
  document.getElementById('vm-progress').style.display = 'none';
  document.getElementById('vm-status').style.display = 'none';
  document.getElementById('vm-file-name').textContent = '';
  document.getElementById('vm-file-input').value = '';
  document.getElementById('vm-upload-btn').disabled = true;
  document.getElementById('vm-upload-btn').style.opacity = '0.4';
  document.getElementById('vm-upload-btn').style.pointerEvents = 'none';
  showVmStatus('Cancelled — video discarded. Upload or record a new one whenever you\'re ready.', 'var(--text-muted)');
}

async function sendVideoToCustomer() {
  clearInterval(_sendCountdownInterval);
  const btn = document.getElementById('vm-send-btn');
  const label = document.getElementById('vm-send-countdown-label');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  if (label) label.textContent = '';
  document.getElementById('vm-send-status').textContent = '';

  const idx = _spellsCache.findIndex(s => s.id === _vmSpellId);
  const localBookings = OculttDB.getBookings();
  const localIdx = localBookings.findIndex(b => b.id === _vmSpellId);

  const markSent = () => {
    const sentAt = new Date().toISOString();
    if (idx > -1) { _spellsCache[idx].video_sent = true; _spellsCache[idx].status = 'Completed'; }
    if (localIdx > -1) {
      localBookings[localIdx].video_sent = true;
      localBookings[localIdx].video_sent_at = sentAt;
      localBookings[localIdx].status = 'Completed';
      OculttDB.saveBooking(localBookings[localIdx]);
    }
    advanceSpellStage(_vmSpellId, 'Completed');
  };

  try {
    const result = await apiPost('/spells/' + _vmSpellId + '/video/send', {});
    if (!result.success) throw new Error(result.error || 'Send failed');
    markSent();
    document.getElementById('vm-send-status').style.color = '#5BB888';
    document.getElementById('vm-send-status').textContent = '✓ Secure video link emailed to customer. Link expires in 7 days.';
    btn.textContent = '✓ SENT';
    setTimeout(renderAdminSpells, 500);
  } catch (err) {
    // Only treat this as a safe local-test-mode fallback when there is
    // genuinely no live backend configured at all (apiPost's own guard,
    // thrown before any network request is even attempted). Any other
    // error — a network failure reaching a real backend, or the backend
    // itself reporting the send failed (bad Gmail credentials, invalid
    // recipient, etc.) — must NOT be silently marked as sent. Doing so
    // previously showed "✓ Sent" in the CRM while the customer received
    // nothing, with no way to tell the two cases apart.
    if (err.message === 'No backend connected yet — using local storage') {
      console.warn('[sendVideoToCustomer] no live backend configured, marking sent locally (test mode):', err.message);
      markSent();
      document.getElementById('vm-send-status').style.color = '#5BB888';
      document.getElementById('vm-send-status').textContent = '✓ Marked as sent (local test mode — connect the backend to actually email the customer).';
      btn.textContent = '✓ SENT';
      setTimeout(renderAdminSpells, 500);
    } else {
      console.error('[sendVideoToCustomer] send failed — NOT marking as sent:', err.message);
      document.getElementById('vm-send-status').style.color = '#C0392B';
      document.getElementById('vm-send-status').textContent = '✕ Send failed: ' + err.message + ' — the customer did NOT receive this. Please try again.';
      btn.disabled = false;
      btn.textContent = '✉ RETRY SEND';
    }
  }
}

// ── Webcam recording ────────────────────────────────────────────────
// ── Generic media (video/audio) modal — Energy Healing, Numerology, Audio
// Tarot Reading. Deliberately separate state/IDs (mm-*) from the existing
// Spell video modal (vm-*) above — zero shared code, zero risk to the
// already-working Spell flow. Uses the new generic backend routes (see
// server/routes/media.js): /bookings/:id/media/upload|record|send.
function isMediaEligible(b){
  if (!b) return false;
  // Spell / Magic isn't included here — it already has its own dedicated
  // recording system (see the Spell Requests tab / openVideoModal), so it
  // never reaches this general Bookings detail view anyway. Every other
  // service can now record & deliver video or audio here.
  return ['Energy Healing', 'Numerology', 'Tarot Reading', 'Group Magic'].includes(b.service);
}

let _mmBookingId = null;
let _mmMediaType  = 'video';
let _mmStream     = null;
let _mmRecorder   = null;
let _mmChunks     = [];
let _mmRecordedBlob = null;

function openMediaModal(bookingId){
  _mmBookingId = bookingId;
  const b = OculttDB.getBookings().find(x => x.id === bookingId);
  document.getElementById('mm-booking-id').textContent = bookingId;
  document.getElementById('mm-client-name').textContent = b ? `Client: ${b.name} · ${b.service}` : '';

  mmSetMediaType('video');
  mmSwitchTab('upload');
  document.getElementById('mm-file-name').textContent = '';
  document.getElementById('mm-upload-btn').disabled = true;
  document.getElementById('mm-upload-btn').style.opacity = '0.4';
  document.getElementById('mm-status').style.display = 'none';
  document.getElementById('mm-record-status').textContent = '';
  document.getElementById('mm-stop-btn').style.display = 'none';
  document.getElementById('mm-save-recording-btn').style.display = 'none';
  document.getElementById('mm-file-input').value = '';
  _mmRecordedBlob = null;

  if (b && b.video_url && !b.video_sent) {
    document.getElementById('mm-send-section').style.display = 'block';
    document.getElementById('mm-send-status').textContent = '';
  } else {
    document.getElementById('mm-send-section').style.display = 'none';
  }

  document.getElementById('media-modal').style.display = 'flex';
}

function closeMediaModal(){
  mmStopStream();
  document.getElementById('media-modal').style.display = 'none';
}

function mmSetMediaType(type){
  _mmMediaType = type === 'audio' ? 'audio' : 'video';
  const videoBtn = document.getElementById('mm-type-video');
  const audioBtn = document.getElementById('mm-type-audio');
  if (videoBtn && audioBtn) {
    videoBtn.style.background = _mmMediaType === 'video' ? 'var(--gold-dk)' : 'transparent';
    videoBtn.style.color = _mmMediaType === 'video' ? '#fff' : 'var(--text)';
    audioBtn.style.background = _mmMediaType === 'audio' ? 'var(--gold-dk)' : 'transparent';
    audioBtn.style.color = _mmMediaType === 'audio' ? '#fff' : 'var(--text)';
  }
  const preview = document.getElementById('mm-preview');
  if (preview) preview.style.display = _mmMediaType === 'video' ? 'block' : 'none';
  const fileInput = document.getElementById('mm-file-input');
  if (fileInput) fileInput.accept = _mmMediaType === 'video' ? 'video/*' : 'audio/*';
  // Re-init capture if the record tab is currently active
  if (document.getElementById('mm-record-panel').style.display !== 'none') mmInitCapture();
}

function mmSwitchTab(tab){
  const uploadActive = tab === 'upload';
  document.getElementById('mm-upload-panel').style.display = uploadActive ? 'block' : 'none';
  document.getElementById('mm-record-panel').style.display = uploadActive ? 'none' : 'block';
  document.getElementById('mm-tab-upload').style.borderBottomColor = uploadActive ? '#1A7055' : 'transparent';
  document.getElementById('mm-tab-record').style.borderBottomColor = uploadActive ? 'transparent' : '#1A7055';
  if (!uploadActive) mmInitCapture();
  else mmStopStream();
}

async function mmInitCapture(){
  mmStopStream();
  try {
    const constraints = _mmMediaType === 'audio' ? { audio: true } : { video: true, audio: true };
    _mmStream = await navigator.mediaDevices.getUserMedia(constraints);
    const preview = document.getElementById('mm-preview');
    if (_mmMediaType === 'video' && preview) { preview.srcObject = _mmStream; preview.muted = true; preview.play?.(); }
    document.getElementById('mm-record-status').textContent = (_mmMediaType === 'audio' ? 'Microphone' : 'Camera') + ' ready. Click Start Recording when ready.';
  } catch (err) {
    document.getElementById('mm-record-status').textContent = (_mmMediaType === 'audio' ? 'Microphone' : 'Camera') + ' access denied: ' + err.message;
  }
}

function mmStartRecording(){
  if (!_mmStream) return;
  _mmChunks = [];
  _mmRecordedBlob = null;
  const mimeType = _mmMediaType === 'audio' ? 'audio/webm;codecs=opus' : 'video/webm;codecs=vp9,opus';
  _mmRecorder = new MediaRecorder(_mmStream, { mimeType });
  _mmRecorder.ondataavailable = e => { if (e.data.size > 0) _mmChunks.push(e.data); };
  _mmRecorder.onstop = () => {
    _mmRecordedBlob = new Blob(_mmChunks, { type: _mmMediaType === 'audio' ? 'audio/webm' : 'video/webm' });
    document.getElementById('mm-record-status').textContent = 'Recording ready (' + (_mmRecordedBlob.size/1024/1024).toFixed(1) + ' MB). Click Save & Upload.';
    document.getElementById('mm-save-recording-btn').style.display = 'inline-block';
    if (_mmMediaType === 'video') {
      const preview = document.getElementById('mm-preview');
      preview.srcObject = null;
      preview.src = URL.createObjectURL(_mmRecordedBlob);
      preview.controls = true;
      preview.muted = false;
    }
  };
  _mmRecorder.start(1000);
  document.getElementById('mm-start-btn').style.display = 'none';
  document.getElementById('mm-stop-btn').style.display = 'inline-block';
  document.getElementById('mm-record-status').textContent = '● Recording…';
}

function mmStopRecording(){
  if (_mmRecorder && _mmRecorder.state !== 'inactive') _mmRecorder.stop();
  document.getElementById('mm-stop-btn').style.display = 'none';
  document.getElementById('mm-start-btn').style.display = 'inline-block';
}

function mmSaveRecording(){
  if (!_mmRecordedBlob) return;
  const ext = _mmMediaType === 'audio' ? 'webm' : 'webm';
  const file = new File([_mmRecordedBlob], `recording-${_mmBookingId}.${ext}`, { type: _mmRecordedBlob.type });
  mmDoUpload(file);
}

function mmStopStream(){
  if (_mmStream) { _mmStream.getTracks().forEach(t => t.stop()); _mmStream = null; }
  if (_mmRecorder && _mmRecorder.state !== 'inactive') _mmRecorder.stop();
  const preview = document.getElementById('mm-preview');
  if (preview) { preview.srcObject = null; preview.src = ''; preview.controls = false; }
}

function mmOnFileSelected(input){
  if (!input.files.length) return;
  const file = input.files[0];
  document.getElementById('mm-file-name').textContent = file.name + ' (' + (file.size/1024/1024).toFixed(1) + ' MB)';
  document.getElementById('mm-upload-btn').disabled = false;
  document.getElementById('mm-upload-btn').style.opacity = '1';
}

function mmUploadSelectedFile(){
  const input = document.getElementById('mm-file-input');
  if (!input.files.length) return;
  mmDoUpload(input.files[0]);
}

function mmShowStatus(msg, color){
  const el = document.getElementById('mm-status');
  el.style.display = 'block';
  el.style.color = color || 'var(--text-muted)';
  el.textContent = msg;
}

async function mmDoUpload(file){
  mmShowStatus('Uploading…', 'var(--text-muted)');
  try {
    if (!OCULTT_BACKEND_CONNECTED) throw new Error('No backend connected yet — using local storage');
    const formData = new FormData();
    formData.append('file', file, file.name || 'recording.webm');
    formData.append('mediaType', _mmMediaType);
    const r = await fetch(OCULTT_API + '/bookings/' + _mmBookingId + '/media/upload', {
      method: 'POST',
      headers: { 'x-admin-key': getAdminKey() },
      body: formData
    });
    const result = await r.json();
    if (!result.success) throw new Error(result.error || 'Upload failed');
    mmShowStatus('✓ ' + (_mmMediaType === 'audio' ? 'Audio' : 'Video') + ' uploaded and secured. Expires in 7 days.', '#5BB888');
    document.getElementById('mm-send-section').style.display = 'block';
    document.getElementById('mm-send-status').textContent = '';
    const idx = OculttDB.getBookings().findIndex(b => b.id === _mmBookingId);
    if (idx > -1) {
      const bookings = OculttDB.getBookings();
      bookings[idx].video_url = result.publicId;
      OculttDB.saveBooking(bookings[idx]);
    }
  } catch (err) {
    console.warn('[mmDoUpload]', err.message);
    mmShowStatus('Upload failed: ' + err.message, '#c0392b');
  }
}

async function mmSendToCustomer(){
  const btn = document.getElementById('mm-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  const statusEl = document.getElementById('mm-send-status');
  try {
    if (!OCULTT_BACKEND_CONNECTED) throw new Error('No backend connected yet — using local storage');
    const r = await fetch(OCULTT_API + '/bookings/' + _mmBookingId + '/media/send', {
      method: 'POST',
      headers: { 'x-admin-key': getAdminKey() }
    });
    const result = await r.json();
    if (!result.success) throw new Error(result.error || 'Send failed');
    statusEl.style.color = '#5BB888';
    statusEl.textContent = '✓ Secure link emailed to customer. Link expires in 7 days.';
    if (btn) btn.textContent = '✓ SENT';
    setTimeout(renderAdminBookings, 500);
  } catch (err) {
    console.error('[mmSendToCustomer]', err.message);
    statusEl.style.color = '#c0392b';
    statusEl.textContent = '✗ Send failed: ' + err.message + ' — the customer did NOT receive this. Please try again.';
    if (btn) { btn.disabled = false; btn.textContent = '✉ SEND NOW'; }
  }
}
async function initCamera() {
  try {
    _videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const preview = document.getElementById('vm-preview');
    preview.srcObject = _videoStream;
    document.getElementById('vm-record-status').textContent = 'Camera ready. Click Start Recording when ready.';
  } catch (err) {
    document.getElementById('vm-record-status').textContent = 'Camera access denied: ' + err.message;
  }
}

function startRecording() {
  if (!_videoStream) return;
  _recordChunks = [];
  _recordedBlob = null;
  _mediaRecorder = new MediaRecorder(_videoStream, { mimeType: 'video/webm;codecs=vp9,opus' });
  _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _recordChunks.push(e.data); };
  _mediaRecorder.onstop = () => {
    _recordedBlob = new Blob(_recordChunks, { type: 'video/webm' });
    document.getElementById('vm-record-status').textContent = 'Recording ready (' + (_recordedBlob.size / 1024 / 1024).toFixed(1) + ' MB). Click Save & Upload.';
    document.getElementById('vm-save-recording-btn').style.display = 'inline-block';

    // Show playback preview
    const preview = document.getElementById('vm-preview');
    preview.srcObject = null;
    preview.src = URL.createObjectURL(_recordedBlob);
    preview.controls = true;
    preview.muted = false;
  };
  _mediaRecorder.start(1000);
  document.getElementById('vm-start-btn').style.display = 'none';
  document.getElementById('vm-stop-btn').style.display = 'inline-block';
  document.getElementById('vm-record-status').textContent = '● Recording…';
}

function stopRecording() {
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
    _mediaRecorder.stop();
  }
  document.getElementById('vm-stop-btn').style.display = 'none';
  document.getElementById('vm-start-btn').style.display = 'inline-block';
}

function saveRecording() {
  if (!_recordedBlob) return;
  const file = new File([_recordedBlob], 'ritual-recording-' + _vmSpellId + '.webm', { type: 'video/webm' });
  doVideoUpload(file, 'record');
}

function stopVideoStream() {
  if (_videoStream) { _videoStream.getTracks().forEach(t => t.stop()); _videoStream = null; }
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') _mediaRecorder.stop();
  const preview = document.getElementById('vm-preview');
  if (preview) { preview.srcObject = null; preview.src = ''; preview.controls = false; }
}

function showVmStatus(msg, color) {
  const el = document.getElementById('vm-status');
  el.style.display = 'block';
  el.style.color = color || 'var(--text-muted)';
  el.style.background = color === '#5BB888' ? 'rgba(91,184,136,0.08)' : 'rgba(192,57,43,0.06)';
  el.style.border = '1px solid ' + (color || 'var(--border)');
  el.style.padding = '12px 16px';
  el.textContent = msg;
}

// ── Load availability from server (replaces localStorage blocks) ─────
async function loadAvailabilityFromServer() {
  try {
    const { blocks } = await apiGet('/availability');
    if (!blocks) return;
    // Merge into OculttDB local for calendar to use immediately
    const lsKey = 'ocultt_availability_blocks_v1';
    // Map server schema (snake_case) to client schema (camelCase)
    const mapped = blocks.map(b => ({
      id:        b.id,
      type:      b.type,
      startDate: b.start_date,
      endDate:   b.end_date,
      times:     b.times || [],
      note:      b.note,
      createdAt: b.created_at
    }));
    try { localStorage.setItem(lsKey, JSON.stringify(mapped)); } catch(e) {}
  } catch(e) {
    console.warn('[loadAvailabilityFromServer] Using cached blocks:', e.message);
  }
}

// Run on load — silently sync availability from server to local calendar
document.addEventListener('DOMContentLoaded', function() {
  loadAvailabilityFromServer();
});

// ── _pendingBookingId — set by initiateRazorpay for confirmation use
let _pendingBookingId = '';

// ── Energy Healing service selection ─────────────────────────────────
let _selectedEH = '';
function selectEH(el, serviceName, price) {
  document.querySelectorAll('#page-energy-healing .service-select-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  _selectedEH = serviceName + ' — ' + price;
  document.getElementById('eh-service').value = _selectedEH;
  const disp = document.getElementById('eh-selected-display');
  document.getElementById('eh-selected-name').textContent = serviceName;
  document.getElementById('eh-selected-price').textContent = price;
  disp.style.display = 'block';
}

// ── Energy Healing form submit ───────────────────────────────────────
function submitEnergyHealing() {
  const nameEl   = document.getElementById('eh-name');
  const emailEl  = document.getElementById('eh-email');
  const phoneEl  = document.getElementById('eh-phone');
  const intentEl = document.getElementById('eh-intention');
  const name    = (nameEl?.value || '').trim();
  const email   = (emailEl?.value || '').trim();
  const phone   = (phoneEl?.value || '').trim();
  const service = document.getElementById('eh-service')?.value || '';
  const intent  = (intentEl?.value || '').trim();

  ['eh-name','eh-email','eh-phone','eh-intention'].forEach(function(id){
    const f=document.getElementById(id); if(f)f.classList.remove('field-invalid');
    const e=document.getElementById(id+'-err'); if(e)e.classList.remove('is-visible');
  });
  _clearBanner('eh-error');
  let hasError=false;
  if(!name){nameEl.classList.add('field-invalid');document.getElementById('eh-name-err').classList.add('is-visible');hasError=true;}
  if(!email||!email.includes('@')){emailEl.classList.add('field-invalid');document.getElementById('eh-email-err').classList.add('is-visible');hasError=true;}
  if(!phone){phoneEl.classList.add('field-invalid');document.getElementById('eh-phone-err').classList.add('is-visible');hasError=true;}
  if(!intent){intentEl.classList.add('field-invalid');document.getElementById('eh-intention-err').classList.add('is-visible');hasError=true;}
  if(!service){_showBanner('eh-error','Please select a service above before submitting');return;}
  if(hasError){
    _showBanner('eh-error','Please fill in all required fields to continue');
    const firstErr=document.querySelector('#page-energy-healing .field-invalid');
    if(firstErr)firstErr.scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }

  const id = 'OEH-' + Math.floor(100000 + Math.random() * 900000);
  const basePrice = _extractPriceNumber(service);
  _pendingEHBooking = { id, service: 'Energy Healing', package: service, basePrice, name, email, phone, intention: intent };

  renderEHPaymentView();
  swapStep('eh-form-view', 'eh-payment-view');
  window.scrollTo({top: 0, behavior: 'smooth'});
}

// ── Energy Healing payment step ─────────────────────────────────────
let _pendingEHBooking = null;

function renderEHPaymentView(){
  const b = _pendingEHBooking;
  if (!b) return;
  const nameOnly = (b.package || '').replace(/\s*—\s*₹[\d,]+$/, '');
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText('eh-pay-name', nameOnly || b.package || '—');
  setText('eh-pay-total', formatPrice(b.basePrice));
  resetCoupon('eh');
  refreshCouponDisplay('eh');
  const payBtn = document.getElementById('eh-rzp-pay-btn');
  if (payBtn) { payBtn.style.display = ''; payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; payBtn.onclick = function(){ payForEHBooking(); }; }
  const paypalContainer = document.getElementById('eh-paypal-container');
  if (paypalContainer) { paypalContainer.style.display = 'none'; paypalContainer.innerHTML = ''; }
  const statusEl = document.getElementById('eh-rzp-status-msg');
  if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
}

function backFromEHPayment(){
  swapStep('eh-payment-view', 'eh-form-view');
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function ehRzpSetStatus(msg, color){
  const el = document.getElementById('eh-rzp-status-msg');
  if (!el) return;
  el.style.display = 'block'; el.style.color = color; el.textContent = msg;
}

function finalizeEHBooking(b, paymentId){
  const finalBooking = {
    id: b.id, service: 'Energy Healing', package: b.package,
    price: formatPrice(b.basePrice),
    duration: '—', name: b.name, email: b.email, phone: b.phone, intention: b.intention,
    paymentStatus: 'Paid', razorpayPaymentId: paymentId,
    date: 'TBC', time: 'TBC', status: 'Booking Received', createdAt: new Date().toISOString()
  };
  OculttDB.saveBooking(finalBooking);
  swapStep('eh-payment-view', 'eh-success-view');
  window.scrollTo({top: 0, behavior: 'smooth'});
  _pendingEHBooking = null;
}

function payForEHBooking(){
  const b = _pendingEHBooking;
  if (!b) return;
  if (window.OT_CURRENCY === 'USD') {
    initiatePayPalCheckout({
      bookingId: b.id, type: 'energy_healing', basePrice: b.basePrice,
      name: b.name, email: b.email, phone: b.phone,
      couponCode: _appliedCoupons.eh ? _appliedCoupons.eh.code : null,
      payBtnId: 'eh-rzp-pay-btn', containerId: 'eh-paypal-container',
      statusSetter: ehRzpSetStatus,
      onApproved: function(paypalOrderId){
        fetch(OCULTT_API + '/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.id, service: 'Energy Healing', package: b.package, name: b.name, email: b.email, phone: b.phone, intention: b.intention })
        })
        .then(r => { if (!r.ok) console.warn('[payForEHBooking] POST /bookings did not succeed (status ' + r.status + ') — payment already verified against the placeholder row, but the request\'s full details may not have saved. Check the CRM.'); })
        .catch(() => {})
        .then(function(){ finalizeEHBooking(b, 'PAYPAL-' + paypalOrderId); });
      }
    });
  } else {
    initiateEHRazorpay();
  }
}

function initiateEHRazorpay(){
  const b = _pendingEHBooking;
  if (!b) return;
  const payBtn = document.getElementById('eh-rzp-pay-btn');
  if (payBtn) { payBtn.disabled = true; payBtn.style.opacity = '0.5'; payBtn.textContent = 'Creating order…'; }

  if (TEST_MODE) {
    if (payBtn) payBtn.textContent = 'Simulating test payment…';
    ehRzpSetStatus('TEST MODE — simulating payment, no real charge is made…', 'var(--gold)');
    setTimeout(function(){
      ehRzpSetStatus('✓ TEST MODE — payment simulated, booking confirmed.', 'var(--sage)');
      setTimeout(function(){ finalizeEHBooking(b, 'TEST-' + Math.floor(100000 + Math.random() * 900000)); }, 1200);
    }, 900);
    return;
  }

  fetch(OCULTT_API + '/payments/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId: b.id, type: 'energy_healing', basePrice: b.basePrice, name: b.name, email: b.email, phone: b.phone, couponCode: _appliedCoupons.eh ? _appliedCoupons.eh.code : null })
  })
  .then(r => r.json())
  .then(order => {
    if (order.error) throw { ocultOrderError: true, message: order.error };
    if (payBtn) payBtn.textContent = 'Opening payment…';

    const options = {
      key:         order.keyId,
      order_id:    order.orderId,
      amount:      order.amount,
      currency:    order.currency,
      name:        'The Ocultt Tarot',
      description: b.package,
      prefill:     { name: b.name, email: b.email, contact: b.phone },
      notes:       { ehId: b.id },
      theme:       { color: '#2E8B6E' },
      modal: {
        ondismiss: function() {
          if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
          ehRzpSetStatus('Payment cancelled. Click "Pay & Confirm Booking" to try again.', 'var(--text-muted)');
        }
      },
      handler: function(response) {
        ehRzpSetStatus('Verifying payment…', 'var(--text-muted)');
        fetch(OCULTT_API + '/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.id, service: 'Energy Healing', package: b.package, name: b.name, email: b.email, phone: b.phone, intention: b.intention })
        })
        .then(r => { if (!r.ok) console.warn('[initiateEHRazorpay] POST /bookings did not succeed (status ' + r.status + ') — payment will still be verified against the placeholder row created at order time, but the request\'s full details may not have saved. Check the CRM.'); })
        .then(() => fetch(OCULTT_API + '/payments/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            razorpay_order_id:   response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature:  response.razorpay_signature,
            bookingId: b.id,
            bookingType: 'energy_healing'
          })
        }))
        .then(r => r.json())
        .then(result => {
          if (!result.success) throw new Error(result.error || 'Verification failed');
          ehRzpSetStatus('✓ Payment verified! Your booking is confirmed.', 'var(--sage)');
          setTimeout(function(){ finalizeEHBooking(b, response.razorpay_payment_id); }, 1200);
        })
        .catch(err => {
          ehRzpSetStatus('✗ Payment verification failed: ' + err.message + '. Please contact support.', '#c0392b');
          if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
        });
      }
    };

    try {
      const rzp = new Razorpay(options);
      rzp.on('payment.failed', function(response) {
        if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; payBtn.onclick = function(){ initiateEHRazorpay(); }; }
        ehRzpSetStatus('✗ Payment failed: ' + (response.error.description || 'Please try again.'), '#c0392b');
      });
      rzp.open();
    } catch(e) {
      if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
      ehRzpSetStatus('Payment gateway could not be loaded. Please disable any ad-blockers and try again.', '#c0392b');
    }
  })
  .catch(err => {
    if (payBtn) { payBtn.disabled = false; payBtn.style.opacity = '1'; payBtn.textContent = 'Pay & Confirm Booking →'; }
    if (err && err.ocultOrderError) {
      ehRzpSetStatus('✗ ' + err.message, '#c0392b');
    } else {
      ehRzpSetStatus('Could not connect to payment server. Please try again.', '#c0392b');
    }
    console.error('[initiateEHRazorpay]', err);
  });
}
// ── 100-WORD LIMIT: customer-facing intention / goal / question / notes fields ──
// Applies consistently across every booking form (Tarot, Spell, Group Magic,
// Numerology, Energy Healing) plus the dynamically generated per-question
// textareas on the Audio/Phone Tarot form. Purely enforces the limit on typed
// input — no UI, styling, or layout changes.
(function () {
  const WORD_LIMIT = 100;
  const AUDIO_TAROT_WORD_LIMIT = 30; // Question 1, Question 2, ... on the Audio/Phone Tarot form
  const LIMITED_FIELD_IDS = [
    't-intent',      // Tarot Reading — Your Question / Intention
    's-goal',        // Spell — Your Goal
    's-detail',       // Spell — Detailed Request
    's-notes',       // Spell — Additional Notes
    'g-intent',      // Group Magic — Your Intention
    'g-notes',       // Group Magic — Notes
    'n-notes',       // Numerology — Your Questions
    'eh-intention'   // Energy Healing — Your Intention
  ];
  const DYNAMIC_FIELD_PATTERN = /^t-audio-q\d+$/; // Audio/Phone Tarot per-question textareas

  function enforceWordLimit(el, maxWords) {
    const text = el.value;
    const parts = text.split(/(\s+)/); // keep whitespace tokens so we don't disturb spacing/newlines
    let wordCount = 0;
    let result = '';
    for (const part of parts) {
      if (part.length === 0) continue;
      if (/^\s+$/.test(part)) {
        result += part;
      } else {
        wordCount++;
        if (wordCount > maxWords) break;
        result += part;
      }
    }
    if (wordCount > maxWords) {
      const selStart = el.selectionStart, selEnd = el.selectionEnd;
      el.value = result;
      // Keep cursor sensible if it was mid-field rather than jumping to the very end
      if (typeof selStart === 'number' && el.value.length < text.length) {
        const newPos = Math.min(selStart, el.value.length);
        try { el.setSelectionRange(newPos, newPos); } catch (e) {}
      }
    }
  }

  document.addEventListener('input', function (e) {
    const el = e.target;
    if (!el || !el.id) return;
    if (DYNAMIC_FIELD_PATTERN.test(el.id)) {
      enforceWordLimit(el, AUDIO_TAROT_WORD_LIMIT);
    } else if (LIMITED_FIELD_IDS.includes(el.id)) {
      enforceWordLimit(el, WORD_LIMIT);
    }
  });
})();

// ── Header-clearance sync (site-wide) ──
// Measures the real fixed-nav height and exposes it as both --crm-nav-h
// (CRM layout, unchanged) and --nav-h (used by ordinary page headers below)
// so no page ever starts underneath the nav, regardless of logo size, OS
// font metrics, browser zoom, or DPI scaling.
(function () {
  function syncCrmNavOffset() {
    const navEl = document.querySelector('nav');
    if (!navEl) return;
    const h = navEl.getBoundingClientRect().height;
    if (h > 0) {
      document.documentElement.style.setProperty('--crm-nav-h', h + 'px');
      document.documentElement.style.setProperty('--nav-h', h + 'px');
    }
  }
  document.addEventListener('DOMContentLoaded', syncCrmNavOffset);
  let _crmResizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(_crmResizeTimer);
    _crmResizeTimer = setTimeout(syncCrmNavOffset, 150);
  });
  // Re-check on every page navigation, in case fonts/layout shifted the
  // nav height slightly since initial load (not just for the CRM).
  const _origShowPage = window.showPage;
  if (typeof _origShowPage === 'function') {
    window.showPage = function (id, fromPopstate) {
      const r = _origShowPage(id, fromPopstate);
      setTimeout(syncCrmNavOffset, 0);
      return r;
    };
  }
})();

// ── Remember & prefill returning-customer contact details (v186) ──
// So a repeat visitor booking a second service (or re-doing a form after
// leaving it) doesn't have to retype name/email/phone every time. We do NOT
// remember per-participant Group Magic fields (g-p1-dob, g-p2-name, etc.) —
// only the main booker's own name/email/phone/dob, since those other fields
// often belong to someone else entirely.
(function () {
  const STORE_KEY = 'ocultt_saved_contact_v1';
  const FIELD_SUFFIXES = ['-name', '-email', '-phone', '-dob'];

  function isOwnField(id) {
    // Exclude participant-indexed fields like g-p1-name, g-p2-dob, etc.
    if (/-p\d+-/.test(id)) return false;
    return FIELD_SUFFIXES.some(function (suf) { return id.endsWith(suf); });
  }

  function fieldKind(id) {
    if (id.endsWith('-name')) return 'name';
    if (id.endsWith('-email')) return 'email';
    if (id.endsWith('-phone')) return 'phone';
    if (id.endsWith('-dob')) return 'dob';
    return null;
  }

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function saveField(kind, value) {
    if (!value) return;
    try {
      const saved = loadSaved();
      saved[kind] = value;
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch (e) {}
  }

  // Prefill every empty matching field currently in the DOM (cheap — only
  // ever a handful of booking-form inputs exist at once).
  function prefillSavedContactInfo() {
    const saved = loadSaved();
    if (!saved || !Object.keys(saved).length) return;
    document.querySelectorAll('input[id]').forEach(function (input) {
      const id = input.id;
      if (!isOwnField(id)) return;
      const kind = fieldKind(id);
      if (!kind || !saved[kind]) return;
      if (input.value) return; // don't clobber something already typed
      input.value = saved[kind];
    });
  }
  window.prefillSavedContactInfo = prefillSavedContactInfo;

  // Save as the visitor types (blur, not every keystroke) so the details
  // are captured even if they never finish/submit the form.
  document.addEventListener('blur', function (e) {
    const el = e.target;
    if (!el || el.tagName !== 'INPUT' || !el.id) return;
    if (!isOwnField(el.id)) return;
    const kind = fieldKind(el.id);
    if (kind) saveField(kind, el.value.trim());
  }, true);

  document.addEventListener('DOMContentLoaded', prefillSavedContactInfo);
})();
