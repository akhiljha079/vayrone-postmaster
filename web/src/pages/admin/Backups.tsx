import { useEffect, useState } from 'react';
import { del, formatBytes, formatDate, get, patch, post } from '../../api';
import { useMe } from '../../auth';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Toggle, useAction, useConfirm, useResource } from '../../components/ui';
import { useUserOptions } from './Users';

interface Target {
  id: number;
  name: string;
  kind: 'local' | 'smb' | 'nfs' | 'usb' | 's3' | 'ftp';
  path?: string;
  s3?: { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; pathStyle: boolean; secretSet: boolean };
  ftp?: { host: string; port: number; secure: 'none' | 'explicit' | 'implicit'; user: string; path: string; tlsVerify: boolean; passwordSet: boolean };
  encryption?: { enabled: boolean; passphraseSet: boolean };
  isEnabled: boolean;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
}
interface Schedule {
  id: number;
  name: string;
  targetId: number;
  kind: 'full' | 'incremental';
  cron: string;
  keepFull: number;
  isEnabled: boolean;
  nextRun: string | null;
}
interface Run {
  id: number;
  targetId: number;
  target: string;
  kind: string;
  status: string;
  progress: number;
  startedAt: string;
  finishedAt: string | null;
  files: number | null;
  bytes: number | null;
  error: string | null;
}
interface Contents {
  createdAt: string;
  users: { userId: number; login: string; displayName: string; existsNow: boolean; folders: { path: string; messages: number }[] }[];
}

const STATUS: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'slate'> = { verified: 'green', ok: 'green', running: 'blue', verifying: 'blue', failed: 'red', corrupt: 'red', expired: 'slate' };
const KIND_LABEL = { local: 'Local disk', smb: 'NAS (Windows share / SMB)', nfs: 'NAS (NFS)', usb: 'USB drive', s3: 'Cloud storage (S3)', ftp: 'FTP / FTPS server' };

