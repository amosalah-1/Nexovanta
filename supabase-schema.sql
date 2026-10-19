-- Nexovanta Supabase schema
-- Run this once in Supabase Dashboard > SQL Editor.

create table if not exists public.nexovanta_profiles (
  id text primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  username text not null unique,
  full_name text not null default '',
  email text not null default '',
  phone text not null default '',
  avatar_url text,
  cover_photo_url text,
  bio text not null default '',
  location text not null default '',
  community_category text not null default 'general',
  role text not null default 'student' check (role in ('student', 'business', 'resident')),
  account_role text not null default 'member' check (account_role in ('member', 'moderator', 'admin')),
  privacy_settings jsonb not null default '{"public_posts": true, "show_email": false}'::jsonb,
  marketplace_shop_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nexovanta_records (
  collection text not null constraint nexovanta_records_collection_check check (collection in (
    'nx_posts', 'nx_comments', 'nx_reactions', 'nx_events', 'nx_event_rsvps',
    'nx_saved_posts', 'nx_notifications', 'nx_reports', 'nx_news',
    'nx_chat_conversations', 'nx_chat_messages',
    'nexovanta_shops_db', 'nexovanta_products_db', 'nexovanta_orders_db',
    'nexovanta_reviews_db', 'nexovanta_wishlist_db'
  )),
  record_id text not null,
  owner_id text,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, record_id)
);

alter table public.nexovanta_records
  drop constraint if exists nexovanta_records_collection_check;
alter table public.nexovanta_records
  add constraint nexovanta_records_collection_check check (collection in (
    'nx_posts', 'nx_comments', 'nx_reactions', 'nx_events', 'nx_event_rsvps',
    'nx_saved_posts', 'nx_notifications', 'nx_reports', 'nx_news',
    'nx_chat_conversations', 'nx_chat_messages',
    'nexovanta_shops_db', 'nexovanta_products_db', 'nexovanta_orders_db',
    'nexovanta_reviews_db', 'nexovanta_wishlist_db'
  ));

create index if not exists nexovanta_records_collection_owner_idx
  on public.nexovanta_records (collection, owner_id);
create index if not exists nexovanta_records_data_gin_idx
  on public.nexovanta_records using gin (data);

create or replace view public.nexovanta_profiles_public
with (security_invoker = true) as
select id, username, full_name, phone, avatar_url, cover_photo_url, bio, location,
       community_category, role, account_role, privacy_settings, marketplace_shop_id,
       auth_user_id, created_at, updated_at
from public.nexovanta_profiles;

create or replace function public.nexovanta_current_profile_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.nexovanta_profiles p
  where p.auth_user_id = (select auth.uid())
  limit 1
$$;

create or replace function public.nexovanta_is_moderator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.nexovanta_profiles p
    where p.auth_user_id = (select auth.uid())
      and p.account_role in ('admin', 'moderator')
  )
$$;

