'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Eye, Lock, Radio, ShieldAlert, UserCheck, Users, Wifi, WifiOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useIncidentStore, occupiesAsset, findOccupier, needsTwoApprovals, kindLabel, type ActionStatus, type ResponseAction } from '@/lib/store';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const assetSchema = z.object({ asset: z.string().min(2, '请填写至少2个字的资产名') });
const roleNames = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };

const statusMeta: Record<ActionStatus, { label: string; className: string }> = {
  pending: { label: '待审批', className: 'pending' },
  approved: { label: '已批准·待执行', className: 'approved' },
  queued: { label: '排队中', className: 'queued' },
  executing: { label: '执行中·待回执', className: 'executing' },
  executed: { label: '已执行', className: 'executed' }
};

function StatusBadge({ status }: { status: ActionStatus }) {
  const meta = statusMeta[status];
  return <Badge className={meta.className}>{meta.label}</Badge>;
}

function SortableAction({ action }: { action: ResponseAction }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id });
  const canSee = !action.sensitive || ['responder', 'legal'].includes(store.role);
  const occupier = findOccupier(action, store.incident.actions);
  const locked = store.demoMode || store.role === 'viewer';
  const approveDisabled = locked || action.approvals.includes(store.role);
  const needsTwo = needsTwoApprovals(action);
  const executeDisabled = locked || action.status === 'executed' || action.status === 'executing' || !!action.invalidated || (needsTwo && action.approvals.length < 2) || (action.status === 'queued' && !!occupier);
  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-row">
      <div>
        <div className="action-title-line">
          <strong>{canSee ? action.title : '敏感处置动作（当前角色不可见）'}</strong>
          <StatusBadge status={action.status} />
        </div>
        <div className="muted action-meta">
          <span>{kindLabel[action.kind]}动作</span>
          {action.targetAssets.length > 0 && <span className="asset-chips">{action.targetAssets.map((asset) => <span className="asset-chip" key={asset}>{asset}</span>)}</span>}
          <span>审批人 {action.approvals.length > 0 ? action.approvals.map((r) => roleNames[r]).join('、') : '无'}</span>
        </div>
        {action.status === 'pending' && needsTwo && action.approvalDeadline && (
          <div className="deadline">确认时限剩余 {formatDistanceToNow(new Date(action.approvalDeadline), { locale: zhCN })}，超时作废重来</div>
        )}
        {action.status === 'queued' && action.queuedReason && <div className="queued-note">被占住：{action.queuedReason}</div>}
        {action.status === 'executing' && <div className="receipt-note">已下发执行，回执待{store.online ? '对账' : '恢复网络后对账'}</div>}
        {action.status === 'executed' && action.receipt === 'acknowledged' && <div className="receipt-note ok">回执已确认，执行完成{action.released ? '（隔离已解除，原记录保留）' : ''}</div>}
        {action.invalidated && <div className="invalid-note">已失效：{action.invalidatedReason}，需重新审批</div>}
      </div>
      <div className="row-actions">
        <Button size="sm" variant="outline" disabled={approveDisabled} onClick={() => store.approveAction(action.id)}><UserCheck size={14} />审批</Button>
        <Button size="sm" disabled={executeDisabled} onClick={() => store.executeAction(action.id)}>执行</Button>
        <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners}>排序</Button>
      </div>
    </div>
  );
}

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });
  const assetForm = useForm<z.infer<typeof assetSchema>>({ resolver: zodResolver(assetSchema), defaultValues: { asset: '' } });
  const { data: health = { connected: false, latency: 0 } } = useQuery({ queryKey: ['live'], queryFn: async () => ({ connected: true, latency: 42 }), refetchInterval: 10000 });
  useEffect(() => { const timer = window.setInterval(() => { if (!store.demoMode) store.tick(); }, 20000); return () => window.clearInterval(timer); }, [store.demoMode]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  void now;
  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }
  const canSeeSensitive = ['responder', 'legal'].includes(store.role);
  const locked = store.demoMode || store.role === 'viewer';
  const executingCount = incident.actions.filter((item) => item.status === 'executing').length;
  const occupancy = incident.affected.map((asset) => ({ asset, occupier: incident.actions.find((item) => occupiesAsset(item, asset)) }));
  const queuedActions = incident.actions.filter((item) => item.status === 'queued');

  return <main className="shell">
    <header className="topbar">
      <div><span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div>
      <div className="controls">
        <select value={store.role} onChange={(event) => store.setRole(event.target.value as typeof store.role)}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <Button variant={store.online ? 'outline' : 'danger'} onClick={store.toggleNetwork}>{store.online ? <Wifi size={16} /> : <WifiOff size={16} />}{store.online ? '网络在线' : '已断网'}</Button>
        <Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button>
      </div>
    </header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：审批、执行、拖拽、新增操作与资产调整均被冻结，仍可查看允许范围内的内容。</div>}
    {!store.online && <div className="offline-banner">网络已断开：处置动作可下发但回执收不到，执行状态停在「执行中·待回执」。恢复网络后将自动先对账，认了才算执行完。</div>}
    <section className="metrics">
      <Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card>
      <Card><CardContent><span>实时通道</span><strong>{store.online ? `${health.latency}ms` : '离线'}</strong><small>{store.online ? '监测代理已连接' : '已断网·回执无法接收'}</small></CardContent></Card>
      <Card><CardContent><span>子事件</span><strong>{incident.subIncidents.filter((item) => item.status !== 'closed').length}</strong><small>处理中</small></CardContent></Card>
      <Card><CardContent><span>处置动作</span><strong>{incident.actions.filter((item) => item.status === 'executed').length}/{incident.actions.length}</strong><small>已执行/总数</small></CardContent></Card>
    </section>
    <section className="grid">
      <div className="stack">
        <Card><CardHeader><div><h2>事件摘要</h2><p className="muted">影响范围：{incident.affected.join(' · ')}</p></div><ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} /></CardHeader><CardContent><div className="incident-state"><span>处置阶段</span><strong>{incident.status}</strong></div><h3>子事件</h3>{incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}</CardContent></Card>
        <Card>
          <CardHeader><div><h2>占用账</h2><p className="muted">同一资产只留一个执行中的隔离，后到的排队并写明被谁占住。</p></div><Lock size={20} /></CardHeader>
          <CardContent>
            <div>{occupancy.map(({ asset, occupier }) => <div className="occupancy-row" key={asset}><span className="asset-chip">{asset}</span>{occupier ? <span className="queued-note">占住中：{occupier.title}（{kindLabel[occupier.kind]}）</span> : <Badge className="online">空闲</Badge>}</div>)}</div>
            {queuedActions.length > 0 && <div className="queued-list"><h4>排队中的处置</h4>{queuedActions.map((item) => <div className="queued-note" key={item.id}>{item.title} — {item.queuedReason}</div>)}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><h2>{t('approval')}</h2><p className="muted">隔离/封禁需两个不同角色确认，确认超过时限作废重来；敏感动作仅响应和法务角色可见。</p></div><Users size={20} /></CardHeader>
          <CardContent>
            <div className="card-toolbar">
              <Button size="sm" variant="outline" disabled={locked || !store.online || executingCount === 0} onClick={store.reconcile}><Wifi size={14} />恢复对账{executingCount > 0 ? `（${executingCount}）` : ''}</Button>
              {!store.online && <span className="muted">断网中无法对账，恢复后自动执行</span>}
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{incident.actions.map((action) => <SortableAction key={action.id} action={action} />)}</div></SortableContext></DndContext>
          </CardContent>
        </Card>
      </div>
      <div className="stack">
        <Card><CardHeader><h2>影响资产</h2></CardHeader><CardContent>
          <div className="asset-list">{incident.affected.map((asset) => <span className="asset-chip" key={asset}>{asset}{!locked && <button type="button" className="asset-remove" onClick={() => store.removeAsset(asset)} aria-label={`移除 ${asset}`}><X size={12} /></button>}</span>)}</div>
          <form className="asset-editor" onSubmit={assetForm.handleSubmit((values) => { store.addAsset(values.asset); assetForm.reset(); })}><Input {...assetForm.register('asset')} placeholder="新增影响资产，如：rds-prod-01" /><Button type="submit" size="sm" disabled={locked}>新增</Button></form>
          <small className="error">{assetForm.formState.errors.asset?.message}</small>
          <p className="muted">影响资产一变，待批动作失效退回待复核；已执行的留原记录。</p>
        </CardContent></Card>
        <Card><CardHeader><h2>新增子事件</h2></CardHeader><CardContent><form onSubmit={form.handleSubmit((values) => { store.addSubIncident(values); form.reset(); })}><label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label><small className="error">{form.formState.errors.title?.message}</small><label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label><small className="error">{form.formState.errors.owner?.message}</small><Button type="submit" disabled={locked}><ShieldAlert size={16} />创建子事件</Button></form></CardContent></Card>
        <Card className="timeline-card"><CardHeader><div><h2>{t('timeline')}</h2><p className="muted">每 20 秒接收一次模拟监测事件</p></div><Radio color="#ef4444" /></CardHeader><CardContent><div className="timeline">{incident.timeline.map((event) => <article key={event.id}><i /><div><div className="timeline-meta"><strong>{event.actor}</strong><span>{formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span></div><p>{event.sensitive && !canSeeSensitive ? '敏感处置记录已隐藏' : event.text}</p></div></article>)}</div></CardContent></Card>
      </div>
    </section>
  </main>;
}
