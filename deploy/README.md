# Deploying the TermDeck sync server

The server is a thin E2EE blob store: it holds ciphertext + auth hashes only and can never
read a vault. Runs as three containers — the Rust server, Postgres, and Caddy (automatic
HTTPS).

## Prerequisites
- A VPS with Docker + Docker Compose.
- A domain/subdomain (e.g. `sync.example.com`) with an A/AAAA record pointing at the VPS.
- Ports 80 and 443 open (Caddy needs them for TLS issuance).

## Steps
```bash
git clone <this repo> && cd TermDeck/deploy
cp .env.example .env
# edit .env: set DOMAIN=sync.example.com and a long random DB_PASSWORD
docker compose up -d --build
docker compose logs -f server   # watch it come up
```
Caddy obtains a Let's Encrypt certificate for `$DOMAIN` automatically on first run.

## Verify
```bash
curl https://sync.example.com/healthz     # -> ok
```
Then in the desktop or Android app, use `https://sync.example.com` as the sync server and
register an account.

## Notes
- **Backups:** the `pgdata` volume is the whole datastore (encrypted records + account
  material). Back it up (`docker compose exec db pg_dump -U termdeck termdeck > dump.sql`).
- **Schema:** created automatically on server start (idempotent `CREATE TABLE IF NOT EXISTS`).
- **Secrets:** `DB_PASSWORD` lives in `.env` (gitignored). Even if the DB leaks, vault
  contents stay encrypted — but rotate it and keep the VPS patched.
- **Scaling:** for personal use a single instance is plenty; the server is stateless apart
  from Postgres, so it can run behind any TLS proxy you prefer instead of Caddy.
- **Without Docker:** `DATABASE_URL=postgres://… BIND_ADDR=0.0.0.0:8787 cargo run --release`
  in `server/`, behind your own TLS terminator.
