// Turns an uploaded request file (.vreq) into a licence file (.vlic) download.
import { NextResponse, type NextRequest } from 'next/server';
import { requireWebsiteAdmin } from '../../../../../lib/admin-guard';
import { VlsError } from '../../../../../lib/vayrone-license';
import { vls } from '../../../../../lib/vls.server';

export async function POST(req: NextRequest) {
  await requireWebsiteAdmin();
  const back = (msg: string) => NextResponse.redirect(new URL(`/admin/licences/offline?error=${encodeURIComponent(msg)}`, req.url), 303);
  const file = (await req.formData()).get('request');
  if (!(file instanceof File) || file.size === 0) return back('Choose the request file (.vreq)');
  if (file.size > 100_000) return back('That file is too large to be a PostMaster request file');
  try {
    const r = await vls().issueOfflineLicense(await file.text());
    return new NextResponse(r.license, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${r.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return back(e instanceof VlsError ? e.message : 'The License Server could not be reached');
  }
}
