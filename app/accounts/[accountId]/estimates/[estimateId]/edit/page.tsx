import { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getCurrentUserProfileServer } from '@/lib/auth-server';
import { createServerSupabase } from '@/lib/supabase-server';
import { checkEstimateAccess } from '@/lib/financial-access';
import { estimateService } from '@/lib/estimate-service';
import { Permission } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { EstimateForm } from '@/components/estimates/estimate-form';

export const metadata: Metadata = {
  title: 'Edit estimate',
};

interface EditEstimatePageProps {
  params: Promise<{ accountId: string; estimateId: string }>;
}

export default async function EditEstimatePage({ params }: EditEstimatePageProps) {
  const { accountId, estimateId } = await params;

  const userProfile = await getCurrentUserProfileServer();
  const supabase = await createServerSupabase();

  if (!userProfile || !supabase) {
    return (
      <div className="container mx-auto p-6 text-center">
        <h1 className="text-foreground text-2xl font-bold">Access Denied</h1>
        <p className="text-muted-foreground mt-2">
          {userProfile ? 'Unable to connect to database.' : 'Please log in to edit estimates.'}
        </p>
      </div>
    );
  }

  const decision = await checkEstimateAccess(
    userProfile,
    Permission.UPDATE_ESTIMATES,
    accountId,
    supabase,
  );

  if (!decision.allowed) {
    return (
      <div className="container mx-auto p-6 text-center">
        <h1 className="text-foreground text-2xl font-bold">Access Denied</h1>
        <p className="text-muted-foreground mt-2">
          You don&apos;t have permission to edit estimates for this account.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link href={`/accounts/${accountId}/estimates`}>Back to estimates</Link>
        </Button>
      </div>
    );
  }

  let result;
  try {
    result = await estimateService.getEstimate(estimateId, userProfile, supabase, { accountId });
  } catch {
    return (
      <div className="container mx-auto p-6 text-center">
        <h1 className="text-foreground text-2xl font-bold">Estimate not found</h1>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link href={`/accounts/${accountId}/estimates`}>Back to estimates</Link>
        </Button>
      </div>
    );
  }

  if (result.estimate.status !== 'draft') {
    return (
      <div className="container mx-auto p-6 text-center">
        <h1 className="text-foreground text-2xl font-bold">This estimate can no longer be edited</h1>
        <p className="text-muted-foreground mt-2">
          It is already {result.estimate.status}. Only drafts can be changed.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link href={`/accounts/${accountId}/estimates/${estimateId}`}>
            Back to estimate
          </Link>
        </Button>
      </div>
    );
  }

  const [{ data: account }, { data: projects }] = await Promise.all([
    supabase.from('accounts').select('id, name').eq('id', accountId).single(),
    supabase
      .from('projects')
      .select('id, name')
      .eq('account_id', accountId)
      .order('name', { ascending: true }),
  ]);

  return (
    <div className="bg-background min-h-screen">
      <div className="px-4 py-6 sm:px-6 sm:py-8">
        <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2">
          <Link href={`/accounts/${accountId}/estimates/${estimateId}`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {result.estimate.estimate_number}
          </Link>
        </Button>
        <h1 className="text-foreground text-3xl font-bold sm:text-4xl">Edit draft</h1>
        <p className="text-muted-foreground mt-2 text-sm sm:text-base">
          {account?.name ?? 'Account'} · only drafts can be edited
        </p>

        <div className="mt-6">
          <EstimateForm
            mode="edit"
            estimateId={estimateId}
            accountId={accountId}
            accountName={account?.name ?? 'this account'}
            projects={(projects ?? []) as Array<{ id: string; name: string }>}
            initial={{
              estimate_number: result.estimate.estimate_number,
              title: result.estimate.title,
              description: result.estimate.description,
              currency: result.estimate.currency,
              project_id: result.estimate.project_id,
              tax_minor: result.estimate.tax_minor,
              line_items: result.lineItems.map((line) => ({
                description: line.description,
                quantity: String(line.quantity),
                unit_price_minor: line.unit_price_minor,
              })),
            }}
          />
        </div>
      </div>
    </div>
  );
}
