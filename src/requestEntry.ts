import type { Cargo } from './api';

/**
 * 请求入口 —— 导入与保存的统一入口。
 *
 * - 导入舱单：每票货按提单号识别，重复导入沿用第一次结果；
 * - 保存：失败后原批次保留待重试，不丢失、不重复提交。
 */

export type ImportResult = {
  imported: Cargo[];
  /** 重复提单号（沿用第一次结果，未覆盖） */
  duplicates: string[];
  /** 本次新增的提单号 */
  added: string[];
};

/**
 * 导入舱单并按提单号去重。
 * 已存在的提单号沿用第一次结果，不覆盖；仅追加新票。
 */
export function importManifest(existing: Cargo[], incoming: Cargo[]): ImportResult {
  const byBill = new Map<string, Cargo>();
  existing.forEach((item) => {
    if (!byBill.has(item.bill)) byBill.set(item.bill, item); // 重复导入沿用第一次结果
  });
  const duplicates: string[] = [];
  const added: string[] = [];
  incoming.forEach((item) => {
    if (byBill.has(item.bill)) {
      duplicates.push(item.bill);
      return;
    }
    byBill.set(item.bill, item);
    added.push(item.bill);
  });
  return { imported: Array.from(byBill.values()), duplicates, added };
}

export type SaveBatch = {
  id: string;
  cargo: Cargo[];
  attempts: number;
  lastError: string | null;
  status: 'pending' | 'saving' | 'failed' | 'saved';
};

export function createSaveBatch(cargo: Cargo[]): SaveBatch {
  return {
    id: `BATCH-${Date.now().toString(36)}`,
    cargo: cargo.map((item) => ({ ...item })),
    attempts: 0,
    lastError: null,
    status: 'pending'
  };
}

/**
 * 模拟保存请求。默认成功；当批次货票中包含非法货位（bay<=0）时判定失败，
 * 用于演示“保存失败后原批次保留待重试”。
 */
export async function saveBatchRequest(batch: SaveBatch): Promise<{ ok: boolean; error?: string }> {
  await new Promise((resolve) => setTimeout(resolve, 420));
  const invalid = batch.cargo.some((item) => item.bay <= 0 || item.row < 0 || item.tier < 0);
  if (invalid) return { ok: false, error: '货位校验未通过：存在非法 bay/row/tier，原批次保留待重试。' };
  return { ok: true };
}
