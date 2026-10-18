import { workflowProxy } from '../workflow_proxy';
export const dynamic = 'force-dynamic';
export async function GET() {
  return workflowProxy('api/workflow-corpora');
}
