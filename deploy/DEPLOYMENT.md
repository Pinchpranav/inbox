# VPS deployment

Requires Linux with systemd, Node.js 24+, pnpm, git, curl, and nginx.
Run commands from the repository root. nginx/systemd steps require sudo.

## First setup

```bash
git clone https://github.com/Pinchpranav/inbox.git
cd inbox
pnpm install
sudo apt-get update
sudo apt-get install -y nginx
nano deploy/.env
```

Set this in `deploy/.env`:

```dotenv
COMMANDCODE_API_KEY=your-api-key
CF_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
CF_ACCESS_AUD=your-access-application-audience
INBOX_PUBLIC_ORIGIN=https://your-inbox-domain.example
```

Optional overrides: `PORT`, `INBOX_BACKEND`, `INBOX_LISTEN`, `INBOX_DB`,
`INBOX_AGENT_DIR`. If you change `PORT`, update `INBOX_BACKEND` to match.
The owner defaults to `pranav0202@gmail.com`; `INBOX_OWNER_EMAIL` can override it.

In Cloudflare Zero Trust, use the team domain and the Application Audience (AUD)
from this app's Access application. Protect the entire hostname, including
`/api/*` and WebSocket paths. nginx forwards Cloudflare's signed identity token;
the backend verifies its signature, issuer, audience, and expiry.
[Cloudflare's validation documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
describes these values.

`backend.sh` sets `NODE_ENV=production`. Do not set `INBOX_DEV_EMAIL` on the VPS;
it is rejected in production. The backend binds to `127.0.0.1`, and nginx should
remain on loopback behind the tunnel.

```bash
chmod +x deploy/backend.sh
sudo cp -f deploy/inbox-backend.service /etc/systemd/system/
sudo sed -i "s|/path/to/inbox|$PWD|g" /etc/systemd/system/inbox-backend.service
sudo nano /etc/systemd/system/inbox-backend.service
```

Set `User` to the deployment user and `Environment=PATH` to include the actual
Node.js bin directory. systemd does not load nvm or shell profiles.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now inbox-backend
bash deploy/start.sh
```

nginx defaults to `127.0.0.1:8085`; the backend defaults to port `8787`.
If using Cloudflare, point the tunnel at `http://127.0.0.1:8085` and configure
Access separately.

## Deploy updates

Check for local changes before pulling:

```bash
git status --short
git pull --ff-only
pnpm install
bash deploy/start.sh
```

`start.sh` builds the frontend, configures nginx, and restarts the backend.
Keep `deploy/.env` and `.inbox/inbox.db` across deployments.

## Verify and troubleshoot

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8085/api/me
curl -fsSI http://127.0.0.1:8085/
systemctl status inbox-backend
journalctl -u inbox-backend -n 100 --no-pager
sudo nginx -t
sudo tail -n 50 /var/log/nginx/error.log
```

The unauthenticated API check should return 401; the static frontend check should
return 200. Open the public domain through Cloudflare Access and verify `/api/me`
shows your email and owner status. Missing or incorrect Access configuration
returns 401 rather than implicitly identifying a visitor as the owner.

Use the project's ⋯ → Users menu to add an email that is already allowed by your
Cloudflare Access policy. Project sharing does not change Cloudflare policies or
send invitations. A new user without project grants sees no projects. New and
existing projects are private until shared.

Verify with two users: both see the same conversation, sender emails, live output,
and Generating… lock; either user can Stop and continue. Remove one user's grant
while their project is open and confirm the view clears immediately and cannot
be reopened.

Authorized users can rename/delete projects and conversations. Deletion hides
app data and keeps the event log and working-directory files. Stop generation
before deleting. Global ZDR and project creation/user management are owner-only.

- `node: not found`: correct the unit's `Environment=PATH`, then reload systemd.
- Backend start limit reached: fix the logged error, then run
  `sudo systemctl reset-failed inbox-backend` and `sudo systemctl restart inbox-backend`.
- nginx cannot serve the SPA: its worker needs directory traversal permission
  through the repository's parent directories and read access to `dist/`.
- nginx port conflict: keep the listener on a free loopback port; this VPS uses
  8085 because Coolify occupies port 80.
