import { brandAsset, brandAssetHeaders } from '@/server/brand';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Brand files: stylesheet, fonts, logo and favicon. They are looked up by their content hash among what was
 * validated at startup, never by a path on disk. Any other name is a 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  const asset = brandAsset((await params).file);
  if (!asset) {
    return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
  }
  return new Response(asset.bytes, { headers: brandAssetHeaders(asset) });
}
