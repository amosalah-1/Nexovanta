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

(function () {
  'use strict';

  // Run synchronously so the redirect happens before the DOM paints
  try {
    var session = JSON.parse(localStorage.getItem('nexovanta_user') || 'null');
    var isLoggedIn = !!(session && session.loggedIn && session.id);

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
    // If localStorage is unavailable, redirect to login
    window.location.replace('login.html');
  }
})();