create or replace function public.nexovanta_is_chat_member(conversation_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
set row_security = off
as $$
  select exists (
    select 1
    from public.nexovanta_records r
    where r.collection = 'nx_chat_conversations'
      and r.record_id = conversation_id
      and r.data -> 'member_ids' ? public.nexovanta_current_profile_id()
  )
$$;

revoke all on function public.nexovanta_is_chat_member(text) from public, anon;
grant execute on function public.nexovanta_is_chat_member(text) to authenticated;

create or replace function public.nexovanta_current_user_owns_shop(shop_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
set row_security = off
as $$
  select exists (
    select 1
    from public.nexovanta_records r
    where r.collection = 'nexovanta_shops_db'
      and r.record_id = shop_id
      and r.owner_id = public.nexovanta_current_profile_id()
  )
$$;

create or replace function public.nexovanta_shop_exists(shop_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
set row_security = off
as $$
  select exists (
    select 1
    from public.nexovanta_records r
    where r.collection = 'nexovanta_shops_db'
      and r.record_id = shop_id
  )
$$;

revoke all on function public.nexovanta_current_user_owns_shop(text) from public, anon;
grant execute on function public.nexovanta_current_user_owns_shop(text) to authenticated;
revoke all on function public.nexovanta_shop_exists(text) from public, anon;
grant execute on function public.nexovanta_shop_exists(text) to authenticated;

create or replace function public.nexovanta_create_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_username text;
  legacy_profile_id text;
begin
  profile_username := lower(regexp_replace(
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
    '[^a-zA-Z0-9_]', '', 'g'
  ));
  if length(profile_username) < 3 then
    profile_username := 'user_' || left(replace(new.id::text, '-', ''), 12);
  end if;
  profile_username := left(profile_username, 30);

  select p.id into legacy_profile_id
  from public.nexovanta_profiles p
  where p.username = profile_username and p.auth_user_id is null
  limit 1;

  if legacy_profile_id is not null then
    update public.nexovanta_profiles
    set auth_user_id = new.id,
        email = coalesce(new.email, ''),
        role = case when new.raw_user_meta_data ->> 'role' in ('student', 'business', 'resident')
          then new.raw_user_meta_data ->> 'role' else role end,
        updated_at = now()
    where id = legacy_profile_id;
  else
    insert into public.nexovanta_profiles (
      id, auth_user_id, username, full_name, email, phone, role,
      community_category, account_role, bio, location
    ) values (
      new.id::text,
      new.id,
      profile_username,
      coalesce(new.raw_user_meta_data ->> 'full_name', profile_username),
      coalesce(new.email, ''),
      coalesce(new.raw_user_meta_data ->> 'phone', ''),
      case when new.raw_user_meta_data ->> 'role' in ('student', 'business', 'resident')
        then new.raw_user_meta_data ->> 'role' else 'student' end,
      coalesce(new.raw_user_meta_data ->> 'community_category', 'general'),
      'member',
      coalesce(new.raw_user_meta_data ->> 'bio', ''),
      coalesce(new.raw_user_meta_data ->> 'location', '')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists nexovanta_auth_user_created on auth.users;
create trigger nexovanta_auth_user_created
  after insert on auth.users
  for each row execute function public.nexovanta_create_profile();

create or replace function public.nexovanta_protect_profile_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.auth_user_id is not null and new.account_role <> old.account_role and auth.uid() is not null then
    raise exception 'Account privileges can only be changed by an administrator';
  end if;
  if old.auth_user_id is not null and new.auth_user_id <> old.auth_user_id then
    raise exception 'Profile ownership cannot be changed';
  end if;
  return new;
end;
$$;

drop trigger if exists nexovanta_profile_role_guard on public.nexovanta_profiles;
create trigger nexovanta_profile_role_guard
  before update on public.nexovanta_profiles
  for each row execute function public.nexovanta_protect_profile_roles();

alter table public.nexovanta_profiles enable row level security;
alter table public.nexovanta_records enable row level security;

revoke all on public.nexovanta_profiles from anon, authenticated;
grant select (id, username, full_name, phone, avatar_url, cover_photo_url, bio, location,
  community_category, role, account_role, privacy_settings, marketplace_shop_id, auth_user_id,
  created_at, updated_at)
  on public.nexovanta_profiles to anon, authenticated;
grant insert (id, auth_user_id, username, full_name, email, phone, avatar_url, cover_photo_url, bio,
  location, community_category, role, privacy_settings, marketplace_shop_id)
  on public.nexovanta_profiles to authenticated;
grant update (username, full_name, phone, avatar_url, cover_photo_url, bio, location,
  community_category, role, privacy_settings, marketplace_shop_id, updated_at)
  on public.nexovanta_profiles to authenticated;
grant select, insert, update, delete on public.nexovanta_records to anon, authenticated;
grant select on public.nexovanta_profiles_public to anon, authenticated;

drop policy if exists "Public profiles are readable" on public.nexovanta_profiles;
create policy "Public profiles are readable"
  on public.nexovanta_profiles for select
  using (true);

drop policy if exists "Users update their own profile" on public.nexovanta_profiles;
create policy "Users update their own profile"
  on public.nexovanta_profiles for update to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));

drop policy if exists "Public marketplace and community records are readable" on public.nexovanta_records;
create policy "Public marketplace and community records are readable"
  on public.nexovanta_records for select
  using (collection in (
    'nx_posts', 'nx_comments', 'nx_reactions', 'nx_events', 'nx_event_rsvps', 'nx_news',
    'nexovanta_shops_db', 'nexovanta_products_db', 'nexovanta_reviews_db'
  ));

drop policy if exists "Owners and moderators read private records" on public.nexovanta_records;
create policy "Owners and moderators read private records"
  on public.nexovanta_records for select to authenticated
  using (
    owner_id = public.nexovanta_current_profile_id()
    or public.nexovanta_is_moderator()
    or (
      collection = 'nx_chat_conversations'
      and data -> 'member_ids' ? public.nexovanta_current_profile_id()
    )
    or (
      collection = 'nx_chat_messages'
      and public.nexovanta_is_chat_member(data ->> 'conversation_id')
    )
    or (
      collection = 'nexovanta_orders_db'
      and data ->> 'customer_id' = public.nexovanta_current_profile_id()
    )
    or (
      collection = 'nexovanta_orders_db'
      and public.nexovanta_current_user_owns_shop(data ->> 'shop_id')
    )
  );

drop policy if exists "Authenticated users create owned records" on public.nexovanta_records;
create policy "Authenticated users create owned records"
  on public.nexovanta_records for insert to authenticated
  with check (
    (collection = 'nx_posts' and data ->> 'author_id' = public.nexovanta_current_profile_id())
    or (collection = 'nx_comments' and data ->> 'author_id' = public.nexovanta_current_profile_id())
    or (collection = 'nx_reactions' and data ->> 'user_id' = public.nexovanta_current_profile_id())
    or (collection = 'nx_events' and data ->> 'organiser_id' = public.nexovanta_current_profile_id())
    or (collection = 'nx_event_rsvps' and data ->> 'user_id' = public.nexovanta_current_profile_id())
    or (collection = 'nx_saved_posts' and data ->> 'user_id' = public.nexovanta_current_profile_id())
    or (collection = 'nexovanta_wishlist_db' and data ->> 'user_id' = public.nexovanta_current_profile_id())
    or (collection = 'nx_notifications'
      and owner_id = data ->> 'recipient_id'
      and exists (
        select 1 from public.nexovanta_profiles p
        where p.auth_user_id = (select auth.uid())
          and p.username = data ->> 'actor_username'
      ))
    or (collection = 'nx_reports' and data ->> 'reporter_id' = public.nexovanta_current_profile_id())
    or (collection = 'nx_news' and data ->> 'author_id' = public.nexovanta_current_profile_id())
    or (
      collection = 'nx_chat_conversations'
      and owner_id = public.nexovanta_current_profile_id()
      and data ->> 'created_by' = public.nexovanta_current_profile_id()
      and data -> 'member_ids' ? public.nexovanta_current_profile_id()
    )
    or (
      collection = 'nx_chat_messages'
      and owner_id = public.nexovanta_current_profile_id()
      and data ->> 'sender_id' = public.nexovanta_current_profile_id()
      and public.nexovanta_is_chat_member(data ->> 'conversation_id')
    )
    or (collection = 'nexovanta_shops_db' and owner_id = public.nexovanta_current_profile_id()
      and data ->> 'owner_id' = public.nexovanta_current_profile_id())
    or (collection = 'nexovanta_products_db'
      and public.nexovanta_current_user_owns_shop(data ->> 'shop_id'))
    or (collection = 'nexovanta_reviews_db' and data ->> 'author_id' = public.nexovanta_current_profile_id())
    or (collection = 'nexovanta_orders_db'
      and coalesce(data ->> 'customer_name', '') <> ''
      and coalesce(data ->> 'customer_phone', '') <> ''
      and public.nexovanta_shop_exists(data ->> 'shop_id'))
  );

drop policy if exists "Owners and moderators update records" on public.nexovanta_records;
create policy "Owners and moderators update records"
  on public.nexovanta_records for update to authenticated
  using (
    owner_id = public.nexovanta_current_profile_id()
    or public.nexovanta_is_moderator()
    or (
      collection = 'nexovanta_orders_db'
      and public.nexovanta_current_user_owns_shop(data ->> 'shop_id')
    )
  )
  with check (
    owner_id = public.nexovanta_current_profile_id()
    or public.nexovanta_is_moderator()
    or (
      collection = 'nexovanta_orders_db'
      and public.nexovanta_current_user_owns_shop(data ->> 'shop_id')
    )
  );

drop policy if exists "Owners and moderators delete records" on public.nexovanta_records;
create policy "Owners and moderators delete records"
  on public.nexovanta_records for delete to authenticated
  using (owner_id = public.nexovanta_current_profile_id() or public.nexovanta_is_moderator());

create or replace function public.nexovanta_migrate_legacy_data(
  legacy_profiles jsonb,
  legacy_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  migrated_profiles integer := 0;
  migrated_records integer := 0;
  item jsonb;
begin
  if not public.nexovanta_is_moderator() then
    raise exception 'Only an administrator can migrate local data';
  end if;

  for item in select value from jsonb_array_elements(coalesce(legacy_profiles, '[]'::jsonb))
  loop
    insert into public.nexovanta_profiles (
      id, username, full_name, phone, avatar_url, cover_photo_url, bio, location,
      community_category, role, account_role, privacy_settings, marketplace_shop_id,
      created_at, updated_at
    ) values (
      item ->> 'id', lower(item ->> 'username'), coalesce(item ->> 'full_name', ''),
      coalesce(item ->> 'phone', ''), item ->> 'avatar_url', item ->> 'cover_photo_url',
      coalesce(item ->> 'bio', ''), coalesce(item ->> 'location', ''),
      coalesce(item ->> 'community_category', 'general'),
      case when item ->> 'role' in ('student', 'business', 'resident') then item ->> 'role' else 'student' end,
      'member',
      coalesce(item -> 'privacy_settings', '{"public_posts": true, "show_email": false}'::jsonb),
      item ->> 'marketplace_shop_id',
      coalesce((item ->> 'created_at')::timestamptz, now()),
      coalesce((item ->> 'updated_at')::timestamptz, now())
    )
    on conflict do nothing;
    migrated_profiles := migrated_profiles + 1;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(legacy_records, '[]'::jsonb))
  loop
    insert into public.nexovanta_records (collection, record_id, owner_id, data)
    values (item ->> 'collection', item ->> 'record_id', nullif(item ->> 'owner_id', ''), item -> 'data')
    on conflict (collection, record_id) do nothing;
    migrated_records := migrated_records + 1;
  end loop;

  return jsonb_build_object('profiles', migrated_profiles, 'records', migrated_records);
end;
$$;

revoke all on function public.nexovanta_migrate_legacy_data(jsonb, jsonb) from public, anon;
grant execute on function public.nexovanta_migrate_legacy_data(jsonb, jsonb) to authenticated;
