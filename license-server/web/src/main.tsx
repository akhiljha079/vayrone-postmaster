import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import './styles.css';
import type { Me } from './api';
import { AuthProvider, useAuth } from './auth';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { LicensesPage } from './pages/Licenses';
import { LicenseDetailPage } from './pages/LicenseDetail';
import { ClientDetailPage, ClientsPage } from './pages/Clients';
import { OfflinePage, PortalPage } from './pages/Offline';
import { PlansPage } from './pages/Plans';
import { PartnersPage } from './pages/Partners';
import { SettingsPage } from './pages/Settings';
import { ServersPage } from './pages/Servers';

const NAV: { to: string; label: string; roles?: Me['user']['role'][] }[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/servers', label: 'Client servers' },
  { to: '/licenses', label: 'Licences' },
  { to: '/clients', label: 'Clients' },
  { to: '/offline', label: 'Offline files' },
  { to: '/plans', label: 'Plans & pricing' },
  { to: '/partners', label: 'Partners', roles: ['owner', 'staff'] },
  { to: '/settings', label: 'Settings', roles: ['owner'] },
];

function Layout({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between bg-brand-900 px-4 py-2.5 text-white">
        <div>
          <div className="font-semibold">Vayrone License Server</div>
          <div className="text-xs text-white/60">{me!.reseller ? `Partner portal — ${me!.reseller.name}` : 'Vayrone Infratech, Agra'}</div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden text-white/80 sm:inline">{me!.user.name}</span>
          <button
            className="rounded px-2 py-1 text-white/80 hover:bg-white/10"
            onClick={async () => {
              await logout();
              nav('/login');
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white p-2 md:w-52 md:flex-col md:border-r md:border-b-0">
          {NAV.filter((n) => !n.roles || n.roles.includes(me!.user.role)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) => `whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

function Private({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  if (!me) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/portal" element={<PortalPage />} />
      <Route path="/" element={<Private><DashboardPage /></Private>} />
      <Route path="/servers" element={<Private><ServersPage /></Private>} />
      <Route path="/licenses" element={<Private><LicensesPage /></Private>} />
      <Route path="/licenses/:id" element={<Private><LicenseDetailPage /></Private>} />
      <Route path="/clients" element={<Private><ClientsPage /></Private>} />
      <Route path="/clients/:id" element={<Private><ClientDetailPage /></Private>} />
      <Route path="/offline" element={<Private><OfflinePage /></Private>} />
      <Route path="/plans" element={<Private><PlansPage /></Private>} />
      <Route path="/partners" element={<Private><PartnersPage /></Private>} />
      <Route path="/settings" element={<Private><SettingsPage /></Private>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
