import type { Cargo } from '../api';
import type { CargoPatch, CheckStatus, PortConclusion, StowageSnapshot } from './types';

/**
 * 职责一：快照判定（adjudication）
 * 只做纯计算：按提单号识别货物、判定受影响港口、重算港口结论、给出锁定/打印闸门。
 * 不持有状态、不发起请求；状态在 snapshotSlice，请求在 gateway。
 */

export type Gate = {
  canEdit: boolean;
  canLock: boolean;
  canPrint: boolean;
  blockers: string[];
  warnings: string[];
};

/** 改港：生成新的挂靠顺序版本号 */
export function bumpRotationVersion(version: string): string {
  const match = /^R-(\d+)-(\d+)$/.exec(version);
  if (!match) return 'R-09-02';
  return `R-${String(match[1]).padStart(2, '0')}-${Number(match[2]) + 1}`;
}

export function findByBill(cargo: Cargo[], bill: string): Cargo | undefined {
  return cargo.find((item) => item.bill === bill);
}

/** 将一批货位/卸货港/绑扎修改应用到货物数组（纯函数，返回新数组） */
export function applyPatches(cargo: Cargo[], patches: CargoPatch[]): Cargo[] {
  const next = cargo.map((item) => ({ ...item }));
  patches.forEach((patch) => {
    const target = next.find((item) => item.bill === patch.bill);
    if (!target) return;
    if (patch.bay !== undefined) target.bay = patch.bay;
    if (patch.row !== undefined) target.row = patch.row;
    if (patch.tier !== undefined) target.tier = patch.tier;
    if (patch.port !== undefined) target.port = patch.port;
    if (patch.lashing !== undefined) target.lashing = patch.lashing;
  });
  return next;
}

/**
 * 受影响港口：卸货港变化 → 旧港 + 新港都要重算；货位或绑扎变化 → 只重算该票货的卸货港。
 * 其余港口的既有结论继续有效。
 */
export function affectedPorts(before: Cargo[], patches: CargoPatch[]): string[] {
  const ports = new Set<string>();
  patches.forEach((patch) => {
    const old = findByBill(before, patch.bill);
    if (!old) return;
    ports.add(old.port);
    if (patch.port && patch.port !== old.port) ports.add(patch.port);
  });
  return [...ports];
}

/** 到 port 时仍在船上的货：卸货港为该港或位于其后挂港的货物 */
function cargoAboardAt(cargo: Cargo[], rotation: string[], port: string): Cargo[] {
  const index = rotation.indexOf(port);
  if (index < 0) return [];
  const remaining = new Set(rotation.slice(index));
  return cargo.filter((item) => remaining.has(item.port));
}

/** 港口货物指纹：参与该港校核的货物的关键字段 + 挂港顺序 */
export function portFingerprint(cargo: Cargo[], rotation: string[], port: string): string {
  const aboard = cargoAboardAt(cargo, rotation, port).sort((a, b) => a.bill.localeCompare(b.bill));
  const body = aboard
    .map((item) => `${item.bill}:${item.bay}/${item.row}/${item.tier}|${item.deck}|${item.weight}|${item.hazmat}|${item.lashing}|${item.port}`)
    .join(';');
  return `${port}@${rotation.join('>')}#${body}`;
}

/**
 * 重算单个港口的四项结论：卸货顺序、危险品隔离、稳性裕度、绑扎复核。
 */
