import axios from 'axios';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

export interface GraphCreds {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export async function getAccessToken(creds: GraphCreds): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt - 60_000 > now) {
    return cached.accessToken;
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });

  try {
    const { data } = await axios.post(url, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    if (!data?.access_token || typeof data.expires_in !== 'number') {
      throw new Error('Token endpoint returned unexpected shape');
    }

    cached = {
      accessToken: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    return cached.accessToken;
  } catch (err: any) {
    const detail = err?.response?.data ?? err?.message ?? String(err);
    throw new Error(
      `Failed to acquire Microsoft Graph access token: ${
        typeof detail === 'string' ? detail : JSON.stringify(detail)
      }`,
    );
  }
}

export function clearTokenCache(): void {
  cached = null;
}
