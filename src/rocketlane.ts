import axios, { AxiosInstance } from 'axios';
import type { RocketlaneProject } from './types';

const FLAGGED_STATUSES = ['BLOCKED', 'DELAYED'] as const;

export class RocketlaneClient {
  private http: AxiosInstance;

  constructor(baseUrl: string, apiKey: string) {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 30000,
    });
  }

  async fetchFlaggedProjects(): Promise<RocketlaneProject[]> {
    const out: RocketlaneProject[] = [];
    for (const status of FLAGGED_STATUSES) {
      out.push(...(await this.fetchByStatus(status)));
    }
    return out;
  }

  private async fetchByStatus(status: string): Promise<RocketlaneProject[]> {
    const results: RocketlaneProject[] = [];
    let pageToken: string | undefined;

    do {
      const { data } = await this.http.get('/projects', {
        params: {
          'projectStatus.eq': status,
          pageSize: 100,
          pageToken,
        },
      });

      const items: unknown[] = data?.data ?? data?.projects ?? data?.items ?? [];
      for (const raw of items) {
        const project = this.normalize(raw, status);
        // Client-side guard: skip projects whose status doesn't match.
        // The API filter param may return all projects regardless of status.
        if (project.status === status.toUpperCase()) {
          results.push(project);
        }
      }
      pageToken =
        data?.pagination?.nextPageToken ??
        data?.nextPageToken ??
        data?.next_page_token;
    } while (pageToken);

    return results;
  }

  private normalize(raw: unknown, statusGuess: string): RocketlaneProject {
    const r = raw as Record<string, any>;

    // Status: API returns { value: 4, label: "Blocked" } or { value: 12, label: "Delayed" }
    const statusObj = r.projectStatus ?? r.status;
    const statusLabel =
      typeof statusObj === 'string'
        ? statusObj
        : statusObj?.label ?? statusObj?.name ?? statusGuess;

    // No dedicated status-change timestamp in this API — rely on DynamoDB/local history.
    // Only use explicit API fields (not statusObj?.updatedAt which is the status object's
    // own modification time, unrelated to when the project status changed).
    const rawStatusDate = r.statusUpdatedAt ?? r.statusLastChangedAt;
    const statusUpdatedAt: string | undefined = (() => {
      if (rawStatusDate == null) return undefined;
      const n = Number(rawStatusDate);
      const d = Number.isFinite(n) && n > 0 ? new Date(n) : new Date(String(rawStatusDate));
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    })();

    const id = String(r.projectId ?? r.id ?? '');

    // Owner: API returns { firstName, lastName, emailId } — no combined "name" field
    const ownerObj = r.owner ?? r.projectOwner;
    const ownerName = ownerObj
      ? [ownerObj.firstName, ownerObj.lastName].filter(Boolean).join(' ') ||
        ownerObj.emailId ||
        'Unassigned'
      : r.ownerName ?? 'Unassigned';

    const currentPhase = extractField(r.fields, 'Current Phase') ?? 'Other';

    // Reason: per spec, picked from the "Action Item" custom field (HTML stripped).
    const reason = extractField(r.fields, 'Action Item') ?? '—';

    // Role assignments live in custom fields. Values are sometimes plain names
    // (e.g. "Aadarsh") and sometimes emails (e.g. "agilan.ks@aivar.tech").
    const deliveryManager = humanize(
      extractField(r.fields, 'Delivery Manager') ?? 'Unassigned',
    );
    const csm = humanize(extractField(r.fields, 'CSM') ?? 'Unassigned');
    const accountManager = humanize(
      extractField(r.fields, 'Account Manager') ?? 'Unassigned',
    );

    // lastUpdatedAt: API returns a Unix millisecond timestamp, not an ISO string
    const updatedAtMs = r.updatedAt ?? r.lastUpdatedAt;
    const lastUpdatedAt = updatedAtMs
      ? new Date(Number(updatedAtMs)).toISOString()
      : new Date().toISOString();

    return {
      id,
      name: r.projectName ?? r.name ?? 'Untitled project',
      status: String(statusLabel).toUpperCase(),
      statusUpdatedAt,
      currentPhase,
      owner: ownerName,
      ownerEmail: ownerObj?.emailId ?? ownerObj?.email,
      deliveryManager,
      csm,
      accountManager,
      reason,
      lastUpdatedAt,
      url:
        r.projectUrl ??
        (id ? `https://app.rocketlane.com/projects/${id}` : 'https://app.rocketlane.com'),
    };
  }
}

// Finds a custom field by label and returns its value as plain text (HTML stripped).
function extractField(fields: unknown, label: string): string | undefined {
  if (!Array.isArray(fields)) return undefined;
  const field = (fields as Record<string, any>[]).find(
    (f) => f.fieldLabel === label,
  );
  if (!field) return undefined;
  const raw =
    typeof field.fieldValueLabel === 'string' && field.fieldValueLabel
      ? field.fieldValueLabel
      : typeof field.fieldValue === 'string'
        ? field.fieldValue
        : undefined;
  if (!raw) return undefined;
  const plain = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return plain || undefined;
}

// Convert an email like "akshay.shetty@aivar.tech" → "Akshay Shetty".
// Plain names ("Aadarsh") and free text ("Unassigned") pass through unchanged.
function humanize(value: string): string {
  if (!value) return 'Unassigned';
  const trimmed = value.trim();
  if (!trimmed.includes('@')) return trimmed;
  const local = trimmed.split('@')[0] ?? '';
  if (!local) return trimmed;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}
