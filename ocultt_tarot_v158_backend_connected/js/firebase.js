/* ═══════════════════════════════════════════════════════════════════════
   js/firebase.js  ·  Firebase Authentication — Phase 1
   The Ocultt Tarot by Akankshaa
   ───────────────────────────────────────────────────────────────────────
   WHAT THIS FILE DOES
   ────────────────────
   • Initialises the Firebase app with your project credentials
   • Sets up Google as the sole Sign-In provider (via popup)
   • Exposes window.OculttFirebase — a small API that script.js calls
     for every auth operation (sign-in, sign-out, state changes)
   • Keeps the authenticated user (uid · name · email · picture) in
     localStorage under the same key that the rest of the site already
     reads, so the nav-pill and avatar restore instantly on every reload

   PHASE 1 SCOPE (this file)
   ──────────────────────────
   ✅  Firebase App initialisation
   ✅  Google Sign-In via popup
   ✅  Persist uid / name / email / picture to localStorage
   ✅  Sign-out with localStorage clean-up
   ✅  onAuthStateChanged listener (auto-restores session after refresh)
   ✅  isConfigured() guard (falls back to demo mode until you add credentials)

   NOT IN PHASE 1 — leave for later phases
   ─────────────────────────────────────────
   ⏳  Firestore / Realtime Database
   ⏳  Storing bookings in the cloud
   ⏳  Google Calendar / Meet integration
   ⏳  Cloud Functions / email via SMTP
   ⏳  Razorpay live keys
   ⏳  Any backend API

   FIREBASE SETTINGS YOU WILL NEED TO CREATE
   ────────────────────────────────────────────
   Before this file does anything real, complete these steps once:

   1. Go to  https://console.firebase.google.com
   2. Click "Add project" → give it a name (e.g. "ocultt-tarot")
   3. Inside the project, open  Authentication → Sign-in method
   4. Enable the "Google" provider and set your support email
   5. Open  Authentication → Settings → Authorised domains
      and add every domain you will deploy to (e.g. ocultt.com, www.ocultt.com)
      localhost is already there by default for local testing
   6. Open  Project Settings (gear icon) → Your apps → </> (Web)
      Register a web app → copy the firebaseConfig object
   7. Paste each value into the FIREBASE_CONFIG block below
   8. Done — no separate OAuth client setup needed;
      Firebase manages the Google OAuth credentials automatically

   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 1 — FIREBASE CONFIGURATION
     ─────────────────────────────────────────────────────────────────────
     Replace every placeholder string with the real values from your
     Firebase Console → Project Settings → SDK setup and configuration.

     ⚠️  DO NOT commit real credentials to a public repository.
         When going to production, move these into environment variables
         or a server-side endpoint that serves them at runtime.
     ───────────────────────────────────────────────────────────────────── */
  var FIREBASE_CONFIG = {
    apiKey:            'AIzaSyCqs3px-ZaSMPtCpkDE3utC1wOxlfc8iF0',
    authDomain:        'the-ocultt-tarot.firebaseapp.com',
    projectId:         'the-ocultt-tarot',
    storageBucket:     'the-ocultt-tarot.firebasestorage.app',
    messagingSenderId: '599952695152',
    appId:             '1:599952695152:web:66c4dbd95aae6ccf8339b5',
    measurementId:     'G-S8JZZ5JWXC'  // optional — Analytics only,
  };

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 2 — SAFETY CHECKS
     Verify that the Firebase compat SDKs are loaded before this file runs.
     Both scripts must appear in index.html BEFORE this <script> tag.
     ───────────────────────────────────────────────────────────────────── */
  if (typeof firebase === 'undefined') {
    console.error(
      '[OculttFirebase] Firebase SDK not found. ' +
      'Ensure firebase-app-compat.js and firebase-auth-compat.js ' +
      'are loaded in index.html before js/firebase.js.'
    );
    // Attach a no-op stub so script.js does not throw if it calls OculttFirebase
    window.OculttFirebase = { isConfigured: function(){ return false; } };
    return;
  }

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 3 — INITIALISE FIREBASE APP
     Guard against accidental double-initialisation (e.g. hot-reload).
     ───────────────────────────────────────────────────────────────────── */
  var _app;
  try {
    _app = (firebase.apps && firebase.apps.length > 0)
      ? firebase.app()
      : firebase.initializeApp(FIREBASE_CONFIG);
  } catch (err) {
    console.error('[OculttFirebase] firebase.initializeApp() failed:', err);
    window.OculttFirebase = { isConfigured: function(){ return false; } };
    return;
  }

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 4 — AUTH INSTANCE AND GOOGLE PROVIDER
     ───────────────────────────────────────────────────────────────────── */
  var _auth     = firebase.auth();
  var _provider = new firebase.auth.GoogleAuthProvider();

  // Request profile and email scopes (included by default; listed for clarity)
  _provider.addScope('profile');
  _provider.addScope('email');

  // Force the Google account chooser so multi-account users can pick freely.
  // Remove this line if you prefer silent re-authentication.
  _provider.setCustomParameters({ prompt: 'select_account' });

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 5 — LOCALSTORAGE KEY
     Must match GAUTH_STORAGE_KEY in script.js (currently 'ocultt_user_v1')
     so both files read/write the same object.
     ───────────────────────────────────────────────────────────────────── */
  var STORAGE_KEY = 'ocultt_user_v1';

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 6 — INTERNAL HELPERS
     ───────────────────────────────────────────────────────────────────── */

  /**
   * Map a Firebase User object to the flat shape the rest of the site
   * expects: { uid, name, email, picture }
   * This matches the object written by the legacy GIS integration.
   */
  function _normaliseUser(firebaseUser) {
    if (!firebaseUser) return null;
    return {
      uid:     firebaseUser.uid         || '',
      name:    firebaseUser.displayName || firebaseUser.email || '',
      email:   firebaseUser.email       || '',
      picture: firebaseUser.photoURL    || ''
    };
  }

  /**
   * Write the normalised user to localStorage.
   * On sign-out, pass null to remove the entry.
   * Wrapped in try/catch because localStorage can be blocked in
   * private-browsing mode — non-fatal.
   */
  function _persist(normalisedUser) {
    try {
      if (normalisedUser) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(normalisedUser));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      console.warn('[OculttFirebase] localStorage write blocked:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 7 — PUBLIC API  (window.OculttFirebase)
     All methods are attached to window so script.js can call them
     without a module bundler or import statements.
     ───────────────────────────────────────────────────────────────────── */
  window.OculttFirebase = {

    /* ── signInWithGoogle ────────────────────────────────────────────
       Trigger the Google popup sign-in flow.
       Returns a Promise that resolves with { uid, name, email, picture }
       on success, or rejects with a Firebase AuthError on failure.

       Called by script.js when the "Continue with Google" button is
       clicked inside the "Enter the Sanctum" modal.
       ──────────────────────────────────────────────────────────────── */
    signInWithGoogle: function () {
      return _auth.signInWithPopup(_provider).then(function (result) {
        var user = _normaliseUser(result.user);
        _persist(user);
        return user;
        // Errors propagate to the caller in script.js for UI handling
      });
    },

    /* ── signOut ─────────────────────────────────────────────────────
       Sign the current user out of Firebase and clear localStorage.
       Returns a Promise.
       ──────────────────────────────────────────────────────────────── */
    signOut: function () {
      return _auth.signOut().then(function () {
        _persist(null);
      });
    },

    /* ── getCurrentUser ──────────────────────────────────────────────
       Return the currently signed-in user as a normalised object,
       or null if nobody is signed in.
       This is synchronous — it reads the Firebase SDK's in-memory cache.
       ──────────────────────────────────────────────────────────────── */
    getCurrentUser: function () {
      return _normaliseUser(_auth.currentUser);
    },

    /* ── onAuthStateChanged ──────────────────────────────────────────
       Register a callback that fires:
         • Immediately with the current user (or null) on page load
         • Again whenever the user signs in or out
         • Again when the Firebase ID token is silently refreshed

       script.js calls this once during gauthInit() so the nav pill
       stays in sync automatically without any manual polling.

       @param  {Function} callback  Receives a normalised user object or null
       @returns {Function}          Unsubscribe function (call to stop listening)
       ──────────────────────────────────────────────────────────────── */
    onAuthStateChanged: function (callback) {
      return _auth.onAuthStateChanged(function (firebaseUser) {
        var user = _normaliseUser(firebaseUser);
        _persist(user);    // keep localStorage in sync on every token refresh
        callback(user);
      });
    },

    /* ── getIdToken ──────────────────────────────────────────────────
       Returns a Promise resolving to the current user's Firebase ID
       token (or null if signed out). This is the real, verifiable proof
       of identity — used as the CRM's admin key (x-admin-key header) so
       the backend can check who is actually calling it, instead of
       trusting the browser.
       ──────────────────────────────────────────────────────────────── */
    getIdToken: function () {
      return _auth.currentUser ? _auth.currentUser.getIdToken() : Promise.resolve(null);
    },

    /* ── isConfigured ────────────────────────────────────────────────
       Returns true only when FIREBASE_CONFIG has been filled in with
       real credentials.  While the placeholder strings are still in
       place, script.js falls back to demo mode so the site remains
       fully usable during development.
       ──────────────────────────────────────────────────────────────── */
    isConfigured: function () {
      return FIREBASE_CONFIG.apiKey !== 'REPLACE_WITH_YOUR_FIREBASE_API_KEY';
    }

  }; // end window.OculttFirebase

  /* ─────────────────────────────────────────────────────────────────────
     SECTION 8 — BOOT LOG
     ───────────────────────────────────────────────────────────────────── */
  if (window.OculttFirebase.isConfigured()) {
    console.info('[OculttFirebase] Initialised with real credentials. Google Sign-In is live.');
  } else {
    console.info(
      '[OculttFirebase] Placeholder credentials detected. ' +
      'Fill in FIREBASE_CONFIG in js/firebase.js to enable real Google Sign-In. ' +
      'Demo mode is active in the meantime.'
    );
  }

})(); // end IIFE
