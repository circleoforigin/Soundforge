import fs from 'node:fs';
import path from 'node:path';
import { logSonosError } from './SonosDiagnosticLog.ts';

export interface SonosTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const expiryBufferMs = 60_000;

let tokens: SonosTokens | null = null;
let initialized = false;
let refreshRequest: Promise<SonosTokens> | null = null;

function getTokenDirectory(): string {
  const dataRoot = process.env.SACSCAPE_DATA_DIR?.trim() || 'C:\\SACscapeData';
  return path.join(dataRoot, 'sonos');
}

function getTokenPath(): string {
  return path.join(getTokenDirectory(), 'tokens.json');
}

function isSonosTokens(value: unknown): value is SonosTokens {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<SonosTokens>;
  return typeof candidate.accessToken === 'string' &&
    typeof candidate.refreshToken === 'string' &&
    typeof candidate.expiresAt === 'number';
}

async function persistTokens(newTokens: SonosTokens): Promise<void> {
  const tokenDirectory = getTokenDirectory();
  const tokenPath = getTokenPath();
  await fs.promises.mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${tokenPath}.${crypto.randomUUID()}.tmp`;

  try {
    await fs.promises.writeFile(
      temporaryPath,
      JSON.stringify(newTokens),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
    await fs.promises.rename(temporaryPath, tokenPath);
    await fs.promises.chmod(tokenPath, 0o600);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function refreshSonosTokens(currentTokens: SonosTokens): Promise<SonosTokens> {
  const clientId = process.env.SONOS_CLIENT_ID;
  const clientSecret = process.env.SONOS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('SACscape is not connected to Sonos. Reconnect Sonos to continue.');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://api.sonos.com/login/v3/oauth/access', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentTokens.refreshToken,
    }),
  });
  const data = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!response.ok || !data.access_token || typeof data.expires_in !== 'number') {
    logSonosError('Sonos token refresh failed.', { httpStatus: response.status });
    throw new Error('SACscape is not connected to Sonos. Reconnect Sonos to continue.');
  }

  const refreshedTokens: SonosTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || currentTokens.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  await setSonosTokens(refreshedTokens);
  return refreshedTokens;
}

export async function initializeSonosTokenStore(): Promise<void> {
  if (initialized) {
    return;
  }

  initialized = true;

  try {
    const contents = await fs.promises.readFile(getTokenPath(), 'utf8');
    const storedTokens: unknown = JSON.parse(contents);

    if (!isSonosTokens(storedTokens)) {
      throw new Error('Persisted Sonos token data is invalid.');
    }

    tokens = storedTokens;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logSonosError('Unable to load persisted Sonos authorization.', error);
    }

    tokens = null;
  }
}

export async function setSonosTokens(newTokens: SonosTokens): Promise<void> {
  await persistTokens(newTokens);
  tokens = newTokens;
  initialized = true;
}

export async function getSonosTokens(): Promise<SonosTokens | null> {
  await initializeSonosTokenStore();
  return tokens;
}

export async function getValidSonosAccessToken(): Promise<string> {
  const currentTokens = await getSonosTokens();

  if (!currentTokens) {
    throw new Error('SACscape is not connected to Sonos.');
  }

  if (Date.now() < currentTokens.expiresAt - expiryBufferMs) {
    return currentTokens.accessToken;
  }

  refreshRequest ??= refreshSonosTokens(currentTokens).finally(() => {
    refreshRequest = null;
  });

  return (await refreshRequest).accessToken;
}

export async function clearSonosTokens(): Promise<void> {
  tokens = null;
  initialized = true;
  await fs.promises.rm(getTokenPath(), { force: true });
}
