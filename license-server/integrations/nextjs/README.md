# PostMaster licences in the Vayrone website admin panel (Next.js)

These pages let Vayrone staff issue and manage PostMaster licences from the website's own admin panel. All of them go through the Vayrone License Server, which stays the single place that signs licences, handles online activation and renewals, and runs the customer portal.

| Page | What it does |
|------|--------------|
| `/admin/licences` | All licences: client, plan, users used / licensed, expiry, AMC, status. Search by company, licence number, key, e-mail or phone. |
| `/admin/licences/new` | New licence: pick a client or enter a new one, the plan, **the number of users**, validity, AMC, servers, amount and invoice. It shows the licence key (`VPM-…`) to give the client. |
| `/admin/licences/[id]` | One licence: key (copy button), users, dates and servers. You can change the number of users, renew the licence or AMC, suspend or reactivate it, and move it to new hardware. Sales history. |
| `/admin/licences/offline` | Servers without internet: upload the client's request file (`.vreq`) and download the licence file (`.vlic`). |

Requirements: Next.js 15 (App Router), React 19, Node 18+. The pages use Tailwind classes. They still work without Tailwind, just unstyled.

## Install

1. **License Server: create a key.** Sign in as owner and go to **Settings → API keys → Create key**, named for example "Website admin panel". Copy the key (`vls_…`); it is shown only once.

2. **Copy the files** into the website project, keeping the paths:

   ```
   lib/vayrone-license.ts                     License Server client (no dependencies)
   lib/vls.server.ts                          reads the key from the environment (server only)
   lib/admin-guard.ts                         ← connect to your admin login (step 4)
   app/admin/licences/…                       the pages and server actions
   app/api/admin/licences/offline/route.ts    the offline file download
   ```

   If your project uses `src/`, put them under `src/`. If the admin area lives at another path, move the `app/admin/licences` folder and change the links that start with `/admin/licences`.

3. **Environment** (`.env.local`, or the hosting panel's environment variables):

   ```sh
   VLS_URL=https://license.vayrone.com
   VLS_API_KEY=vls_…
   ```

   Then run `npm install server-only`. It makes the build fail if the key file is ever imported into browser code.

4. **Connect the admin login.** Edit `lib/admin-guard.ts` so it returns when the visitor is a website admin and redirects otherwise. Until you do, the pages always redirect to `/login`, so licences can't be issued by accident.

5. **Add a menu link** to `/admin/licences` in your admin navigation.

## Security

- **Server only.** The API key is used only on the website server (server components, server actions, route handlers). The browser never sees it.
- **Limited rights.** A key works like a License Server *staff* login. It can manage clients and licences. It can't change plans, prices, settings, logins or API keys, can't sign in, and can't change any password.
- **History.** Every action is recorded in the License Server history as `API key "<name>"`. *Settings → API keys* shows when and from which IP address each key was last used.
- **Revoking.** If the website is compromised, revoke the key in *Settings → API keys*. Anything using it stops working immediately. Then create a new key.
- **Network.** Serve the License Server over HTTPS only. Optionally, allow the website server's IP in the VPS firewall.

## The number of users

`maxUsers` is how many mailbox users the client's PostMaster may have. Their admin can't create more.

- **Online servers** pick up a change within a day, or straight away when their admin clicks *Check now*.
- **Offline servers** need a new request file, processed on the *Offline licence file* page.
- **The licence list** shows users in use next to the licensed number, as reported by the client's server.

## Using the client elsewhere

`lib/vayrone-license.ts` has no dependencies. Use it from any server-side Node code, for example a payment webhook that issues a licence automatically:

```ts
import { createVlsClient } from './lib/vayrone-license';
const vls = createVlsClient({ baseUrl: process.env.VLS_URL!, apiKey: process.env.VLS_API_KEY! });
const { id: clientId } = await vls.createClient({ company: 'Agra Steel Traders', email: 'it@agrasteel.com' });
const plan = (await vls.plans()).find((p) => p.code === 'business')!;
const { licenseKey } = await vls.createLicense({ clientId, planId: plan.id, maxUsers: 50, amount: 45000, invoiceRef: 'VI/26-27/031' });
```

Every method throws a `VlsError` with `status` and `message` when the License Server refuses a request. One example is "This plan starts at 10 users".
