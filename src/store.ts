import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { stowageApi, type Cargo, type CargoType } from './api';
import {
  canLockOrPrint,
  createInitialSnapshot,
  determineAffectedPorts,
  hasPendingConclusion,
  isSnapshotCurrent,
  markPortsRecalculating,
  recalculatePorts,
  type Snapshot
} from './snapshot';
import {
  createSaveBatch,
  importManifest,
  saveBatchRequest,
  type SaveBatch
} from './requestEntry';
import { mergeOfflineChanges, resolveConflict, type ConflictPair, type OfflineChange } from './offlineMerge';

export type StowageComment = {
  id: string;
  cargoId: string;
  author: string;
  role: '船长' | '码头' | '货主';
  content: string;
  status: '待确认' | '已接受' | '已退回';
};

type State = {
  cargo: Cargo[];
  activeCargoId: string;
  planRevision: number;
  comments: StowageComment[];
  acceptedLimits: string[];
  locked: boolean;
  viewMode: '3d' | 'section';
  draftSavedAt: string;
  /** 配载快照：货位、卸货港、绑扎复核共同绑定的同一份快照 */
  snapshot: Snapshot;
  /** 保存批次：失败后保留待重试 */
  pendingSaveBatch: SaveBatch | null;
  saveStatus: 'idle' | 'saving' | 'failed' | 'saved';
  /** 最近一次导入结果（重复提单号沿用第一次） */
  lastImport: { duplicates: string[]; added: string[] } | null;
  /** 断网恢复后的待选冲突（货位不同的两份） */
  offlineConflicts: ConflictPair[];
};

const initialCargo: Cargo[] = [
  { id: 'BL-88214', bill: 'SEA-88214', type: '集装箱', bay: 12, row: 4, tier: 2, deck: '主甲板', weight: 24.6, dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: '无', lashing: '已绑扎', color: '#2b7c75' },
  { id: 'BL-88219', bill: 'SEA-88219', type: '集装箱', bay: 13, row: 4, tier: 2, deck: '主甲板', weight: 28.1, dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: 'UN 1263', lashing: '需复核', color: '#c77835' },
  { id: 'BL-88231', bill: 'SEA-88231', type: '集装箱', bay: 10, row: 6, tier: 1, deck: '主甲板', weight: 18.2, dimension: '20 × 8 × 8.6 ft', port: '釜山', hazmat: '无', lashing: '已绑扎', color: '#366d94' },
  { id: 'BL-88240', bill: 'SEA-88240', type: '集装箱', bay: 8, row: 2, tier: 2, deck: '货舱', weight: 31.4, dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: '无', lashing: '待绑扎', color: '#6d528d' },
  { id: 'BL-88247', bill: 'SEA-88247', type: '重大件', bay: 15, row: 0, tier: 1, deck: '主甲板', weight: 112.5, dimension: '18.4 × 4.2 × 4.8 m', port: '温哥华', hazmat: '无', lashing: '需复核', color: '#b64f49' },
  { id: 'BL-88254', bill: 'SEA-88254', type: '散货', bay: 5, row: 0, tier: 0, deck: '货舱', weight: 286.0, dimension: '散装 / 420 m³', port: '釜山', hazmat: '无', lashing: '已绑扎', color: '#9a7836' }
];

const initialSnapshot = createInitialSnapshot(initialCargo, 5);

const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('yy62-stowage-plan') : null;
const saved = raw ? JSON.parse(raw) : null;
const initialState: State = saved
  ? {
      ...saved,
      // 快照不持久化旧结论，首次加载按当前货票重建，保证货位/卸货港/绑扎同源
      snapshot: createInitialSnapshot(saved.cargo ?? initialCargo, saved.planRevision ?? 5),
      pendingSaveBatch: null,
      saveStatus: 'idle',
      lastImport: null,
      offlineConflicts: []
    }
  : {
      cargo: initialCargo,
      activeCargoId: 'BL-88247',
      planRevision: 5,
      comments: [
        { id: 'CM-21', cargoId: 'BL-88219', author: '港方配载', role: '码头', content: '危险品箱与船员生活区保持隔离，请在最终图中标注危险品隔离线。', status: '待确认' },
        { id: 'CM-22', cargoId: 'BL-88247', author: '周船长', role: '船长', content: '重大件横向支撑需增加两组绑扎点，检查甲板局部强度。', status: '待确认' },
        { id: 'CM-23', cargoId: 'BL-88254', author: '货主代表', role: '货主', content: '釜山港卸货前不得覆盖散货舱口，已接受当前安排。', status: '已接受' }
      ],
      acceptedLimits: [],
      locked: false,
      viewMode: '3d',
      draftSavedAt: '09:52',
      snapshot: initialSnapshot,
      pendingSaveBatch: null,
      saveStatus: 'idle',
      lastImport: null,
      offlineConflicts: []
    };

