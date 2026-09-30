import type { CargoPatch, ImportBatch } from './types';

/**
 * 职责三：请求入口（gateway）
 * 码头导入、重复导入、失败重试都只经此模块。
 *  - 幂等：同一 batchId 第二次提交，直接沿用第一次结果（不重复落货位）；
 *  - 失败保留：传输/保存失败时由调用方把批次留在 failed 队列，原批次内容不丢、可重试；
 *  - 保存成功前不得改动快照（由 slice 保证）。
 * 纯传输层，不接触 Redux。
 */

export type SubmitResult =
  | { ok: true; savedAt: string; duplicate: boolean }
  | { ok: false; reason: string };

// 模拟“保存失败”的批次（可重试后成功）；其他批次正常保存
export const FLAKY_BATCH_IDS = new Set(['B-2609-502']);

function now(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * 提交一个导入批次。
 * @param seenBatchIds 本航次已经成功/失败处理过的批次 → 幂等沿用第一次结果
 */
export async function submitImportBatch(
  batch: Pick<ImportBatch, 'batchId' | 'patches'>,
  seen: Map<string, { duplicate: boolean }>
): Promise<SubmitResult> {
  await new Promise((resolve) => setTimeout(resolve, 650));
  const previous = seen.get(batch.batchId);
  if (previous) {
    return { ok: true, savedAt: now(), duplicate: true };
  }
  if (FLAKY_BATCH_IDS.has(batch.batchId)) {
    return { ok: false, reason: '码头岸网瞬断，批次未送达' };
  }
  return { ok: true, savedAt: now(), duplicate: false };
}

/** 失败批次重试：与首次提交走同一个入口（仍由 batchId 幂等保护） */
export async function retryImportBatch(
  batch: Pick<ImportBatch, 'batchId' | 'patches'>,
  seen: Map<string, { duplicate: boolean }>
): Promise<SubmitResult> {
  FLAKY_BATCH_IDS.delete(batch.batchId); // 演示：重试时链路已恢复
  return submitImportBatch(batch, seen);
}

export function makeBatch(batchId: string, terminal: string, note: string, patches: CargoPatch[]): ImportBatch {
  return { batchId, terminal, note, patches, status: 'saving', receivedAt: now() };
}

/** 预置的两码头导入批次（含一个会先失败、保留待重试的批次） */
export function presetBatches(): ImportBatch[] {
  return [
    makeBatch('B-2609-501', '釜山码头', '改靠港后首轮货位调整', [
      { bill: 'SEA-88231', bay: 9, row: 5, tier: 1 },
      { bill: 'SEA-88254', lashing: '已绑扎' }
    ]),
    makeBatch('B-2609-502', '温哥华码头', '重大件绑扎通道调整（首次会失败）', [
      { bill: 'SEA-88247', bay: 14, row: 1, tier: 1 },
      { bill: 'SEA-88219', lashing: '已绑扎' }
    ]),
    makeBatch('B-2609-503', '釜山码头', '重复导入 501（应沿用第一次结果）', [
      { bill: 'SEA-88231', bay: 11, row: 7, tier: 1 }
    ])
  ];
}
