import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ROLE_LABEL } from '../api';
import { useAuth, useMe } from '../auth';

export function Footer() {
  const { branding } = useAuth();
  return (
    <footer className="border-t border-slate-200 bg-white px-4 py-3 text-center text-xs text-slate-500 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]">
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
      className={`rounded px-2.5 py-1 text-xs font-medium transition sm:px-3 sm:text-sm ${me.mode === m ? 'bg-white text-brand-900 shadow' : 'text-white/80 hover:text-white'}`}
      aria-pressed={me.mode === m}
    >
      {label}
    </button>
  );
  return (
    <div className="flex rounded-md bg-white/15 p-0.5" role="group" aria-label="Mode">
      {btn('mail', 'Mail')}
      {btn('admin', 'Admin')}
    </div>
  );
}

function UserMenu() {
  const me = useMe();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
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
        <div className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-lg bg-white py-1 text-sm text-slate-700 shadow-xl ring-1 ring-slate-200">
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

/** Opens the admin navigation drawer on phones and tablets. */
const DrawerContext = createContext<(() => void) | null>(null);

export function TopBar() {
  const { branding } = useAuth();
  const openDrawer = useContext(DrawerContext);
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-2 border-b-2 border-accent bg-brand-900 px-3 text-white shadow-sm sm:px-4">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        {openDrawer && (
          <button onClick={openDrawer} className="-ml-1 rounded-md p-2 hover:bg-white/10 lg:hidden" aria-label="Open menu">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        {branding?.company?.logoUrl ? (
          <img src={branding.company.logoUrl} alt="" className="h-8 w-8 rounded bg-white object-contain p-0.5" />
        ) : (
          <img src="/favicon.svg" alt="" className="h-8 w-8 shrink-0" />
        )}
        <div className="hidden min-w-0 leading-tight min-[400px]:block">
          <div className="truncate font-semibold">{branding?.company?.name ?? 'Vayrone PostMaster'}</div>
          <div className="truncate text-xs text-white/60">Vayrone PostMaster</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
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
  return <SidebarShell sidebar={sidebar}>{children}</SidebarShell>;
}

/** Desktop: fixed sidebar. Phones and tablets: the sidebar slides in from the menu button. */
function SidebarShell({ children, sidebar }: { children: ReactNode; sidebar?: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);
  return (
    <DrawerContext.Provider value={sidebar ? () => setDrawer(true) : null}>
      <div className="flex min-h-full flex-col">
        <TopBar />
        <LicenseBanner />
        <div className="flex flex-1">
          {sidebar && (
            <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-60 shrink-0 overflow-y-auto border-r border-slate-200 bg-white lg:block">{sidebar}</aside>
          )}
          {sidebar && drawer && (
            <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
              <div className="absolute inset-0 bg-slate-900/50" onClick={() => setDrawer(false)} />
              <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-2xl">
                <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-4">
                  <img src="/logo.png" alt="Vayrone PostMaster" className="h-11 w-11" />
                  <button onClick={() => setDrawer(false)} className="rounded-md p-2 text-slate-500 hover:bg-slate-100" aria-label="Close menu">
                    ✕
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto">{sidebar}</div>
              </aside>
            </div>
          )}
          <main className="min-w-0 flex-1 px-3 py-4 sm:px-6 sm:py-6 lg:px-8">
            <div className="mx-auto max-w-7xl">{children}</div>
          </main>
        </div>
        <Footer />
      </div>
    </DrawerContext.Provider>
  );
}

const STAFF = ['super_admin', 'admin', 'vayrone_support'];
const ADMIN_NAV: { section: string; items: { to: string; label: string; roles?: string[] }[] }[] = [
  {
    section: 'Overview',
    items: [
      { to: '/admin', label: 'Dashboard' },
      { to: '/admin/health', label: 'System health', roles: STAFF },
    ],
  },
  {
    section: 'Mailboxes',
    items: [
      { to: '/admin/users', label: 'Users', roles: STAFF },
      { to: '/admin/domains', label: 'Domains', roles: STAFF },
      { to: '/admin/aliases', label: 'Aliases', roles: STAFF },
      { to: '/admin/lists', label: 'Distribution lists', roles: STAFF },
      { to: '/admin/groups', label: 'Groups', roles: STAFF },
      { to: '/admin/external', label: 'External mailboxes', roles: STAFF },
    ],
  },
  {
    section: 'Mail flow',
    items: [
      { to: '/admin/easy-rules', label: 'Easy rules', roles: STAFF },
      { to: '/admin/rules', label: 'Mail rules', roles: STAFF },
      { to: '/admin/journal', label: 'Journaling', roles: STAFF },
      { to: '/admin/relay', label: 'SMTP relay', roles: STAFF },
      { to: '/admin/queue', label: 'Mail queue', roles: STAFF },
      { to: '/admin/filtering', label: 'Spam & quarantine', roles: STAFF },
    ],
  },
  {
    section: 'Data',
    items: [
      { to: '/admin/archive', label: 'Archive' },
      { to: '/admin/backups', label: 'Backups', roles: STAFF },
      { to: '/admin/logs', label: 'Logs & audit' },
    ],
  },
  {
    section: 'Security & system',
    items: [
      { to: '/admin/sessions', label: 'Sessions', roles: STAFF },
      { to: '/admin/security', label: 'Security', roles: STAFF },
      { to: '/admin/network', label: 'Network & TLS', roles: STAFF },
      { to: '/admin/company', label: 'Company', roles: STAFF },
      { to: '/admin/license', label: 'Licence' },
      { to: '/admin/updates', label: 'Updates', roles: STAFF },
    ],
  },
];

export function AdminSidebar() {
  const me = useMe();
  return (
    <nav className="space-y-5 px-3 py-4" aria-label="Admin">
      {ADMIN_NAV.map((g) => {
        const items = g.items.filter((n) => !n.roles || n.roles.includes(me.user.role));
        if (!items.length) return null;
        return (
          <div key={g.section}>
            <div className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.section}</div>
            {items.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/admin'}
                className={({ isActive }) =>
                  `relative block rounded-md px-3 py-2 text-sm transition lg:py-1.5 ${
                    isActive
                      ? 'bg-brand-50 font-medium text-brand-900 before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-accent'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
