import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './auth';
import { AdminMobileNav, AdminSidebar, Shell } from './components/Layout';
import { Spinner } from './components/ui';
import { Login } from './pages/Login';
import { MailHome } from './pages/Mail';
import { Account } from './pages/Account';
import { Dashboard } from './pages/admin/Dashboard';
import { Users } from './pages/admin/Users';
import { Aliases, Domains, Groups, Lists } from './pages/admin/Directory';
import { QueuePage, RelayPage } from './pages/admin/Relay';
import { CompanyPage, LogsPage, SecurityPage, SessionsPage } from './pages/admin/System';
import { ExternalPage } from './pages/admin/External';
import { JournalPage, MailRulesPage, UserMailSettingsPage } from './pages/admin/MailRules';
import { MailSettings } from './pages/MailSettings';
import { ArchivePage } from './pages/admin/Archive';
import { BackupsPage } from './pages/admin/Backups';
import { LicensePage } from './pages/admin/License';
import { UpdatesPage } from './pages/admin/Updates';
import { HealthPage } from './pages/admin/Health';
import { NetworkPage } from './pages/admin/Network';
import { Webmail } from './pages/webmail/Webmail';
import { SetupWizard } from './pages/Setup';
import { AboutPage } from './pages/About';

function Admin({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  if (state.status !== 'ready') return null;
  if (!state.me.canUseAdmin) return <Navigate to="/mail" replace />;
  return (
    <Shell sidebar={<AdminSidebar />}>
      <AdminMobileNav />
      {children}
    </Shell>
  );
}

/** Until the setup wizard is completed, every path shows it. */
function SetupGate({ children }: { children: ReactNode }) {
  const [required, setRequired] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/api/setup/status')
      .then((r) => (r.ok ? r.json() : { required: false }))
      .then((s: { required: boolean }) => setRequired(s.required), () => setRequired(false));
  }, []);
  if (required === null) return <Spinner />;
  if (required) return <SetupWizard />;
  if (window.location.pathname === '/setup') window.history.replaceState(null, '', '/login');
  return <>{children}</>;
}

function App() {
  const { state } = useAuth();
  if (state.status === 'loading') return <Spinner />;
  if (state.status !== 'ready') {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  const me = state.me;
  const home = me.mode === 'admin' || !me.canUseMail ? '/admin' : '/mail';
  return (
    <Routes>
      <Route path="/login" element={<Navigate to={home} replace />} />
      <Route path="/" element={<Navigate to={home} replace />} />
      <Route
        path="/mail"
        element={
          me.canUseMail ? (
            <Shell flush>
              <Webmail />
            </Shell>
          ) : (
            <Navigate to="/admin" replace />
          )
        }
      />
      <Route
        path="/mail/setup"
        element={
          me.canUseMail ? (
            <Shell>
              <MailHome />
            </Shell>
          ) : (
            <Navigate to="/admin" replace />
          )
        }
      />
      <Route
        path="/mail/settings"
        element={
          me.canUseMail ? (
            <Shell>
              <MailSettings />
            </Shell>
          ) : (
            <Navigate to="/admin" replace />
          )
        }
      />
      <Route
        path="/account"
        element={
          <Shell>
            <Account />
          </Shell>
        }
      />
      <Route
        path="/about"
        element={
          <Shell>
            <AboutPage />
          </Shell>
        }
      />
      {(
        [
          ['/admin', <Dashboard />],
          ['/admin/users', <Users />],
          ['/admin/domains', <Domains />],
          ['/admin/aliases', <Aliases />],
          ['/admin/lists', <Lists />],
          ['/admin/groups', <Groups />],
          ['/admin/external', <ExternalPage />],
          ['/admin/rules', <MailRulesPage />],
          ['/admin/journal', <JournalPage />],
          ['/admin/users/:id/mail', <UserMailSettingsPage />],
          ['/admin/relay', <RelayPage />],
          ['/admin/queue', <QueuePage />],
          ['/admin/archive', <ArchivePage />],
          ['/admin/backups', <BackupsPage />],
          ['/admin/license', <LicensePage />],
          ['/admin/updates', <UpdatesPage />],
          ['/admin/health', <HealthPage />],
          ['/admin/network', <NetworkPage />],
          ['/admin/sessions', <SessionsPage />],
          ['/admin/security', <SecurityPage />],
          ['/admin/logs', <LogsPage />],
          ['/admin/company', <CompanyPage />],
        ] as const
      ).map(([path, el]) => (
        <Route key={path} path={path} element={<Admin>{el}</Admin>} />
      ))}
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SetupGate>
        <AuthProvider>
          <App />
        </AuthProvider>
      </SetupGate>
    </BrowserRouter>
  </StrictMode>,
);
