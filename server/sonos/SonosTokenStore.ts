export interface SonosTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

let tokens: SonosTokens | null = null;

export function setSonosTokens(
  newTokens: SonosTokens
): void {
  tokens = newTokens;
}

export function getSonosTokens():
  SonosTokens | null {
  return tokens;
}

export function clearSonosTokens(): void {
  tokens = null;
}