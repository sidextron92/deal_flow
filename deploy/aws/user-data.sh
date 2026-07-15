#!/bin/bash
# -------------------------------------------------------------------------
# EC2 first-boot bootstrap (cloud-init user-data). Runs once as root.
# 03-launch.sh substitutes __REGION__ __ACCOUNT__ __IMAGE__ __SSM_PREFIX__
# then passes this to run-instances --user-data. It installs Docker + the
# AWS CLI, then writes a self-contained run.sh + systemd unit so every boot
# re-pulls the image and re-reads secrets from SSM.
# -------------------------------------------------------------------------
set -euxo pipefail
exec > /var/log/deal-flow-bootstrap.log 2>&1   # inspect via SSM if boot fails

REGION="__REGION__"
ACCOUNT="__ACCOUNT__"
IMAGE="__IMAGE__"
SSM_PREFIX="__SSM_PREFIX__"

# --- Docker ---
dnf install -y docker
systemctl enable --now docker

# --- AWS CLI v2 (AL2023 does not ship it) ---
if ! command -v aws >/dev/null 2>&1; then
  dnf install -y unzip
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
  ( cd /tmp && unzip -q awscliv2.zip && ./aws/install )
fi

# --- deploy script (re-run on every boot via systemd) ---
mkdir -p /opt/deal-flow
cat > /opt/deal-flow/run.sh <<RUN
#!/bin/bash
set -euo pipefail
REGION="$REGION"; ACCOUNT="$ACCOUNT"; IMAGE="$IMAGE"; SSM_PREFIX="$SSM_PREFIX"
get() { aws ssm get-parameter --name "\$1" --with-decryption --region "\$REGION" --query Parameter.Value --output text; }
aws ecr get-login-password --region "\$REGION" | docker login --username AWS --password-stdin "\$ACCOUNT.dkr.ecr.\$REGION.amazonaws.com"
docker pull "\$IMAGE"
docker rm -f deal-flow 2>/dev/null || true
docker run -d --name deal-flow --restart=unless-stopped -p 3000:3000 \\
  -e NODE_ENV=production \\
  -e DB_HOST="\$(get \$SSM_PREFIX/DB_HOST)" \\
  -e DB_PORT="\$(get \$SSM_PREFIX/DB_PORT)" \\
  -e DB_USER="\$(get \$SSM_PREFIX/DB_USER)" \\
  -e DB_PASSWORD="\$(get \$SSM_PREFIX/DB_PASSWORD)" \\
  -e DB_NAME="\$(get \$SSM_PREFIX/DB_NAME)" \\
  -e AUTH_KEY="\$(get \$SSM_PREFIX/AUTH_KEY)" \\
  "\$IMAGE"
RUN
chmod +x /opt/deal-flow/run.sh

# --- systemd unit ---
cat > /etc/systemd/system/deal-flow.service <<'UNIT'
[Unit]
Description=deal_flow container
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/deal-flow/run.sh

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now deal-flow.service

# --- local smoke check ---
sleep 8
curl -fsS localhost:3000/g/deal-flow/api/health && echo "  <- deal_flow healthy" || echo "  !! health check failed — see docker logs deal-flow"