export function recomputePort(cargo: Cargo[], rotation: string[], port: string, at = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })): PortConclusion {
  // 卸货顺序：本港卸货按货位自艉向艏（bay 大者先卸，减少倒垛）
  const discharging = cargo
    .filter((item) => item.port === port)
    .sort((a, b) => b.bay - a.bay || a.row - b.row || b.tier - a.tier);
  const dischargeOrder = discharging.map((item) => item.bill);

  // 危险品隔离：本港时仍在船上的危险品，检查相互水平间隔与靠边界距离
  const aboard = cargoAboardAt(cargo, rotation, port);
  const hazmatItems = aboard.filter((item) => item.hazmat !== '无');
  let hazmat: PortConclusion['hazmat'] = { status: 'ok', detail: '无危险品在船' };
  if (hazmatItems.length) {
    const violations: string[] = [];
    hazmatItems.forEach((item) => {
      if (item.deck === '主甲板' && item.row <= 1) violations.push(`${item.bill} 距舷边不足隔离距离`);
    });
    for (let i = 0; i < hazmatItems.length; i += 1) {
      for (let j = i + 1; j < hazmatItems.length; j += 1) {
        const a = hazmatItems[i];
        const b = hazmatItems[j];
        if (a.deck === b.deck && Math.abs(a.bay - b.bay) < 2 && a.row === b.row) {
          violations.push(`${a.bill} 与 ${b.bill} 纵向隔离不足一个箱位`);
        }
      }
    }
    hazmat = violations.length
      ? { status: 'warning', detail: violations.join('；') }
      : { status: 'ok', detail: `${hazmatItems.map((item) => item.bill).join('、')} 隔离距离满足要求` };
  }

  // 稳性裕度：该港卸货完成、船继续航行时的在船货物
  const afterDischarge = aboard.filter((item) => item.port !== port);
  const total = afterDischarge.reduce((sum, item) => sum + item.weight, 0);
  const longitudinal = total
    ? afterDischarge.reduce((sum, item) => sum + item.weight * item.bay, 0) / total
    : 10.8;
  const vertical = total
    ? afterDischarge.reduce((sum, item) => sum + item.weight * (item.tier + 1), 0) / total
    : 1.5;
  const stabilityMargin = Math.max(0, 92 - Math.abs(longitudinal - 10.8) * 2.2 - Math.max(0, vertical - 1.75) * 8);

  // 绑扎复核：本港卸货的重大件与危险品必须已绑扎
  const pending = discharging
    .filter((item) => (item.weight > 100 || item.hazmat !== '无') && item.lashing !== '已绑扎')
    .map((item) => item.bill);
  const lashing: PortConclusion['lashing'] = pending.length
    ? { pendingBills: pending, detail: `${pending.join('、')} 卸船前须完成绑扎复核` }
    : { pendingBills: [], detail: dischargeOrder.length ? '本港卸货绑扎复核全部通过' : '本港无卸货，无需复核' };

  return {
    port,
    status: 'valid',
    dischargeOrder,
    hazmat,
    stabilityMargin,
    lashing,
    fingerprint: portFingerprint(cargo, rotation, port),
    recalculatedAt: at
  };
}

/** 以现有结论为底，只重算受影响港口；其他港口结论沿用（指纹校验仍通过则 valid） */
export function recomputeAffected(
  snapshot: Pick<StowageSnapshot, 'cargo' | 'rotation' | 'conclusions'>,
  ports: string[],
  at?: string
): PortConclusion[] {
  return snapshot.conclusions.map((conclusion) => {
    if (!ports.includes(conclusion.port)) {
      const freshFingerprint = portFingerprint(snapshot.cargo, snapshot.rotation, conclusion.port);
      if (freshFingerprint === conclusion.fingerprint && conclusion.status !== 'recalculating') {
        return conclusion;
      }
      return { ...conclusion, status: 'stale' as CheckStatus };
    }
    return recomputePort(snapshot.cargo, snapshot.rotation, conclusion.port, at);
  });
}

/** 由货物 + 挂港顺序引导出完整的初版港口结论（装货港除外） */
export function bootConclusions(cargo: Cargo[], rotation: string[]): PortConclusion[] {
  return rotation
    .slice(1)
    .map((port) => recomputePort(cargo, rotation, port));
}

export type SnapshotLock = Pick<StowageSnapshot, 'cargo' | 'rotation' | 'rotationVersion' | 'conclusions' | 'locked' | 'id'>;

/** 船长放行时校验：所持快照必须与当前挂靠顺序版本一致，旧配载图不得放行 */
export function isSnapshotCurrent(snapshot: Pick<StowageSnapshot, 'rotationVersion'>, currentRotationVersion: string): boolean {
  return snapshot.rotationVersion === currentRotationVersion;
}

/**
 * 全船校核：稳性 / 冲突（供原有总览、配载、打印页面继续使用）。
 */
