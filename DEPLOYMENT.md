# PixelPro Max — deployment

Live at **https://pixelpromax.onkra.online** on Coolify (`coolify.solnix.store`,
VPS `173.212.233.194`). Deployed 2026-10-07.

## Coolify resources

| Resource | UUID | Notes |
|---|---|---|
| Project | `hqufytw9pvytqunfmcjzwuwv` | "PixelPro Max" |
| Environment | `eqenyg5ykwlxvevyssw48jah` | `production` |
| Server | `myfwitwdjhljv0ksumbn9vqq` | `localhost` (the Coolify host) |
| Application | `ankgyogbk6lxoinxmljqcido` | `pixelpro-max` |
| Database | `uil3cbxpmbn7m0tuqa5kmrsw` | `pixelpromax-postgres` (standalone PostgreSQL) |

## How it's wired

- **Source:** public GitHub repo `ankur4work/pixelpromax`, branch `main`,
  build pack **dockerfile**. No deploy key or GitHub App — the repo is public,
  so Coolify clones it anonymously. Pushing `main` does **not** auto-redeploy
  (no git webhook is configured); trigger a deploy explicitly (Coolify UI, or
  `POST /api/v1/deploy?uuid=ankgyogbk6lxoinxmljqcido`).
- **Port:** container listens on `3000`; health check `GET /healthz`.
- **Migrations:** the container start command is `prisma migrate deploy &&
  react-router-serve` (see `Dockerfile` → `npm run docker-start`). Because the
  health check only passes once the server is serving, a healthy container is
  proof the migration applied. The DB holds the `0001_init` baseline.
- **Database URL:** set as a runtime env var in Coolify, using the Postgres
  resource's **internal** hostname (the container UUID above) over Coolify's
  Docker network. It is not reachable from outside the host.

## Secrets (NOT in git)

Set as runtime environment variables on the `pixelpro-max` application in
Coolify: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`,
`SHOPIFY_APP_HANDLE`, `DATABASE_URL`, `OPENAI_API_KEY`. The Postgres password is
stored on the database resource in Coolify. None of these live in the repo.

## Still required before App Store launch

These are not deployable via the Coolify API and remain manual:

1. **Push Shopify app config** — `shopify.app.toml` (URLs, scopes, webhook
   subscriptions incl. the mandatory compliance webhook) only takes effect once
   pushed to Shopify: `shopify app deploy --allow-updates` with
   `SHOPIFY_APP_AUTOMATION_TOKEN` set. Until then the registered webhooks /
   redirect URLs are whatever the Dev Dashboard already has.
2. **Create the Managed Pricing plans** in the Dev Dashboard — `Free`,
   `Starter`, `Growth`, `Pro` (+ `… Annual`), names matching
   `app/plans.server.js` byte-for-byte. **The Free plan is mandatory** or a
   reviewer on a dev store hits an impassable pricing wall.
3. **Confirm `SHOPIFY_APP_HANDLE`** — set to the assumed `pixelpro-max`. Verify
   against a real install URL (`/store/<store>/apps/<handle>/…`) and update the
   Coolify env var if Shopify appended a suffix. A wrong handle 404s every
   pricing CTA.
4. **Rotate `SHOPIFY_API_SECRET`** — it was shared in plaintext during setup.
   Rotate in the Dev Dashboard and update the Coolify env var.
5. **Set `SUPPORT_EMAIL`** in Coolify — otherwise `/privacy` shows the inherited
   fallback address.
