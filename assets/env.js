// G7 Capital — Environment routing
// Determines which Cloudflare Worker to talk to based on the current hostname.
// Load this file BEFORE auth.js, scout.js, or workspace.js on every page.
var G7_WORKER_URL = (function () {
  var h = location.hostname;
  if (h === 'gsevnservices.in' || h === 'www.gsevnservices.in')
    return 'https://g7-proxy.gsevnservices.workers.dev';
  return 'https://g7-proxy-dev.gsevnservices.workers.dev';
})();
