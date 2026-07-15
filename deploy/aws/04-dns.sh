#!/usr/bin/env bash
# -------------------------------------------------------------------------
# 04 · (OPTIONAL / NOT v1) DNS name for the instance.
#
# v1 uses the raw private IP in the gateway's config.dealFlowUrl, so this
# script is NOT needed to ship. It exists for when you later want a stable
# name so replacing the instance doesn't force a gateway config change.
#
# IMPORTANT — internal.bijnis.co is a **GCP Cloud DNS** private zone
# (internal-bijnis-co), NOT AWS Route53. And AWS→GCP resolution of
# internal.bijnis.co from vpc-9e875ff6 is UNVERIFIED. Before relying on this
# name, prove the gateway pods can resolve it:
#   kubectl exec <gateway-pod> -- getent hosts deal-flow.internal.bijnis.co
#
# Usage (only after that check passes):
#   PRIVATE_IP=172.31.x.x VERIFY_RESOLUTION=1 bash deploy/aws/04-dns.sh
# -------------------------------------------------------------------------
set -uo pipefail
FQDN="deal-flow.internal.bijnis.co"
ZONE="internal-bijnis-co"
TTL=60
IP="${PRIVATE_IP:-}"

if [ "${VERIFY_RESOLUTION:-0}" != "1" ]; then
  echo "Refusing to run: this is NOT part of IP-first v1."
  echo "First confirm gateway pods resolve internal.bijnis.co from the AWS VPC, then re-run with:"
  echo "  PRIVATE_IP=<ip> VERIFY_RESOLUTION=1 bash deploy/aws/04-dns.sh"
  exit 1
fi
[ -z "$IP" ] && { echo "ERROR: set PRIVATE_IP=<instance private IP>"; exit 1; }

echo "Would UPSERT (GCP Cloud DNS): $FQDN A $IP (ttl $TTL) in zone $ZONE"
echo
echo "# RUN MANUALLY (creates a DNS record — GCP mutation):"
echo "gcloud dns record-sets create $FQDN. --zone=$ZONE --type=A --ttl=$TTL --rrdatas=$IP"
echo "#   (if the record already exists, use: gcloud dns record-sets update $FQDN. --zone=$ZONE --type=A --ttl=$TTL --rrdatas=$IP)"
echo
echo "Then in the gateway config, prefer the name over the IP:"
echo "  config.dealFlowUrl: \"http://$FQDN:3000\""
