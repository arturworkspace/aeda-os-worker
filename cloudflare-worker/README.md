# aeda email worker (cloudflare)

this worker receives inbound emails at artur@aeda.am and:

1. posts the raw email to the railway webhook
2. forwards every email to artur@aedawallet.com (always, regardless of webhook status)

## deployment

this file is deployed manually via cloudflare dashboard, not via CI.

### steps

1. go to cloudflare dashboard > workers & pages
2. create a new worker or select existing "aeda-email-worker"
3. paste the contents of `email-worker.js`
4. go to settings > variables and add:
   - `RAILWAY_WEBHOOK_URL`: https://your-railway-app.up.railway.app/webhook/inbound-email
   - `WEBHOOK_SECRET`: (same value as in railway env vars)
5. go to email > email routing > routes
6. add a route: `*@aeda.am` -> worker: `aeda-email-worker`

## env vars

| variable | description |
|----------|-------------|
| RAILWAY_WEBHOOK_URL | full url to POST /webhook/inbound-email |
| WEBHOOK_SECRET | shared secret for authentication |

## notes

- the worker has zero dependencies on the main typescript codebase
- it uses only web-standard apis (fetch, streams, btoa)
- artur always receives the email in gmail, even if railway is down
