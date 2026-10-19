/**
 * Public Supabase project settings.
 * The anon key is intended for browser use; never put a service-role key here.
 */
if (typeof window !== 'undefined') {
window.NEXOVANTA_SUPABASE_CONFIG = {
  url: 'https://your-project.supabase.co',
  anonKey: 'your-anon-public-key'
};

if (window.supabase && window.NEXOVANTA_SUPABASE_CONFIG.url.startsWith('https://') && window.NEXOVANTA_SUPABASE_CONFIG.anonKey) {
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
}
