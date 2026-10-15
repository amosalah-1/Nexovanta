# Connect Nexovanta to Supabase

The browser app uses Supabase Auth for sign-in and Supabase Postgres for platform data. `localStorage` remains a read-through UI cache; it is not the system of record once Supabase is configured. Never place a Supabase service-role key in this repository or in browser code.

## 1. Create the Supabase project

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. In **Project Settings → API**, copy the **Project URL** and **anon/public key**.
3. For local development, put the Project URL and anon/public key in `.env`. Use the project base URL (for example, `https://your-project.supabase.co`, without `/rest/v1`). The anon key is designed for browsers; RLS in the schema protects data. Never use a service-role or secret key in browser code.
4. Serve the project from a local web server (not by opening HTML files with `file://`). Configure your local and production origins under **Authentication → URL Configuration**.

## 2. Create the database schema

1. Open **SQL Editor** in the Supabase dashboard.
2. Paste and run all of `supabase-schema.sql`.
3. In **Authentication → Providers**, keep Email enabled. Set the site URL and allowed redirect URLs for your development and production hosts.
4. Configure email delivery and confirmation behavior for your deployment. With email confirmation enabled, new users must confirm their email before logging in.

The schema creates profiles, record storage for the existing social/events/news/marketplace data, row-level security policies, and an Auth trigger that creates each new profile. New account privileges are always `member`; assign moderator/admin privileges only through trusted SQL.

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

1. Register a new account using a real email address and sign in.
2. Create a post, event, marketplace shop/product, and a test order.
3. Confirm records appear in `nexovanta_profiles` and `nexovanta_records`.
4. Open the site in another browser/device and confirm public records are shared.
5. Check browser console and the Nexovanta connection banner for RLS/configuration errors.

## 6. Deploy to Vercel

1. Push the repository to GitHub and import it into Vercel. Use the **Other** framework preset. `vercel.json` configures the build command and `dist` output directory; do not override them in the Vercel dashboard.
2. In Vercel, open **Project Settings → Environment Variables** and add `SUPABASE_URL` (the project base URL, without `/rest/v1`) and `SUPABASE_ANON_KEY` (the public anon key). Add them for Production and Preview as needed. Do not add the service-role key.
3. Deploy or redeploy. The build copies only browser assets into `dist/`, so browser scripts such as `app.js` are served as static files instead of being run by Node. Vercel's `/api/supabase-config` function supplies the browser config at `/supabase-config.js`; the rewrite is in `vercel.json`.
4. In Supabase **Authentication → URL Configuration**, set the deployed site URL and add the Vercel production domain and any Preview domains you will use to the allowed redirect URLs.
5. Open the deployed site and verify sign-up/login and database reads. If the config endpoint returns an error, check that both Vercel environment variables are set and redeploy after changing them.

The `.env` file is only for local development and is ignored by Git. Hosting platforms do not automatically read it; configure their environment variables in the dashboard.

## Operational notes

- The browser config contains only the public Supabase URL and anon key. Keep service-role keys, database passwords, and secrets on a trusted server.
- Username availability is checked against the locally hydrated profile cache; the database unique constraint remains authoritative.
- Login now uses email and password through Supabase Auth. Reset passwords through Supabase Auth/email (not the former local-only demo reset).
- The current application uses browser-side JSON records to match its existing synchronous UI. For high traffic or payments, move order creation, inventory changes, moderation, and privileged operations to validated Postgres RPCs or a trusted server and tighten the relevant RLS policies.
- If Supabase is not configured, the app visibly reports that it is using its local demo cache; remote login and persistence are unavailable.
