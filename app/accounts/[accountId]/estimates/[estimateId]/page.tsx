import { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getCurrentUserProfileServer } from '@/lib/auth-server';
import { createServerSupabase } from '@/lib/supabase-server';
import { checkEstimateAccess } from '@/lib/financial-access';
import { estimateService, serializeEstimateWithItems } from '@/lib/estimate-service';
import { Permission } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { EstimateDetail } from '@/components/estimates/estimate-detail';

export const metadata: Metadata = {
  title: 'Estimate',
};

interface EstimateDetailPageProps {
  params: Promise<{ accountId: string; estimateId: string }>;
}

export default async function EstimateDetailPage({ params }: EstimateDetailPageProps) {
  const { accountId, estimateId } = await params;

  const userProfile = await getCurrentUserProfileServer();
  const supabase = await createServerSupabase();

  if (!userProfile || !supabase) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground mt-2">
            {userProfile ? 'Unable to connect to database.' : 'Please log in to view estimates.'}
          </p>
        </div>
      </div>
    );
  }

  let result;
  try {
    // Membership + view_estimates, scoped to this account, enforced by the
    // service (which reports another tenant's id as not found).
    result = await estimateService.getEstimate(estimateId, userProfile, supabase, { accountId });
  } catch {
    notFound();
  }

  // Which lifecycle actions this user may take, decided server-side. The UI
  // only hides what the API would refuse anyway.
  const [sendDecision, acceptDecision, rejectDecision, updateDecision] = await Promise.all([
    checkEstimateAccess(userProfile, Permission.SEND_ESTIMATES, accountId, supabase),
    checkEstimateAccess(userProfile, Permission.ACCEPT_ESTIMATES, accountId, supabase),
    checkEstimateAccess(userProfile, Permission.REJECT_ESTIMATES, accountId, supabase),
    checkEstimateAccess(userProfile, Permission.UPDATE_ESTIMATES, accountId, supabase),
  ]);

  const { data: project } = result.estimate.project_id
    ? await supabase
        .from('projects')
        .select('name')
        .eq('id', result.estimate.project_id)
        .eq('account_id', accountId)
        .maybeSingle()
    : { data: null };

  return (
    <div className="bg-background min-h-screen">
      <div className="bg-background/95 supports-[backdrop-filter]:bg-background/60 border-b backdrop-blur">
        <div className="px-4 py-6 sm:px-6 sm:py-8">
          <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2">
            <Link href={`/accounts/${accountId}/estimates`}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Estimates
            </Link>
          </Button>
          <EstimateDetail
            accountId={accountId}
            initial={serializeEstimateWithItems(result)}
            projectName={(project as { name?: string } | null)?.name ?? null}
            permissions={{
              canEdit: updateDecision.allowed,
              canSend: sendDecision.allowed,
              canAccept: acceptDecision.allowed,
              canReject: rejectDecision.allowed,
            }}
          />
        </div>
      </div>
    </div>
  );
}
