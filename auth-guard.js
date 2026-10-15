/**
 * auth-guard.js — Nexovanta Authentication Guard
 * 
 * Include this script AFTER nexovanta-db.js on every protected page.
 * It immediately checks whether a valid session exists and redirects
 * unauthenticated visitors to login.html before any page content renders.
 * 
 * Usage:
 *   <script src="nexovanta-db.js"></script>
 *   <script src="auth-guard.js"></script>
 */

(async function () {
  'use strict';

  try {
    await NexovantaDB.ready;
    if (!NexovantaDB.supabase) {
      window.location.replace('login.html');
      return;
    }
    const { data, error } = await NexovantaDB.supabase.auth.getSession();
    if (error) throw error;
    var session = JSON.parse(localStorage.getItem('nexovanta_user') || 'null');
    var isLoggedIn = !!(
      data.session &&
      session &&
      session.loggedIn &&
      session.auth_user_id === data.session.user.id
    );

    if (!isLoggedIn) {
      // Preserve the intended destination so login.html can redirect back after auth
      var returnPath = window.location.pathname + window.location.search;
      var loginUrl = 'login.html';
      if (returnPath && returnPath !== '/' && returnPath !== '/login.html') {
        loginUrl = 'login.html?return=' + encodeURIComponent(returnPath);
      }
      window.location.replace(loginUrl);
    }
  } catch (e) {
    console.error('Nexovanta authentication check failed:', e);
    window.location.replace('login.html');
  }
})();
