import { EventEmitter } from 'node:events';

/**
 * In-process change notifications. A folder event means "something in this
 * folder changed — re-sync from the DB". Payload-free on purpose: the DB is
 * the source of truth, so a dropped or coalesced event can never lose state.
 */
export class MailEvents extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  folderChanged(folderId: number): void {
    this.emitLocal(folderId);
  }

  /** Emits to local listeners only (used for notifications that arrived from another process). */
  emitLocal(folderId: number): void {
    this.emit(`folder:${folderId}`);
    this.emit('folder', folderId);
  }

  /** Every folder change (realtime web push, IPC stream). */
  onAnyFolder(fn: (folderId: number) => void): () => void {
    this.on('folder', fn);
    return () => this.off('folder', fn);
  }

  onFolder(folderId: number, fn: () => void): () => void {
    const ev = `folder:${folderId}`;
    this.on(ev, fn);
    return () => this.off(ev, fn);
  }
}
