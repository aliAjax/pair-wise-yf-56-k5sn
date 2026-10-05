import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Role = 'analyst' | 'responder' | 'legal' | 'viewer';
export type Severity = 'medium' | 'high' | 'critical';
export type ActionKind = 'isolate' | 'block' | 'restore' | 'notify';
export type ActionStatus = 'pending' | 'approved' | 'queued' | 'executing' | 'executed';

export interface TimelineEvent { id: string; at: string; actor: string; text: string; sensitive?: boolean; }
export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }
export interface ResponseAction {
  id: string;
  title: string;
  kind: ActionKind;
  /** 处置动作指向的资产；占用账按这些资产判定 */
  targetAssets: string[];
  approvals: Role[];
  status: ActionStatus;
  sensitive?: boolean;
  /** 双人确认时限：首个确认到达后计时，超时未齐两人则作废重来 */
  approvalDeadline?: string;
  /** 被哪个动作占住（占用账） */
  queuedBy?: string;
  queuedReason?: string;
  /** 断网执行：回执状态；恢复后对账，认了才算执行完 */
  receipt?: 'pending' | 'acknowledged' | 'lost';
  /** 已执行的隔离在恢复动作执行后解除占用，但原记录保留 */
  released?: boolean;
  executedAt?: string;
  /** 影响资产变更后，待批动作失效退回待复核 */
  invalidated?: boolean;
  invalidatedReason?: string;
}
export interface Incident {
  id: string; title: string; severity: Severity; status: 'investigating' | 'contained' | 'recovered'; affected: string[];
  subIncidents: SubIncident[]; actions: ResponseAction[]; timeline: TimelineEvent[];
}
interface State {
  incident: Incident;
  role: Role;
  demoMode: boolean;
  online: boolean;
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  toggleNetwork: () => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  addAsset: (asset: string) => void;
  removeAsset: (asset: string) => void;
  approveAction: (id: string) => void;
  executeAction: (id: string) => void;
  reconcile: () => void;
  reorderActions: (activeId: string, overId: string) => void;
  tick: () => void;
}

export const APPROVAL_WINDOW_MS = 5 * 60 * 1000;
export const roleLabel: Record<Role, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
export const kindLabel: Record<ActionKind, string> = { isolate: '隔离', block: '封禁', restore: '恢复', notify: '通知' };

/** 隔离/封禁属高风险处置，需两个不同角色确认 */
export const needsTwoApprovals = (action: ResponseAction) => action.kind === 'isolate' || action.kind === 'block';

/** 动作当前是否占住某资产：已批准待执行 / 执行中 / 已执行且未解除的隔离封禁 */
export function occupiesAsset(action: ResponseAction, asset: string): boolean {
  return (action.kind === 'isolate' || action.kind === 'block')
    && (action.status === 'approved' || action.status === 'executing' || action.status === 'executed')
    && !action.released
    && (action.targetAssets ?? []).includes(asset);
}

/** 找到占住该动作任一目标资产的其它动作（占用账：后到排队，写明被谁占住） */
export function findOccupier(action: ResponseAction, actions: ResponseAction[]): ResponseAction | undefined {
  const targets = action.targetAssets ?? [];
  return actions.find((other) => other.id !== action.id && targets.some((asset) => occupiesAsset(other, asset)));
}

/** 恢复动作执行后，解除目标资产上仍占住的隔离/封禁；已执行的原记录保留，仅标记 released */
function releaseAssets(actions: ResponseAction[], assets: string[]): ResponseAction[] {
  return actions.map((item) => {
    if (item.released || item.kind !== 'isolate' && item.kind !== 'block') return item;
    if (item.status !== 'executed' && item.status !== 'approved' && item.status !== 'executing') return item;
    if (!(item.targetAssets ?? []).some((asset) => assets.includes(asset))) return item;
    return { ...item, released: true };
  });
}

/** 影响资产一变，待批动作（待审批 / 已批准待执行 / 排队中）失效退回待复核；执行中与已执行留原记录 */
function invalidatePending(actions: ResponseAction[], reason: string): ResponseAction[] {
  return actions.map((item) => {
    if (item.status !== 'pending' && item.status !== 'approved' && item.status !== 'queued') return item;
    return { ...item, status: 'pending', approvals: [], approvalDeadline: undefined, queuedBy: undefined, queuedReason: undefined, invalidated: true, invalidatedReason: reason };
  });
}

