import type { Cargo } from './api';

/**
 * 配载快照 —— 货位、卸货港与绑扎复核共同绑定的同一份快照。
 *
 * 快照把每票货（按提单号识别）的货位、卸货港和绑扎复核结论保存在一起，
 * 三者必须来自同一份快照，不允许出现“货位是一版、绑扎结论是另一版”的情况。
 * 当货位或卸货港变化时，只有受影响港口的结论需要重算，其他港口结论继续有效。
 */

export type ConclusionStatus = 'valid' | 'stale' | 'recalculating';

export type DischargeItem = { bill: string; bay: number; row: number; tier: number; order: number };

export type DgConflict = { bill: string; level: 'high' | 'medium'; detail: string };

export type LashingReviewItem = { bill: string; lashing: Cargo['lashing']; required: boolean; note: string };

export type PortConclusion = {
  port: string;
  status: ConclusionStatus;
  /** 卸货顺序：该港卸货的箱号与先后次序 */
  dischargeSequence: DischargeItem[];
  /** 危险品隔离结论 */
  dgConflicts: DgConflict[];
  /** 该港对稳性裕度的贡献（重量 / 纵向力矩 / 裕度分） */
  stability: { weight: number; moment: number; margin: number };
  /** 绑扎复核结论 */
  lashingReview: LashingReviewItem[];
  computedAt: string;
};

export type Snapshot = {
  id: string;
  revision: number;
  /** 结论所依据的货票（按提单号识别） */
  cargo: Cargo[];
  ports: string[];
  conclusions: Record<string, PortConclusion>;
  locked: boolean;
  savedAt: string;
};

const NOW = () => new Date().toISOString();

/** 港口卸货顺序：按 bay 从大到小（先卸尾部），再按 row 排序。 */
function computeDischargeSequence(items: Cargo[]): DischargeItem[] {
  return [...items]
    .sort((a, b) => b.bay - a.bay || a.row - b.row || a.tier - b.tier)
    .map((item, index) => ({ bill: item.bill, bay: item.bay, row: item.row, tier: item.tier, order: index + 1 }));
}

/** 危险品隔离：同港危险品箱与普通箱/生活区的隔离核查。 */
function computeDgConflicts(items: Cargo[]): DgConflict[] {
  const conflicts: DgConflict[] = [];
  const dg = items.filter((item) => item.hazmat !== '无');
  dg.forEach((item) => {
    if (item.deck === '主甲板' && item.row <= 1) {
      conflicts.push({ bill: item.bill, level: 'high', detail: `${item.bill} 危险品箱距船体边界不足一个隔离位。` });
    }
    const adjacent = items.find(
      (other) => other.bill !== item.bill && Math.abs(other.bay - item.bay) <= 1 && other.hazmat === '无' && other.deck === item.deck
    );
    if (adjacent) {
      conflicts.push({ bill: item.bill, level: 'medium', detail: `${item.bill} 与普通货 ${adjacent.bill} 相邻，需确认隔离间距。` });
    }
  });
  return conflicts;
}

/** 该港对稳性裕度的贡献。 */
function computePortStability(items: Cargo[]) {
  const weight = items.reduce((sum, item) => sum + item.weight, 0);
  const moment = items.reduce((sum, item) => sum + item.weight * item.bay, 0);
  // 与全局 calculateStability 一致的裕度口径，按该港货量占比折算贡献分。
  const margin = weight > 0 ? Math.max(0, 92 - Math.abs(moment / Math.max(weight, 1) - 10.8) * 2.2) : 0;
  return { weight: Number(weight.toFixed(2)), moment: Number(moment.toFixed(2)), margin: Number(margin.toFixed(2)) };
}

/** 绑扎复核：重大件、危险品及绑扎状态非“已绑扎”的货票需要复核。 */
function computeLashingReview(items: Cargo[]): LashingReviewItem[] {
  return items.map((item) => {
    const required = item.weight > 100 || item.hazmat !== '无' || item.lashing !== '已绑扎';
    let note = '绑扎状态符合要求。';
    if (item.weight > 100) note = '重大件，需甲板部复核绑扎点与局部强度。';
    else if (item.hazmat !== '无') note = '危险品箱，绑扎需符合 IMDG 隔离与系固要求。';
    else if (item.lashing === '待绑扎') note = '尚未绑扎，离港前必须完成。';
    else if (item.lashing === '需复核') note = '绑扎状态需复核确认。';
    return { bill: item.bill, lashing: item.lashing, required, note };
  });
}

