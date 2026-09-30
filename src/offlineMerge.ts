import type { Cargo } from './api';

/**
 * 离线合并 —— 断网期间两个终端各自修改，恢复后按提单号合并。
 *
 * 规则：
 * - 每票货按提单号识别；
 * - 只有一个终端修改 → 采用该终端结果；
 * - 两个终端都修改且货位一致 → 合并；
 * - 两个终端都修改且货位不同 → 保留两份待选，不盖掉锁定版本；
 * - 锁定版本永远不被静默覆盖，冲突需人工选择。
 */

export type OfflineTerminal = 'A' | 'B';

export type OfflineChange = {
  bill: string;
  bay: number;
  row: number;
  tier: number;
  deck: Cargo['deck'];
  port: string;
  lashing: Cargo['lashing'];
  terminal: OfflineTerminal;
};

export type ConflictPair = {
  bill: string;
  first: OfflineChange;
  second: OfflineChange;
};

export type MergeResult = {
  /** 无冲突、可直接合并的货票（已应用变更） */
  merged: Cargo[];
  /** 货位不同、需人工选择的两份待选 */
  conflicts: ConflictPair[];
  /** 合并后仍保持锁定的版本（不被覆盖） */
  locked: boolean;
};

function sameSpace(a: OfflineChange, b: OfflineChange): boolean {
  return a.bay === b.bay && a.row === b.row && a.tier === b.tier && a.deck === b.deck;
}

function applyChange(base: Cargo, change: OfflineChange): Cargo {
  return {
    ...base,
    bay: change.bay,
    row: change.row,
    tier: change.tier,
    deck: change.deck,
    port: change.port,
    lashing: change.lashing
  };
}

/**
 * 合并两个终端的离线修改。
 * @param lockedBase 已锁定的基准货票（不会被覆盖）
 * @param changesA 终端 A 的修改
 * @param changesB 终端 B 的修改
 */
export function mergeOfflineChanges(lockedBase: Cargo[], changesA: OfflineChange[], changesB: OfflineChange[]): MergeResult {
  const map = new Map<string, Cargo>();
  lockedBase.forEach((item) => map.set(item.bill, { ...item }));

  const aByBill = new Map(changesA.map((c) => [c.bill, c]));
  const bByBill = new Map(changesB.map((c) => [c.bill, c]));
  const conflicts: ConflictPair[] = [];

  const allBills = new Set<string>([...aByBill.keys(), ...bByBill.keys()]);
  allBills.forEach((bill) => {
    const a = aByBill.get(bill);
    const b = bByBill.get(bill);
    const base = map.get(bill);
    if (!base) return; // 基准中不存在的票不纳入合并

    if (a && b) {
      if (sameSpace(a, b)) {
        // 两边货位一致，合并（以 A 为准，二者相同）
        map.set(bill, applyChange(base, a));
      } else {
        // 货位不同，保留两份待选，不盖锁定版本
        conflicts.push({ bill, first: a, second: b });
      }
    } else if (a) {
      map.set(bill, applyChange(base, a));
    } else if (b) {
      map.set(bill, applyChange(base, b));
    }
  });

  return { merged: Array.from(map.values()), conflicts, locked: true };
}

/** 从冲突对中选定一份，返回应用后的货票。 */
export function resolveConflict(base: Cargo[], conflict: ConflictPair, pick: 'first' | 'second'): Cargo[] {
  const change = pick === 'first' ? conflict.first : conflict.second;
  return base.map((item) => (item.bill === conflict.bill ? applyChange(item, change) : item));
}
