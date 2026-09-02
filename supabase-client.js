/* Browser-safe Supabase client configuration. In a Next.js build, expose these from NEXT_PUBLIC_* env vars. */
(function(){
  const url = window.NEXT_PUBLIC_SUPABASE_URL || 'https://utvavxwbsutuxhausaw.supabase.co';
  const key = window.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';
  window.FashionMaisonSupabase = { url, key, configured: Boolean(key) };
})();
