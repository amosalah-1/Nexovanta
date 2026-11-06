# Connect Nexovanta to Supabase

The browser app uses Supabase Auth for sign-in and Supabase Postgres for platform data. `localStorage` remains a read-through UI cache; it is not the system of record once Supabase is configured. Never place a Supabase service-role key in this repository or in browser code.

## 1. Create the Supabase project

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. In **Project Settings → API**, copy the **Project URL** and **anon/public key**.
3. For local development, copy `.env.example` to `.env` and replace both placeholders with the Project URL and anon/public key. Use the project base URL (for example, `https://your-project.supabase.co`, without `/rest/v1`). The anon key is designed for browsers; RLS in the schema protects data. Never use a service-role or secret key in browser code.
4. Serve the project from a local web server (not by opening HTML files with `file://`). Configure your local and production origins under **Authentication → URL Configuration**.

## 2. Create the database schema

1. Open **SQL Editor** in the Supabase dashboard.
2. Paste and run all of `supabase-schema.sql`.
3. In **Authentication → URL Configuration**, set **Site URL** to your production app URL and add the callback URLs under **Redirect URLs**. Nexovanta sends signup confirmations back to the current host's `/login.html?verified=1`; allow each host/path used for signup, for example `https://nexovanta-seven.vercel.app/login.html`, `http://127.0.0.1:8000/login.html`, and `http://localhost:8000/login.html`. If using another Vercel production or preview domain/local port, add its matching `/login.html` URL as well. The URL must match the browser host where the user registered.
4. In **Authentication → Providers**, keep Email enabled and enable **Allow new users to sign up** in the Auth settings. Configure email delivery and confirmation behavior for your deployment. Student, business, and resident accounts all use the same Supabase Auth login; with email confirmation enabled, new users must confirm their email before logging in.
5. If you customized the **Confirm signup** email template, keep its link as `{{ .ConfirmationURL }}` so Supabase can validate the one-time token and apply the requested redirect.

The schema creates profiles, record storage for social/events/news/marketplace, follows, and private chat data; row-level security policies; and an Auth trigger that creates each new profile. It adds `nexovanta_records` to the `supabase_realtime` publication so open feed and chat pages receive inserts immediately. Follows are stored as `nx_follows` records with server-enforced ownership; the profile pages can display and manage followers/following, and following members get a dedicated feed. The Messages profile action opens a private one-to-one Supabase chat. It creates the public `profile-media` Storage bucket for profile avatars and cover photos. Authenticated users can upload only into their own profile-ID folder; images are restricted to JPG, PNG, or WebP and 5 MB, while profile images are publicly readable. Chat conversations and messages are readable only by their members. The record policies use security-definer checks for cross-record lookups to avoid recursive RLS evaluation. For existing projects, apply the specific SQL migrations in `supabase-migrations/`; rerun the full schema only when a change explicitly requires it. New account privileges are always `member`; assign moderator/admin privileges only through trusted SQL.

### Community publishing upgrade

The current full schema includes the publishing protections. Existing Supabase projects must run `supabase-migrations/20261106_community_publishing.sql` once in the SQL Editor before deploying the frontend. It preserves all existing records and tables, limits public news reads to published articles, forces member submissions into `pending`, and reserves publication-status and review-metadata changes for moderators/admins. Authors and moderators can still read their pending submissions through the existing owner/moderator policy.

Follow creation and its new-follower notification are inserted together by the `nexovanta_follow_profile` database function, which derives the follower from the signed-in Supabase user. This prevents a second client-side write from failing notification RLS after the follow itself has already succeeded. If following or notification creation fails with an RLS or missing-function error, rerun the full `supabase-schema.sql` in the SQL Editor for the correct Supabase project so the current functions and policies are installed.

### Marketplace shop images

For an existing Supabase project, run `supabase-migrations/20261106_marketplace_shop_media.sql` once in the SQL Editor before enabling merchant uploads. It creates/reuses the public `shop-media` bucket (8 MB limit; JPEG/WebP objects) and installs public-read plus shop-owner-only insert/update/delete Storage policies. The policies use the existing `nexovanta_current_user_owns_shop` function and the first path segment as the shop ID. Do not make the bucket private or broaden the write policies; public storefronts load published shop images directly from their public URLs.

The merchant dashboard compresses photos in the browser, stores full images and WebP thumbnails in Storage, and saves the public URLs and Storage paths in existing shop/product JSON records. No marketplace tables or migrations to existing shop/product records are required. Uploads require Supabase to be configured and the signed-in user's shop ownership to be represented by its `owner_id`; URL-based product and branding images remain available. If installing from scratch, the full `supabase-schema.sql` also creates the bucket and policies.

## 3. Promote the initial administrator

Register the first account through Nexovanta, confirm its email if required, then run this in the SQL Editor, replacing the username:

