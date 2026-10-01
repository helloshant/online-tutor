#!/usr/bin/env bash
# Provisions a fresh Ubuntu VPS to run this app's full docker-compose
# stack behind Caddy (automatic HTTPS), end to end -- covers the 10-step
# runbook this repo's own deployment conversation worked out manually:
# user/firewall/swap setup, Docker, cloning this repo, scaffolding every
# service's .env.local, building/launching the stack, and installing Caddy.
#
# Intentionally does NOT (and cannot) do everything -- three things stay
# manual because they live in external dashboards this script has no
# access to, not because they were forgotten:
#   1. Filling in real secrets into the .env.local files this script
#      scaffolds (Supabase keys, Anthropic/Voyage keys, CCAvenue
#      credentials, etc.) -- the script detects unfilled placeholders and
#      stops rather than building/launching against garbage credentials.
#   2. Pointing the domain's DNS A record at this server (Namecheap
#      dashboard, or whichever registrar you use).
#   3. Supabase Auth's Site URL/Redirect URLs and the Google OAuth
#      client's redirect URI, once you know the real domain.
# The script prints a clear checklist for all three where they come up.
#
# Usage: run as root (or via sudo) on a fresh Ubuntu VPS:
#   DOMAIN=syllabusmate.in REPO_URL=https://github.com/you/your-repo.git \
#     bash setup-vps.sh
#
# Safe to re-run: every step checks whether it's already done before
# doing it again. Run it once to scaffold + halt for you to fill in
# secrets, fill them in, then run it again (same command) to build,
# launch, and install Caddy.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration -- override any of these by setting the env var before
# running, e.g. `DOMAIN=example.com bash setup-vps.sh`.
# ---------------------------------------------------------------------------
DOMAIN="${DOMAIN:?Set DOMAIN to your real domain, e.g. DOMAIN=syllabusmate.in bash setup-vps.sh}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
REPO_URL="${REPO_URL:?Set REPO_URL to the git URL of this repo, e.g. REPO_URL=https://github.com/you/repo.git bash setup-vps.sh}"
REPO_BRANCH="${REPO_BRANCH:-main}"
APP_DIR="/home/${DEPLOY_USER}/online-tutor"
SWAP_SIZE="${SWAP_SIZE:-4G}"

