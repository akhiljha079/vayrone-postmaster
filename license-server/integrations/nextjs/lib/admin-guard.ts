// Connect this to the website's own admin login. Every licence page, server
// action and route handler calls it first.
import 'server-only';
import { redirect } from 'next/navigation';

export async function requireWebsiteAdmin(): Promise<{ name: string }> {
  // EXAMPLE (NextAuth / Auth.js):
  //   const session = await auth();
  //   if (session?.user?.role !== 'admin') redirect('/login');
  //   return { name: session.user.name ?? 'admin' };
  //
  // Until this is wired up the pages refuse to open, so licences can never be issued by accident.
  redirect('/login?next=/admin/licences');
}
