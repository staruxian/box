# Vercel

Deploy this repository's root using the Vite preset. The build command is
`bun run build`, and the output directory is `dist`.
Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in the project's environment
variables for each deployment environment that should access the database.

`vercel.json` serves `index.html` for browser routes such as `/clients/42`, so
opening a link directly or refreshing it works with React Router. Existing
files and functions take precedence. `/api` and `/assets` are excluded from the
fallback, so API responses and missing build assets never become HTML pages.
The API remains the Node function in `api/[...path].ts`.

After deploying, open `/inventory`, `/clients`, and an existing client profile
directly, then refresh each page twice. Check that `/api/snapshot` returns JSON,
that the JavaScript and CSS referenced by the page load, and that a nonexistent
`/assets/missing.js` returns 404. A local Vite preview alone does not verify
Vercel's routing configuration.

Reference: [Vercel's Vite SPA routing guide](https://vercel.com/docs/frameworks/frontend/vite#using-vite-to-make-spas).
