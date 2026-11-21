import { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getCurrentUserProfileServer } from '@/lib/auth-server';
import { createServerSupabase } from '@/lib/supabase-server';
import { checkEstimateAccess } from '@/lib/financial-access';
import { Permission } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { EstimatesList } from '@/components/estimates/estimates-list';

export const metadata: Metadata = {
  title: 'Estimates',
};

interface EstimatesPageProps {
  params: Promise<{ accountId: string }>;
}

export default async function AccountEstimatesPage({ params }: EstimatesPageProps) {
  const { accountId } = await params;

  const userProfile = await getCurrentUserProfileServer();
  if (!userProfile) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground mt-2">Please log in to view estimates.</p>
        </div>
      </div>
    );
  }

  const supabase = await createServerSupabase();
  if (!supabase) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-bold">Database Error</h1>
          <p className="text-muted-foreground mt-2">Unable to connect to database.</p>
        </div>
      </div>
    );
  }

  // Same rule the API enforces: active membership AND view_estimates.
  const decision = await checkEstimateAccess(
    userProfile,
    Permission.VIEW_ESTIMATES,
    accountId,
    supabase,
  );

  if (!decision.allowed) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-foreground text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground mt-2">
            You don&apos;t have permission to view estimates for this account.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link href="/accounts">Back to accounts</Link>
          </Button>
        </div>
      </div>
    );
  }

  const { data: account } = await supabase
    .from('accounts')
    .select('id, name')
    .eq('id', accountId)
    .single();

  return (
    <div className="bg-background min-h-screen">
      <div className="bg-background/95 supports-[backdrop-filter]:bg-background/60 border-b backdrop-blur">
        <div className="px-4 py-6 sm:px-6 sm:py-8">
          <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2">
            <Link href={`/accounts/${accountId}`}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              {account?.name ?? 'Account'}
            </Link>
          </Button>
          <h1 className="text-foreground text-3xl font-bold sm:text-4xl">Estimates</h1>
          <p className="text-muted-foreground mt-2 text-sm sm:text-base">
            Estimates for {account?.name ?? 'this account'}.
          </p>
        </div>
      </div>

      <div className="px-4 py-6 sm:px-6 sm:py-8">
        <EstimatesList accountId={accountId} />
      </div>
    </div>
  );
}
