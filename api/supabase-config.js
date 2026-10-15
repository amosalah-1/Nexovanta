'use strict';

function getProjectUrl() {
  const configuredUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!configuredUrl) return null;

  try {
    const url = new URL(configuredUrl);
    if (url.protocol !== 'https:') return null;
    url.pathname = url.pathname.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function createConfigScript(url, anonKey) {
  return `window.NEXOVANTA_SUPABASE_CONFIG = {
  url: ${JSON.stringify(url)},
  anonKey: ${JSON.stringify(anonKey)}
};

if (window.supabase) {
  window.NexovantaSupabase = window.supabase.createClient(
    window.NEXOVANTA_SUPABASE_CONFIG.url,
    window.NEXOVANTA_SUPABASE_CONFIG.anonKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );
}
`;
}

module.exports = (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    response.status(405).send('Method Not Allowed');
    return;
  }

  const url = getProjectUrl();
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey || /^(your-project\.supabase\.co|your-anon-public-key|your-public-anon-key)$/i.test(anonKey)) {
    response.status(500).send('Supabase deployment configuration is missing or invalid. Set SUPABASE_URL to the project base URL and SUPABASE_ANON_KEY to the public anon key.');
    return;
  }

  const script = createConfigScript(url, anonKey);
  response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'HEAD') {
    response.status(200).end();
    return;
  }
  response.status(200).send(script);
};
