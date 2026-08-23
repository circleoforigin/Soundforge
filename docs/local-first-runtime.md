# SACscape local-first runtime

## Runtime roles

### SACscape UI

The React UI runs in the browser. It owns editor state and browser-managed library handles. It sends Room Audio, settings, diagnostics, and Research Lab requests only to the local runtime through `runtimeUrl()`.

### SACscape local runtime

`server/local-runtime.ts` listens on `127.0.0.1:3001` by default. It owns Room Audio sessions, the authoritative 20 ms PCM clock, source timelines, decoding/cache, FFmpeg encoders, provider adapters, LAN discovery and listeners, settings, and diagnostics. `SACSCAPE_LOCAL_RUNTIME_PORT` and the frontend build variable `VITE_LOCAL_RUNTIME_URL` may select another loopback port.

Room Audio assets are copied from the browser-managed library to the local runtime's managed cache under `<SACSCAPE_DATA_DIR>/audio-assets` (default `C:\SACscapeData\audio-assets`). Arbitrary browser filesystem paths are never sent to the runtime.

The Sonos local provider resolves saved physical RINCON IDs with SSDP on the user's LAN. Each endpoint owns an AAC/ADTS encoder and an ephemeral LAN HTTP listener. A PLAY:1 fetches that stream directly from the SACscape computer's routed LAN address; the public server is not involved.

### Remote services

`server/index.ts` remains the public/remote service entry point. `apiUrl()` continues to address it for functionality that may require a public origin or cloud credentials, including Sonos OAuth and Cloud AudioClip/media operations. The local-first migration does not remove these optional capabilities.

### Provider adapters

The mixer depends only on `AudioOutputProvider` and `AudioEndpointConnection`. Sonos-specific SSDP, AVTransport, HTTP serving, encoding, and reconnect behavior remain behind the Sonos adapter. A mixed-provider Room therefore does not require provider branching in the mixer.

## Communication

Local HTTP is the initial UI/runtime boundary. Realtime controls retain semantic deduplication, latest-value position coalescing, a 20 ms dispatch floor, bounded concurrency, and error aggregation. WebSockets or desktop IPC can replace this boundary later without changing Room Audio contracts.

## Development

Run:

```text
npm run dev
```

This starts both the local runtime and Vite UI. `npm run dev:ui` and `npm run local-runtime` remain available for isolated work. The public server can be started separately with `npm run server` only when testing remote/cloud functionality.

## Future desktop packaging

A future desktop shell can supervise `server/local-runtime.ts`, allocate a loopback port, and host the existing UI without moving the mixer or provider code. This migration deliberately does not select Electron, Tauri, or another packaging framework.
