import type { Cargo } from '../api';
import type { CargoPatch, MergeSummary, OfflineConflict, TerminalEdits } from './types';

/**
 * 职责二：离线合并（merge）
 * 断网期间两个终端各自修改；恢复后按提单号三路合并（基线 / 终端A / 终端B / 可选锁定版）。
 * 规则：
 *  - 相同修改 → 保留一份直接生效；
 *  - 只有一个终端改 → 采用该终端；
 *  - 两终端都改但内容不同 → 两份都保留为候选，不得互相覆盖；
 *  - 与已锁定版本冲突 → 锁定版作为不可覆盖的候选同时保留。
 * 纯函数，不直接写状态；由 snapshotSlice 落库。
 */

export function mergeEdits(
  baseCargo: Cargo[],
  terminalA: TerminalEdits,
  terminalB: TerminalEdits,
  lockedBills: Set<string> = new Set()
): MergeSummary {
  const byBill = new Map<string, { a?: CargoPatch; b?: CargoPatch }>();
  terminalA.edits.forEach((patch) => {
    byBill.set(patch.bill, { ...byBill.get(patch.bill), a: patch });
  });
  terminalB.edits.forEach((patch) => {
    byBill.set(patch.bill, { ...byBill.get(patch.bill), b: patch });
  });

  const applied: string[] = [];
  const unchanged: string[] = [];
  const unrecognized: string[] = [];
  const conflicts: OfflineConflict[] = [];
  let seq = 0;

  byBill.forEach(({ a, b }, bill) => {
    const base = baseCargo.find((item) => item.bill === bill);
    if (!base) {
      unrecognized.push(bill);
      return;
    }
    const patchA = a ?? b!;
    const patchB = b ?? a!;
    const both = Boolean(a && b);
    const equal = both && samePatch(a!, b!);

    // 与基线（或锁定版）完全一致 → 无需处理
    if (matchesCargo(base, patchA) && matchesCargo(base, patchB)) {
      unchanged.push(bill);
      return;
    }

    if (!both || equal) {
      // 单边修改 / 两边一致
      if (lockedBills.has(bill) && !matchesCargo(base, patchA)) {
        // 锁定版不能被盖掉：锁定版与离线版同时保留待选
        conflicts.push(buildConflict(bill, terminalA.terminal, terminalB.terminal, patchA, patchA, base, seq += 1));
      } else {
        applied.push(bill);
      }
      return;
    }

    // 两边都改且不同：两份候选都保留
    conflicts.push(buildConflict(bill, terminalA.terminal, terminalB.terminal, a!, b!, lockedBills.has(bill) ? base : undefined, seq += 1));
  });

  return {
    applied,
    conflicts,
    unchanged,
    unrecognized,
    baseRevision: 0
  };
}

function buildConflict(
  bill: string,
  terminalA: string,
  terminalB: string,
  a: CargoPatch,
  b: CargoPatch,
  lockedBase: Cargo | undefined,
  seq: number
): OfflineConflict {
  return {
    id: `CF-${Date.now()}-${seq}`,
    bill,
    terminalA,
    terminalB,
    a,
    b,
    lockedPatch: lockedBase ? cargoToPatch(lockedBase) : undefined,
    status: '待选'
  };
}

export function cargoToPatch(cargo: Cargo): CargoPatch {
  return { bill: cargo.bill, bay: cargo.bay, row: cargo.row, tier: cargo.tier, port: cargo.port, lashing: cargo.lashing };
}

export function samePatch(a: CargoPatch, b: CargoPatch): boolean {
  return a.bay === b.bay && a.row === b.row && a.tier === b.tier && a.port === b.port && a.lashing === b.lashing;
}

export function matchesCargo(cargo: Cargo, patch: CargoPatch): boolean {
  return (patch.bay === undefined || cargo.bay === patch.bay)
    && (patch.row === undefined || cargo.row === patch.row)
    && (patch.tier === undefined || cargo.tier === patch.tier)
    && (patch.port === undefined || cargo.port === patch.port)
    && (patch.lashing === undefined || cargo.lashing === patch.lashing);
}

/** 断网期间同一终端对同一票货的多次修改：后写覆盖先写（按提单号收敛） */
export function foldTerminalEdit(edits: CargoPatch[], next: CargoPatch): CargoPatch[] {
  const merged: CargoPatch = { ...edits.find((item) => item.bill === next.bill), ...next };
  const rest = edits.filter((item) => item.bill !== next.bill);
  rest.push(merged);
  return rest;
}

export function describePatch(patch: CargoPatch): string {
  const parts: string[] = [];
  if (patch.bay !== undefined) parts.push(`B${patch.bay}`);
  if (patch.row !== undefined) parts.push(`R${patch.row}`);
  if (patch.tier !== undefined) parts.push(`T${patch.tier}`);
  if (patch.port !== undefined) parts.push(`→${patch.port}`);
  if (patch.lashing !== undefined) parts.push(patch.lashing);
  return parts.join(' / ') || '无变化';
}

export const PATCH_FIELD_LABELS: Record<keyof Omit<CargoPatch, 'bill'>, string> = {
  bay: 'Bay',
  row: 'Row',
  tier: 'Tier',
  port: '卸货港',
  lashing: '绑扎'
};

/** 两候选在哪些字段上不同（用于 UI 高亮） */
export function differingFields(a: CargoPatch, b: CargoPatch): (keyof Omit<CargoPatch, 'bill'>)[] {
  return (Object.keys(PATCH_FIELD_LABELS) as (keyof Omit<CargoPatch, 'bill'>)[])
    .filter((key) => a[key] !== b[key]);
}
