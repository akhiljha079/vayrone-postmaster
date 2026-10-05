import { get } from '../api';
import { AutoReplyCard, ForwardingCard, RuleList } from '../components/RuleEditor';
import { PageHeader, useResource } from '../components/ui';

/** Employee self-service: out of office, forwarding and personal rules. */
export function MailSettings() {
  const policy = useResource(() => get<{ allowExternalForwarding: boolean }>('/api/mail/policy'));
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Rules & out of office" />
      <div className="grid gap-5 lg:grid-cols-2">
        <AutoReplyCard url="/api/mail/autoreply" />
        <ForwardingCard url="/api/mail/forwarding" externalAllowed={policy.data?.allowExternalForwarding} />
        <div className="lg:col-span-2">
          <RuleList base="/api/mail" title="My rules" description="Sort incoming mail automatically. Drag to change the order." />
        </div>
      </div>
    </div>
  );
}