```sql
update public.nexovanta_profiles
set account_role = 'admin'
where username = 'your_username';
```

The profile trigger prevents users from changing their own privilege level.

## 4. Migrate existing browser data once

Legacy accounts used locally stored, reversibly encoded passwords. Those passwords must **not** be copied to Supabase; every person needs to register again with a real email and a new password. The existing seed/demo accounts cannot sign in through Supabase Auth until separately recreated as Auth users.

To migrate the currently open browser's profiles and content, sign into the administrator account on the site, open the browser developer console, and run:

```js
await NexovantaDB.migrateLocalData()
```

Run this only once from the browser that has the local data you want to retain. The RPC ignores duplicate IDs, strips password fields, and is restricted to an administrator. Review the migrated data in the Supabase Table Editor. If data lives in several browsers, run the migration in each browser while signed in as the administrator.

## 5. Run locally and test the connection

Install [Node.js](https://nodejs.org/) if it is not already installed. From the project root, start the included static development server:

```bash
npm start
```

Then open `http://127.0.0.1:8000`. Start the server from the repository root (the folder containing `package.json` and `supabase-config.js`), not the older duplicate `Nexovanta` subfolder. You can also run `node server.js` directly. Stop the server with `Ctrl+C`. Set `PORT` to use a different port, for example `PORT=3000 npm start` (PowerShell: `$env:PORT=3000; npm start`).

This serves the existing browser app locally; it is not a separate application backend. Supabase Auth and Postgres requests go directly from the browser to your Supabase project using the public anon key and database RLS.

To verify the local configuration without printing the anon key, request the config endpoint:

```powershell
(Invoke-WebRequest http://127.0.0.1:8000/supabase-config.js).StatusCode
```

It should return `200`. If it returns `500`, check that `.env` has both values, that the URL is the project base URL, and that the key is the anon/public key; restart `npm start` after changing `.env`. Do not paste the response body into public logs because it contains the browser anon key.

1. Register a new account using a real email address and sign in.
2. Create a post, event, marketplace shop/product, and a test order.
3. Change the test account's avatar and cover photo; confirm objects appear in the `profile-media` bucket and their URLs are saved in `nexovanta_profiles`.
4. Follow a second test account, verify its follower/following counts and connection lists, and check that the new-follower notification appears.
5. Open **Following** in the feed and confirm posts from followed members appear there.
6. Start a one-to-one message from a member's profile and confirm the conversation and messages are visible only to its members.
7. Open the site in another browser/device and confirm messages arrive without refreshing and new posts appear on the feed.
8. Use **Enable alerts** in the feed notification menu or **Enable notifications** in Messages to allow browser notifications for new posts and messages while the site is open.
9. Check browser console and the Nexovanta connection banner for RLS/configuration errors.

## 6. Deploy to Vercel

1. Push the repository to GitHub and import it into Vercel. Use the **Other** framework preset. `vercel.json` configures the build command and `dist` output directory; do not override them in the Vercel dashboard.
2. In Vercel, open **Project Settings → Environment Variables** and add `SUPABASE_URL` (the project base URL, without `/rest/v1`) and `SUPABASE_ANON_KEY` (the public anon key). Add them for Production and Preview as needed. Do not add the service-role key.
3. Deploy or redeploy. The build copies only browser assets into `dist/`, so browser scripts such as `app.js` are served as static files instead of being run by Node. Vercel's `/api/supabase-config` function supplies the browser config at `/supabase-config.js`; the rewrite is in `vercel.json`.
4. In Supabase **Authentication → URL Configuration**, set the deployed site URL and add the Vercel production domain and any Preview domains you will use to the allowed redirect URLs.
5. Open `https://<your-deployment>/supabase-config.js` and confirm it returns JavaScript with HTTP `200`; do not share or publish the response body because it includes the anon key. If it returns an error, check both Vercel environment variables, ensure the URL does not include `/rest/v1`, then redeploy after changing them. Finally, open the deployed site and verify sign-up/login and database reads.

The `.env` file is only for local development and is ignored by Git. `.env.example` contains placeholders only. Hosting platforms do not automatically read `.env`; configure their environment variables in the dashboard.

## Operational notes

- The browser config contains only the public Supabase URL and anon key. Keep service-role keys, database passwords, and secrets on a trusted server.
- Username availability is checked against the locally hydrated profile cache; the database unique constraint remains authoritative.
- Login now uses email and password through Supabase Auth. Reset passwords through Supabase Auth/email (not the former local-only demo reset).
- The current application uses browser-side JSON records to match its existing synchronous UI. For high traffic or payments, move order creation, inventory changes, moderation, and privileged operations to validated Postgres RPCs or a trusted server and tighten the relevant RLS policies.
- If Supabase is not configured, the app visibly reports that it is using its local demo cache; remote login and persistence are unavailable.
