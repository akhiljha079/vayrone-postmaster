// REST protocol between the product and the Vayrone License Server (/api/v1).
// Pure types, shared by both sides.
import type { HealthReport } from '@vpm/core';
import type { Components } from './format.js';

export type { HealthReport };

export interface MachineInfo {
  id: string;
  components: Components;
}
/** Client details entered in the setup wizard (company profile). */
export interface SiteInfo {
  company: string;
  gstin: string | null;
  contact: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
}
export interface ProductInfo {
  version: string;
  installId: string;
  hostname: string;
  site?: SiteInfo | null;
}
export interface UsageInfo {
  activeUsers: number;
  externalAccounts: number;
}

/** POST /api/v1/activate */
export interface ActivateRequest {
  key: string;
  machine: MachineInfo;
  product: ProductInfo;
  usage: UsageInfo;
}
export interface ActivateResponse {
  license: string;
  /** Proves later heartbeats/deactivation come from this install. Stored sealed. */
  token: string;
}

/** POST /api/v1/heartbeat */
export interface HeartbeatRequest {
  licenseId: string;
  activationId: string;
  token: string;
  machine: MachineInfo;
  product: ProductInfo;
  usage: UsageInfo;
  /** Server health for Vayrone's overview of client servers (optional; newer versions). */
  health?: HealthReport;
}
export interface HeartbeatResponse {
  /** Refreshed licence (new checkBy, current entitlements after renewals/upgrades). */
  license?: string;
  /** This activation was transferred, suspended or revoked. */
  revocation?: string;
  serverTime: string;
}

/** POST /api/v1/deactivate — release this machine so the licence can move. */
export interface DeactivateRequest {
  licenseId: string;
  activationId: string;
  token: string;
}
export interface DeactivateResponse {
  revocation: string;
}

/** POST /api/v1/health: hourly health report between the daily heartbeats. */
export interface HealthReportRequest {
  licenseId: string;
  activationId: string;
  token: string;
  health: HealthReport;
}

/** POST /api/v1/offline — portal processing of an activation request file (text body). */
export interface OfflineResponse {
  license: string;
}

export type ApiErrorCode =
  | 'INVALID_KEY'
  | 'LICENSE_SUSPENDED'
  | 'LICENSE_REVOKED'
  | 'ALREADY_ACTIVATED'
  | 'ACTIVATION_NOT_FOUND'
  | 'BAD_TOKEN'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED';

export interface ApiError {
  error: ApiErrorCode | string;
  message: string;
}
