# SACscape Sonos Bridge deployment

This directory is a complete production package. It does not require the Soundforge repository, TypeScript, Vite, FFmpeg, Git, or `node_modules`.

## One-time installation

1. Install Node.js 24 or newer on the home computer.
2. Transfer the entire `sonos-bridge` package directory to the home computer.
3. Create `C:\SACscapeBridge\.env.local` manually with the existing Sonos server configuration. Never place it inside the transferred package.
4. From an elevated PowerShell window in the transferred package, run:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\Install-SACscapeSonosBridge.ps1
   ```

5. Verify:

   ```powershell
   Invoke-RestMethod http://localhost:3001/api/health
   ```

The installer copies only its explicit production-file allow-list, preserves any existing destination `.env.local`, and creates the startup task `SACscape Sonos Bridge` under the built-in `SYSTEM` service account. Task Scheduler retries a failed process after one minute.

Tailscale/Funnel configuration is not modified. It must continue forwarding the existing public HTTPS address to local port 3001.

## Manual operation

```powershell
C:\SACscapeBridge\Manage-SACscapeSonosBridge.ps1 -Action Status
C:\SACscapeBridge\Manage-SACscapeSonosBridge.ps1 -Action Stop
C:\SACscapeBridge\Manage-SACscapeSonosBridge.ps1 -Action Start
C:\SACscapeBridge\Manage-SACscapeSonosBridge.ps1 -Action Restart
```

The bridge can also be run interactively from its installation directory with either `node bridge.cjs` or `npm start`. npm is not required when using the scheduled task or direct Node command.

## Manual update

Build and transfer a new package, then rerun its installer from elevated PowerShell. It stops the existing bridge task, replaces only packaged program/support files, preserves `C:\SACscapeBridge\.env.local` and `C:\SACscapeData`, updates the task definition, and starts the new bridge. There is no automatic updater.