/** 重算受影响港口的结论（异步，模拟计算耗时）。 */
export const recalculateAffectedPorts = createAsyncThunk<void, string[], { state: RootState }>(
  'stowage/recalculateAffectedPorts',
  async (ports, { getState, dispatch }) => {
    if (!ports.length) return;
    dispatch(portsRecalculating(ports));
    await new Promise((resolve) => setTimeout(resolve, 650));
    const { cargo, snapshot } = getState().stowage;
    const next = recalculatePorts(snapshot, ports, cargo);
    dispatch(portsRecalculated(next));
  }
);

/** 保存当前配载为一个批次；失败则原批次保留待重试。 */
export const saveCurrentBatch = createAsyncThunk<void, void, { state: RootState }>(
  'stowage/saveCurrentBatch',
  async (_void, { getState, dispatch }) => {
    const batch = createSaveBatch(getState().stowage.cargo);
    dispatch(saveStarted(batch));
    const result = await saveBatchRequest(batch);
    if (result.ok) dispatch(saveSucceeded());
    else dispatch(saveFailed(result.error ?? '保存失败'));
  }
);

/** 重试上次失败的保存批次。 */
export const retrySave = createAsyncThunk<void, void, { state: RootState }>(
  'stowage/retrySave',
  async (_void, { getState, dispatch }) => {
    const batch = getState().stowage.pendingSaveBatch;
    if (!batch) return;
    dispatch(saveStarted({ ...batch, attempts: batch.attempts + 1, status: 'saving', lastError: null }));
    const result = await saveBatchRequest({ ...batch, attempts: batch.attempts + 1 });
    if (result.ok) dispatch(saveSucceeded());
    else dispatch(saveFailed(result.error ?? '保存失败'));
  }
);

/** 导入舱单：按提单号去重（重复沿用第一次），随后保存为一个批次。 */
export const importCargoAndSave = createAsyncThunk<void, Cargo[], { state: RootState }>(
  'stowage/importCargoAndSave',
  async (incoming, { getState, dispatch }) => {
    const prev = getState().stowage.cargo;
    const result = importManifest(prev, incoming);
    const affected = determineAffectedPorts(prev, result.imported);
    dispatch(importRecorded({ cargo: result.imported, duplicates: result.duplicates, added: result.added }));
    if (affected.length) dispatch(recalculateAffectedPorts(affected));
    // 导入后保存为一个批次（失败则保留待重试）
    const batch = createSaveBatch(result.imported);
    dispatch(saveStarted(batch));
    const saveResult = await saveBatchRequest(batch);
    if (saveResult.ok) dispatch(saveSucceeded());
    else dispatch(saveFailed(saveResult.error ?? '保存失败'));
  }
);

/** 断网恢复：合并两个终端的离线修改，货位不同则保留两份待选。 */
export const mergeOffline = createAsyncThunk<void, { changesA: OfflineChange[]; changesB: OfflineChange[] }, { state: RootState }>(
  'stowage/mergeOffline',
  async ({ changesA, changesB }, { getState, dispatch }) => {
    const base = getState().stowage.cargo;
    const result = mergeOfflineChanges(base, changesA, changesB);
    const affected = determineAffectedPorts(base, result.merged);
    dispatch(offlineMergeRecorded({ cargo: result.merged, conflicts: result.conflicts }));
    if (affected.length) dispatch(recalculateAffectedPorts(affected));
  }
);

