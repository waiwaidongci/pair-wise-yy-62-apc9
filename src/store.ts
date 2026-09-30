import { configureStore, createSlice, type Middleware, type PayloadAction } from '@reduxjs/toolkit';
import { stowageApi, type Cargo } from './api';
import { initialCargo } from './seed';
import {
  commitPatches,
  selectActiveSnapshot,
  selectGate,
  snapshotActions,
  snapshotSliceReducer
} from './snapshot/snapshotSlice';
import { calculateStability, detectConflicts } from './snapshot/adjudication';
import type { CargoPatch } from './snapshot/types';

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
};

const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('yy62-stowage-plan') : null;
const saved = raw ? JSON.parse(raw) as State : null;
const initialState: State = saved ?? {
  cargo: initialCargo.map((item) => ({ ...item })),
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
  draftSavedAt: '09:52'
};

const slice = createSlice({
  name: 'stowage',
  initialState,
  reducers: {
    selectCargo(state, action: PayloadAction<string>) { state.activeCargoId = action.payload; },
    moveCargo(state, action: PayloadAction<{ id: string; bay: number; row: number; tier: number }>) {
      const cargo = state.cargo.find((item) => item.id === action.payload.id);
      if (cargo) Object.assign(cargo, action.payload);
      state.planRevision += 1;
      state.draftSavedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    },
    updateLashing(state, action: PayloadAction<{ id: string; lashing: Cargo['lashing'] }>) {
      const cargo = state.cargo.find((item) => item.id === action.payload.id);
      if (cargo) cargo.lashing = action.payload.lashing;
    },
    /** 改卸货港（按提单号识别，影响旧港+新港结论） */
    changePort(state, action: PayloadAction<{ id: string; port: string }>) {
      const cargo = state.cargo.find((item) => item.id === action.payload.id);
      if (cargo) cargo.port = action.payload.port;
      state.planRevision += 1;
      state.draftSavedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    },
    /** 快照层重算/合并/切版本后，把权威货位与版本号回灌到可编辑草稿 */
    hydrateCargo(state, action: PayloadAction<{ cargo: Cargo[]; revision: number }>) {
      state.cargo = action.payload.cargo.map((item) => ({ ...item }));
      state.planRevision = action.payload.revision;
      state.draftSavedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    },
    setLocked(state, action: PayloadAction<boolean>) { state.locked = action.payload; },
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
    // 锁定只改状态；版本号以权威快照为准（由 bridge 回灌，避免双份版本号分叉）
    lockPlan(state) { state.locked = true; }
  }
});

export const {
  selectCargo, moveCargo, updateLashing, changePort, hydrateCargo, setLocked,
  addComment, acceptComment, rejectComment, acceptLimit, setViewMode, lockPlan
} = slice.actions;

/**
 * 桥接中间件：配载页的编辑经唯一入口 commitPatches 进入快照判定；
 * 快照重算/切换/合并后的权威货位回灌配载草稿。两层状态互不直接 import 对方 reducer。
 */
type BridgeState = {
  stowage: State;
  snapshot: ReturnType<typeof snapshotSliceReducer>;
};
const bridge: Middleware<{}, BridgeState> = (apiStore) => (next) => (action: unknown) => {
  const result = next(action);
  const a = action as { type?: string; payload?: unknown };
  if (typeof a.type !== 'string') return result;
  const root = apiStore.getState();

  // 配载页编辑 → 快照（锁定/断网时由闸门拦截）
  if (a.type.startsWith('stowage/')) {
    const name = a.type.slice('stowage/'.length);
    const gate = selectGate(root);
    if ((name === 'moveCargo' || name === 'updateLashing' || name === 'changePort') && gate.canEdit) {
      const stowageCargo = root.stowage.cargo;
      const patches: CargoPatch[] = [];
      if (name === 'moveCargo') {
        const p = a.payload as { id: string; bay: number; row: number; tier: number };
        const target = stowageCargo.find((item: Cargo) => item.id === p.id);
        if (target) patches.push({ bill: target.bill, bay: p.bay, row: p.row, tier: p.tier });
      } else if (name === 'updateLashing') {
        const p = a.payload as { id: string; lashing: Cargo['lashing'] };
        const target = stowageCargo.find((item: Cargo) => item.id === p.id);
        if (target) patches.push({ bill: target.bill, lashing: p.lashing });
      } else if (name === 'changePort') {
        const p = a.payload as { id: string; port: string };
        const target = stowageCargo.find((item: Cargo) => item.id === p.id);
        if (target) patches.push({ bill: target.bill, port: p.port });
      }
      if (patches.length) (apiStore.dispatch as (action: unknown) => unknown)(commitPatches({ patches, source: '配载工作区' }));
    }
    if (name === 'lockPlan' && selectGate(root).canLock) {
      apiStore.dispatch(snapshotActions.lockFromStowage());
    }
  }

  // 快照变更 → 回灌配载草稿（总览/对比/打印读的是同一份货位）
  if (a.type === 'snapshot/beginPatch' || a.type === 'snapshot/beginRotation'
    || a.type === 'snapshot/switchSnapshot' || a.type === 'snapshot/forkDraft') {
    const active = selectActiveSnapshot(apiStore.getState() as BridgeState);
    apiStore.dispatch(hydrateCargo({ cargo: active.cargo, revision: active.revision }));
  }
  if (a.type === 'snapshot/lockFromStowage') {
    apiStore.dispatch(setLocked(true));
  }
  if (a.type === 'snapshot/forkDraft') {
    apiStore.dispatch(setLocked(false));
  }

  return result;
};

export const store = configureStore({
  reducer: { stowage: slice.reducer, snapshot: snapshotSliceReducer, [stowageApi.reducerPath]: stowageApi.reducer },
  middleware: (getDefault) => getDefault().concat(stowageApi.middleware).concat(bridge)
});

store.subscribe(() => {
  if (typeof localStorage !== 'undefined') localStorage.setItem('yy62-stowage-plan', JSON.stringify(store.getState().stowage));
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// 原有页面继续从 store 引用全船校核函数（实现归快照判定模块）
export { calculateStability, detectConflicts };
