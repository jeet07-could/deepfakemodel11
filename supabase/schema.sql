create extension if not exists pgcrypto;

create table if not exists public.analyses (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    video_path text not null unique,
    model text not null,
    real_probability double precision not null check (real_probability between 0 and 1),
    verdict text not null check (verdict in ('real', 'fake')),
    regions jsonb not null default '{}'::jsonb,
    gradcam_path text,
    created_at timestamptz not null default now()
);

create index if not exists analyses_user_created_at_idx
    on public.analyses (user_id, created_at desc);

alter table public.analyses enable row level security;

drop policy if exists "Users can view their own analyses" on public.analyses;
create policy "Users can view their own analyses"
    on public.analyses for select to authenticated
    using ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own analyses" on public.analyses;
create policy "Users can delete their own analyses"
    on public.analyses for delete to authenticated
    using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'deepfake-videos',
    'deepfake-videos',
    false,
    104857600,
    array['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/webm', 'image/png']
)
on conflict (id) do update set
    public = false,
    file_size_limit = 104857600,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can view their own video objects" on storage.objects;
create policy "Users can view their own video objects"
    on storage.objects for select to authenticated
    using (
        bucket_id = 'deepfake-videos'
        and (storage.foldername(name))[1] = (select auth.uid())::text
    );

drop policy if exists "Users can upload their own video objects" on storage.objects;
create policy "Users can upload their own video objects"
    on storage.objects for insert to authenticated
    with check (
        bucket_id = 'deepfake-videos'
        and (storage.foldername(name))[1] = (select auth.uid())::text
    );

drop policy if exists "Users can delete their own video objects" on storage.objects;
create policy "Users can delete their own video objects"
    on storage.objects for delete to authenticated
    using (
        bucket_id = 'deepfake-videos'
        and (storage.foldername(name))[1] = (select auth.uid())::text
    );
