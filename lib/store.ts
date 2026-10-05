import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Severity = 'medium' | 'high' | 'critical';
export type Role = 'analyst' | 'responder' | 'legal' | 'viewer';
export type ActionKind = 'isolate' | 'block' | 'restore' | 'notify';
export type ActionStatus = 'review' | 'approving' | 'approved' | 'queued' | 'executing' | 'reconciling' | 'done' | 'void';

export const roleText: Record<Role, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
export const statusText: Record<ActionStatus, string> = { review: '待复核', approving: '待批·确认中', approved: '已批准', queued: '排队中', executing: '执行中', reconciling: '待对账', done: '已完成', void: '已作废' };
export const CONFIRM_TTL_MS = 2 * 60 * 1000; // 双人确认时限，超时作废
const RECEIPT_DELAY_MS = 8000; // 在线回执模拟时延
const ISOLATE_CONFIRMATIONS = 2; // 隔离需两个不同角色确认

export interface TimelineEvent { id: string; at: string; actor: string; text: string; sensitive?: boolean; }
export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }
export interface Confirmation { role: Role; at: string; }
export interface BlockRef { asset: string; actionId: string; actionTitle: string; }
export interface ResponseAction {
  id: string; title: string; kind: ActionKind; sensitive?: boolean;
  assets: string[]; // 目标资产
  confirmations: Confirmation[]; // 确认记录（隔离需两个不同角色）
  confirmDeadline: string | null; // 确认时限，超时作废
  status: ActionStatus;
  blockedBy: BlockRef[]; // 排队原因：被谁占住
  executedAssets: string[] | null; // 执行时资产快照，留原记录
  dispatchedAt: string | null;
  completedAt: string | null;
  voidReason: string | null;
}
export interface OccupancyEntry {
  id: string; asset: string; actionId: string; actionTitle: string;
  holder: Role; acquiredAt: string;
  releasedAt: string | null; releaseReason: 'done' | null;
}
export interface Incident {
  id: string; title: string; severity: Severity; status: 'investigating' | 'contained' | 'recovered';
  affected: string[]; subIncidents: SubIncident[]; actions: ResponseAction[]; timeline: TimelineEvent[];
}
interface State {
  incident: Incident;
  ledger: OccupancyEntry[]; // 占用账：资产 × 处置动作 × 值班角色
  role: Role;
  demoMode: boolean;
  online: boolean;
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  toggleOnline: () => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  confirmAction: (id: string) => void;
  executeAction: (id: string) => void;
  acknowledgeAction: (id: string) => void;
  restartAction: (id: string) => void;
  setAffected: (assets: string[]) => void;
  reorderActions: (activeId: string, overId: string) => void;
  sweep: () => void;
  tick: () => void;
}

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now()}-${seq++}`;
const nowIso = () => new Date().toISOString();
const note = (actor: string, text: string, sensitive?: boolean): TimelineEvent => ({ id: uid('e'), at: nowIso(), actor, text, sensitive });

// 占用账查询：资产当前被哪个动作占住
const holderOf = (ledger: OccupancyEntry[], asset: string, excludeActionId?: string) =>
  ledger.find((entry) => !entry.releasedAt && entry.asset === asset && entry.actionId !== excludeActionId) ?? null;

function blocksFor(ledger: OccupancyEntry[], action: ResponseAction): BlockRef[] {
  const seen = new Set<string>();
  const blocks: BlockRef[] = [];
  for (const asset of action.assets) {
    const holder = holderOf(ledger, asset, action.id);
    if (holder && !seen.has(asset)) { seen.add(asset); blocks.push({ asset, actionId: holder.actionId, actionTitle: holder.actionTitle }); }
  }
  return blocks;
}

// 释放动作的占用，并刷新排队动作：全部释放则回到已批准，否则更新被谁占住
function releaseAndPromote(ledger: OccupancyEntry[], actions: ResponseAction[], actionId: string, at: string, notes: TimelineEvent[]) {
  const nextLedger = ledger.map((entry) => entry.actionId === actionId && !entry.releasedAt ? { ...entry, releasedAt: at, releaseReason: 'done' as const } : entry);
  const nextActions = actions.map((action) => {
    if (action.status !== 'queued') return action;
    const blocks = blocksFor(nextLedger, action);
    if (blocks.length === 0) {
      notes.push(note('占用账', `排队解除：《${action.title}》等待的资产已释放，可以动手`, action.sensitive));
      return { ...action, status: 'approved' as ActionStatus, blockedBy: [] };
    }
    return { ...action, blockedBy: blocks };
  });
  return { ledger: nextLedger, actions: nextActions };
}

const blank = { confirmations: [] as Confirmation[], confirmDeadline: null, blockedBy: [] as BlockRef[], executedAssets: null, dispatchedAt: null, completedAt: null, voidReason: null };

const initial: Incident = {
  id: 'INC-2026-0929', title: '对外网关异常凭证使用', severity: 'critical', status: 'investigating', affected: ['api-gateway', 'customer-portal', 'audit-log'],
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', assets: ['api-gateway'], status: 'review', ...blank },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', assets: [], status: 'review', ...blank },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', sensitive: true, assets: [], status: 'review', ...blank },
    { id: 'act-4', title: '隔离网关热备节点', kind: 'isolate', assets: ['api-gateway'], status: 'review', ...blank }
  ],
  timeline: [
    { id: 'e1', at: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
    { id: 'e2', at: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
  ]
};

// 影响资产一变即失效的状态（已执行的留原记录，不在其列）
const PRE_EXECUTION: ActionStatus[] = ['approving', 'approved', 'queued'];

export const useIncidentStore = create<State>()(persist((set, get) => ({
  incident: initial, ledger: [], role: 'analyst', demoMode: false, online: true,
  setRole: (role) => set({ role }),
  toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
  toggleOnline: () => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    if (state.online) {
      const stuck = state.incident.actions.filter((a) => a.status === 'executing').length;
      set((s) => ({ online: false, incident: { ...s.incident, actions: s.incident.actions.map((a) => a.status === 'executing' ? { ...a, status: 'reconciling' as ActionStatus } : a), timeline: [note('网络通道', `连接中断：回执不可达，${stuck} 条执行中动作转入待对账`), ...s.incident.timeline] } }));
    } else {
      const pending = state.incident.actions.filter((a) => a.status === 'reconciling').length;
      set((s) => ({ online: true, incident: { ...s.incident, timeline: [note('网络通道', `连接恢复：先对账，${pending} 条回执待确认，认了才算执行完`), ...s.incident.timeline] } }));
    }
  },
  addSubIncident: (payload) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    set((s) => ({ incident: { ...s.incident, subIncidents: [...s.incident.subIncidents, { id: uid('sub'), ...payload, status: 'open' }], timeline: [note(roleText[state.role], `创建子事件：${payload.title}`), ...s.incident.timeline] } }));
  },
  confirmAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((a) => a.id === id);
    if (!action || (action.status !== 'review' && action.status !== 'approving')) return;
    if (action.confirmations.some((c) => c.role === state.role)) return; // 同一角色不能重复确认
    const needed = action.kind === 'isolate' ? ISOLATE_CONFIRMATIONS : 1;
    const confirmations: Confirmation[] = [...action.confirmations, { role: state.role, at: nowIso() }];
    const complete = confirmations.length >= needed;
    // 隔离：首次确认起算时限，双人确认超时就作废
    const confirmDeadline = !complete && action.kind === 'isolate' ? new Date(Date.now() + CONFIRM_TTL_MS).toISOString() : null;
    set((s) => ({ incident: { ...s.incident,
      actions: s.incident.actions.map((a) => a.id === id ? { ...a, confirmations, status: complete ? 'approved' as ActionStatus : 'approving' as ActionStatus, confirmDeadline } : a),
      timeline: [note(roleText[state.role], complete ? `确认完成：《${action.title}》已批准，等待动手` : `已确认：《${action.title}》（${confirmations.length}/${needed}），还需不同角色在时限内确认`, action.sensitive), ...s.incident.timeline] } }));
  },
  executeAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((a) => a.id === id);
    if (!action || action.status !== 'approved') return;
    const at = nowIso();
    // 占用账：同一资产只留一个执行中的隔离，后到的排队并写明被谁占住
    if (action.kind === 'isolate') {
      const blocks = blocksFor(state.ledger, action);
      if (blocks.length > 0) {
        set((s) => ({ incident: { ...s.incident, actions: s.incident.actions.map((a) => a.id === id ? { ...a, status: 'queued' as ActionStatus, blockedBy: blocks } : a), timeline: [note('占用账', `《${action.title}》排队：${blocks.map((b) => `${b.asset} 被《${b.actionTitle}》占住`).join('；')}`, action.sensitive), ...s.incident.timeline] } }));
        return;
      }
    }
    const entries: OccupancyEntry[] = action.kind === 'isolate' ? action.assets.map((asset) => ({ id: uid('occ'), asset, actionId: action.id, actionTitle: action.title, holder: state.role, acquiredAt: at, releasedAt: null, releaseReason: null })) : [];
    // 断网后回执收不到：下发即转入待对账
    const nextStatus: ActionStatus = state.online ? 'executing' : 'reconciling';
    set((s) => ({ ledger: [...entries, ...s.ledger], incident: { ...s.incident,
      actions: s.incident.actions.map((a) => a.id === id ? { ...a, status: nextStatus, dispatchedAt: at, executedAssets: [...a.assets] } : a),
      timeline: [note(roleText[state.role], state.online ? `执行处置动作：《${action.title}》${entries.length ? `，占住 ${entries.map((e) => e.asset).join('、')}` : ''}` : `已下发：《${action.title}》，当前断网回执不可达，转入待对账`, action.sensitive), ...s.incident.timeline] } }));
  },
  acknowledgeAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer' || !state.online) return;
    const action = state.incident.actions.find((a) => a.id === id);
    if (!action || action.status !== 'reconciling') return;
    const at = nowIso();
    const notes = [note(roleText[state.role], `对账确认：《${action.title}》回执已认，执行完成`, action.sensitive)];
    const done = state.incident.actions.map((a) => a.id === id ? { ...a, status: 'done' as ActionStatus, completedAt: at } : a);
    const { ledger, actions } = releaseAndPromote(state.ledger, done, id, at, notes);
    set({ ledger, incident: { ...state.incident, actions, timeline: [...notes, ...state.incident.timeline] } });
  },
  restartAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((a) => a.id === id);
    if (!action || action.status !== 'void') return;
    set((s) => ({ incident: { ...s.incident, actions: s.incident.actions.map((a) => a.id === id ? { ...a, status: 'review' as ActionStatus, confirmations: [], confirmDeadline: null, blockedBy: [], voidReason: null } : a), timeline: [note(roleText[state.role], `重新发起：《${action.title}》退回待复核，需重新确认`, action.sensitive), ...s.incident.timeline] } }));
  },
  setAffected: (assets) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const clean = [...new Set(assets.map((a) => a.trim()).filter(Boolean))];
    if (clean.length === 0) return;
    if (clean.length === state.incident.affected.length && clean.every((a) => state.incident.affected.includes(a))) return;
    const invalidated = state.incident.actions.filter((a) => PRE_EXECUTION.includes(a.status));
    set((s) => ({ incident: { ...s.incident, affected: clean,
      actions: s.incident.actions.map((a) => PRE_EXECUTION.includes(a.status) ? { ...a, status: 'review' as ActionStatus, confirmations: [], confirmDeadline: null, blockedBy: [], voidReason: null } : a),
      timeline: [note('影响范围', `影响资产变更为 ${clean.join('、')}；${invalidated.length ? `${invalidated.length} 条待批动作失效退回待复核（${invalidated.map((a) => a.title).join('、')}），已执行动作保留原记录` : '无待批动作受影响'}`), ...s.incident.timeline] } }));
  },
  reorderActions: (activeId, overId) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const actions = [...state.incident.actions];
    const from = actions.findIndex((item) => item.id === activeId);
    const to = actions.findIndex((item) => item.id === overId);
    if (from < 0 || to < 0) return;
    const [moved] = actions.splice(from, 1);
    actions.splice(to, 0, moved);
    set({ incident: { ...state.incident, actions } });
  },
  // 周期巡检：确认超时作废、在线回执到达、排队解除
  sweep: () => {
    const state = get();
    if (state.demoMode) return;
    const at = nowIso();
    const notes: TimelineEvent[] = [];
    let actions = state.incident.actions.map((a) => {
      if (a.kind === 'isolate' && a.status === 'approving' && a.confirmDeadline && a.confirmDeadline <= at) {
        notes.push(note('占用账', `确认超时作废：《${a.title}》双人确认未在时限内完成，需重新发起`, a.sensitive));
        return { ...a, status: 'void' as ActionStatus, voidReason: '双人确认超过时限', confirmDeadline: null };
      }
      return a;
    });
    let ledger = state.ledger;
    if (state.online) {
      const nowMs = Date.now();
      for (const fin of actions.filter((a) => a.status === 'executing' && a.dispatchedAt && nowMs - new Date(a.dispatchedAt).getTime() >= RECEIPT_DELAY_MS)) {
        notes.push(note('监测代理', `回执到达：《${fin.title}》执行完成`, fin.sensitive));
        actions = actions.map((a) => a.id === fin.id ? { ...a, status: 'done' as ActionStatus, completedAt: at } : a);
        const released = releaseAndPromote(ledger, actions, fin.id, at, notes);
        ledger = released.ledger;
        actions = released.actions;
      }
    }
    if (notes.length === 0) return;
    set({ ledger, incident: { ...state.incident, actions, timeline: [...notes, ...state.incident.timeline].slice(0, 40) } });
  },
  tick: () => set((state) => ({ incident: { ...state.incident, timeline: [note('监测代理', `实时检查：${state.incident.affected.length} 项资产状态已更新`), ...state.incident.timeline].slice(0, 40) } }))
}), {
  name: 'yf56-incident-store',
  version: 2,
  migrate: (persisted, version) => {
    if (version >= 2) return persisted as State;
    const old = persisted as { incident?: Omit<Partial<Incident>, 'actions'> & { actions?: Array<Record<string, unknown>> }; role?: Role; demoMode?: boolean };
    const actions: ResponseAction[] = (old.incident?.actions ?? []).map((a) => ({
      ...blank,
      id: String(a.id), title: String(a.title), kind: a.kind as ActionKind, sensitive: Boolean(a.sensitive),
      assets: Array.isArray(a.assets) ? (a.assets as string[]) : [],
      confirmations: Array.isArray(a.approvals) ? (a.approvals as string[]).filter((r): r is Role => r in roleText).map((r) => ({ role: r, at: nowIso() })) : [],
      status: (a.status === 'approved' ? 'approved' : a.status === 'executed' ? 'done' : 'review') as ActionStatus,
      executedAssets: a.status === 'executed' ? [] : null,
      completedAt: a.status === 'executed' ? nowIso() : null
    }));
    return { incident: { ...initial, ...old.incident, actions }, ledger: [], online: true, role: old.role ?? 'analyst', demoMode: Boolean(old.demoMode) } as unknown as State;
  }
}));