export function calculateStability(cargo: Cargo[]) {
  const total = cargo.reduce((sum, item) => sum + item.weight, 0);
  const longitudinal = total ? cargo.reduce((sum, item) => sum + item.weight * item.bay, 0) / total : 10.8;
  const vertical = total ? cargo.reduce((sum, item) => sum + item.weight * (item.tier + 1), 0) / total : 1.5;
  const deckLoad = cargo.filter((item) => item.deck === '主甲板').reduce((sum, item) => sum + item.weight, 0);
  const stability = Math.max(0, 92 - Math.abs(longitudinal - 10.8) * 2.2 - Math.max(0, vertical - 1.75) * 8);
  return {
    total,
    longitudinal,
    vertical,
    deckLoad,
    stability,
    trim: (longitudinal - 10.8) < -0.4 ? '艉倾' : (longitudinal - 10.8) > 0.4 ? '艏倾' : '正平'
  };
}

export type StowageConflict = { id: string; cargoId: string; level: 'high' | 'medium'; title: string; detail: string };

export function detectConflicts(cargo: Cargo[]): StowageConflict[] {
  const issues: StowageConflict[] = [];
  const slots = new Map<string, Cargo>();
  cargo.forEach((item) => {
    const key = `${item.deck}-${item.bay}-${item.row}-${item.tier}`;
    const existing = slots.get(key);
    if (existing) issues.push({ id: `${item.id}-overlap`, cargoId: item.id, level: 'high', title: '货位重叠', detail: `${item.id} 与 ${existing.id} 占用相同二维货位。` });
    slots.set(key, item);
    if (item.hazmat !== '无' && item.deck === '主甲板' && item.row <= 1) issues.push({ id: `${item.id}-hazmat`, cargoId: item.id, level: 'high', title: '危险品隔离不足', detail: `${item.id} 与船体边界距离小于方案要求。` });
    if (item.weight > 100 && item.lashing !== '已绑扎') issues.push({ id: `${item.id}-lashing`, cargoId: item.id, level: 'medium', title: '重大件绑扎未完成', detail: `${item.id} 重量 ${item.weight}t，绑扎状态为“${item.lashing}”。` });
    if (item.type === '集装箱' && item.weight > 30 && item.tier >= 3) issues.push({ id: `${item.id}-stack`, cargoId: item.id, level: 'medium', title: '上层堆重超限', detail: `${item.id} 不应放在第 ${item.tier} 层。` });
  });
  return issues;
}

/**
 * 锁定 / 打印闸门。
 * 重算未完成（recalculating）、结论过期、有挂起失败批次、离线冲突未裁决时，一律不能锁定或打印。
 */
export function buildGate(input: {
  snapshot: StowageSnapshot;
  currentRotationVersion: string;
  offline: boolean;
  hasSavingBatches: boolean;
  hasFailedBatches: boolean;
  pendingConflicts: number;
  conflicts: { level: 'high' | 'medium' }[];
}): Gate {
  const { snapshot, currentRotationVersion, offline, hasSavingBatches, hasFailedBatches, pendingConflicts, conflicts } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!isSnapshotCurrent(snapshot, currentRotationVersion)) {
    blockers.push(`快照基于旧靠港顺序 ${snapshot.rotationVersion}，当前为 ${currentRotationVersion}，旧配载图不得放行`);
  }
  const recalculating = snapshot.conclusions.filter((item) => item.status === 'recalculating').map((item) => item.port);
  if (recalculating.length) blockers.push(`${recalculating.join('、')} 港口重算未完成，不能锁定或打印`);
  const stale = snapshot.conclusions.filter((item) => item.status === 'stale').map((item) => item.port);
  if (stale.length) blockers.push(`${stale.join('、')} 港口结论已过期，等待重算`);
  if (offline) blockers.push('当前处于断网编辑状态，恢复并完成合并前不能锁定或打印');
  if (hasSavingBatches) blockers.push('码头导入批次保存中，原批次尚未落定');
  if (hasFailedBatches) warnings.push('存在保存失败的导入批次，原批次保留待重试（不影响已生效快照）');
  if (pendingConflicts > 0) blockers.push(`${pendingConflicts} 处离线货位冲突待裁决（两份货位保留待选）`);
  const high = conflicts.filter((item) => item.level === 'high').length;
  if (high > 0) blockers.push(`存在 ${high} 项阻断性配载冲突`);

  const canEdit = !snapshot.locked && !offline;
  const hardBlocked = blockers.length > 0;
  return {
    canEdit,
    // 可编辑不代表可锁定/打印；只有无任何阻断项且未锁定时才能锁定
    canLock: !hardBlocked && !snapshot.locked,
    canPrint: !hardBlocked,
    blockers,
    warnings
  };
}
