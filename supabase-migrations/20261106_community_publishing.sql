begin;

create or replace function public.nexovanta_guard_news_moderation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.collection <> 'nx_news' or public.nexovanta_is_moderator() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.data := jsonb_set(coalesce(new.data, '{}'::jsonb), '{status}', '"pending"'::jsonb, true);
    new.data := new.data || jsonb_build_object(
      'published_at', null,
      'reviewed_by', null,
      'moderation_note', ''
    );
    return new;
  end if;

  if new.data -> 'status' is distinct from old.data -> 'status'
    or new.data -> 'published_at' is distinct from old.data -> 'published_at'
    or new.data -> 'reviewed_by' is distinct from old.data -> 'reviewed_by'
    or new.data -> 'moderation_note' is distinct from old.data -> 'moderation_note' then
    raise exception 'Only moderators can change news publication status or review details';
  end if;

  return new;
end;
$$;

drop trigger if exists nexovanta_news_moderation_guard on public.nexovanta_records;
create trigger nexovanta_news_moderation_guard
  before insert or update on public.nexovanta_records
  for each row execute function public.nexovanta_guard_news_moderation();

drop policy if exists "Public marketplace and community records are readable" on public.nexovanta_records;
create policy "Public marketplace and community records are readable"
  on public.nexovanta_records for select
  using (collection in (
    'nx_posts', 'nx_comments', 'nx_reactions', 'nx_events', 'nx_event_rsvps',
    'nx_follows', 'nexovanta_shops_db', 'nexovanta_products_db', 'nexovanta_reviews_db'
  ) or (collection = 'nx_news' and data ->> 'status' = 'published'));

commit;
