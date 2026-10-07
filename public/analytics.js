/**
 * Quantum Pulse — Vercel Web Analytics loader (page views only).
 *
 * Kept as a file rather than Vercel's inline snippet because the server's CSP
 * allows scripts from 'self' only. The insights script and its beacon are both
 * served same-origin under /_vercel/insights on Vercel deployments, so no CSP
 * change is needed. Skipped for local development, where that path does not
 * exist. No cookies; Vercel aggregates visits anonymously.
 */
(() => {
  // Queue for custom events: window.va('event', { name: '...' }) before the script loads.
  window.va = window.va || function va(...args) { (window.vaq = window.vaq || []).push(args); };
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = '/_vercel/insights/script.js';
  document.head.appendChild(s);
})();