const S3_PRESETS: { label: string; endpoint: string; region: string; pathStyle: boolean }[] = [
  { label: 'Amazon S3 (Mumbai)', endpoint: 'https://s3.ap-south-1.amazonaws.com', region: 'ap-south-1', pathStyle: false },
  { label: 'Wasabi (Singapore)', endpoint: 'https://s3.ap-southeast-1.wasabisys.com', region: 'ap-southeast-1', pathStyle: false },
  { label: 'Backblaze B2', endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', pathStyle: false },
  { label: 'Cloudflare R2', endpoint: 'https://<account-id>.r2.cloudflarestorage.com', region: 'auto', pathStyle: true },
  { label: 'MinIO / other (path style)', endpoint: 'https://minio.example.local:9000', region: 'us-east-1', pathStyle: true },
];

function targetSummary(t: Target): string {
  if (t.kind === 's3' && t.s3) return `s3://${t.s3.bucket}/${t.s3.prefix}${t.encryption?.enabled ? ' · encrypted' : ''}`;
  if (t.kind === 'ftp' && t.ftp) return `${t.ftp.secure === 'none' ? 'ftp' : 'ftps'}://${t.ftp.user}@${t.ftp.host}${t.ftp.path}${t.encryption?.enabled ? ' · encrypted' : ''}`;
  return t.path ?? '';
}

/** Add a backup location: folder, NAS, USB, S3 or FTP. */
function TargetForm({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<Target['kind']>('smb');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [s3, setS3] = useState({ endpoint: S3_PRESETS[0]!.endpoint, region: S3_PRESETS[0]!.region, bucket: '', prefix: 'postmaster', accessKeyId: '', secretAccessKey: '', pathStyle: false });
  const [ftp, setFtp] = useState({ host: '', port: '21', secure: 'explicit' as 'none' | 'explicit' | 'implicit', user: '', password: '', path: '/postmaster', tlsVerify: true });
  const [enc, setEnc] = useState({ enabled: true, passphrase: '', confirm: '' });
  const cloud = kind === 's3' || kind === 'ftp';
  const add = useAction(async () => {
    if (cloud && enc.enabled && enc.passphrase !== enc.confirm) throw new Error('The passphrases do not match');
    const encryption = { enabled: enc.enabled, passphrase: enc.passphrase || null };
    const body =
      kind === 's3'
        ? { name, kind, s3, encryption }
        : kind === 'ftp'
          ? { name, kind, ftp: { ...ftp, port: Number(ftp.port) }, encryption }
          : { name, kind, path };
    await post('/api/admin/backup/targets', body);
    setName('');
    setPath('');
    setEnc({ enabled: true, passphrase: '', confirm: '' });
    onDone();
  });
  const ok = name && (kind === 's3' ? s3.bucket && s3.accessKeyId && s3.secretAccessKey : kind === 'ftp' ? ftp.host && ftp.user : path) && (!cloud || !enc.enabled || enc.passphrase.length >= 12);
  return (
    <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input placeholder="Name, e.g. Office NAS" value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={kind} onChange={(e) => setKind(e.target.value as Target['kind'])}>
          {Object.entries(KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      {!cloud && (
        <Input
          placeholder={kind === 'smb' ? '\\\\nas\\backups\\mail   or   /mnt/nas/mail' : kind === 'usb' ? 'E:\\MailBackup   or   /media/usb/mail' : '/var/backups/vayrone'}
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
      )}
      {kind === 's3' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Select
            className="sm:col-span-2"
            value=""
            onChange={(e) => {
              const p = S3_PRESETS.find((x) => x.label === e.target.value);
              if (p) setS3({ ...s3, endpoint: p.endpoint, region: p.region, pathStyle: p.pathStyle });
            }}
          >
            <option value="">Provider preset…</option>
            {S3_PRESETS.map((p) => (
              <option key={p.label}>{p.label}</option>
            ))}
          </Select>
          <Input className="sm:col-span-2" placeholder="Endpoint URL" value={s3.endpoint} onChange={(e) => setS3({ ...s3, endpoint: e.target.value })} />
          <Input placeholder="Region" value={s3.region} onChange={(e) => setS3({ ...s3, region: e.target.value })} />
          <Input placeholder="Bucket" value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} />
          <Input placeholder="Folder in the bucket" value={s3.prefix} onChange={(e) => setS3({ ...s3, prefix: e.target.value })} />
          <Input placeholder="Access key ID" value={s3.accessKeyId} onChange={(e) => setS3({ ...s3, accessKeyId: e.target.value })} />
          <Input type="password" autoComplete="new-password" placeholder="Secret access key" value={s3.secretAccessKey} onChange={(e) => setS3({ ...s3, secretAccessKey: e.target.value })} />
          <Toggle checked={s3.pathStyle} onChange={(v) => setS3({ ...s3, pathStyle: v })} label="Path-style URLs (MinIO, R2)" />
        </div>
      )}
      {kind === 'ftp' && (
        <div className="grid gap-2 sm:grid-cols-3">
          <Input className="sm:col-span-2" placeholder="Server" value={ftp.host} onChange={(e) => setFtp({ ...ftp, host: e.target.value })} />
          <Input placeholder="Port" value={ftp.port} onChange={(e) => setFtp({ ...ftp, port: e.target.value })} />
          <Select value={ftp.secure} onChange={(e) => setFtp({ ...ftp, secure: e.target.value as typeof ftp.secure, port: e.target.value === 'implicit' ? '990' : '21' })}>
            <option value="explicit">FTPS (explicit TLS)</option>
            <option value="implicit">FTPS (implicit TLS, port 990)</option>
            <option value="none">Plain FTP (not recommended)</option>
          </Select>
          <Input placeholder="Username" value={ftp.user} onChange={(e) => setFtp({ ...ftp, user: e.target.value })} />
          <Input type="password" autoComplete="new-password" placeholder="Password" value={ftp.password} onChange={(e) => setFtp({ ...ftp, password: e.target.value })} />
          <Input className="sm:col-span-2" placeholder="Folder on the server" value={ftp.path} onChange={(e) => setFtp({ ...ftp, path: e.target.value })} />
          <Toggle checked={ftp.tlsVerify} onChange={(v) => setFtp({ ...ftp, tlsVerify: v })} label="Check the server certificate" />
        </div>
      )}
      {cloud && (
        <div className="rounded-md bg-slate-50 p-3 ring-1 ring-slate-200">
          <Toggle checked={enc.enabled} onChange={(v) => setEnc({ ...enc, enabled: v })} label="Encrypt backups before upload (recommended)" />
          {enc.enabled && (
            <>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Input type="password" autoComplete="new-password" placeholder="Passphrase (12+ characters)" value={enc.passphrase} onChange={(e) => setEnc({ ...enc, passphrase: e.target.value })} />
                <Input type="password" autoComplete="new-password" placeholder="Repeat passphrase" value={enc.confirm} onChange={(e) => setEnc({ ...enc, confirm: e.target.value })} />
              </div>
              <p className="mt-2 text-xs text-amber-800">Write the passphrase down and keep it away from this server. If the server is lost, the backups can only be restored with it — Vayrone cannot recover it.</p>
            </>
          )}
          <p className="mt-2 text-xs text-slate-500">Backups are prepared in the data folder and uploaded; the data disk needs free space for one backup.</p>
        </div>
      )}
      <ErrorBanner error={add.error} />
      <Button disabled={!ok} busy={add.busy} onClick={() => void add.run()}>
        Add location
      </Button>
    </div>
  );
}

const PRESETS: [string, string][] = [
  ['0 1 * * *', 'Every night at 01:00'],
  ['0 1 * * 1-6', 'Mon–Sat at 01:00'],
  ['0 */6 * * *', 'Every 6 hours'],
  ['0 2 * * 0', 'Sundays at 02:00'],
];

function RestoreWizard({ run, onClose }: { run: Run; onClose: () => void }) {
  const c = useResource(() => get<Contents>(`/api/admin/backup/runs/${run.id}/contents`), [run.id]);
  const users = useUserOptions();
  const [src, setSrc] = useState('');
  const [folder, setFolder] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [mode, setMode] = useState<'original' | 'restore_folder'>('original');
  const [target, setTarget] = useState('');
  const [done, setDone] = useState<number | null>(null);
  const su = c.data?.users.find((u) => String(u.userId) === src);
  const start = useAction(async () => {
    const r = await post<{ restoreRunId: number }>('/api/admin/backup/restore', {
      backupRunId: run.id,
      sourceUserId: Number(src),
      targetUserId: target ? Number(target) : null,
      folderPath: folder || null,
      from: from || null,
      to: to || null,
      mode,
      recreateUser: Boolean(su && !su.existsNow && !target),
    });
    setDone(r.restoreRunId);
  });
  return (
    <Modal
      open
      wide
      title={`Restore from backup of ${formatDate(run.startedAt)}`}
      onClose={onClose}
      footer={
        done ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <Button disabled={!src} busy={start.busy} onClick={() => void start.run()}>
            Start restore
          </Button>
        )
      }
    >
      <ErrorBanner error={c.error ?? start.error} />
      {done ? (
        <p className="text-sm text-emerald-700">Restore #{done} started. Progress and results appear under "Restores" below; the mailbox updates live in Outlook and webmail.</p>
      ) : !c.data ? (
        <Spinner />
      ) : (
        <>
          <Field label="Mailbox in the backup">
            <Select value={src} onChange={(e) => (setSrc(e.target.value), setFolder(''))}>
              <option value="">Choose…</option>
              {c.data.users.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.login}
                  {u.existsNow ? '' : ' (deleted since)'}
                </option>
              ))}
            </Select>
          </Field>
          {su && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Folder" className="sm:col-span-3">
                  <Select value={folder} onChange={(e) => setFolder(e.target.value)}>
                    <option value="">All folders</option>
                    {su.folders.map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.path} ({f.messages})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Received from (optional)">
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field label="Received until (optional)">
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </Field>
                <Field label="Restore into">
                  <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">{su.existsNow ? 'The same mailbox' : 'Recreate the deleted mailbox'}</option>
                    {(users.data ?? [])
                      .filter((u) => u.hasMailbox)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.login}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
              <Toggle checked={mode === 'restore_folder'} onChange={(v) => setMode(v ? 'restore_folder' : 'original')} label='Put restored mail in a separate "Restored <date>" folder' />
              <p className="rounded bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Folders that no longer exist come back exactly as they were, so Outlook and phones do not download them again. Folders that still exist only get the missing
                messages added; nothing already there is changed.
              </p>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

export function BackupsPage() {
  const me = useMe();
  const isSuper = me.user.role === 'super_admin';
  const targets = useResource(() => get<Target[]>('/api/admin/backup/targets'));
  const schedules = useResource(() => get<Schedule[]>('/api/admin/backup/schedules'));
  const [tick, setTick] = useState(0);
  const runs = useResource(() => get<Run[]>('/api/admin/backup/runs'), [tick]);
  const restores = useResource(() => get<{ id: number; scope: string; status: string; itemsRestored: number | null; error: string | null; startedAt: string | null; finishedAt: string | null; requestedBy: string; criteria: { folderPath?: string | null } }[]>('/api/admin/backup/restores'), [tick]);
  const [ask, confirmNode] = useConfirm();
  const [restoreFrom, setRestoreFrom] = useState<Run | null>(null);
  const [sf, setSf] = useState({ name: 'Nightly', targetId: '', kind: 'incremental' as Schedule['kind'], cron: '0 1 * * *', keepFull: '4' });
  const [check, setCheck] = useState<Record<number, { ok: boolean; message: string }>>({});

  // While something is running, refresh progress every 3 seconds.
  const active = (runs.data ?? []).some((r) => ['running', 'verifying'].includes(r.status)) || (restores.data ?? []).some((r) => ['pending', 'running'].includes(r.status));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((x) => x + 1), 3000);
    return () => clearInterval(t);
  }, [active]);

  const addSchedule = useAction(async () => {
    await post('/api/admin/backup/schedules', { ...sf, targetId: Number(sf.targetId), keepFull: Number(sf.keepFull) });
    schedules.reload();
  });
  const runNow = useAction(async (targetId: number, kind: 'full' | 'incremental') => {
    await post('/api/admin/backup/run', { targetId, kind });
    setTimeout(() => setTick((x) => x + 1), 1500);
  });
  const targetName = (id: number) => targets.data?.find((t) => t.id === id)?.name ?? `#${id}`;

  return (
    <div>
      {confirmNode}
      <PageHeader title="Backups" description="Backups keep every mailbox exactly as it is — after a restore, Outlook and phones do not download mail again." />
      <ErrorBanner error={targets.error ?? schedules.error ?? runs.error ?? runNow.error} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Where backups are stored">
          {!targets.data?.length ? (
            <Empty>No backup location yet.</Empty>
          ) : (
            <Table head={['Location', 'Folder', '']}>
              {targets.data.map((t) => (
                <tr key={t.id}>
                  <Td>
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-slate-500">{KIND_LABEL[t.kind]}</div>
                    {check[t.id] && <div className={`text-xs ${check[t.id]!.ok ? 'text-emerald-700' : 'text-red-600'}`}>{check[t.id]!.message}</div>}
                  </Td>
                  <Td className="max-w-[14rem] break-all font-mono text-xs">{targetSummary(t)}</Td>
                  <Td className="whitespace-nowrap text-right">
                    <Button variant="ghost" onClick={() => void post<{ ok: boolean; message: string }>(`/api/admin/backup/targets/${t.id}/check`).then((r) => setCheck({ ...check, [t.id]: r }))}>
                      Check
                    </Button>
                    <Button variant="secondary" busy={runNow.busy} onClick={() => void runNow.run(t.id, 'full')}>
                      Back up now
                    </Button>
                    {isSuper && (
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          if (await ask(`Remove backup location "${t.name}"? Existing backup files on it are not deleted.`, { confirmLabel: 'Remove' })) {
                            await del(`/api/admin/backup/targets/${t.id}`).catch((e) => alert((e as Error).message));
                            targets.reload();
                          }
                        }}
                      >
                        ✕
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {isSuper && <TargetForm onDone={targets.reload} />}
        </Card>

        <Card title="Schedules">
          {!schedules.data?.length ? (
            <Empty>No automatic backups yet.</Empty>
          ) : (
            <Table head={['Schedule', 'Location', 'Next run', '']}>
              {schedules.data.map((s) => (
                <tr key={s.id}>
                  <Td>
                    <div className="font-medium">
                      {s.name} {!s.isEnabled && <Badge>off</Badge>}
                    </div>
                    <div className="text-xs text-slate-500">
                      {s.kind === 'incremental' ? 'Incremental' : 'Full'} · <span className="font-mono">{s.cron}</span> · keeps {s.keepFull} full backups
                    </div>
                  </Td>
                  <Td>{targetName(s.targetId)}</Td>
                  <Td className="text-xs">{formatDate(s.nextRun)}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {isSuper && (
                      <>
                        <Button variant="ghost" onClick={() => void patch(`/api/admin/backup/schedules/${s.id}`, { isEnabled: !s.isEnabled }).then(schedules.reload)}>
                          {s.isEnabled ? 'Pause' : 'Resume'}
                        </Button>
                        <Button variant="ghost" onClick={() => void del(`/api/admin/backup/schedules/${s.id}`).then(schedules.reload)}>
                          ✕
                        </Button>
                      </>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {isSuper && (targets.data?.length ?? 0) > 0 && (
            <div className="mt-4 grid gap-2 border-t border-slate-100 pt-4 sm:grid-cols-2">
              <Input value={sf.name} onChange={(e) => setSf({ ...sf, name: e.target.value })} placeholder="Name" />
              <Select value={sf.targetId} onChange={(e) => setSf({ ...sf, targetId: e.target.value })}>
                <option value="">Location…</option>
                {(targets.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              <Select value={PRESETS.some((p) => p[0] === sf.cron) ? sf.cron : ''} onChange={(e) => e.target.value && setSf({ ...sf, cron: e.target.value })}>
                {PRESETS.map(([c, l]) => (
                  <option key={c} value={c}>
                    {l}
                  </option>
                ))}
                <option value="">Custom…</option>
              </Select>
              <Input value={sf.cron} onChange={(e) => setSf({ ...sf, cron: e.target.value })} className="font-mono" aria-label="Cron expression" />
              <Select value={sf.kind} onChange={(e) => setSf({ ...sf, kind: e.target.value as Schedule['kind'] })}>
                <option value="incremental">Incremental (only new mail; a full backup when needed)</option>
                <option value="full">Full every time</option>
              </Select>
              <Field label="Keep this many full backups">
                <Input type="number" min={1} value={sf.keepFull} onChange={(e) => setSf({ ...sf, keepFull: e.target.value })} />
              </Field>
              <ErrorBanner error={addSchedule.error} />
              <Button disabled={!sf.targetId} busy={addSchedule.busy} onClick={() => void addSchedule.run()}>
                Add schedule
              </Button>
            </div>
          )}
        </Card>
      </div>

      <Card title="Backup history" className="mt-5">
        {!runs.data ? (
          <Spinner />
        ) : !runs.data.length ? (
          <Empty>No backups have run yet.</Empty>
        ) : (
          <Table head={['Started', 'Location', 'Type', 'Status', 'Size', '']}>
            {runs.data.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap">{formatDate(r.startedAt)}</Td>
                <Td>{r.target}</Td>
                <Td className="capitalize">{r.kind.replace('_', ' ')}</Td>
                <Td className="max-w-xs">
                  <Badge color={STATUS[r.status] ?? 'slate'}>{r.status === 'running' ? `running ${r.progress}%` : r.status}</Badge>
                  {r.error && <div className="mt-1 truncate text-xs text-red-600" title={r.error}>{r.error}</div>}
                </Td>
                <Td className="tabular text-xs">{r.bytes ? `${formatBytes(r.bytes)} · ${r.files} files` : '—'}</Td>
                <Td className="whitespace-nowrap text-right">
                  {['ok', 'verified'].includes(r.status) && (
                    <>
                      <Button variant="ghost" onClick={() => void post(`/api/admin/backup/runs/${r.id}/verify`).then(() => setTick((x) => x + 1))}>
                        Verify
                      </Button>
                      <Button variant="secondary" onClick={() => setRestoreFrom(r)}>
                        Restore…
                      </Button>
                    </>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Full server restore (disaster recovery) is done by a technician with the services stopped: <span className="font-mono">vpm cli restore-full &lt;backup folder&gt;</span>
        </p>
      </Card>

      <Card title="Restores" className="mt-5">
        {!restores.data?.length ? (
          <Empty>No restores yet.</Empty>
        ) : (
          <Table head={['Requested', 'By', 'What', 'Status', 'Messages']}>
            {restores.data.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap">{formatDate(r.startedAt)}</Td>
                <Td>{r.requestedBy}</Td>
                <Td>
                  {r.scope}
                  {r.criteria?.folderPath ? `: ${r.criteria.folderPath}` : ''}
                </Td>
                <Td>
                  <Badge color={r.status === 'ok' ? 'green' : r.status === 'failed' ? 'red' : 'blue'}>{r.status}</Badge>
                  {r.error && <div className="text-xs text-red-600">{r.error}</div>}
                </Td>
                <Td className="tabular">{r.itemsRestored ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {restoreFrom && <RestoreWizard run={restoreFrom} onClose={() => (setRestoreFrom(null), setTick((x) => x + 1))} />}
    </div>
  );
}
