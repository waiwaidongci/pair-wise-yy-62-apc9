import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Cargo } from '../api';
import { initialCargo, initialRotation, initialRotationVersion } from '../seed';
import {
  affectedPorts,
  applyPatches,
  bootConclusions,
  buildGate,
  bumpRotationVersion,
  detectConflicts,
  recomputePort,
  type Gate
} from './adjudication';
import { foldTerminalEdit, mergeEdits } from './merge';
import { presetBatches, retryImportBatch, submitImportBatch } from './gateway';
import type {
  ActivityLogEntry,
  CargoPatch,
  ImportBatch,
  MergeSummary,
  OfflineConflict,
  PortConclusion,
  StowageSnapshot,
  TerminalEdits
} from './types';

const now = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

function bootSnapshot(): StowageSnapshot {
  return {
    id: 'SS-2609-05',
    revision: 5,
    label: 'V5 工作快照',
    createdAt: now(),
    rotation: [...initialRotation],
    rotationVersion: initialRotationVersion,
    locked: false,
    cargo: initialCargo.map((item) => ({ ...item })),
    conclusions: bootConclusions(initialCargo, initialRotation),
    origin: '工作快照'
  };
}

type SnapshotState = {
  rotationVersion: string;
  snapshots: StowageSnapshot[];
  activeId: string;
  /** 每个港口进行中的重算令牌（用于丢弃过期结果） */
  recomputeTokens: Record<string, number>;
  batches: ImportBatch[];
  seenBatchIds: Record<string, { duplicate: boolean }>;
  offline: boolean;
  terminals: TerminalEdits[];
  conflicts: OfflineConflict[];
  lastMerge: MergeSummary | null;
  log: ActivityLogEntry[];
};

let logSeq = 0;
function log(message: string, tone: ActivityLogEntry['tone'] = 'info'): ActivityLogEntry {
  logSeq += 1;
  return { id: logSeq, at: now(), message, tone };
}

const initialState: SnapshotState = {
  rotationVersion: initialRotationVersion,
  snapshots: [bootSnapshot()],
  activeId: 'SS-2609-05',
  recomputeTokens: {},
  batches: [],
  seenBatchIds: {},
  offline: false,
  terminals: [],
  conflicts: [],
  lastMerge: null,
  log: [log('配载快照 SS-2609-05 建立：货位、卸货港与绑扎复核已挂接同一份快照', 'ok')]
};

/** 受影响港口标记为重算中，异步完成后按令牌确认（模拟校核耗时） */
export const commitPatches = createAsyncThunk(
  'snapshot/commitPatches',
  async (arg: { patches: CargoPatch[]; source: string }, { dispatch, getState }) => {
    const state = (getState() as RootState).snapshot;
    const active = state.snapshots.find((item) => item.id === state.activeId);
    if (!active) return;
    const ports = affectedPorts(active.cargo, arg.patches);
    const tokens = ports.map((port) => ({ port, token: (state.recomputeTokens[port] ?? 0) + 1 }));
    dispatch(snapshotActions.beginPatch({ patches: arg.patches, ports, tokens, source: arg.source }));
    await new Promise((resolve) => setTimeout(resolve, 850));
    const after = (getState() as RootState).snapshot;
    const current = after.snapshots.find((item) => item.id === after.activeId);
    if (!current) return;
    const conclusions = tokens
      .filter(({ port, token }) => (after.recomputeTokens[port] ?? 0) === token)
      .map(({ port }) => recomputePort(current.cargo, current.rotation, port));
    dispatch(snapshotActions.finishRecompute({ conclusions }));
  }
);

