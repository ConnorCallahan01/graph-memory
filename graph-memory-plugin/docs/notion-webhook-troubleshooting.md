# Notion Webhook Setup & Troubleshooting

## Architecture

```
Notion → ngrok (public URL) → localhost:3100 → Docker container → webhook handler
```

The webhook server runs inside the Docker container on port 3100. Ngrok tunnels external HTTPS requests to the host's port 3100, which is published from the container (`-p 3100:3100` in `docker/start.sh`).

## Setup

### One-Time Setup

1. **Start ngrok**: `ngrok http 3100`
2. **Copy the public URL** from the ngrok dashboard (e.g. `https://xxxx.ngrok-free.dev`)
3. **In Notion**: Go to https://www.notion.so/profile/integrations → your integration → Webhooks
4. **Add webhook endpoint**: `{ngrok-url}/notion-webhook`
5. **Notion sends a verification request** with a `verification_token` — the daemon auto-saves it to `~/.graph-memory/.notion-webhook-token`
6. **Copy the verification token** from the daemon logs and paste it into Notion's verification prompt:
   ```bash
   cat ~/.graph-memory/.notion-webhook-token
   # or check logs:
   grep "verification" ~/.graph-memory/.logs/activity.jsonl | tail -1
   ```
7. **Ensure the integration is connected** to the databases/pages you want events from (Notion only sends webhooks for resources the integration has access to)

### Container Startup

Use `docker/start.sh` — it reads `NOTION_WEBHOOK_SECRET` from macOS Keychain and publishes port 3100:

```bash
cd graph-memory-plugin
docker/start.sh
```

### Keychain Secret

The signing secret is stored in macOS Keychain under `NOTION_WEBHOOK_SECRET` (account: `graph-memory`). To update it:

```bash
security delete-generic-password -s "NOTION_WEBHOOK_SECRET" -a "graph-memory"
security add-generic-password -s "NOTION_WEBHOOK_SECRET" -a "graph-memory" -w "<new-secret>"
```

## Troubleshooting

### Webhooks not arriving (no requests in ngrok)

1. **Check Notion webhook status**: Go to integration → Webhooks. If it shows errors or disabled, click "Send test request" or "Resend verification" to re-enable
2. **Notion backs off after repeated failures**: If the endpoint returned many 401s, Notion may temporarily stop sending events. Re-sending the verification token usually kicks it alive
3. **Check ngrok is running**: `curl -s http://127.0.0.1:4040/api/tunnels` — if unreachable, restart ngrok
4. **ngrok URL changed**: Free-tier ngrok URLs change every restart. Update the webhook URL in Notion integration settings

### 401 Unauthorized (signature validation failed)

1. **Verification token is stale**: Delete and re-add the webhook endpoint in Notion. The daemon will save the new token automatically
2. **Token file missing**: Check `cat ~/.graph-memory/.notion-webhook-token`. If missing, re-trigger Notion verification
3. **Container recreated without token**: The token file is on the mounted volume (`~/.graph-memory/`), so it persists across container restarts. If the volume was wiped, re-do verification

### 200 OK but no visible action

The webhook handler only logs for specific matched events:
- `page.content_updated` / `page.properties_updated` on tracked pages → content update
- `page.created` → new task detection
- `comment.created` on tracked pages → comment logged
- Other event types or untracked pages → processed silently (200 OK, no log)

Every event IS logged to activity.jsonl with `notion-webhook:event` type. Check:
```bash
grep "notion-webhook:event" ~/.graph-memory/.logs/activity.jsonl | tail -5
```

### Container not receiving requests

1. **Port not published**: Container must be started with `-p 3100:3100`. Verify: `docker port graph-memory-daemon-graph-memory`
2. **Ngrok pointing to wrong port**: Ngrok should be `ngrok http 3100`
3. **Container health**: `docker inspect graph-memory-daemon-graph-memory --format '{{.State.Health.Status}}'`

### Daemon logs

```bash
# Container logs (webhook server status, errors)
docker logs graph-memory-daemon-graph-memory --tail 50

# Activity log (all webhook events)
grep "notion-webhook" ~/.graph-memory/.logs/activity.jsonl | tail -20

# Pipeline logs (sync job details)
ls -lt ~/.graph-memory/.pipeline-logs/ | grep notion | head -5
```

## Restart Checklist

If everything needs to be restarted from scratch:

1. `ngrok http 3100`
2. Copy ngrok URL
3. `cd graph-memory-plugin && docker/start.sh`
4. Verify container: `docker inspect graph-memory-daemon-graph-memory --format '{{.State.Health.Status}}'`
5. Verify tunnel: `curl -s -o /dev/null -w "%{http_code}" -X POST {ngrok-url}/notion-webhook -d '{"type":"test"}'` → should return 401
6. Update Notion webhook URL if ngrok domain changed
7. Re-verify in Notion if needed (resend verification, copy token from daemon logs)