/** 恢复后对账：执行中的动作由监测代理认账，认了才算执行完；未认的回执丢失，退回已批准待重新下发 */
function runReconcile(actions: ResponseAction[]): { actions: ResponseAction[]; entries: TimelineEvent[] } {
  let next = [...actions];
  const entries: TimelineEvent[] = [];
  for (const action of actions.filter((item) => item.status === 'executing')) {
    const acknowledged = Math.random() < 0.75;
    if (acknowledged) {
      next = next.map((item) => item.id === action.id ? { ...item, status: 'executed', receipt: 'acknowledged', executedAt: new Date().toISOString() } : item);
      entries.push({ id: `e-${Date.now()}-${action.id}`, at: new Date().toISOString(), actor: '响应负责人', text: `对账确认：${action.title} 已执行，回执已认`, sensitive: action.sensitive });
      if (action.kind === 'restore') next = releaseAssets(next, action.targetAssets ?? []);
    } else {
      next = next.map((item) => item.id === action.id ? { ...item, status: 'approved', receipt: 'lost' } : item);
      entries.push({ id: `e-${Date.now()}-${action.id}`, at: new Date().toISOString(), actor: '响应负责人', text: `对账未确认：${action.title} 回执丢失、未执行，需重新下发`, sensitive: action.sensitive });
    }
  }
  return { actions: next, entries };
}

