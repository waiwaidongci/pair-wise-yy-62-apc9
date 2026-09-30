import { useState, type ReactNode } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from './store';
import {
  Accordion,
  Badge,
  Box,
  Button,
  Card,
  Code,
  Group,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconCloudOff,
  IconDeviceFloppy,
  IconGitMerge,
  IconHistory,
  IconLock,
  IconLockOpen,
  IconMap2,
  IconPrinter,
  IconRefresh,
  IconShip,
  IconWifi
} from '@tabler/icons-react';
import {
  changeRotation,
  commitPatches,
  goOffline,
  offlineEdit,
  reconnect,
  retryBatch,
  selectActiveSnapshot,
  selectGate,
  selectSnapshotState,
  snapshotActions,
  submitBatch
} from './snapshot/snapshotSlice';
import { describePatch, differingFields } from './snapshot/merge';
import { makeBatch } from './snapshot/gateway';
import type { CargoPatch, OfflineConflict, PortConclusion, StowageSnapshot } from './snapshot/types';

function Section({ title, hint, icon, action, children }: { title: string; hint: string; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  return <Card padding={0} className="snap-section">
    <div className="panel-title">
      <Group gap={8}><ThemeIcon variant="light" color="teal" size="md">{icon}</ThemeIcon><div><strong>{title}</strong><Text size="xs" c="dimmed">{hint}</Text></div></Group>
      {action}
    </div>
    <Box p="md">{children}</Box>
  </Card>;
}

function StatusBadge({ status }: { status: PortConclusion['status'] }) {
  if (status === 'valid') return <Badge color="teal" size="xs" leftSection={<IconCheck size={11} />}>结论有效</Badge>;
  if (status === 'recalculating') return <Badge color="orange" size="xs" leftSection={<IconRefresh size={11} className="spin" />}>重算中</Badge>;
  return <Badge color="red" size="xs">已过期</Badge>;
}

function PortConclusions({ snapshot }: { snapshot: StowageSnapshot }) {
  return <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
    {snapshot.conclusions.map((conclusion) => <Card key={conclusion.port} padding="sm" className="port-card" withBorder>
      <Group justify="space-between" mb={6}>
        <Group gap={6}><IconMap2 size={15} /><strong>{conclusion.port} 港</strong></Group>
        <StatusBadge status={conclusion.status} />
      </Group>
      <Table verticalSpacing={3} className="port-table">
        <Table.Tbody>
          <Table.Tr><Table.Td>卸货顺序</Table.Td><Table.Td>{conclusion.status === 'valid'
            ? conclusion.dischargeOrder.length
              ? conclusion.dischargeOrder.map((bill, index) => <Code key={bill} mr={4}>{index + 1}. {bill}</Code>)
              : <Text size="xs" c="dimmed">本港无卸货</Text>
            : <Text span size="xs" c="orange">等待重算…</Text>}</Table.Td></Table.Tr>
          <Table.Tr><Table.Td>危险品隔离</Table.Td><Table.Td><Text size="xs" c={conclusion.hazmat.status === 'warning' ? 'red' : 'teal'}>{conclusion.hazmat.detail}</Text></Table.Td></Table.Tr>
          <Table.Tr><Table.Td>稳性裕度</Table.Td><Table.Td><Text fw={700} c={conclusion.status === 'valid' && conclusion.stabilityMargin > 70 ? 'teal' : 'orange'}>{conclusion.status === 'valid' ? `${conclusion.stabilityMargin.toFixed(1)}%` : '—'}</Text></Table.Td></Table.Tr>
          <Table.Tr><Table.Td>绑扎复核</Table.Td><Table.Td><Text size="xs" c={conclusion.lashing.pendingBills.length ? 'red' : 'teal'}>{conclusion.lashing.detail}</Text></Table.Td></Table.Tr>
        </Table.Tbody>
      </Table>
      {conclusion.status === 'valid' && <Text size="9px" c="dimmed" mt={4}>校核于 {conclusion.recalculatedAt} · 指纹 {conclusion.fingerprint.slice(-10)}…</Text>}
    </Card>)}
  </SimpleGrid>;
}

function ConflictRow({ conflict, onChoose }: { conflict: OfflineConflict; onChoose: (id: string, choice: 'a' | 'b' | 'locked') => void }) {
  const fields = differingFields(conflict.a, conflict.b);
  return <Card padding="sm" withBorder mb="sm" className="conflict-pick">
    <Group justify="space-between" mb={6}>
      <Group gap={6}><IconGitMerge size={15} /><strong>{conflict.bill}</strong><Badge size="xs" color="orange">两份货位待选</Badge></Group>
      {conflict.status !== '待选' && <Badge color="teal">{conflict.status}</Badge>}
    </Group>
    <Text size="xs" c="dimmed" mb={6}>差异字段：{fields.join('、')}</Text>
    <SimpleGrid cols={conflict.lockedPatch ? 3 : 2} spacing="xs">
      <button className="pick-card" disabled={conflict.status !== '待选'} onClick={() => onChoose(conflict.id, 'a')}>
        <Badge size="xs" variant="light">{conflict.terminalA}</Badge>
        <strong>{describePatch(conflict.a)}</strong>
        <small>{conflict.status === '待选' ? '采用此货位' : '候选 A'}</small>
      </button>
      <button className="pick-card" disabled={conflict.status !== '待选'} onClick={() => onChoose(conflict.id, 'b')}>
        <Badge size="xs" variant="light">{conflict.terminalB}</Badge>
        <strong>{describePatch(conflict.b)}</strong>
        <small>{conflict.status === '待选' ? '采用此货位' : '候选 B'}</small>
      </button>
      {conflict.lockedPatch && <button className="pick-card locked" disabled={conflict.status !== '待选'} onClick={() => onChoose(conflict.id, 'locked')}>
        <Badge size="xs" color="teal" variant="light"><IconLock size={10} /> 锁定版本</Badge>
        <strong>{describePatch(conflict.lockedPatch)}</strong>
        <small>锁定版不可被盖掉</small>
      </button>}
    </SimpleGrid>
  </Card>;
}

export default function SnapshotPage() {
  const dispatch = useDispatch<AppDispatch>();
  const snapshot = useSelector((root: RootState) => selectActiveSnapshot(root));
  const state = useSelector((root: RootState) => selectSnapshotState(root));
  const gate = useSelector((root: RootState) => selectGate(root));
  const [rotationInput, setRotationInput] = useState(snapshot.rotation.slice(1).map((port) => `上海/${port}`).join('/'));
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ bill: 'SEA-88231', bay: 9, row: 5, terminal: '终端A · 船长站' });

  const recalculating = snapshot.conclusions.some((item) => item.status === 'recalculating');

  const applyRotation = () => {
    const rotation = rotationInput.split('/').map((item) => item.trim()).filter(Boolean);
    if (rotation.length >= 2 && rotation[0] === '上海') {
      dispatch(changeRotation(rotation));
    }
  };

  const queueBatches = () => dispatch(snapshotActions.queuePresetBatches());
  const submit = (index: number) => dispatch(submitBatch(state.batches[index]));
  const resubmitDuplicate = () => {
    // 用已有成功批次的同一 batchId 再走一次入口 → 必须沿用第一次结果
    const first = state.batches[0];
    if (first) dispatch(submitBatch({ ...makeBatch(first.batchId, first.terminal, first.note, first.patches), status: 'saving', receivedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }));
  };

  const chooseConflict = (id: string, choice: 'a' | 'b' | 'locked') => {
    const conflict = state.conflicts.find((item) => item.id === id);
    if (!conflict) return;
    dispatch(snapshotActions.resolveConflict({ id, choice }));
    const patch = choice === 'a' ? conflict.a : choice === 'b' ? conflict.b : conflict.lockedPatch;
    if (patch) dispatch(commitPatches({ patches: [patch], source: `离线冲突裁决 ${conflict.bill}` }));
  };

  const offlinePatchFor = (bill: string, bay: number, row: number, terminal: string): CargoPatch => ({ bill, bay, row });

  return <div className="page">
    <div className="page-heading">
      <div><small>STOWAGE SNAPSHOT / 快照判定 · 离线合并 · 请求入口</small><h1>配载快照与同步校核</h1><p>货位、卸货港与绑扎复核挂接同一份快照；按提单号识别，重复导入沿用首次结果，失败批次保留待重试。</p></div>
      <Group gap="xs">
        <Badge size="lg" variant="light" color={state.offline ? 'orange' : 'teal'} leftSection={state.offline ? <IconCloudOff size={14} /> : <IconWifi size={14} />}>{state.offline ? '断网编辑中' : '联网正常'}</Badge>
        <Badge size="lg" variant="light" color="gray">靠港顺序 {state.rotationVersion}</Badge>
      </Group>
    </div>

    {/* 闸门：锁定 / 打印共用 */}
    <Card padding="md" mb="md" className={gate.blockers.length ? 'gate-card blocked' : 'gate-card'}>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap={8} mb={4}><IconLock size={16} /><strong>快照闸门</strong>
            {snapshot.locked
              ? <Badge color="teal" leftSection={<IconLock size={12} />}>当前为锁定版本，只读</Badge>
              : <Badge color={gate.canEdit ? 'teal' : 'orange'} leftSection={gate.canEdit ? <IconLockOpen size={12} /> : <IconLock size={12} />}>{gate.canEdit ? '可编辑' : '编辑被闸门拦截'}</Badge>}
            {state.rotationVersion !== snapshot.rotationVersion && <Badge color="red" leftSection={<IconAlertTriangle size={12} />}>旧配载图 · 禁止放行</Badge>}
          </Group>
          {gate.blockers.length
            ? <Stack gap={2}>{gate.blockers.map((item) => <Text key={item} size="xs" c="red">• {item}</Text>)}</Stack>
            : <Text size="xs" c="teal">快照与当前靠港顺序一致，全部港口结论有效，可锁定或打印。</Text>}
          {gate.warnings.map((item) => <Text key={item} size="xs" c="orange" mt={2}>• {item}</Text>)}
        </div>
        <Group gap="xs">
          {snapshot.locked
            ? <Button color="teal" variant="light" leftSection={<IconLockOpen size={16} />} onClick={() => dispatch(snapshotActions.forkDraft())}>另立工作草稿 V{snapshot.revision + 1}</Button>
            : <Tooltip label={gate.canLock ? undefined : '存在未解除的闸门条件'}><span><Button color="teal" leftSection={<IconLock size={16} />} disabled={!gate.canLock} onClick={() => dispatch(snapshotActions.lockFromStowage())}>锁定当前快照</Button></span></Tooltip>}
          <Tooltip label={gate.canPrint ? undefined : '重算未完成前不能打印'}><span><Button variant="default" leftSection={<IconPrinter size={16} />} disabled={!gate.canPrint} onClick={() => window.print()}>打印</Button></span></Tooltip>
        </Group>
      </Group>
    </Card>

    <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="md">
      {/* 左列：快照与港口结论 */}
      <Stack gap="md">
        <Section title="快照链与靠港顺序" hint="改靠港顺序后旧快照保留；船长只能对当前顺序版本的快照放行" icon={<IconHistory size={16} />}>
          <Text size="xs" c="dimmed" mb={6}>当前活动：<strong>{snapshot.label}</strong>（{snapshot.id} · {snapshot.rotationVersion}）· 建自 {snapshot.createdAt}</Text>
          <Group gap="xs" mb="sm">
            {state.snapshots.slice(0, 6).map((item) => <Badge
              key={item.id}
              variant={item.id === state.activeId ? 'filled' : 'outline'}
              color={item.locked ? 'teal' : item.rotationVersion !== state.rotationVersion ? 'red' : 'gray'}
              className="snapshot-chip"
              onClick={() => dispatch(snapshotActions.switchSnapshot(item.id))}
            >
              {item.locked && '🔒 '}{item.label} {item.rotationVersion !== state.rotationVersion && '· 旧顺序'}
            </Badge>)}
          </Group>
          <Group align="flex-end" gap="xs">
            <TextInput flex={1} label="改靠港顺序（/ 分隔，首位装货港）" value={rotationInput} onChange={(event) => setRotationInput(event.currentTarget.value)} placeholder="上海/釜山/温哥华" disabled={!gate.canEdit} />
            <Button color="teal" variant="light" leftSection={<IconRefresh size={15} />} disabled={!gate.canEdit || recalculating} onClick={applyRotation}>改港并重建快照</Button>
          </Group>
          <Text size="9px" c="dimmed" mt={4}>例如 上海/温哥华/釜山 或加入新挂港 上海/釜山/东京/温哥华；改港后所有卸货港结论进入重算，未完成前不可锁定或打印。</Text>
        </Section>

        <Section title="分港口校核结论" hint="卸货港或货位变化时只重算受影响港口，其他港口结论继续有效" icon={<IconShip size={16} />}
          action={recalculating ? <Badge color="orange" leftSection={<IconRefresh size={12} className="spin" />}>部分港口重算中</Badge> : <Badge color="teal" leftSection={<IconCheck size={12} />}>全部有效</Badge>}>
          <PortConclusions snapshot={snapshot} />
        </Section>
      </Stack>

      {/* 右列：请求入口 + 离线合并 */}
      <Stack gap="md">
        <Section title="请求入口：码头导入批次" hint="两码头同时提交不互相覆盖；按批次保存，成功后才写入快照" icon={<IconDeviceFloppy size={16} />}
          action={<Group gap="xs"><Button size="xs" variant="light" onClick={queueBatches} disabled={state.batches.length > 0}>准备批次</Button><Button size="xs" variant="default" onClick={resubmitDuplicate} disabled={!state.batches.length}>重复导入 501</Button></Group>}>
          {state.batches.length === 0
            ? <Text size="xs" c="dimmed">点击“准备批次”载入两码头待提交货位调整（含一批首次保存会失败的批次）。</Text>
            : <Table verticalSpacing="xs" className="batch-table">
              <Table.Thead><Table.Tr><Table.Th>批次</Table.Th><Th>码头 / 内容</Th><Th>状态</Th><Th>操作</Th></Table.Tr></Table.Thead>
              <Table.Tbody>{state.batches.map((batch, index) => <Table.Tr key={batch.batchId}>
                <Table.Td><Code>{batch.batchId}</Code><Text size="9px" c="dimmed">{batch.patches.map((item) => item.bill).join('、')}</Text></Table.Td>
                <Table.Td><Text size="xs">{batch.terminal}</Text><Text size="9px" c="dimmed">{batch.note}</Text>{batch.duplicate && <Badge size="xs" color="grape" mt={3}>幂等命中</Badge>}</Table.Td>
                <Table.Td>{batch.status === 'saving'
                  ? <Badge color="orange" leftSection={<IconRefresh size={11} className="spin" />}>保存中</Badge>
                  : batch.status === 'saved'
                    ? <Badge color="teal" leftSection={<IconCheck size={11} />}>已保存 {batch.savedAt}</Badge>
                    : <Badge color="red" leftSection={<IconAlertTriangle size={11} />}>失败待重试</Badge>}</Table.Td>
                <Table.Td>{batch.status === 'failed'
                  ? <Button size="compact-xs" color="teal" onClick={() => dispatch(retryBatch(batch.batchId))}>重试原批次</Button>
                  : <Button size="compact-xs" variant="default" disabled={batch.status === 'saving'} onClick={() => submit(index)}>{batch.status === 'saved' ? '再次导入' : '提交'}</Button>}</Table.Td>
              </Table.Tr>)}</Table.Tbody>
            </Table>}
          <Text size="9px" c="dimmed" mt={6}>保存失败时批次留在队列、快照不变；重复 batchId 直接沿用第一次保存结果，不重复落货位。</Text>
        </Section>

        <Section title="离线双终端合并" hint="断网期间两个终端各自修改，恢复后按提单号合并；货位不同保留两份待选" icon={<IconGitMerge size={16} />}
          action={state.offline
            ? <Button size="xs" color="teal" leftSection={<IconWifi size={14} />} onClick={() => dispatch(reconnect())}>恢复联网并合并</Button>
            : <Button size="xs" variant="light" color="orange" leftSection={<IconCloudOff size={14} />} disabled={!gate.canEdit} onClick={() => dispatch(goOffline())}>模拟断网</Button>}>
          {!state.offline && state.conflicts.length === 0 && !state.lastMerge && <Text size="xs" c="dimmed">模拟断网后，可分别在两个终端对同一票货（SEA-88231）改成不同货位，恢复后系统不会互相覆盖，而是保留两份待选。</Text>}
          {state.offline && <SimpleGrid cols={2} spacing="xs" mb="sm">
            {state.terminals.map((terminal) => <Card key={terminal.terminal} padding="sm" withBorder>
              <Text size="xs" fw={700} mb={4}>{terminal.terminal}</Text>
              {terminal.edits.length === 0 && <Text size="9px" c="dimmed">暂无离线修改</Text>}
              {terminal.edits.map((edit) => <Text key={edit.bill} size="xs">• {edit.bill}：{describePatch(edit)}</Text>)}
              <Button size="compact-xs" variant="light" mt={6} onClick={() => dispatch(offlineEdit({ terminal: terminal.terminal, patch: terminal.terminal.startsWith('终端A') ? offlinePatchFor('SEA-88231', 9, 5, terminal.terminal) : offlinePatchFor('SEA-88231', 11, 7, terminal.terminal) }))}>
                {terminal.terminal.startsWith('终端A') ? '把 SEA-88231 调到 B9/R5' : '把 SEA-88231 调到 B11/R7'}
              </Button>
            </Card>)}
          </SimpleGrid>}
          {state.lastMerge && <Card padding="xs" bg="teal.0" mb="sm">
            <Text size="xs">上次合并（基线 V{state.lastMerge.baseRevision}）：自动采用 <strong>{state.lastMerge.applied.length}</strong> 票，待选冲突 <strong>{state.lastMerge.conflicts.length}</strong> 票，无变化 {state.lastMerge.unchanged.length} 票{state.lastMerge.unrecognized.length > 0 ? `，未识别提单 ${state.lastMerge.unrecognized.join('、')}` : ''}。</Text>
          </Card>}
          {state.conflicts.filter((item) => item.status === '待选').map((conflict) => <ConflictRow key={conflict.id} conflict={conflict} onChoose={chooseConflict} />)}
          <Button size="compact-xs" variant="subtle" onClick={() => setManualOpen(true)}>自定义离线修改（提单号 / 货位 / 终端）</Button>
        </Section>

        <Section title="判定与同步记录" hint="快照、重算、幂等、合并的全部决策留痕" icon={<IconHistory size={16} />}>
          <div className="snap-log">{state.log.map((entry) => <div key={entry.id} className={`log-${entry.tone}`}><small>{entry.at}</small><span>{entry.message}</span></div>)}</div>
        </Section>
      </Stack>
    </SimpleGrid>

    <Modal opened={manualOpen} onClose={() => setManualOpen(false)} title="自定义离线终端修改" centered>
      <Stack>
        <Text size="xs" c="dimmed">断网后按提单号记录修改；同一终端重复改同一票按后写折叠，两终端改不同则合并时保留两份。</Text>
        <TextInput label="提单号" value={manual.bill} onChange={(event) => setManual({ ...manual, bill: event.currentTarget.value })} />
        <Group grow>
          <TextInput label="Bay" value={manual.bay} onChange={(event) => setManual({ ...manual, bay: Number(event.currentTarget.value) })} />
          <TextInput label="Row" value={manual.row} onChange={(event) => setManual({ ...manual, row: Number(event.currentTarget.value) })} />
        </Group>
        <Select label="终端" data={['终端A · 船长站', '终端B · 码头站']} value={manual.terminal} onChange={(value) => value && setManual({ ...manual, terminal: value })} />
        <Button color="teal" disabled={!state.offline} onClick={() => { dispatch(offlineEdit({ terminal: manual.terminal, patch: { bill: manual.bill, bay: manual.bay, row: manual.row } })); }}>记到该终端离线队列</Button>
      </Stack>
    </Modal>
  </div>;
}

function Th({ children }: { children: ReactNode }) {
  return <Table.Th><Text size="9px" c="dimmed">{children}</Text></Table.Th>;
}
