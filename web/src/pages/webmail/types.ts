import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

export interface Folder {
  id: number;
  path: string;
  specialUse: string | null;
  messages: number;
  unseen: number;
  bytes: number;
}

export interface ListItem {
  id: number;
  uid: number;
  subject: string;
  from: string;
  to: string[];
  date: string;
  size: number;
  preview: string;
  hasAttachments: boolean;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  forwarded: boolean;
  draft: boolean;
}

export interface Addr {
  name: string;
  address: string;
}

export interface FullMessage {
  id: number;
  folderId: number;
  folderSpecialUse: string | null;
  flags: { seen: boolean; flagged: boolean; answered: boolean; draft: boolean };
  subject: string;
  from: Addr[];
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  date: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  html: string;
  remoteImages: boolean;
  text: string;
  attachments: { index: number; filename: string; contentType: string; size: number }[];
  size: number;
}

export const FOLDER_LABEL: Record<string, string> = { inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent', archive: 'Archive', junk: 'Junk', trash: 'Trash' };
export const FOLDER_ICON: Record<string, string> = { inbox: '📥', drafts: '📝', sent: '📤', archive: '🗄', junk: '⚠', trash: '🗑' };

export function folderName(f: Folder): string {
  return f.specialUse ? (FOLDER_LABEL[f.specialUse] ?? f.path) : f.path;
}

export function addrText(a: Addr): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function displayName(from: string): string {
  const m = /^(.*?)\s*<[^>]+>$/.exec(from);
  return (m ? m[1]!.replace(/^"|"$/g, '') : from) || from;
}

export function shortDate(d: string): string {
  const date = new Date(d);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  if (now.getTime() - date.getTime() < 6 * 86400_000) return date.toLocaleDateString('en-IN', { weekday: 'short' });
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** Live mailbox updates over Socket.IO. Returns whether the push channel is connected. */
export function useMailSocket(onMail: (folders: number[]) => void): boolean {
  const ref = useRef(onMail);
  ref.current = onMail;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const s: Socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('mail', (e: { folders: number[] }) => ref.current(e.folders));
    return () => {
      s.close();
    };
  }, []);
  return connected;
}
