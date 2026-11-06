# Meta Groups Playwright Collector (isolated from Marketplace)

This project is intentionally separate from the existing Marketplace collector.
It uses its own folder, container, port `3001`, environment file and Facebook `storageState` copy.

## 1. Recommended folder on the server

```bash
cd ~/www/wwwroot/tom
mkdir -p facebook-groups-collector
cd facebook-groups-collector
```

Copy the files from this package into that new folder. Do **not** overwrite files inside the current `facebook-collector-docker` Marketplace folder.

## 2. Create environment file

```bash
cp .env.example .env
nano .env
```

Initial recommendation:

```text
PORT=3001
GROUPS_MAX_CONCURRENT=1
GROUPS_HEADLESS=true
GROUPS_STORAGE_STATE=/app/data/groups-storageState.json
```

## 3. Create a dedicated Facebook session state

The Group collector must have its own copy of the authenticated Facebook state.
Do not symlink it to the Marketplace state because both services should be isolated.

If the Marketplace state is currently located at:

```text
~/www/wwwroot/tom/facebook-collector-docker/data/storageState.json
```

copy it once:

```bash
mkdir -p data
cp ../facebook-collector-docker/data/storageState.json ./data/groups-storageState.json
chmod 600 ./data/groups-storageState.json
```

If the Marketplace state uses a different path, copy from the actual path instead.
The JSON contains authentication cookies; do not share it in chat, Git, email, or public storage.

## 4. Validate JavaScript before Docker build

If Node.js is installed on the host:

```bash
node --check server-groups.js
node --check groups.config.js
node --check playwright-groups.config.js
```

## 5. Build/start only the Groups collector

Run this from the **new Groups folder**:

```bash
docker compose up -d --build
```

This creates a separate container named:

```text
facebook-groups-collector
```

It does not run `docker compose` inside the Marketplace folder and therefore does not rebuild or restart the existing Marketplace service.

## 6. Check the new service

```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/session/check
```

Expected `/health` fields include:

```text
service = facebook-groups-collector
collection_mode = group_feed
port = 3001
storage_state_exists = true
```

Expected `/session/check`:

```text
session_valid = true
```

If session is false, refresh only `data/groups-storageState.json`; do not change the Marketplace session while diagnosing Groups.

## 7. Manual API test for G01

Example window (replace with the real ISO window from n8n):

```bash
curl -X POST http://127.0.0.1:3001/collect \
  -H 'Content-Type: application/json' \
  -d '{
    "source_type":"group",
    "collection_mode":"group_feed",
    "source_key":"group_1894427947317950",
    "group_id":"1894427947317950",
    "window_start":"2026-11-05T04:00:00.000Z",
    "window_end":"2026-11-05T12:00:00.000Z",
    "max_posts_per_run":100,
    "link_verify_limit":20
  }'
```

The response must contain:

```text
meta.source_type = group
meta.collection_mode = group_feed
meta.group_id = 1894427947317950
meta.diagnostics.articles_seen
meta.diagnostics.posts_parsed
posts = [...]
```

There must be no Group Search query requirement for `loa` or `speakers`.

## 8. Change only G01 in n8n first

In node `01 Config - Group` change the Groups collector URL from:

```text
http://192.168.10.36:3000/collect
```

to:

```text
http://192.168.10.36:3001/collect
```

Ensure the request body contains:

```text
source_type = group
collection_mode = group_feed
```

Do not change the Marketplace flow; it stays on port `3000`.

## 9. G01 acceptance checks

Run G01 manually and check in this order:

1. `02 Call Group Collector` returns `meta.collection_mode = group_feed`.
2. `03 Audit - Group Feed` succeeds.
3. `articles_seen > 0` when the Facebook Group visibly has posts.
4. A known recent Facebook post appears in `posts`.
5. Share/repost timestamps use the outer Group post timestamp, not the nested original post timestamp.
6. `04 Normalize + Window Keep` preserves `TIME_UNRESOLVED` and only drops `EXACT_OUTSIDE`.
7. The row reaches Google Sheets.
8. Re-running the same window does not create unexpected duplicates.
9. Verified Group links open the correct post.
10. Marketplace flow on port `3000` continues to run normally.

## 10. Move G02-G04 after G01 is stable

Only update the `collector_url` in G02/G03/G04 to port `3001` after G01 passes the checks above.
The new collector accepts only the four configured Group IDs.

## 11. Operational commands

Logs:

```bash
docker logs --tail 200 facebook-groups-collector
```

Follow logs:

```bash
docker logs -f facebook-groups-collector
```

Restart Groups only:

```bash
docker restart facebook-groups-collector
```

Stop Groups only:

```bash
docker compose down
```

Rebuild Groups only:

```bash
docker compose up -d --build
```

## Architecture

```text
Marketplace n8n
    -> port 3000
    -> existing server.js / Marketplace collector (unchanged)

G01/G02/G03/G04 n8n
    -> port 3001
    -> facebook-groups-collector
    -> server-groups.js
    -> Playwright Chromium
    -> Facebook Group Feed
```