const slice = createSlice({
  name: 'stowage',
  initialState: initialState as State,
  reducers: {
    selectCargo(state, action: PayloadAction<string>) { state.activeCargoId = action.payload; },
    /** 货票变化：更新工作副本，标记受影响港口结论为过期（重算中的不降级）。 */
    cargoMutated(state, action: PayloadAction<{ cargo: Cargo[]; affected: string[] }>) {
      state.cargo = action.payload.cargo;
      const conclusions = { ...state.snapshot.conclusions };
      action.payload.affected.forEach((port) => {
        const existing = conclusions[port];
        if (existing && existing.status === 'recalculating') return; // 重算中的等最新货票
        conclusions[port] = {
          port,
          status: 'stale',
          dischargeSequence: existing?.dischargeSequence ?? [],
          dgConflicts: existing?.dgConflicts ?? [],
          stability: existing?.stability ?? { weight: 0, moment: 0, margin: 0 },
          lashingReview: existing?.lashingReview ?? [],
          computedAt: existing?.computedAt ?? new Date().toISOString()
        };
      });
      state.snapshot = { ...state.snapshot, conclusions };
      state.draftSavedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    },
    portsRecalculating(state, action: PayloadAction<string[]>) {
      state.snapshot = markPortsRecalculating(state.snapshot, action.payload);
    },
    portsRecalculated(state, action: PayloadAction<Snapshot>) {
      state.snapshot = action.payload;
      state.planRevision = action.payload.revision;
      state.draftSavedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    },
    saveStarted(state, action: PayloadAction<SaveBatch>) {
      state.pendingSaveBatch = action.payload;
      state.saveStatus = 'saving';
    },
    saveSucceeded(state) {
      if (state.pendingSaveBatch) {
        state.pendingSaveBatch = { ...state.pendingSaveBatch, status: 'saved', attempts: state.pendingSaveBatch.attempts + 1, lastError: null };
      }
      state.saveStatus = 'saved';
    },
    saveFailed(state, action: PayloadAction<string>) {
      if (state.pendingSaveBatch) {
        state.pendingSaveBatch = { ...state.pendingSaveBatch, status: 'failed', attempts: state.pendingSaveBatch.attempts + 1, lastError: action.payload };
      }
      state.saveStatus = 'failed';
    },
    importRecorded(state, action: PayloadAction<{ cargo: Cargo[]; duplicates: string[]; added: string[] }>) {
      state.cargo = action.payload.cargo;
      state.lastImport = { duplicates: action.payload.duplicates, added: action.payload.added };
      state.draftSavedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    },
    offlineMergeRecorded(state, action: PayloadAction<{ cargo: Cargo[]; conflicts: ConflictPair[] }>) {
      state.cargo = action.payload.cargo;
      state.offlineConflicts = action.payload.conflicts;
      state.draftSavedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    },
    offlineConflictResolved(state, action: PayloadAction<{ bill: string; pick: 'first' | 'second' }>) {
      const conflict = state.offlineConflicts.find((item) => item.bill === action.payload.bill);
      if (!conflict) return;
      state.cargo = resolveConflict(state.cargo, conflict, action.payload.pick);
      state.offlineConflicts = state.offlineConflicts.filter((item) => item.bill !== action.payload.bill);
      const affected = determineAffectedPorts(state.snapshot.cargo, state.cargo);
      const conclusions = { ...state.snapshot.conclusions };
      affected.forEach((port) => {
        const existing = conclusions[port];
        conclusions[port] = {
          port,
          status: 'stale',
          dischargeSequence: existing?.dischargeSequence ?? [],
          dgConflicts: existing?.dgConflicts ?? [],
          stability: existing?.stability ?? { weight: 0, moment: 0, margin: 0 },
          lashingReview: existing?.lashingReview ?? [],
          computedAt: existing?.computedAt ?? new Date().toISOString()
        };
      });
      state.snapshot = { ...state.snapshot, conclusions };
    },
    addComment(state, action: PayloadAction<{ cargoId: string; author: string; role: StowageComment['role']; content: string }>) {
      state.comments.unshift({ ...action.payload, id: `CM-${Date.now()}`, status: '待确认' });
    },
    acceptComment(state, action: PayloadAction<string>) {
      const comment = state.comments.find((item) => item.id === action.payload);
      if (comment) comment.status = '已接受';
    },
    rejectComment(state, action: PayloadAction<string>) {
      const comment = state.comments.find((item) => item.id === action.payload);
      if (comment) comment.status = '已退回';
    },
    acceptLimit(state, action: PayloadAction<string>) {
      if (!state.acceptedLimits.includes(action.payload)) state.acceptedLimits.push(action.payload);
    },
    setViewMode(state, action: PayloadAction<'3d' | 'section'>) { state.viewMode = action.payload; },
    lockPlan(state) {
      // 重算未完成前不能锁定；快照锁定后不允许再放行旧图
      if (!canLockOrPrint(state.snapshot)) return;
      state.snapshot = { ...state.snapshot, locked: true };
      state.locked = true;
      state.planRevision += 1;
    }
  }
});

