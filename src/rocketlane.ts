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

    // No statusUpdatedAt exposed by this API — days-in-status relies on DynamoDB tracking
    const statusUpdatedAt =
      statusObj?.updatedAt ??
      statusObj?.lastUpdatedAt ??
      r.statusUpdatedAt ??
      r.statusLastChangedAt;

    const id = String(r.projectId ?? r.id ?? '');

    // Owner: API returns { firstName, lastName, emailId } — no combined "name" field
    const ownerObj = r.owner ?? r.projectOwner;
    const ownerName = ownerObj
      ? [ownerObj.firstName, ownerObj.lastName].filter(Boolean).join(' ') ||
        ownerObj.emailId ||
        'Unassigned'
      : r.ownerName ?? 'Unassigned';

    // Reason: stored in custom fields array under "Current Status_Desc" or "Action Item"
    const reason =
      r.statusReason ??
      r.reason ??
      r.projectStatus?.reason ??
      extractField(r.fields, 'Current Status_Desc') ??
      extractField(r.fields, 'Action Item') ??
      '—';

    // lastUpdatedAt: API returns a Unix millisecond timestamp, not an ISO string
    const updatedAtMs = r.updatedAt ?? r.lastUpdatedAt;
    const lastUpdatedAt = updatedAtMs
      ? new Date(Number(updatedAtMs)).toISOString()
      : new Date().toISOString();

    return {
      id,
      name: r.projectName ?? r.name ?? 'Untitled project',
      status: String(statusLabel).toUpperCase(),
      statusUpdatedAt: statusUpdatedAt ? String(statusUpdatedAt) : undefined,
      owner: ownerName,
      ownerEmail: ownerObj?.emailId ?? ownerObj?.email,
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
  if (!field || typeof field.fieldValue !== 'string' || !field.fieldValue) {
    return undefined;
  }
  const plain = field.fieldValue.replace(/<[^>]+>/g, '').trim();
  return plain || undefined;
}
