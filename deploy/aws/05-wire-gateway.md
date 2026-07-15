# 05 · Wire the gateway (activates the feature)

The gateway change is **feature-gated on `config.dealFlowUrl`**. Until this key is
set, the gateway is byte-for-byte unchanged (proven by the route-table diff in the
gateway MR). Adding it mounts the `/g/deal-flow` group and starts routing to the
EC2 instance.

This step is **manual and coordinated with the gateway release** — do it *after*
`03-launch.sh` reports the instance is running and healthy.

## 1. Preconditions
- [ ] `03-launch.sh` printed a `PRIVATE_IP` and health returns 200 on the box.
- [ ] Gateway release branch `release/deal-flow-gateway-integration` is merged + deployed **inert** (no `config.dealFlowUrl` yet).
- [ ] deal_flow `AUTH_KEY` (SSM `/deal-flow/prod/AUTH_KEY`) **equals** the gateway's `config.authKey`.

## 2. Reachability check (read-only, from a gateway pod)
```
kubectl exec <gateway-pod> -- curl -s http://<PRIVATE_IP>:3000/g/deal-flow/api/health
# expect: {"status":"ok","service":"deal_flow",...}
```

## 3. Add the config key
In each prod gateway env YAML, under `config:`:
```yaml
config:
  dealFlowUrl: "http://<PRIVATE_IP>:3000"   # v1: raw private IP (DNS is a later step)
  # authKey: <already present> — MUST equal deal_flow's AUTH_KEY
```
Then redeploy/restart the gateway so it re-reads config and mounts `/g/deal-flow`.

## 4. End-to-end verification (through the public gateway)
```
curl https://api.bijnis.com/g/deal-flow/api/health                     # 200, public
curl -H "token: <FOS_JWT>" -H "User-Type: fos" \
     "https://api.bijnis.com/g/deal-flow/api/cart?phone=<retailer>"     # 200 + items
curl "https://api.bijnis.com/g/deal-flow/api/cart?phone=<retailer>"     # 401 (no token)
```
Then point the RN app webview at `https://api.bijnis.com/g/deal-flow`.

## 5. Rollback (instant, no EC2 change)
Remove `config.dealFlowUrl` from the gateway config + restart → `/g/deal-flow`
returns 404, every other route unchanged.
