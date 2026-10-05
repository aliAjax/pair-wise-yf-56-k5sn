'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { CheckCheck, Eye, Lock, Play, Radio, RotateCcw, ShieldAlert, UserCheck, Users, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { roleText, statusText, useIncidentStore, type BlockRef, type ResponseAction } from '@/lib/store';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });

function ActionRow({ action, nowTs }: { action: ResponseAction; nowTs: number }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id });
  const privileged = ['responder', 'legal'].includes(store.role);
  const canSee = !action.sensitive || privileged;
  const readOnly = store.demoMode || store.role === 'viewer';
  const needed = action.kind === 'isolate' ? 2 : 1;
  const already = action.confirmations.some((c) => c.role === store.role);
  const canConfirm = !readOnly && !already && (action.status === 'review' || action.status === 'approving');
  const remainSec = action.confirmDeadline ? Math.max(0, Math.ceil((new Date(action.confirmDeadline).getTime() - nowTs) / 1000)) : 0;
  const holderTitle = (b: BlockRef) => {
    const holder = store.incident.actions.find((a) => a.id === b.actionId);
    return holder?.sensitive && !privileged ? '敏感动作' : b.actionTitle;
  };
  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-row">
      <div className="action-main">
        <div className="action-title"><strong>{canSee ? action.title : '敏感处置动作（当前角色不可见）'}</strong><Badge className={`st-${action.status}`}>{statusText[action.status]}</Badge></div>
        <div className="muted">{action.kind} · 目标资产：{action.assets.length ? action.assets.join('、') : '无内部资产'}</div>
        {action.confirmations.length > 0 && <div className="muted">确认 {action.confirmations.length}/{needed}：{action.confirmations.map((c) => `${roleText[c.role]} ${format(new Date(c.at), 'HH:mm')}`).join(' · ')}</div>}
        {action.status === 'approving' && action.confirmDeadline && <div className="countdown">确认时限剩余 {remainSec} 秒，超时作废需重来</div>}
        {action.status === 'queued' && <div className="blocked">排队等待：{action.blockedBy.map((b) => `${b.asset} 被《${holderTitle(b)}》占住`).join('；')}</div>}
        {action.status === 'void' && <div className="error">已作废：{action.voidReason}</div>}
        {action.executedAssets && <div className="muted">执行快照：{action.executedAssets.length ? action.executedAssets.join('、') : '—'}{action.dispatchedAt ? ` · 下发 ${format(new Date(action.dispatchedAt), 'HH:mm:ss')}` : ''}{action.completedAt ? ` · 完成 ${format(new Date(action.completedAt), 'HH:mm:ss')}` : ''}</div>}
      </div>
      <div className="row-actions">
        {(action.status === 'review' || action.status === 'approving') && <Button size="sm" variant="outline" disabled={!canConfirm} onClick={() => store.confirmAction(action.id)}><UserCheck size={14} />确认 {action.confirmations.length}/{needed}</Button>}
        {action.status === 'approved' && <Button size="sm" disabled={readOnly} onClick={() => store.executeAction(action.id)}><Play size={14} />执行</Button>}
        {action.status === 'reconciling' && <Button size="sm" variant="outline" disabled={readOnly || !store.online} onClick={() => store.acknowledgeAction(action.id)}><CheckCheck size={14} />对账确认</Button>}
        {action.status === 'void' && <Button size="sm" variant="outline" disabled={readOnly} onClick={() => store.restartAction(action.id)}><RotateCcw size={14} />重新发起</Button>}
        <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners}>排序</Button>
      </div>
    </div>
  );
}

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const readOnly = store.demoMode || store.role === 'viewer';
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [affectedInput, setAffectedInput] = useState('');
  const { data: health = { latency: 42 } } = useQuery({ queryKey: ['live', store.online], queryFn: async () => ({ latency: 42 }), refetchInterval: 10000 });
  useEffect(() => { const timer = window.setInterval(() => setNowTs(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { const timer = window.setInterval(() => useIncidentStore.getState().sweep(), 2000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { const timer = window.setInterval(() => { if (!useIncidentStore.getState().demoMode) useIncidentStore.getState().tick(); }, 20000); return () => window.clearInterval(timer); }, []);
  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }
  const privileged = ['responder', 'legal'].includes(store.role);
  const activeLedger = store.ledger.filter((entry) => !entry.releasedAt);
  const releasedLedger = store.ledger.filter((entry) => entry.releasedAt).slice(0, 5);
  const queued = incident.actions.filter((a) => a.status === 'queued');
  const ledgerTitle = (actionId: string, fallback: string) => {
    const holder = incident.actions.find((a) => a.id === actionId);
    return holder?.sensitive && !privileged ? '敏感动作' : fallback;
  };

  return <main className="shell">
    <header className="topbar">
      <div><span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div>
      <div className="controls">
        <select value={store.role} onChange={(event) => store.setRole(event.target.value as typeof store.role)}>{Object.entries(roleText).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <Button variant="outline" disabled={readOnly} onClick={store.toggleOnline}>{store.online ? <Wifi size={16} /> : <WifiOff size={16} />}{store.online ? '模拟断网' : '恢复连接'}</Button>
        <Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button>
      </div>
    </header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：确认、执行、对账、变更和拖拽操作均被冻结，仍可查看允许范围内的内容。</div>}
    {!store.online && <div className="offline-banner">连接中断：回执不可达。执行中的动作已转入待对账，恢复连接后需逐条对账确认，认了才算执行完。</div>}
    <section className="metrics">
      <Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card>
      <Card><CardContent><span>实时通道</span><strong>{store.online ? `${health.latency}ms` : '离线'}</strong><small>{store.online ? '监测代理已连接' : '回执不可达 · 恢复后先对账'}</small></CardContent></Card>
      <Card><CardContent><span>子事件</span><strong>{incident.subIncidents.filter((item) => item.status !== 'closed').length}</strong><small>处理中</small></CardContent></Card>
      <Card><CardContent><span>处置动作</span><strong>{incident.actions.filter((item) => item.status === 'done').length}/{incident.actions.length}</strong><small>已完成/总数</small></CardContent></Card>
      <Card><CardContent><span>资产占用</span><strong>{activeLedger.length}</strong><small>排队 {queued.length} 条</small></CardContent></Card>
    </section>
    <section className="grid">
      <div className="stack">
        <Card><CardHeader><div><h2>事件摘要</h2><p className="muted">影响范围：{incident.affected.join(' · ')}</p></div><ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} /></CardHeader><CardContent><div className="incident-state"><span>处置阶段</span><strong>{incident.status}</strong></div><h3>子事件</h3>{incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}</CardContent></Card>
        <Card><CardHeader><div><h2>{t('approval')}</h2><p className="muted">隔离需两名不同角色在时限内确认，超时作废；批过未必能动手，资产被占则排队。</p></div><Users size={20} /></CardHeader><CardContent><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{incident.actions.map((action) => <ActionRow key={action.id} action={action} nowTs={nowTs} />)}</div></SortableContext></DndContext></CardContent></Card>
        <Card><CardHeader><div><h2>{t('ledger')}</h2><p className="muted">同一资产只留一个执行中的隔离，后到的排队并写明被谁占住。</p></div><Lock size={20} /></CardHeader><CardContent>
          {store.ledger.length === 0 && <p className="muted">当前无资产占用记录。</p>}
          {store.ledger.length > 0 && <div className="ledger">
            <div className="ledger-row ledger-head"><span>资产</span><span>占用动作</span><span>值班角色</span><span>占用时间</span><span>状态</span></div>
            {[...activeLedger, ...releasedLedger].map((entry) => <div className="ledger-row" key={entry.id}>
              <span>{entry.asset}</span>
              <span>{ledgerTitle(entry.actionId, entry.actionTitle)}</span>
              <span>{roleText[entry.holder]}</span>
              <span>{format(new Date(entry.acquiredAt), 'HH:mm:ss')}</span>
              <span>{entry.releasedAt ? <Badge className="st-done">已释放</Badge> : <Badge className="st-executing">占用中</Badge>}</span>
            </div>)}
          </div>}
          {queued.length > 0 && <div className="queue"><h3>排队队列</h3>{queued.map((a) => <div className="muted queue-row" key={a.id}>《{a.sensitive && !privileged ? '敏感动作' : a.title}》等待：{a.blockedBy.map((b) => `${b.asset} 被《${ledgerTitle(b.actionId, b.actionTitle)}》占住`).join('；')}</div>)}</div>}
        </CardContent></Card>
      </div>
      <div className="stack">
        <Card><CardHeader><h2>新增子事件</h2></CardHeader><CardContent><form onSubmit={form.handleSubmit((values) => { store.addSubIncident(values); form.reset(); })}><label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label><small className="error">{form.formState.errors.title?.message}</small><label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label><small className="error">{form.formState.errors.owner?.message}</small><Button type="submit" disabled={readOnly}><ShieldAlert size={16} />创建子事件</Button></form></CardContent></Card>
        <Card><CardHeader><div><h2>{t('affected')}</h2><p className="muted">影响资产一变，待批动作失效退回待复核；已执行的留原记录。</p></div><ShieldAlert size={20} /></CardHeader><CardContent>
          <div className="chips">{incident.affected.map((asset) => <span className="chip" key={asset}>{asset}</span>)}</div>
          <form onSubmit={(event) => { event.preventDefault(); store.setAffected(affectedInput.split(/[,，、\s]+/)); setAffectedInput(''); }}>
            <label>新的影响资产清单</label>
            <Input value={affectedInput} onChange={(event) => setAffectedInput(event.target.value)} placeholder="逗号分隔，如 api-gateway, audit-log" />
            <div className="form-gap"><Button type="submit" disabled={readOnly || !affectedInput.trim()}>提交变更</Button></div>
          </form>
        </CardContent></Card>
        <Card className="timeline-card"><CardHeader><div><h2>{t('timeline')}</h2><p className="muted">每 20 秒接收一次模拟监测事件</p></div><Radio color="#ef4444" /></CardHeader><CardContent><div className="timeline">{incident.timeline.map((event) => <article key={event.id}><i /><div><div className="timeline-meta"><strong>{event.actor}</strong><span>{formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span></div><p>{event.sensitive && !privileged ? '敏感处置记录已隐藏' : event.text}</p></div></article>)}</div></CardContent></Card>
      </div>
    </section>
  </main>;
}
