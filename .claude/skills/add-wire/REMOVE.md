# Remove Wire Channel

This reverses every change `/add-wire` makes.

## 1. Remove the adapter

Delete the `import './wire.js';` line from `src/channels/index.ts`, then remove the copied files:

```bash
rm -f src/channels/wire.ts src/channels/wire-worker.ts src/channels/wire-protocol.ts \
  src/channels/wire-registration.test.ts src/channels/wire.test.ts \
  src/channels/wire-worker.test.ts src/channels/wire-protocol.test.ts \
  scripts/wire-register-app.mjs
rm -rf container/skills/wire-formatting
```

## 2. Remove the SDK

```bash
pnpm uninstall @wireapp/wire-apps-js-sdk
```

## 3. Remove credentials

Delete these keys from `.env`: `WIRE_API_HOST`, `WIRE_API_TOKEN`, `WIRE_CRYPTO_KEY`, `WIRE_APP_ID`, `WIRE_APP_DOMAIN`, `WIRE_MAX_ATTACHMENT_MB`.

## 4. Remove the source remote

```bash
git remote remove nanoclaw-channel-wire 2>/dev/null || true
```

## 5. Rebuild and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

## 6. Remove the app's device state (optional)

`store/wire/` holds the app's encryption identity and its current token. Deleting it is irreversible: reinstalling registers the app as a new device and needs a fresh token. Keep a backup if you may come back.

```bash
rm -rf store/wire/
```

To retire the app entirely, a team admin can also delete it in Wire's team settings.

## Verify

- `grep -n "wire" src/channels/index.ts` prints nothing.
- `ncl status` no longer lists `wire`.
- `pnpm run build && pnpm test` pass.