/** 计算单个港口的结论（纯函数，依据快照中的货票）。 */
export function computePortConclusion(cargo: Cargo[], port: string): PortConclusion {
  const items = cargo.filter((item) => item.port === port);
  return {
    port,
    status: 'valid',
    dischargeSequence: computeDischargeSequence(items),
    dgConflicts: computeDgConflicts(items),
    stability: computePortStability(items),
    lashingReview: computeLashingReview(items),
    computedAt: NOW()
  };
}

/** 生成初始快照：所有港口结论均为有效。 */
export function createInitialSnapshot(cargo: Cargo[], revision = 1): Snapshot {
  const ports = Array.from(new Set(cargo.map((item) => item.port)));
  const conclusions: Record<string, PortConclusion> = {};
  ports.forEach((port) => {
    conclusions[port] = computePortConclusion(cargo, port);
  });
  return {
    id: `SNAP-${revision}-${Date.now().toString(36)}`,
    revision,
    cargo: cargo.map((item) => ({ ...item })),
    ports,
    conclusions,
    locked: false,
    savedAt: NOW()
  };
}

function cargoSignature(cargo: Cargo[]): string {
  return cargo
    .map((item) => `${item.bill}|${item.bay}|${item.row}|${item.tier}|${item.deck}|${item.port}|${item.lashing}`)
    .sort()
    .join(';;');
}

/**
 * 快照判定：当前货票是否与快照一致。
 * 一致 → 快照仍有效，可继续使用原有结论；不一致 → 判定受影响港口。
 */
export function isSnapshotCurrent(snapshot: Snapshot, cargo: Cargo[]): boolean {
  return cargoSignature(snapshot.cargo) === cargoSignature(cargo);
}

/**
 * 判定受影响的港口：对比新旧货票，返回结论需要重算的港口集合。
 * 货位（bay/row/tier/deck）、卸货港或绑扎状态变化时，旧港与新港都受影响。
 */
export function determineAffectedPorts(prev: Cargo[], next: Cargo[]): string[] {
  const affected = new Set<string>();
  const prevByBill = new Map(prev.map((item) => [item.bill, item]));
  const nextByBill = new Map(next.map((item) => [item.bill, item]));

  next.forEach((item) => {
    const before = prevByBill.get(item.bill);
    if (!before) {
      // 新增货票：只影响新港
      affected.add(item.port);
      return;
    }
    const changed =
      before.bay !== item.bay ||
      before.row !== item.row ||
      before.tier !== item.tier ||
      before.deck !== item.deck ||
      before.port !== item.port ||
      before.lashing !== item.lashing;
    if (changed) {
      affected.add(before.port);
      affected.add(item.port);
    }
  });

  prev.forEach((item) => {
    if (!nextByBill.has(item.bill)) affected.add(item.port); // 删除货票
  });

  return Array.from(affected);
}

/** 把指定港口标记为重算中。 */
export function markPortsRecalculating(snapshot: Snapshot, ports: string[]): Snapshot {
  const conclusions = { ...snapshot.conclusions };
  ports.forEach((port) => {
    const existing = conclusions[port];
    conclusions[port] = {
      port,
      status: 'recalculating',
      dischargeSequence: existing?.dischargeSequence ?? [],
      dgConflicts: existing?.dgConflicts ?? [],
      stability: existing?.stability ?? { weight: 0, moment: 0, margin: 0 },
      lashingReview: existing?.lashingReview ?? [],
      computedAt: existing?.computedAt ?? NOW()
    };
  });
  return { ...snapshot, conclusions };
}

/**
 * 重算指定港口的结论（纯函数）。只重算传入的港口，其他港口结论原样保留。
 * 返回新快照，其货票更新为当前货票、版本号 +1。
 */
export function recalculatePorts(snapshot: Snapshot, ports: string[], cargo: Cargo[]): Snapshot {
  const conclusions = { ...snapshot.conclusions };
  ports.forEach((port) => {
    conclusions[port] = computePortConclusion(cargo, port);
  });
  // 港口集合可能随卸货港变化而增减
  const portsNow = Array.from(new Set(cargo.map((item) => item.port)));
  Object.keys(conclusions).forEach((port) => {
    if (!portsNow.includes(port)) delete conclusions[port];
  });
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    cargo: cargo.map((item) => ({ ...item })),
    ports: portsNow,
    conclusions,
    savedAt: NOW()
  };
}

/** 是否还有港口结论未完成（stale / recalculating）。 */
export function hasPendingConclusion(snapshot: Snapshot): boolean {
  return Object.values(snapshot.conclusions).some((c) => c.status !== 'valid');
}

/**
 * 锁定 / 打印门槛：重算未完成前不能锁定或打印。
 * 快照锁定后同样不允许再放行旧图。
 */
export function canLockOrPrint(snapshot: Snapshot): boolean {
  return !snapshot.locked && !hasPendingConclusion(snapshot);
}