/** 改靠港顺序：旧快照保留，另建改港快照，全部卸货港结论重算 */
export const changeRotation = createAsyncThunk(
  'snapshot/changeRotation',
  async (rotation: string[], { dispatch, getState }) => {
    const state = (getState() as RootState).snapshot;
    const active = state.snapshots.find((item) => item.id === state.activeId);
    if (!active) return;
    const version = bumpRotationVersion(state.rotationVersion);
    const ports = rotation.slice(1);
    dispatch(snapshotActions.beginRotation({ rotation, version, ports }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = (getState() as RootState).snapshot;
    const current = after.snapshots.find((item) => item.id === after.activeId);
    if (!current || current.rotationVersion !== version) return;
    const conclusions = ports.map((port) => recomputePort(current.cargo, current.rotation, port));
    dispatch(snapshotActions.finishRecompute({ conclusions }));
  }
);

/** 请求入口：码头批次导入（幂等 / 失败保留由 gateway 与本 thunk 共同保证） */
export const submitBatch = createAsyncThunk(
  'snapshot/submitBatch',
  async (batch: ImportBatch, { dispatch, getState }) => {
    const state = (getState() as RootState).snapshot;
    const seen = new Map(Object.entries(state.seenBatchIds));
    const result = await submitImportBatch(batch, seen);
    if (result.ok) {
      dispatch(snapshotActions.batchSaved({
        batchId: batch.batchId,
        savedAt: result.savedAt,
        duplicate: result.duplicate,
        source: `${batch.terminal}批次 ${batch.batchId}`
      }));
      if (!result.duplicate) {
        // 保存落定后才改快照；受影响港口进入重算
        dispatch(commitPatches({ patches: batch.patches, source: `${batch.terminal}批次 ${batch.batchId}` }));
      }
    } else {
      dispatch(snapshotActions.batchFailed({ batchId: batch.batchId, reason: result.reason }));
    }
  }
);

/** 失败批次重试：原批次内容不动，重走同一请求入口 */
export const retryBatch = createAsyncThunk(
  'snapshot/retryBatch',
  async (batchId: string, { dispatch, getState }) => {
    const state = (getState() as RootState).snapshot;
    const batch = state.batches.find((item) => item.batchId === batchId);
    if (!batch) return;
    dispatch(snapshotActions.batchRetrying(batchId));
    const seen = new Map(Object.entries(state.seenBatchIds));
    const result = await retryImportBatch(batch, seen);
    if (result.ok) {
      dispatch(snapshotActions.batchSaved({
        batchId,
        savedAt: result.savedAt,
        duplicate: result.duplicate,
        source: `${batch.terminal}批次 ${batchId} 重试`
      }));
      dispatch(commitPatches({ patches: batch.patches, source: `${batch.terminal}批次 ${batchId} 重试成功` }));
    } else {
      dispatch(snapshotActions.batchFailed({ batchId, reason: result.reason }));
    }
  }
);

/** 断网：登记两个离线终端 */
export const goOffline = createAsyncThunk(
  'snapshot/goOffline',
  async (_, { dispatch }) => {
    dispatch(snapshotActions.offlineStarted({ at: now() }));
  }
);

/** 离线期间某终端编辑（按提单号在终端内折叠，后写覆盖先写） */
export const offlineEdit = createAsyncThunk(
  'snapshot/offlineEdit',
  async (arg: { terminal: string; patch: CargoPatch }, { dispatch }) => {
    dispatch(snapshotActions.terminalEdited(arg));
  }
);

/** 恢复联网：按提单号三路合并，货位不同保留两份待选 */
export const reconnect = createAsyncThunk(
  'snapshot/reconnect',
  async (_, { dispatch, getState }) => {
    const state = (getState() as RootState).snapshot;
    const active = state.snapshots.find((item) => item.id === state.activeId);
    if (!active || state.terminals.length === 0) {
      dispatch(snapshotActions.offlineEnded({ summary: null }));
      return;
    }
    const [a, b] = state.terminals;
    const lockedBills = new Set<string>();
    state.snapshots.filter((item) => item.locked).forEach((item) => item.cargo.forEach((cargo) => lockedBills.add(cargo.bill)));
    const summary = mergeEdits(active.cargo, a, b, lockedBills);
    summary.baseRevision = active.revision;
    dispatch(snapshotActions.offlineEnded({ summary }));
    if (summary.applied.length) {
      const appliedPatches: CargoPatch[] = [];
      state.terminals.forEach((terminal) => {
        terminal.edits.forEach((patch) => {
          if (summary.applied.includes(patch.bill)) appliedPatches.push(patch);
        });
      });
      const unique = dedupePatches(appliedPatches);
      dispatch(commitPatches({ patches: unique, source: `离线合并自动采用 ${unique.map((item) => item.bill).join('、')}` }));
    }
  }
);

function dedupePatches(patches: CargoPatch[]): CargoPatch[] {
  const map = new Map<string, CargoPatch>();
  patches.forEach((patch) => map.set(patch.bill, { ...map.get(patch.bill), ...patch }));
  return [...map.values()];
}

const slice = createSlice({
  name: 'snapshot',
  initialState,
  reducers: {
    beginPatch(state, action: PayloadAction<{ patches: CargoPatch[]; ports: string[]; tokens: { port: string; token: number }[]; source: string }>) {
      const active = state.snapshots.find((item) => item.id === state.activeId);
      if (!active || active.locked) return;
      active.cargo = applyPatches(active.cargo, action.payload.patches);
      active.revision += 1;
      active.label = `V${active.revision} 工作快照`;
      active.createdAt = now();
      action.payload.tokens.forEach(({ port, token }) => { state.recomputeTokens[port] = token; });
      active.conclusions = markRecalculating(active.conclusions, action.payload.ports);
      state.log.unshift(log(`${action.payload.source}：按提单号写入 ${action.payload.patches.map((item) => item.bill).join('、')}，仅重算 ${action.payload.ports.join('、')}`, 'info'));
      trimLog(state);
    },
    finishRecompute(state, action: PayloadAction<{ conclusions: PortConclusion[] }>) {
      const active = state.snapshots.find((item) => item.id === state.activeId);
      if (!active) return;
      const byPort = new Map(action.payload.conclusions.map((item) => [item.port, item]));
      active.conclusions = active.conclusions.map((item) => byPort.get(item.port) ?? item);
      if (action.payload.conclusions.length) {
        state.log.unshift(log(`${[...byPort.keys()].join('、')} 卸货顺序 / 危险品隔离 / 稳性裕度 / 绑扎复核重算完成`, 'ok'));
        trimLog(state);
      }
    },
    beginRotation(state, action: PayloadAction<{ rotation: string[]; version: string; ports: string[] }>) {
      const previous = state.snapshots.find((item) => item.id === state.activeId);
      if (!previous) return;
      state.rotationVersion = action.payload.version;
      const draft: StowageSnapshot = {
        ...previous,
        id: `SS-2609-${Date.now().toString().slice(-5)}`,
        revision: previous.revision + 1,
        label: `V${previous.revision + 1} 改港快照`,
        createdAt: now(),
        rotation: action.payload.rotation,
        rotationVersion: action.payload.version,
        locked: false,
        cargo: previous.cargo.map((item) => ({ ...item })),
        conclusions: action.payload.ports.map((port) => blankConclusion(port)),
        origin: '改港快照'
      };
      state.snapshots.unshift(draft);
      state.activeId = draft.id;
      action.payload.ports.forEach((port) => { state.recomputeTokens[port] = (state.recomputeTokens[port] ?? 0) + 1; });
      state.log.unshift(log(`靠港顺序调整为 ${action.payload.rotation.join(' → ')}（顺序版本 ${action.payload.version}），旧快照保留，改港快照重算中`, 'warn'));
      trimLog(state);
    },
    switchSnapshot(state, action: PayloadAction<string>) {
      const target = state.snapshots.find((item) => item.id === action.payload);
      if (!target) return;
      state.activeId = target.id;
      state.log.unshift(log(`切换查看 ${target.label}（${target.rotationVersion}）${target.locked ? ' · 锁定只读' : ''}`, 'info'));
      trimLog(state);
    },
    lockFromStowage(state) {
      const active = state.snapshots.find((item) => item.id === state.activeId);
      if (!active || active.locked) return;
      active.locked = true;
      active.origin = '锁定副本';
      active.label = `V${active.revision} 锁定版本`;
      state.log.unshift(log(`${active.label} 已锁定：货位、卸货港、绑扎结论固化，后续修改不得覆盖本版本`, 'ok'));
      trimLog(state);
    },
    forkDraft(state) {
      const locked = state.snapshots.find((item) => item.id === state.activeId);
      if (!locked) return;
      const draft: StowageSnapshot = {
        ...locked,
        id: `SS-2609-${Date.now().toString().slice(-5)}`,
        revision: locked.revision + 1,
        label: `V${locked.revision + 1} 工作快照`,
        createdAt: now(),
        locked: false,
        cargo: locked.cargo.map((item) => ({ ...item })),
        conclusions: locked.conclusions.map((item) => ({ ...item })),
        origin: '工作快照'
      };
      state.snapshots.unshift(draft);
      state.activeId = draft.id;
      state.log.unshift(log(`基于 ${locked.label} 另立 V${draft.revision} 工作草稿，锁定版本继续保留`, 'info'));
      trimLog(state);
    },
    queuePresetBatches(state) {
      if (state.batches.length) return;
      state.batches = presetBatches();
      state.log.unshift(log('两码头各有一批货位调整待导入，进入请求入口队列（含一批模拟失败批次）', 'info'));
      trimLog(state);
    },
    batchRetrying(state, action: PayloadAction<string>) {
      const batch = state.batches.find((item) => item.batchId === action.payload);
      if (batch) {
        batch.status = 'saving';
        batch.note = '原批次保留，正在重试…';
      }
    },
    batchSaved(state, action: PayloadAction<{ batchId: string; savedAt: string; duplicate: boolean; source: string }>) {
      const batch = state.batches.find((item) => item.batchId === action.payload.batchId);
      const first = !state.seenBatchIds[action.payload.batchId];
      state.seenBatchIds[action.payload.batchId] = { duplicate: !first };
      if (batch) {
        batch.status = 'saved';
        batch.savedAt = action.payload.savedAt;
        batch.duplicate = action.payload.duplicate;
        batch.note = action.payload.duplicate ? '重复导入：沿用第一次结果，未重复写入' : '保存成功';
      }
      state.log.unshift(log(`批次 ${action.payload.batchId} ${action.payload.duplicate ? '为重复导入，沿用第一次结果' : '保存成功，已写入快照'}`, action.payload.duplicate ? 'info' : 'ok'));
      trimLog(state);
    },
    batchFailed(state, action: PayloadAction<{ batchId: string; reason: string }>) {
      const batch = state.batches.find((item) => item.batchId === action.payload.batchId);
      if (batch) {
        batch.status = 'failed';
        batch.note = `保存失败：${action.payload.reason}，原批次保留待重试`;
      }
      state.log.unshift(log(`批次 ${action.payload.batchId} 保存失败：${action.payload.reason}。原批次保留待重试，快照未被改动`, 'warn'));
      trimLog(state);
    },
    offlineStarted(state, action: PayloadAction<{ at: string }>) {
      state.offline = true;
      state.terminals = [
        { terminal: '终端A · 船长站', startedAt: action.payload.at, edits: [] },
        { terminal: '终端B · 码头站', startedAt: action.payload.at, edits: [] }
      ];
      state.log.unshift(log('进入断网编辑：两个终端可各自按提单号调整，恢复后按提单号合并；锁定版本不会被覆盖', 'warn'));
      trimLog(state);
    },
    terminalEdited(state, action: PayloadAction<{ terminal: string; patch: CargoPatch }>) {
      const terminal = state.terminals.find((item) => item.terminal === action.payload.terminal);
      if (!terminal) return;
      terminal.edits = foldTerminalEdit(terminal.edits, action.payload.patch);
    },
    offlineEnded(state, action: PayloadAction<{ summary: MergeSummary | null }>) {
      state.offline = false;
      state.terminals = [];
      state.lastMerge = action.payload.summary;
      if (action.payload.summary) {
        state.conflicts = [...action.payload.summary.conflicts, ...state.conflicts];
        state.log.unshift(log(`联网恢复并完成按提单号合并：自动采用 ${action.payload.summary.applied.length} 票，${action.payload.summary.conflicts.length} 票货位不同，保留两份待选`, action.payload.summary.conflicts.length ? 'warn' : 'ok'));
        trimLog(state);
      }
    },
    resolveConflict(state, action: PayloadAction<{ id: string; choice: 'a' | 'b' | 'locked' }>) {
      const conflict = state.conflicts.find((item) => item.id === action.payload.id);
      if (!conflict || conflict.status !== '待选') return;
      conflict.status = action.payload.choice === 'a' ? '已选A' : action.payload.choice === 'b' ? '已选B' : '已选锁定版';
    },
    dismissConflict(state, action: PayloadAction<string>) {
      const conflict = state.conflicts.find((item) => item.id === action.payload);
      if (conflict) {
        conflict.status = conflict.status === '待选' ? '已选A' : conflict.status;
        state.conflicts = state.conflicts.filter((item) => item.id !== action.payload);
        state.log.unshift(log(`冲突 ${conflict.bill} 已搁置，两份候选均未写入`, 'info'));
        trimLog(state);
      }
    }
  }
});

function blankConclusion(port: string): PortConclusion {
  return { port, status: 'recalculating', dischargeOrder: [], hazmat: { status: 'ok', detail: '重算中…' }, stabilityMargin: 0, lashing: { pendingBills: [], detail: '重算中…' }, fingerprint: '', recalculatedAt: '' };
}

function markRecalculating(conclusions: PortConclusion[], ports: string[]): PortConclusion[] {
  return conclusions.map((item) => ports.includes(item.port)
    ? { ...item, status: 'recalculating', hazmat: { ...item.hazmat, detail: '货位或卸货港变化，重算中…' }, lashing: { ...item.lashing, detail: '重算中…' } }
    : item);
}

function trimLog(state: SnapshotState) {
  state.log = state.log.slice(0, 14);
}

export const snapshotSliceReducer = slice.reducer;
export const snapshotActions = slice.actions;

type RootState = { snapshot: SnapshotState };

/* ---------- 选择器 ---------- */

export const selectActiveSnapshot = (root: RootState): StowageSnapshot =>
  root.snapshot.snapshots.find((item) => item.id === root.snapshot.activeId) ?? root.snapshot.snapshots[0];

export const selectSnapshotState = (root: RootState) => root.snapshot;

export const selectGate = (root: RootState): Gate => {
  const state = root.snapshot;
  const active = selectActiveSnapshot(root);
  return buildGate({
    snapshot: active,
    currentRotationVersion: state.rotationVersion,
    offline: state.offline,
    hasSavingBatches: state.batches.some((item) => item.status === 'saving'),
    hasFailedBatches: state.batches.some((item) => item.status === 'failed'),
    pendingConflicts: state.conflicts.filter((item) => item.status === '待选').length,
    conflicts: detectConflicts(active.cargo)
  });
};