log() { echo -e "\n\033[1;34m==>\033[0m $1"; }
warn() { echo -e "\033[1;33m!!\033[0m $1"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root (or with sudo) -- it provisions system-level things (users, firewall, Docker, Caddy)." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Non-root deploy user, firewall, swap
# ---------------------------------------------------------------------------
log "Step 1/8: deploy user, firewall, swap"

if ! id -u "$DEPLOY_USER" &>/dev/null; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  usermod -aG sudo "$DEPLOY_USER"
  log "Created user '$DEPLOY_USER' (passwordless -- set one with 'passwd $DEPLOY_USER' if you want password login; SSH key login works regardless)."
else
  log "User '$DEPLOY_USER' already exists, skipping."
fi

if ! command -v ufw &>/dev/null; then
  apt-get update -qq && apt-get install -y -qq ufw
fi
ufw allow OpenSSH >/dev/null
ufw allow 80 >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null
log "Firewall: OpenSSH, 80, 443 allowed."

if ! swapon --show | grep -q .; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  log "Added ${SWAP_SIZE} swap file."
else
  log "Swap already configured, skipping."
fi

# ---------------------------------------------------------------------------
# 2. Docker
# ---------------------------------------------------------------------------
log "Step 2/8: Docker"

if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
else
  log "Docker already installed, skipping."
fi
usermod -aG docker "$DEPLOY_USER"

# ---------------------------------------------------------------------------
# 3. Clone the repo (as the deploy user, so file ownership is correct)
# ---------------------------------------------------------------------------
log "Step 3/8: clone repo"

if [[ -d "$APP_DIR/.git" ]]; then
  log "Repo already cloned at $APP_DIR, skipping clone (run 'git pull' yourself if you want the latest)."
else
  runuser -l "$DEPLOY_USER" -c "git clone --branch '$REPO_BRANCH' '$REPO_URL' '$APP_DIR'"
fi

# ---------------------------------------------------------------------------
# 4. Scaffold every service's .env.local from its own .env.example
# ---------------------------------------------------------------------------
log "Step 4/8: scaffold .env.local files"

ENV_FILES=(
  ".env.local"
  "services/orchestrator/.env.local"
  "services/observability/.env.local"
  "services/payment/.env.local"
  "services/broadcast/.env.local"
  "services/archetype-miner/.env.local"
  "services/vision-ocr/.env.local"
)

for f in "${ENV_FILES[@]}"; do
  example="${f%.local}.example"
  full_path="$APP_DIR/$f"
  full_example="$APP_DIR/$example"
  if [[ -f "$full_path" ]]; then
    continue
  fi
  if [[ -f "$full_example" ]]; then
    runuser -l "$DEPLOY_USER" -c "cp '$full_example' '$full_path'"
    log "Created $f from $example -- needs real values filled in."
  else
    warn "$example not found, skipping $f (this service may not need one)."
  fi
done

# Generate the 4 shared secrets that must match between the web app and
# each backend service, if they're still blank -- these don't need a human
# to invent them, unlike API keys/credentials, so this is safe to automate.
sync_shared_secret() {
  local name="$1" web_file="$APP_DIR/.env.local" service_file="$APP_DIR/$2"
  local current
  current=$(grep -E "^${name}=" "$web_file" 2>/dev/null | cut -d= -f2- || true)
  if [[ -z "$current" ]]; then
    current=$(openssl rand -hex 32)
    runuser -l "$DEPLOY_USER" -c "sed -i 's|^${name}=.*|${name}=${current}|' '$web_file'"
    log "Generated ${name}."
  fi
  runuser -l "$DEPLOY_USER" -c "sed -i 's|^${name}=.*|${name}=${current}|' '$service_file'" 2>/dev/null || true
}
sync_shared_secret "ORCHESTRATOR_SHARED_SECRET" "services/orchestrator/.env.local"
sync_shared_secret "PAYMENT_SHARED_SECRET" "services/payment/.env.local"
sync_shared_secret "BROADCAST_SHARED_SECRET" "services/broadcast/.env.local"
sync_shared_secret "ARCHETYPE_MINER_SHARED_SECRET" "services/archetype-miner/.env.local"
sync_shared_secret "VISION_OCR_SHARED_SECRET" "services/vision-ocr/.env.local"
# Orchestrator -> observability has its own separate secret pair.
orch_obs_secret=$(grep -E '^OBSERVABILITY_SHARED_SECRET=' "$APP_DIR/services/orchestrator/.env.local" 2>/dev/null | cut -d= -f2- || true)
if [[ -z "$orch_obs_secret" ]]; then
  orch_obs_secret=$(openssl rand -hex 32)
  runuser -l "$DEPLOY_USER" -c "sed -i 's|^OBSERVABILITY_SHARED_SECRET=.*|OBSERVABILITY_SHARED_SECRET=${orch_obs_secret}|' '$APP_DIR/services/orchestrator/.env.local'"
fi
runuser -l "$DEPLOY_USER" -c "sed -i 's|^OBSERVABILITY_SHARED_SECRET=.*|OBSERVABILITY_SHARED_SECRET=${orch_obs_secret}|' '$APP_DIR/services/observability/.env.local'" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5. Halt here if any file still has an unfilled placeholder value
# ---------------------------------------------------------------------------
log "Step 5/8: checking for unfilled credentials"

PLACEHOLDER_PATTERNS=(
  "your-project.supabase.co" "your-anon-key" "your-service-role-key"
  "your-anthropic-api-key" "your-voyage-api-key" "your-azure-openai-key"
  "your-ccavenue-merchant-id" "your-ccavenue-access-code" "your-ccavenue-working-key"
  "your-gcp-project-id" "your-processor-id" "your-service-account@your-project"
)

missing=0
for f in "${ENV_FILES[@]}"; do
  full_path="$APP_DIR/$f"
  [[ -f "$full_path" ]] || continue
  for p in "${PLACEHOLDER_PATTERNS[@]}"; do
    if grep -q "$p" "$full_path" 2>/dev/null; then
      warn "$f still has placeholder value(s) -- edit it with real credentials."
      missing=1
      break
    fi
  done
done

if [[ "$missing" -eq 1 ]]; then
  cat <<EOF

Stopped here on purpose. Edit the .env.local files listed above with
real values (nano $APP_DIR/.env.local, and the same for each
services/*/.env.local), then run this exact same command again -- it'll
skip everything already done and pick up from building/launching.
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# 6. Build and launch
# ---------------------------------------------------------------------------
log "Step 6/8: docker compose build + up"

runuser -l "$DEPLOY_USER" -c "cd '$APP_DIR' && docker compose --env-file .env.local build"
runuser -l "$DEPLOY_USER" -c "cd '$APP_DIR' && docker compose up -d"
runuser -l "$DEPLOY_USER" -c "cd '$APP_DIR' && docker compose ps"

# ---------------------------------------------------------------------------
# 7. Caddy (automatic HTTPS reverse proxy)
# ---------------------------------------------------------------------------
log "Step 7/8: Caddy"

if ! command -v caddy &>/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq && apt-get install -y -qq caddy
else
  log "Caddy already installed, skipping."
fi

cat > /etc/caddy/Caddyfile <<EOF
www.${DOMAIN} {
    redir https://${DOMAIN}{uri} permanent
}

${DOMAIN} {
    reverse_proxy localhost:3000
}
EOF
systemctl reload caddy
log "Caddy configured for ${DOMAIN} (+ www redirect) and reloaded."

# ---------------------------------------------------------------------------
# 8. What's left -- the parts no script can do for you
# ---------------------------------------------------------------------------
log "Step 8/8: manual steps still needed"

cat <<EOF

The server itself is fully set up. Three things only you can do, in your
registrar's/Supabase's/Google's own dashboards:

1. DNS -- point ${DOMAIN} at this server's IP ($(curl -s -4 ifconfig.me || echo "<could not detect public IP>")):
   add an A record, Host "@", pointing at that IP (and one for "www" too).

2. Supabase -- Authentication -> URL Configuration:
     Site URL:       https://${DOMAIN}
     Redirect URLs:  https://${DOMAIN}/auth/callback

3. Google OAuth (only if "Continue with Google" is enabled) -- confirm
   your OAuth client's Authorized redirect URIs include your Supabase
   project's own callback URL (shown on Supabase's Authentication ->
   Providers -> Google page).

Once DNS has propagated (can take a few hours), visit https://${DOMAIN}
and walk through signup -> trial -> a chat message to confirm everything
actually works end to end.
EOF
