import type { Cargo } from '../api';

/** 每票货可调整的字段（按提单号识别） */
export type CargoPatch = {
  bill: string;
  bay?: number;
  row?: number;
  tier?: number;
  port?: string;
  lashing?: Cargo['lashing'];
};

export type CheckStatus = 'valid' | 'recalculating' | 'stale';

/** 单一港口的校核结论：卸货顺序 / 危险品隔离 / 稳性裕度 / 绑扎复核 */
export type PortConclusion = {
  port: string;
  status: CheckStatus;
  /** 该港卸船顺序（提单号序列） */
  dischargeOrder: string[];
  hazmat: { status: 'ok' | 'warning'; detail: string };
  /** 该港时点的稳性裕度（0–100） */
  stabilityMargin: number;
  lashing: { pendingBills: string[]; detail: string };
  /** 结论所依据的货物指纹；指纹不变则结论继续有效 */
  fingerprint: string;
  recalculatedAt: string;
};

export type StowageSnapshot = {
  id: string;
  revision: number;
  label: string;
  createdAt: string;
  /** 该快照生效时的挂靠顺序及顺序版本（改靠港顺序后旧快照的版本即过期） */
  rotation: string[];
  rotationVersion: string;
  locked: boolean;
  cargo: Cargo[];
  conclusions: PortConclusion[];
  origin: '工作快照' | '改港快照' | '锁定副本';
};

/** 导入批次（码头导入 / 重复导入 / 失败重试都经过请求入口） */
export type ImportBatchStatus = 'saving' | 'saved' | 'failed';
export type ImportBatch = {
  batchId: string;
  terminal: string;
  receivedAt: string;
  savedAt?: string;
  status: ImportBatchStatus;
  note: string;
  patches: CargoPatch[];
  /** 幂等：同一 batchId 重复导入时沿用第一次的结果 */
  duplicate?: boolean;
};

/** 断网期间某个终端积累的修改（按提单号覆盖合并） */
export type TerminalEdits = {
  terminal: string;
  startedAt: string;
  edits: CargoPatch[];
};

export type OfflineConflict = {
  id: string;
  bill: string;
  terminalA: string;
  terminalB: string;
  a: CargoPatch;
  b: CargoPatch;
  /** 锁定版本与离线修改冲突时，锁定版作为不可覆盖的候选保留 */
  lockedPatch?: CargoPatch;
  status: '待选' | '已选A' | '已选B' | '已选锁定版';
};

export type MergeSummary = {
  applied: string[];
  conflicts: OfflineConflict[];
  unchanged: string[];
  unrecognized: string[];
  baseRevision: number;
};

export type ActivityLogEntry = {
  id: number;
  at: string;
  message: string;
  tone: 'info' | 'ok' | 'warn';
};
