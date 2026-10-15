/**
 * Public Supabase project settings.
 * The anon key is intended for browser use; never put a service-role key here.
 */
if (typeof window !== 'undefined') {
window.NEXOVANTA_SUPABASE_CONFIG = {
  url: 'https://sdqwyfpclkcnhjwuuxap.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkcXd5ZnBjbGtjbmhqd3V1eGFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwNDIyMTUsImV4cCI6MjEwNzYxODIxNX0.ZizeZp5L-E1F96_XlM60DMOyRuNXLb0CMR34KNK1pGg'
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
