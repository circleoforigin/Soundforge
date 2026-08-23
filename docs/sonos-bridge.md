# SACscape Sonos Bridge

The public home-server process is an OAuth and Sonos Cloud control bridge. It is not the SACscape audio runtime.

## Route audit

| Capability | Current caller | Classification | Reason |
| --- | --- | --- | --- |
| OAuth login/callback and code exchange | Manage Rooms | Public bridge | Requires the public registered redirect and client secret. |
| Token persistence/refresh | Sonos Cloud client | Public bridge | Protects refresh tokens and client secret. |
| Households and groups/topology | Manage Rooms | Public bridge | Official Sonos Cloud discovery API. |
| Physical-device CHIME | Manage Rooms Hardware Test | Public bridge | Current identification workflow uses Cloud AudioClip. |
| Room Audio, mixing, assets, settings, diagnostics | Editor | Local runtime | Local and latency-sensitive. |
| SSDP, AVTransport, physical-device continuous streams | Room Audio/Research Lab | Local runtime | LAN-only operations. |
| Logical-player resolution, custom AudioClip, public media | No current application caller (`SonosOneShotOutput` is unreferenced) | Legacy | Superseded by provider-neutral local Room Audio. Retained only in the old full server for rollback. |
| AudioClip/playback events and Cloud group-stream experiment | No current UI caller | Legacy | Experimental diagnostics tied to retired Cloud stream experiments. |
| GitHub library routes/test write | No current frontend caller | Legacy/unrelated | The active library is browser-local and these are not Sonos requirements. |

## Included public responsibilities

- `GET /api/health`
- `GET /api/sonos/login`
- `GET /api/sonos/callback`
- `GET /api/sonos/households`
- `GET /api/sonos/households/:householdId/groups`
- `POST /api/sonos/test-tone/:playerId`
- persisted OAuth access/refresh tokens and automatic refresh
- sanitized Sonos Cloud diagnostics

The bridge deliberately excludes Room Audio, local assets, FFmpeg, encoders, Research Lab, multi-speaker experiments, LAN discovery, AVTransport, continuous streams, settings, general diagnostics, GitHub library routes, custom AudioClip media, and legacy group-stream experiments.

## Production command

```powershell
npm run sonos-bridge
```

The default listener remains port `3001`; `SONOS_BRIDGE_PORT` may override it. Tailscale/Funnel must continue forwarding the existing public HTTPS origin to that listener. The current Sonos redirect URI and `https://sacscape-server.tail7d5063.ts.net` frontend base do not need to change.

Required server configuration is `SONOS_CLIENT_ID`, `SONOS_CLIENT_SECRET`, and `SONOS_REDIRECT_URI`. `CLIENT_ORIGIN`, `SONOS_BRIDGE_PORT`, and `SACSCAPE_DATA_DIR` remain optional. Existing `.env.local` may remain unchanged.

Persistent state defaults to:

- `C:\SACscapeData\sonos\tokens.json`
- `C:\SACscapeData\logs\sonos.log`

No frontend production build is required to run the bridge. The runtime dependency subset is Node.js, Express, and dotenv plus these source modules and their type-erased imports:

- `server/sonos-bridge.ts`
- `server/sonos/SonosBridgeApp.ts`
- `server/routes/SonosAuthRoute.ts`
- `server/routes/SonosDiscoveryRoute.ts`
- `server/sonos/SonosClient.ts`
- `server/sonos/SonosTokenStore.ts`
- `server/sonos/SonosDiagnosticLog.ts`
- `server/sonos/SonosAudioClipDiagnostics.ts`

Keeping the full repository and running `npm ci` is currently the simplest deployment method, but neither the frontend sources nor the local-runtime modules are runtime requirements for the bridge. The self-hosted GitHub Actions runner is needed only for automatic deployment, not to operate the bridge after installation.

## Failure boundary

If this process or its public Tailscale route is unavailable, Manage Rooms reports Sonos Cloud as unavailable. The localhost runtime and active LAN Room Audio sessions do not call or depend on this bridge.
