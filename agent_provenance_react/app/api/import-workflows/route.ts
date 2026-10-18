import { workflowProxy } from '../workflow_proxy';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return workflowProxy('api/import-workflows', request);
}
