import { useState } from 'react';
import { post } from '../../api';
import { Button, ErrorBanner, Field, Input, Modal, Select, useAction } from '../../components/ui';
import { folderName, type Folder } from './types';

/**
 * Outlook's "Always move messages from this sender": a personal rule (Rules & out of office)
 * plus, optionally, moving the sender's mail that is already in the current folder.
 */
export function SenderRule({ sender, folders, currentFolderId, onClose, onDone }: { sender: string; folders: Folder[]; currentFolderId: number; onClose: () => void; onDone: (message: string) => void }) {
  // The user's own folders first (most likely target), then the built-in Archive folder.
  const choices = [...folders.filter((f) => !f.specialUse), ...folders.filter((f) => f.specialUse === 'archive')];
  const [target, setTarget] = useState<string>(choices[0]?.path ?? '');
  const [newName, setNewName] = useState('');
  const [existing, setExisting] = useState(true);
  const save = useAction(async () => {
    const path = target === '__new' ? newName.trim() : target;
    if (!path) throw new Error('Choose a folder or type a name for a new one');
    if (target === '__new') await post('/api/mail/folders', { path });
    const { id } = await post<{ id: number }>('/api/mail/rules', {
      name: `From ${sender} → ${path}`,
      stage: 'inbound',
      matchMode: 'all',
      conditions: [{ field: 'from', op: 'contains', value: sender }],
      actions: [{ type: 'move', folder: path }],
      stopProcessing: true,
    });
    let moved = 0;
    if (existing) moved = (await post<{ moved: number }>(`/api/mail/rules/${id}/run`, { folderId: currentFolderId })).moved;
    onDone(`New mail from ${sender} now goes to "${path}"${existing ? ` · ${moved} message${moved === 1 ? '' : 's'} moved` : ''}`);
  });
  return (
    <Modal
      open
      title="Always move messages from this sender"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={save.busy} onClick={() => void save.run()}>
            Create rule
          </Button>
        </>
      }
    >
      <ErrorBanner error={save.error} />
      <p className="text-sm text-slate-600">
        Mail from <span className="font-medium text-slate-900">{sender}</span> will go straight into the folder you choose, in webmail, Outlook and on phones. You can change or remove the rule
        under Rules &amp; out of office.
      </p>
      <Field label="Folder">
        <Select id="sender-rule-folder" value={target} onChange={(e) => setTarget(e.target.value)}>
          {choices.map((f) => (
            <option key={f.id} value={f.path}>
              {f.specialUse ? folderName(f) : f.path}
            </option>
          ))}
          <option value="__new">New folder…</option>
        </Select>
      </Field>
      {target === '__new' && (
        <Field label="New folder name" hint="Use / for a subfolder, for example Clients/Sharma.">
          <Input id="sender-rule-new" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Clients/Sharma" />
        </Field>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input id="sender-rule-existing" type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} />
        Also move the mail from this sender that is already in this folder
      </label>
    </Modal>
  );
}
