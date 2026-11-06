begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'shop-media',
  'shop-media',
  true,
  8388608,
  array['image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can read shop media" on storage.objects;
create policy "Public can read shop media"
  on storage.objects for select
  using (bucket_id = 'shop-media');

drop policy if exists "Shop owners upload shop media" on storage.objects;
create policy "Shop owners upload shop media"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'shop-media'
    and public.nexovanta_current_user_owns_shop((storage.foldername(name))[1])
  );

drop policy if exists "Shop owners update shop media" on storage.objects;
create policy "Shop owners update shop media"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'shop-media'
    and public.nexovanta_current_user_owns_shop((storage.foldername(name))[1])
  )
  with check (
    bucket_id = 'shop-media'
    and public.nexovanta_current_user_owns_shop((storage.foldername(name))[1])
  );

drop policy if exists "Shop owners delete shop media" on storage.objects;
create policy "Shop owners delete shop media"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'shop-media'
    and public.nexovanta_current_user_owns_shop((storage.foldername(name))[1])
  );

commit;