export const {
  selectCargo,
  cargoMutated,
  portsRecalculating,
  portsRecalculated,
  saveStarted,
  saveSucceeded,
  saveFailed,
  importRecorded,
  offlineMergeRecorded,
  offlineConflictResolved,
  addComment,
  acceptComment,
  rejectComment,
  acceptLimit,
  setViewMode,
  lockPlan
} = slice.actions;

/** 货票变化的统一入口：更新工作副本 → 判定受影响港口 → 触发增量重算。 */
function mutateCargo(getState: () => RootState, dispatch: AppDispatch, next: Cargo[]) {
  const prev = getState().stowage.cargo;
  const affected = determineAffectedPorts(prev, next);
  dispatch(cargoMutated({ cargo: next, affected }));
  if (affected.length) dispatch(recalculateAffectedPorts(affected));
}

export function moveCargo(id: string, bay: number, row: number, tier: number) {
  return (dispatch: AppDispatch, getState: () => RootState) => {
    const next = getState().stowage.cargo.map((item) => (item.id === id ? { ...item, bay, row, tier } : item));
    mutateCargo(getState, dispatch, next);
  };
}

export function updatePort(id: string, port: string) {
  return (dispatch: AppDispatch, getState: () => RootState) => {
    const next = getState().stowage.cargo.map((item) => (item.id === id ? { ...item, port } : item));
    mutateCargo(getState, dispatch, next);
  };
}

export function updateLashing(id: string, lashing: Cargo['lashing']) {
  return (dispatch: AppDispatch, getState: () => RootState) => {
    const next = getState().stowage.cargo.map((item) => (item.id === id ? { ...item, lashing } : item));
    mutateCargo(getState, dispatch, next);
  };
}

export const store = configureStore({
  reducer: { stowage: slice.reducer, [stowageApi.reducerPath]: stowageApi.reducer },
  middleware: (getDefault) => getDefault().concat(stowageApi.middleware)
});

store.subscribe(() => {
  if (typeof localStorage !== 'undefined') {
    const state = store.getState().stowage;
    // 持久化时剔除易失的快照结论与批次，避免旧结论覆盖新快照
    const { snapshot, pendingSaveBatch, ...persist } = state;
    void snapshot;
    void pendingSaveBatch;
    localStorage.setItem('yy62-stowage-plan', JSON.stringify(persist));
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

/** 快照是否仍为最新（货票与快照一致）。 */
export function snapshotIsCurrent(state: State): boolean {
  return isSnapshotCurrent(state.snapshot, state.cargo);
}

/** 是否存在未完成的港口结论（重算中 / 过期）。 */
export function snapshotPending(state: State): boolean {
  return hasPendingConclusion(state.snapshot);
}

export function calculateStability(cargo: Cargo[]) {
  const total = cargo.reduce((sum, item) => sum + item.weight, 0);
  const longitudinal = cargo.reduce((sum, item) => sum + item.weight * item.bay, 0) / Math.max(total, 1);
  const vertical = cargo.reduce((sum, item) => sum + item.weight * (item.tier + 1), 0) / Math.max(total, 1);
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

export function detectConflicts(cargo: Cargo[]) {
  const issues: { id: string; cargoId: string; level: 'high' | 'medium'; title: string; detail: string }[] = [];
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
