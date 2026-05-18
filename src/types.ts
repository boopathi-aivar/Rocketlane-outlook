export type ProjectStatus = 'BLOCKED' | 'DELAYED';

export interface RocketlaneProject {
  id: string;
  name: string;
  status: ProjectStatus | string;
  statusUpdatedAt?: string;
  owner: string;
  ownerEmail?: string;
  reason: string;
  lastUpdatedAt: string;
  url: string;
}

export interface FlaggedProject extends RocketlaneProject {
  daysInStatus: number;
  isUrgent: boolean;
}

export interface AppConfig {
  dayThreshold: number;
  recipients: string[];
  sender: string;
  rocketlaneBaseUrl: string;
  templateBucket: string;
  templateKey: string;
  historyTableName: string;
  useHistoryTable: boolean;
}

export interface RenderInput {
  blocked: FlaggedProject[];
  delayed: FlaggedProject[];
  totalCount: number;
  dayThreshold: number;
  reportDate: string;
  chartCid: string;
  hasChart: boolean;
}