const initial: Incident = {
  id: 'INC-2026-0929', title: '对外网关异常凭证使用', severity: 'critical', status: 'investigating', affected: ['api-gateway', 'customer-portal', 'audit-log', 'egress-ip'],
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', targetAssets: ['api-gateway'], approvals: ['analyst'], status: 'pending', sensitive: true, approvalDeadline: new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString() },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', targetAssets: ['egress-ip'], approvals: [], status: 'pending' },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', targetAssets: [], approvals: ['legal'], status: 'pending', sensitive: true },
    { id: 'act-4', title: '隔离备用网关节点', kind: 'isolate', targetAssets: ['api-gateway'], approvals: [], status: 'pending' },
    { id: 'act-5', title: '恢复网关节点', kind: 'restore', targetAssets: ['api-gateway'], approvals: [], status: 'pending' }
  ],
  timeline: [
    { id: 'e1', at: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
    { id: 'e2', at: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
  ]
};

export const useIncidentStore = create<State>()(persist((set, get) => ({
  incident: initial, role: 'analyst', demoMode: false, online: true,
  setRole: (role) => set({ role }),
  toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
  toggleNetwork: () => {
    const state = get();
    if (state.demoMode) return;
    const nextOnline = !state.online;
    if (nextOnline) {
      // 恢复先对账：把断网期间积压的执行中动作逐笔认账
      const { actions, entries } = runReconcile(state.incident.actions);
      set({ online: true, incident: { ...state.incident, actions, timeline: [...entries, ...state.incident.timeline].slice(0, 50) } });
    } else {
      set({ online: false });
    }
  },
  addSubIncident: (payload) => { if (get().demoMode || get().role === 'viewer') return; set((state) => ({ incident: { ...state.incident, subIncidents: [...state.incident.subIncidents, { id: `sub-${Date.now()}`, ...payload, status: 'open' }], timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: roleLabel[state.role], text: `创建子事件：${payload.title}` }, ...state.incident.timeline] } })); },
  addAsset: (asset) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const name = asset.trim();
    if (!name || state.incident.affected.includes(name)) return;
    const actions = invalidatePending(state.incident.actions, `新增影响资产「${name}」，待批动作退回待复核`);
    set({ incident: { ...state.incident, affected: [...state.incident.affected, name], actions, timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: roleLabel[state.role], text: `新增影响资产：${name}，待批动作退回待复核` }, ...state.incident.timeline] } });
  },
  removeAsset: (asset) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const actions = invalidatePending(state.incident.actions, `移除影响资产「${asset}」，待批动作退回待复核`);
    set({ incident: { ...state.incident, affected: state.incident.affected.filter((item) => item !== asset), actions, timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: roleLabel[state.role], text: `移除影响资产：${asset}，待批动作退回待复核` }, ...state.incident.timeline] } });
  },
  approveAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || action.approvals.includes(state.role)) return;
    const approvals = [...action.approvals, state.role];
    let updates: Partial<ResponseAction> = { approvals, invalidated: false, invalidatedReason: undefined };
    let text = `审批处置动作：${action.title}`;
    if (needsTwoApprovals(action)) {
      if (approvals.length >= 2) {
        updates = { ...updates, status: 'approved', approvalDeadline: undefined };
        const occupier = findOccupier({ ...action, approvals }, state.incident.actions);
        if (occupier) {
          updates = { ...updates, status: 'queued', queuedBy: occupier.id, queuedReason: `被「${occupier.title}」占住（${(occupier.targetAssets ?? []).join('、')}），排队等待执行` };
          text = `审批处置动作：${action.title}，资产被占住排队（占住：${occupier.title}）`;
        }
      } else {
        updates = { ...updates, status: 'pending', approvalDeadline: new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString() };
      }
    } else {
      updates = { ...updates, status: 'approved' };
    }
    set({ incident: { ...state.incident, actions: state.incident.actions.map((item) => item.id === id ? { ...item, ...updates } : item), timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: roleLabel[state.role], text, sensitive: action.sensitive }, ...state.incident.timeline] } });
  },
  executeAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || action.status === 'executed' || action.status === 'executing' || action.invalidated) return;
    if (needsTwoApprovals(action) && action.approvals.length < 2) return;
    // 占用账只约束隔离/封禁：恢复动作本身是为了解除占用，不应被占住；通知不指向资产
    if (action.kind === 'isolate' || action.kind === 'block') {
      const occupier = findOccupier(action, state.incident.actions);
      if (occupier) {
        if (action.status !== 'queued') {
          set({ incident: { ...state.incident, actions: state.incident.actions.map((item) => item.id === id ? { ...item, status: 'queued', queuedBy: occupier.id, queuedReason: `被「${occupier.title}」占住，排队等待执行` } : item), timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: roleLabel[state.role], text: `处置动作排队：${action.title}（被「${occupier.title}」占住）` }, ...state.incident.timeline] } });
        }
        return;
      }
    }
    let updates: Partial<ResponseAction>;
    let text: string;
    if (state.online) {
      updates = { status: 'executed', receipt: 'acknowledged', queuedBy: undefined, queuedReason: undefined, executedAt: new Date().toISOString() };
      text = `执行处置动作：${action.title}，回执已确认`;
    } else {
      updates = { status: 'executing', receipt: 'pending', queuedBy: undefined, queuedReason: undefined };
      text = `已下发执行：${action.title}（断网中，回执待恢复后对账）`;
    }
    let actions = state.incident.actions.map((item) => item.id === id ? { ...item, ...updates } : item);
    if (state.online && action.kind === 'restore') actions = releaseAssets(actions, action.targetAssets ?? []);
    set({ incident: { ...state.incident, actions, timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: roleLabel[state.role], text, sensitive: action.sensitive }, ...state.incident.timeline] } });
  },
  reconcile: () => {
    const state = get();
    if (state.demoMode || state.role === 'viewer' || !state.online) return;
    const { actions, entries } = runReconcile(state.incident.actions);
    if (entries.length === 0) return;
    set({ incident: { ...state.incident, actions, timeline: [...entries, ...state.incident.timeline].slice(0, 50) } });
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
  tick: () => {
    const state = get();
    if (state.demoMode) return;
    const now = Date.now();
    const timedOut: string[] = [];
    const actions = state.incident.actions.map((item) => {
      if (item.status === 'pending' && item.approvalDeadline && new Date(item.approvalDeadline).getTime() < now) {
        timedOut.push(item.title);
        return { ...item, approvals: [], approvalDeadline: undefined };
      }
      return item;
    });
    let timeline = state.incident.timeline;
    if (timedOut.length > 0) {
      timeline = [{ id: `e-${Date.now()}-to`, at: new Date().toISOString(), actor: '值班系统', text: `确认超时作废：${timedOut.join('、')}（需两个不同角色重新确认）` }, ...timeline];
    }
    timeline = [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: '监测代理', text: `实时检查：${state.incident.affected.length} 项资产状态已更新` }, ...timeline].slice(0, 40);
    set({ incident: { ...state.incident, actions, timeline } });
  }
}), { name: 'yf56-incident-store-v2' }));
