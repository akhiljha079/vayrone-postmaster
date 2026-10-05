import { useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { ROLE_LABEL } from '../api';
import { useAuth, useMe } from '../auth';

export function Footer() {
  const { branding } = useAuth();
  return (
    <footer className="border-t border-slate-200 bg-white px-4 py-3 text-center text-xs text-slate-500">
      <span className="font-medium text-slate-600">Vayrone PostMaster</span> by Vayrone Infratech
      {branding?.version && <span className="ml-2 text-slate-400">v{branding.version}</span>}
      <Link to="/about" className="ml-3 text-slate-400 hover:text-slate-600">
        About
      </Link>
    </footer>
  );
}

function ModeToggle() {
  const me = useMe();
  const { setMode } = useAuth();
  const nav = useNavigate();
  if (!(me.canUseAdmin && me.canUseMail)) return null;
  const switchTo = async (m: 'mail' | 'admin') => {
    if (m === me.mode) return;
    await setMode(m);
    nav(m === 'admin' ? '/admin' : '/mail');
  };
  const btn = (m: 'mail' | 'admin', label: string) => (
    <button
      onClick={() => void switchTo(m)}
      className={`rounded px-3 py-1 text-sm font-medium transition ${me.mode === m ? 'bg-white text-brand-900 shadow' : 'text-white/80 hover:text-white'}`}
      aria-pressed={me.mode === m}
    >
      {label}
    </button>
  );
  return (
    <div className="flex rounded-md bg-white/15 p-0.5" role="group" aria-label="Mode">
      {btn('mail', 'Mail')}
      {btn('admin', 'Admin Panel')}
    </div>
  );
}

function UserMenu() {
  const me = useMe();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-white hover:bg-white/10">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
          {me.user.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden text-left sm:block">
          <span className="block leading-tight">{me.user.displayName}</span>
          <span className="block text-xs leading-tight text-white/60">{ROLE_LABEL[me.user.role]}</span>
        </span>
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 rounded-md bg-white py-1 text-sm shadow-lg ring-1 ring-slate-200" onMouseLeave={() => setOpen(false)}>
          <div className="truncate border-b border-slate-100 px-3 py-2 text-xs text-slate-500">{me.user.login}</div>
          {me.canUseMail && (
            <>
              <button className="block w-full px-3 py-2 text-left hover:bg-slate-50" onClick={() => (setOpen(false), nav('/mail/settings'))}>
                Rules &amp; out of office
              </button>
              <button className="block w-full px-3 py-2 text-left hover:bg-slate-50" onClick={() => (setOpen(false), nav('/mail/setup'))}>
                Outlook / Thunderbird setup
              </button>
            </>
          )}
          <button className="block w-full px-3 py-2 text-left hover:bg-slate-50" onClick={() => (setOpen(false), nav('/account'))}>
            Account &amp; security
          </button>
          <button className="block w-full px-3 py-2 text-left text-red-600 hover:bg-slate-50" onClick={() => void logout().then(() => nav('/login'))}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const { branding } = useAuth();
  return (
    <header className="flex h-14 items-center justify-between gap-3 bg-brand-900 px-4 text-white">
      <div className="flex min-w-0 items-center gap-3">
        {branding?.company?.logoUrl ? (
          <img src={branding.company.logoUrl} alt="" className="h-8 w-8 rounded bg-white object-contain p-0.5" />
        ) : (
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
        )}
        <div className="min-w-0 leading-tight">
          <div className="truncate font-semibold">{branding?.company?.name ?? 'Vayrone PostMaster'}</div>
          <div className="truncate text-xs text-white/60">Vayrone PostMaster</div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <ModeToggle />
        <UserMenu />
      </div>
    </header>
  );
}

function LicenseBanner() {
  const me = useMe();
  const { message, level } = me.license;
  if (!message || !level) return null;
  const color = level === 'critical' ? 'bg-red-100 text-red-900' : level === 'warning' ? 'bg-amber-100 text-amber-900' : 'bg-sky-100 text-sky-900';
  const canManage = me.user.role === 'super_admin' || me.user.role === 'admin' || me.user.role === 'vayrone_support';
  return (
    <div className={`px-4 py-2 text-center text-sm ${color}`} role="status">
      {message}
      {canManage && (
        <Link to="/admin/license" className="ml-2 font-medium underline">
          Licence page
        </Link>
      )}
    </div>
  );
}

/** flush: full-height app area without padding or footer (webmail). */
export function Shell({ children, sidebar, flush }: { children: ReactNode; sidebar?: ReactNode; flush?: boolean }) {
  if (flush) {
    return (
      <div className="flex h-full flex-col">
        <TopBar />
        <LicenseBanner />
        <main className="min-h-0 flex-1">{children}</main>
      </div>
    );
  }
  return (
    <div className="flex min-h-full flex-col">
      <TopBar />
      <LicenseBanner />
      <div className="flex flex-1">
        {sidebar}
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
      <Footer />
    </div>
  );
}

const ADMIN_NAV: { to: string; label: string; roles?: string[] }[] = [
  { to: '/admin', label: 'Dashboard' },
  { to: '/admin/health', label: 'System health', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/users', label: 'Users', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/domains', label: 'Domains', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/aliases', label: 'Aliases', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/lists', label: 'Distribution lists', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/groups', label: 'Groups', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/external', label: 'External mailboxes', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/rules', label: 'Mail rules', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/journal', label: 'Journaling', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/relay', label: 'SMTP relay', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/queue', label: 'Mail queue', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/archive', label: 'Archive' },
  { to: '/admin/backups', label: 'Backups', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/sessions', label: 'Sessions', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/security', label: 'Security', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/network', label: 'Network & TLS', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/logs', label: 'Logs & audit' },
  { to: '/admin/company', label: 'Company', roles: ['super_admin', 'admin', 'vayrone_support'] },
  { to: '/admin/license', label: 'Licence' },
  { to: '/admin/updates', label: 'Updates', roles: ['super_admin', 'admin', 'vayrone_support'] },
];

export function AdminSidebar() {
  const me = useMe();
  return (
    <nav className="hidden w-52 shrink-0 border-r border-slate-200 bg-white py-4 md:block" aria-label="Admin">
      {ADMIN_NAV.filter((n) => !n.roles || n.roles.includes(me.user.role)).map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/admin'}
          className={({ isActive }) =>
            `mx-2 block rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`
          }
        >
          {n.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Narrow screens: admin navigation as a select. */
export function AdminMobileNav() {
  const me = useMe();
  const nav = useNavigate();
  return (
    <select className="mb-4 w-full rounded-md border-slate-300 text-sm md:hidden" onChange={(e) => nav(e.target.value)} value={location.pathname}>
      {ADMIN_NAV.filter((n) => !n.roles || n.roles.includes(me.user.role)).map((n) => (
        <option key={n.to} value={n.to}>
          {n.label}
        </option>
      ))}
    </select>
  );
}
