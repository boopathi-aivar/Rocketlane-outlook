export type ProjectStatus = 'BLOCKED' | 'DELAYED';

export interface RocketlaneProject {
  id: string;
  name: string;
  status: ProjectStatus | string;
  statusUpdatedAt?: string;
  owner: string;
  ownerEmail?: string;
  deliveryManager: string;
  csm: string;
  accountManager: string;
  reason: string;
  lastUpdatedAt: string;
  url: string;
}

export interface FlaggedProject extends RocketlaneProject {
  daysInStatus: number;
  isUrgent: boolean;
}

export interface RoleBucket {
  label: string;
  blocked: number;
  delayed: number;
}

export interface AppConfig {
  dayThreshold: number;
  recipients: string[];
  sender: string;
  rocketlaneBaseUrl: string;
  templateBucket: string;
  templateKey: string;
  logoKey: string;
  historyTableName: string;
  useHistoryTable: boolean;
  graphTenantId: string;
  graphClientId: string;
  graphClientSecret: string;
}

export interface RenderInput {
  blocked: FlaggedProject[];
  delayed: FlaggedProject[];
  totalCount: number;
  dayThreshold: number;
  reportDate: string;
  logoCid: string;
  hasLogo: boolean;
  summaryChartCid: string;
  hasSummaryChart: boolean;
  dmChartCid: string;
  hasDmChart: boolean;
  csmChartCid: string;
  hasCsmChart: boolean;
  amChartCid: string;
  hasAmChart: boolean;
}
